import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import type { ExtensionCall, ExtensionManifest, ExtensionRecord } from "@workbench/contracts";
import { Store } from "./store.ts";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { ExtensionService } from "./extensions/service.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const example = fileURLToPath(new URL("../../../extension-runtime/examples/workbench-notebook/", import.meta.url));
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "workbench-extensions-"));
  const store = new Store(join(directory, "state.sqlite"));
  const manager = new SessionManager(store, new EventBus(), { hostId: "extension-test-host", hostLabel: "확장 검사", dataDir: directory, managedWorksDir: join(directory, "works") });
  const work = manager.createWork({ title: "허용 프로젝트" });
  const workspace = manager.workspaces.get(work.defaultWorkspaceId!);
  const siblingPath = join(directory, "sibling"); mkdirSync(siblingPath);
  const sibling = manager.createWorkspace(work.id, { cwd: siblingPath, label: "같은 프로젝트의 다른 작업공간" });
  const services: ExtensionService[] = [];
  const service = () => { const service = new ExtensionService({ dataDir: directory, manager, authorizeWrite: () => undefined }); services.push(service); return service; };
  cleanups.push(async () => { try { for (const service of services) await service.close(); await manager.shutdown(); } finally { store.close(); rmSync(directory, { recursive: true, force: true }); } });
  const packageAt = (name: string, mutate?: (manifest: ExtensionManifest, source: string) => string) => {
    const target = join(directory, name); cpSync(example, target, { recursive: true });
    const manifest: ExtensionManifest = JSON.parse(readFileSync(join(target, "workbench-extension.json"), "utf8"));
    if (mutate) { const source = mutate(manifest, readFileSync(join(target, "index.server.ts"), "utf8")); writeFileSync(join(target, "index.server.ts"), source); }
    writeFileSync(join(target, "workbench-extension.json"), JSON.stringify(manifest)); return target;
  };
  return { directory, manager, work, workspace, sibling, service, packageAt };
}
function call(record: ExtensionRecord, workspaceId: string, contributionId = "echo", input: unknown = { text: "hello" }): ExtensionCall {
  return { extensionId: record.manifest.id, artifactHash: record.artifactHash, grantGeneration: record.grant.generation,
    capability: "tool", workspaceId, contributionId, input };
}
async function activate(service: ExtensionService, record: ExtensionRecord, workspaceId: string) {
  return service.activate(record.manifest.id, { expectedHash: record.artifactHash, expectedGeneration: record.grant.generation,
    capabilities: record.manifest.capabilities, workspaceIds: [workspaceId], permissions: record.manifest.permissions });
}
async function until(predicate: () => boolean, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > end) throw Error("Owned extension did not reach the expected state"); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test("installs disabled and runs original Paseo RPC/provider inside QuickJS with scoped declarative screens", async () => {
  const f = fixture(), service = f.service(); await service.start();
  const packagePath = f.packageAt("package");
  writeFileSync(join(packagePath, "screens/notebook.html"), readFileSync(join(packagePath, "screens/notebook.html"), "utf8") + '<script>fetch("https://evil.invalid")</script><img src="https://evil.invalid"><input onclick="alert(1)">');
  const installed = await service.install({ directory: packagePath });
  expect(installed.status).toBe("disabled"); expect(installed.grant.workspaceIds).toEqual([]);
  expect(installed.artifactHash).toMatch(/^[a-f0-9]{64}$/); expect(installed.manifest.license).toBe("Apache-2.0");
  await expect(service.run(call(installed, f.workspace.id))).rejects.toMatchObject({ code: "extension_grant_denied" });
  const enabled = await activate(service, installed, f.workspace.id);
  expect((await service.run(call(enabled, f.workspace.id))).output).toEqual({ text: "hello" });
  writeFileSync(join(f.workspace.cwd, "note.txt"), "actual workspace bytes");
  expect((await service.run(call(enabled, f.workspace.id, "read-text", { path: "note.txt" }))).output).toBe("actual workspace bytes");
  // Project membership alone cannot authorize a different worktree/workspace.
  await expect(service.run(call(enabled, f.sibling.id))).rejects.toMatchObject({ code: "extension_grant_denied" });
  const providerCall: ExtensionCall = { ...call(enabled, f.workspace.id, "example-echo"), capability: "provider", input: { operation: "catalog" } };
  expect((await service.run(providerCall)).output).toMatchObject({ models: [{ id: "local-echo" }], modes: [] });
  const connection = await service.providerConnection(providerCall), events: unknown[] = [];
  const off = connection.onEvent(event => events.push(event));
  await connection.send({ type: "session.open", requestId: "open", sessionId: "bounded-session", history: "skip", config: { cwd: f.workspace.cwd, env: {}, mcpServers: {}, settings: {}, persist: false } });
  await connection.send({ type: "session.prompt", sessionId: "bounded-session", prompt: { clientMessageId: "prompt", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "local example" }] } } });
  await until(() => events.some(event => !!event && typeof event === "object" && "type" in event && event.type === "session.prompt_result"));
  off(); await connection.close();
  const screen = service.screen({ ...call(enabled, f.workspace.id, "notebook"), capability: "screen" });
  expect(screen.html).toContain("Content-Security-Policy"); expect(screen.html).not.toContain("evil.invalid"); expect(screen.html).not.toContain("onclick");
  expect((await service.screenCall({ nonce: screen.nonce, call: call(enabled, f.workspace.id, "echo", { text: "screen" }) })).output).toEqual({ text: "screen" });
  await expect(service.screenCall({ nonce: "copied-invalid", call: call(enabled, f.workspace.id) })).rejects.toMatchObject({ code: "extension_screen_ticket" });
  if (process.platform !== "win32") expect(statSync(join(f.directory, "extensions", "registry.json")).mode & 0o777).toBe(0o600);
}, 20000);

test("actual VM cannot reach Node, outside files or undeclared network and revoke cancels owned pending work", async () => {
  const f = fixture(), service = f.service();
  const packagePath = f.packageAt("adversarial", (manifest, source) => {
    manifest.permissions.files.push("write");
    manifest.tools.push({ id: "probe", title: "Probe", method: "probe" });
    return source.replace("export default function contribute(server) {", `export default function contribute(server) {
      server.handle(defineRpc({name:'probe',input:z.object({action:z.string()}),output:z.unknown()}),async (input,context)=>{
        if(input.action==='realm') return {process:typeof process,require:typeof require,fetch:typeof fetch,escape:(0,eval)('typeof process')};
        if(input.action==='network') return context.paseo.workbench.fetch('https://127.0.0.1/private');
        if(input.action==='wait') { await context.paseo.workbench.writeText('started.txt','started'); await context.paseo.workbench.delay(5000); return 'late'; }
      });`);
  });
  const enabled = await activate(service, await service.install({ directory: packagePath }), f.workspace.id);
  expect((await service.run(call(enabled, f.workspace.id, "probe", { action: "realm" }))).output).toEqual({ process: "undefined", require: "function", fetch: "undefined", escape: "undefined" });
  writeFileSync(join(f.directory, "outside.txt"), "must stay private");
  await expect(service.run(call(enabled, f.workspace.id, "read-text", { path: "../../outside.txt" }))).rejects.toThrow("상대 파일 경로");
  if (process.platform !== "win32") {
    symlinkSync(join(f.directory, "outside.txt"), join(f.workspace.cwd, "link.txt"));
    await expect(service.run(call(enabled, f.workspace.id, "read-text", { path: "link.txt" }))).rejects.toThrow("심볼릭 링크");
  }
  await expect(service.run(call(enabled, f.workspace.id, "probe", { action: "network" }))).rejects.toThrow("승인하지 않은 네트워크");
  const pending = service.run(call(enabled, f.workspace.id, "probe", { action: "wait" }));
  const rejected = expect(pending).rejects.toThrow();
  await until(() => existsSync(join(f.workspace.cwd, "started.txt")));
  const disabled = await service.disable(enabled.manifest.id, enabled.grant.generation); await rejected;
  expect(disabled.grant.generation).toBeGreaterThan(enabled.grant.generation);
  expect(service.state().runs.some(run => run.contributionId === "probe" && run.status === "cancelled")).toBe(true);
  await expect(service.run(call(enabled, f.workspace.id))).rejects.toMatchObject({ code: "extension_grant_denied" });
  await service.close(); const reopened = f.service(); await reopened.start();
  expect(reopened.state().extensions[0]?.status).toBe("disabled");
  expect(readFileSync(join(f.directory, "outside.txt"), "utf8")).toBe("must stay private");
}, 20000);

test("rejects build/import/hash/version attacks and rolls failed updates back without reusing old grant generations", async () => {
  const f = fixture(), service = f.service();
  const source = f.packageAt("stable"), installed = await service.install({ directory: source });
  const enabled = await activate(service, installed, f.workspace.id);
  const badUpdate = f.packageAt("bad-update", (manifest, source) => { manifest.version = "1.1.0"; return source.replace("export default function contribute(server) {", "export default function contribute(server) { throw new Error('startup refused');"); });
  await expect(service.update(enabled.manifest.id, { directory: badUpdate })).rejects.toThrow("startup refused");
  const retained = service.state().extensions[0]!;
  expect(retained.artifactHash).toBe(enabled.artifactHash); expect(retained.status).toBe("enabled");
  expect(retained.grant.permissions).toEqual(enabled.grant.permissions); expect(retained.grant.generation).toBeGreaterThan(enabled.grant.generation);
  await expect(service.run(call(enabled, f.workspace.id))).rejects.toMatchObject({ code: "extension_grant_denied" });
  expect((await service.run(call(retained, f.workspace.id))).output).toEqual({ text: "hello" });
  const newSource = f.packageAt("good-update", (manifest, source) => { manifest.version = "1.2.0"; return source; });
  const updated = await service.update(enabled.manifest.id, { directory: newSource });
  expect(updated.previous?.artifactHash).toBe(enabled.artifactHash);
  const rolled = await service.rollback(updated.manifest.id, updated.grant.generation);
  expect(rolled.artifactHash).toBe(enabled.artifactHash); expect(rolled.status).toBe("disabled"); expect(rolled.grant.capabilities).toEqual([]);
  const hostileImport = f.packageAt("bad-import", (_manifest, source) => "import fs from 'node:fs';\n" + source);
  await expect(service.update(enabled.manifest.id, { directory: hostileImport })).rejects.toThrow("허용하지 않은 import");
  const build = f.packageAt("bad-build"); writeFileSync(join(build, "paseo-plugin.json"), JSON.stringify({ id: "workbench-notebook", build: [["sh", "-c", "touch forbidden"]] }));
  await expect(service.update(enabled.manifest.id, { directory: build })).rejects.toThrow("build 명령"); expect(existsSync(join(build, "forbidden"))).toBe(false);
  await expect(service.update(enabled.manifest.id, { directory: newSource, expectedHash: "0".repeat(64) })).rejects.toMatchObject({ code: "extension_hash_mismatch" });
  const version = f.packageAt("unsupported", manifest => { manifest.apiVersion = 2 as never; return readFileSync(join(source, "index.server.ts"), "utf8"); });
  await expect(service.update(enabled.manifest.id, { directory: version })).rejects.toThrow("지원하는 확장 API");
}, 25000);
