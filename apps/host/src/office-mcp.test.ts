import { createRequire } from "node:module";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { OfficeMcp } from "./office-mcp.mjs";
import { OfficeControl } from "./office-control.mjs";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";

const require = createRequire(new URL("../../../vendor/ieumoffice/package.json", import.meta.url));
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
// This test restarts the same TCP endpoint immediately. Do not reuse a pooled
// keep-alive socket that the original server correctly destroyed during stop().
const transport = (port: number) => new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { connection: "close" } } });
type Internals = OfficeMcp & { id(view: { viewId: string }): number; command(id: number | string, request: unknown): Promise<any>; save(id: number | string, path: string, overwrite: boolean): Promise<any>; tools(): { name: string; handler(input: unknown): Promise<any> }[] };
async function unusedPort() {
  const socket = createServer(); await new Promise<void>(done => socket.listen(0, "127.0.0.1", done));
  const port = (socket.address() as { port: number }).port; await new Promise<void>(done => socket.close(() => done())); return port;
}
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wb-mcp-")), store = new Store(join(dir, "state.sqlite")), bus = new EventBus();
  const manager = new SessionManager(store, bus, { hostId: "test", hostLabel: "test", dataDir: dir, managedWorksDir: join(dir, "works"), kordoc: null });
  const control = new OfficeControl(manager, bus, dir), mcp = new OfficeMcp(manager, control, dir) as Internals;
  return { dir, store, bus, manager, control, mcp, async close() { control.close(); await mcp.close(); await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
it("keeps the original MCP opt-in, persists settings, rejects web origins and separates client sessions", async () => {
  const env = setup(), clients: any[] = [], seen: string[] = [];
  const stop = env.bus.subscribe(event => {
    if (event.type !== "office.control") return;
    for (const command of env.control.list("main", true).commands) {
      if (command.kind === "open") {
        env.manager.documents.registry.open(command.artifact.id, { viewId: `view-${command.artifact.id}`, windowId: "main", claim: true });
        env.control.reply(command.id, "main", { status: "ok", result: { opened: true } });
      } else if (command.kind === "mcp") {
        seen.push(command.viewId);
        env.control.reply(command.id, "main", { status: "ok", result: { value: { owner: command.viewId } } });
      }
    }
  });
  const call = async (client: any, name: string, args = {}) => client.callTool({ name, arguments: args });
  try {
    expect(await env.mcp.invoke("home:get-mcp-status")).toMatchObject({ enabled: false, running: false });
    const port = await unusedPort();
    await env.mcp.invoke("home:set-mcp-settings", [{ port, enabled: true }]);
    expect(JSON.parse(readFileSync(join(env.dir, "office/mcp-settings.json"), "utf8"))).toMatchObject({ port, enabled: true, logging: false });
    const refused = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { origin: "https://other.invalid", "content-type": "application/json" }, body: "{}" });
    expect(refused.status).toBe(403);
    for (let i = 0; i < 2; i++) { const client = new Client({ name: `unit-${i}`, version: "1" }); clients.push(client); await client.connect(transport(port)); }
    expect((await clients[0].listTools()).tools.map((tool: any) => tool.name)).not.toContain("create_docx");
    await call(clients[0], "create_session", { family: "docx" });
    expect((await call(clients[1], "read_document")).isError).toBe(true);
    await call(clients[1], "create_session", { family: "docx" });
    const a = await call(clients[0], "read_document"), b = await call(clients[1], "read_document");
    expect(a.isError).not.toBe(true); expect(b.isError).not.toBe(true);
    expect(a.content[0].text).not.toBe(b.content[0].text);
    await expect(env.mcp.invoke("home:set-mcp-settings", [{ port: -1 }])).rejects.toThrow();
    expect(await env.mcp.invoke("home:get-mcp-status")).toMatchObject({ running: true, port });
    await env.mcp.invoke("home:set-mcp-settings", [{ background: true }]);
    const next = new Client({ name: "background", version: "1" }); clients.push(next); await next.connect(transport(port));
    expect((await next.listTools()).tools.map((tool: any) => tool.name)).toContain("create_docx");
    await env.mcp.invoke("home:set-mcp-settings", [{ enabled: false }]);
    expect(await env.mcp.invoke("home:get-mcp-status")).toMatchObject({ running: false, enabled: false });
  } finally { for (const client of clients) await client.close().catch(() => {}); stop(); await env.close(); }
}, 30_000);

it("binds copy destinations to the existing writer and refuses both implicit replacement and changed targets", async () => {
  const env = setup(); let commands = 0, changeTarget = false;
  const work = env.manager.createWork({ title: "MCP", cwd: null });
  const artifact = await env.manager.createOfficeDocument(work.id, { format: "docx" }), original = readFileSync(artifact.path);
  const registration = env.manager.documents.registry.open(artifact.id, { viewId: "writer", windowId: "owner", claim: true });
  const target = join(work.cwd, "copy.docx"); writeFileSync(target, original);
  const stop = env.bus.subscribe(event => {
    if (event.type !== "office.control") return;
    for (const command of env.control.list("owner", false).commands) {
      if (command.kind !== "mcp" || command.request.kind !== "save" || !command.request.plan) continue;
      commands++;
      const plan = command.request.plan;
      expect(env.control.reply(command.id, "wrong-owner", { status: "ok", result: { value: {} } }).accepted).toBe(false);
      if (changeTarget) writeFileSync(target, "changed after preparation");
      void env.mcp.outputs.commit(artifact.id, plan.id, original, plan.replace, { viewId: "writer", writeToken: registration.writeToken }).then(
        result => env.control.reply(command.id, "owner", { status: "ok", result: { value: { ok: true, path: result.path } } }),
        error => env.control.reply(command.id, "owner", { status: "error", error: { reason: "conflict", message: error.message } }),
      );
    }
  });
  try {
    await expect(env.mcp.save("writer", artifact.path, false)).rejects.toThrow("overwrite:true"); expect(commands).toBe(0);
    await expect(env.mcp.save("writer", target, false)).rejects.toThrow("overwrite:true"); expect(commands).toBe(0);
    changeTarget = true; await expect(env.mcp.save("writer", target, true)).rejects.toThrow("대상 파일이 바뀌었습니다");
    expect(readFileSync(target, "utf8")).toBe("changed after preparation"); expect(readFileSync(artifact.path)).toEqual(original);
    changeTarget = false; await expect(env.mcp.save("writer", target, true)).resolves.toMatchObject({ ok: true, path: target });
    expect(readFileSync(target)).toEqual(original); expect(readFileSync(artifact.path)).toEqual(original); expect(env.manager.documents.get(artifact.id).revision).toBe(1);
    env.manager.documents.registry.close("writer", "owner");
    await expect(env.mcp.command("writer", { kind: "read" })).rejects.toThrow("문서 탭을 닫았거나");
  } finally { stop(); await env.close(); }
});
