import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { EventBus } from "./bus.ts";
import { Store } from "./store.ts";
import { SessionManager } from "./sessions.ts";
import { Terminals } from "./terminals.ts";

const binary = process.env.PTY_TEST_BINARY || fileURLToPath(new URL("../../desktop/src-tauri/target/debug/achmage-workbench", import.meta.url));
const real = process.platform !== "win32" && existsSync(binary);
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture(worker = binary) {
  const dir = mkdtempSync(join(tmpdir(), "wb-pty-"));
  const store = new Store(join(dir, "state.sqlite"));
  const manager = new SessionManager(store, new EventBus(), { hostId: "local", hostLabel: "here", managedWorksDir: dir, dataDir: dir, ptyBinary: worker });
  cleanup.push(async () => { await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const work = manager.createWork({ title: "터미널", cwd: dir });
  return { dir, store, manager, work, api: manager.terminals, workspaceId: work.defaultWorkspaceId! };
}
async function until(check: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() >= end) throw new Error("Timed out"); await new Promise((resolve) => setTimeout(resolve, 20)); }
}
const output = (api: Terminals, id: string) => {
  let at = 0; const parts: Buffer[] = [];
  for (;;) { const chunk = api.output(id, at); parts.push(Buffer.from(chunk.data, "base64")); if (chunk.end >= chunk.terminal.outputEnd) return Buffer.concat(parts).toString("utf8").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, ""); at = chunk.end; }
};

it("does not spawn without the native worker or in an archived workspace", () => {
  const { manager, api, workspaceId } = fixture("/missing/native/worker");
  expect(api.list(workspaceId).available).toBe(false);
  expect(() => api.create(workspaceId, { requestId: randomUUID() })).toThrow("Rust 터미널");
  manager.updateWorkspace(workspaceId, { archived: true });
  expect(() => api.create(workspaceId, { requestId: randomUUID() })).toThrow("보관되거나 제거");
});

it.skipIf(!real)("uses a real PTY for input, UTF8, cwd, resize and Ctrl-C; protects aliases until actual exit", async () => {
  const { api, workspaceId, manager, dir } = fixture();
  const request = { requestId: randomUUID(), shell: "/bin/sh", args: ["-i"] };
  const terminal = api.create(workspaceId, request);
  expect(api.create(workspaceId, request).id).toBe(terminal.id);
  await until(() => api.get(terminal.id).status === "running");
  expect(api.get(terminal.id).pid).toBeGreaterThan(1);
  api.input(terminal.id, "test -t 0 && printf 'PTY_OK\\n'; pwd; printf '한글 출력\\n'\r");
  await until(() => output(api, terminal.id).includes("\nPTY_OK\n"));
  expect(output(api, terminal.id)).toContain(`\n${dir}\n한글 출력\n`);
  api.resize(terminal.id, 86, 25);
  await until(() => api.get(terminal.id).cols === 86);
  api.input(terminal.id, "stty size\r");
  await until(() => output(api, terminal.id).includes("\n25 86\n"));
  const alias = manager.createWork({ title: "같은 경로", cwd: dir });
  expect(() => manager.updateWorkspace(alias.defaultWorkspaceId!, { archived: true })).toThrow("터미널");
  api.input(terminal.id, "sleep 60\r");
  await new Promise((resolve) => setTimeout(resolve, 100));
  api.input(terminal.id, "\x03"); api.input(terminal.id, "printf 'AFTER_INTERRUPT\\n'\r");
  await until(() => output(api, terminal.id).includes("\nAFTER_INTERRUPT\n"));
  api.input(terminal.id, "exit 7\r");
  await until(() => api.get(terminal.id).status === "exited" && !api.busy(dir));
  expect(api.get(terminal.id).exitCode).toBe(7);
  expect(() => manager.updateWorkspace(alias.defaultWorkspaceId!, { archived: true })).not.toThrow();
  expect(() => api.input(terminal.id, "echo wrong\r")).toThrow("실행 중");
  expect(api.create(workspaceId, request).status).toBe("exited");
});

it.skipIf(!real)("bounds retained raw output and restores it without launching a shell", async () => {
  const { api, workspaceId, store, manager } = fixture();
  const terminal = api.create(workspaceId, { requestId: randomUUID(), shell: process.execPath, args: ["-e", "process.stdout.write('한'.repeat(1100000) + '\\nEND_OF_OUTPUT\\n')"] });
  await until(() => api.get(terminal.id).status === "exited", 15_000);
  const result = api.output(terminal.id);
  expect(result.truncated).toBe(true); expect(result.start).toBeGreaterThan(0);
  expect(result.terminal.outputEnd - result.terminal.outputStart).toBeLessThanOrEqual(2 * 1024 * 1024 + 16384);
  expect(output(api, terminal.id)).toContain("END_OF_OUTPUT");
  const restored = new Terminals(store, manager.workspaces, binary);
  expect(restored.output(terminal.id)).toEqual(result);
  expect(restored.busy(result.terminal.cwd)).toBe(false);
});

it.skipIf(!real)("explicit close confirms owned shell exit and retains output; crashed records never regain PID ownership", async () => {
  const { api, workspaceId, store, manager } = fixture();
  const terminal = api.create(workspaceId, { requestId: randomUUID(), shell: "/bin/sh", args: ["-i"] });
  await until(() => api.get(terminal.id).status === "running");
  const pid = api.get(terminal.id).pid!;
  api.input(terminal.id, "printf 'KEEP_RECORD\\n'; sleep 60\r");
  await until(() => output(api, terminal.id).includes("\nKEEP_RECORD\n"));
  const done = await api.close(terminal.id);
  expect(done.status).toBe("exited"); expect(api.busy(done.cwd)).toBe(false);
  expect(() => process.kill(pid, 0)).toThrow(); expect(output(api, terminal.id)).toContain("KEEP_RECORD");
  store.saveTerminal({ ...done, id: "crash-record", status: "running", pid: process.pid });
  const restored = new Terminals(store, manager.workspaces, binary);
  expect(restored.get("crash-record")).toMatchObject({ status: "interrupted", pid: null });
  await restored.close("crash-record"); expect(process.kill(process.pid, 0)).toBe(true);
});
