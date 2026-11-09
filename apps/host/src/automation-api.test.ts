import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { SubmitCommand } from "@workbench/contracts";
import { WorkbenchClient } from "../../../packages/client/src/index.ts";
import { createAutomationServer } from "../../../packages/client/src/mcp-server.ts";
import { Store } from "./store.ts";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { createHttpServer } from "./http.ts";
import { emptyStatus } from "./providers/types.ts";

test("HTTP and MCP use the same receipts, authorization and workspace checks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-api-")), store = new Store(join(dir, "state.sqlite")), bus = new EventBus();
  const manager = new SessionManager(store, bus, { hostId: "host", hostLabel: "시험", dataDir: dir, managedWorksDir: join(dir, "works") });
  let started = 0;
  manager.registerAdapter({ provider: "codex", init: async () => {}, status: () => emptyStatus("codex"), refreshStatus: async () => emptyStatus("codex"), login: async () => ({ url: null, message: "" }),
    send: async session => { started++; manager.sink.updateSession(session.id, { status: "running" }); }, interrupt: async () => {}, answerApproval: async () => false, shutdown: async () => {} });
  const server = createHttpServer(manager, bus, { token: "fixture-only", webDir: null });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); if (!address || typeof address === "string") throw Error("No address");
  const baseUrl = `http://127.0.0.1:${address.port}`, client = new WorkbenchClient({ baseUrl, token: "fixture-only" });
  const mcp = createAutomationServer(client), remote = new Client({ name: "fixture", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await mcp.connect(a); await remote.connect(b);
    const work = manager.createWork({ title: "automation" }), session = manager.createSession(work.id, { provider: "codex" });
    const command: SubmitCommand = { commandId: "same-command", hostId: "host", workspaceId: session.workspaceId!, sessionId: session.id, text: "한 번만 시작" };
    const first = await client.submit(command);
    const repeated = await remote.callTool({ name: "workbench_submit", arguments: command });
    expect(first.status).toBe("completed"); expect(JSON.stringify(repeated)).toContain("same-command"); expect(started).toBe(1);
    await expect(client.submit({ ...command, text: "다른 요청" })).rejects.toMatchObject({ status: 409 });
    const denied = await remote.callTool({ name: "workbench_submit", arguments: { ...command, commandId: "wrong-workspace", workspaceId: "other" } });
    expect(denied.isError).toBe(true); expect(started).toBe(1);
    await expect(new WorkbenchClient({ baseUrl, token: "wrong" }).tasks()).rejects.toMatchObject({ status: 401 });
  } finally {
    await remote.close(); await mcp.close(); await new Promise<void>(done => server.close(() => done()));
    await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true });
  }
});
