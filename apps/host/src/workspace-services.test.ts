import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { afterEach, expect, it } from "vitest";
import { Store } from "./store.ts";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { WorkspaceServices } from "./workspace-services.ts";

const binary = process.env.PTY_TEST_BINARY ?? "";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wb-services-"));
  const store = new Store(join(dir, "state.sqlite"));
  const manager = new SessionManager(store, new EventBus(), { hostId: "here", hostLabel: "여기", managedWorksDir: dir, dataDir: dir, ptyBinary: binary });
  cleanup.push(async () => { await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const work = manager.createWork({ title: "서버", cwd: dir });
  return { store, manager, dir, work, services: manager.services, workspaceId: work.defaultWorkspaceId! };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw Error("service did not start"); await new Promise(resolve => setTimeout(resolve, 20)); }
}
it.skipIf(!binary || !existsSync(binary))("owns one PTY per request and rejects stale stop identity while retaining output", async () => {
  const { manager, services, workspaceId, dir, store, work } = fixture();
  const request = { requestId: randomUUID(), label: "개발 서버", command: `"${process.execPath}" -e "console.log('한글 서비스');setInterval(()=>{},1000)"` };
  const [one, same] = await Promise.all([services.start(workspaceId, request), services.start(workspaceId, request)]);
  expect(same.ownerId).toBe(one.ownerId);
  expect(manager.terminals.list(workspaceId).terminals).toHaveLength(1);
  expect(one.cwd).toBe(dir);
  await until(() => services.get(one.id).status === "running" && manager.terminals.get(one.terminalId).outputEnd > 0);
  await expect(services.stop(one.id, { ...one, ownerId: "stale" })).rejects.toMatchObject({ code: "service_owner" });
  expect(services.get(one.id).status).toBe("running");
  await expect(services.start(workspaceId, { ...request, command: "different" })).rejects.toMatchObject({ code: "service_request_reused" });
  await services.stop(one.id, one);
  expect(services.get(one.id).status).toBe("exited");
  expect(Buffer.from(manager.terminals.output(one.terminalId).data, "base64").toString()).toContain("한글 서비스");
  const reloaded = new WorkspaceServices(store, manager.workspaces, manager.terminals, () => work);
  expect((await reloaded.start(workspaceId, request)).status).toBe("exited");
  reloaded.forget(one.id);
  expect(manager.terminals.has(one.terminalId)).toBe(true);
});
it("refuses an occupied port without adopting the server listening there", async () => {
  const { services, workspaceId, manager } = fixture();
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("missing server address");
  await expect(services.start(workspaceId, { requestId: randomUUID(), label: "충돌", command: "not-executed", port: address.port })).rejects.toMatchObject({ code: "service_port_busy" });
  expect(server.listening).toBe(true);
  expect(manager.terminals.list(workspaceId).terminals).toHaveLength(0);
});
it("rejects invalid input and archived workspaces before launching", async () => {
  const { services, workspaceId, manager } = fixture();
  const request = { requestId: randomUUID(), label: "서버", command: "not-executed" };
  expect(() => services.start(workspaceId, { ...request, port: -1 })).toThrow("포트");
  manager.updateWorkspace(workspaceId, { archived: true });
  await expect(services.start(workspaceId, request)).rejects.toMatchObject({ code: "workspace_archived" });
});
