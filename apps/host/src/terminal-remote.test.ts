import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createPortServer } from "node:net";
import { afterEach, expect, test } from "vitest";
import { defaultWebSocketFactory } from "@getpaseo/client/internal/daemon-client-websocket-transport";
import { TerminalStreamController } from "@workbench/paseo-terminal/controller";
import type { DeviceApproval, PairingCredentialResult, PairingRequestTicket, TerminalSession } from "@workbench/contracts";
import { RemotePeer, parseRemoteOffer } from "../../../packages/client/src/remote.ts";
import { WorkbenchTerminalClient, type TerminalApi } from "../../../packages/client/src/terminal.ts";
import { DeviceService } from "./devices/service.ts";
import { Store } from "./store.ts";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { Terminals } from "./terminals.ts";
import { createHttpServer } from "./http.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function until(predicate: () => boolean, label: string, milliseconds = 6000) {
  const deadline = Date.now() + milliseconds;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error(label); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function freePort() {
  const socket = createPortServer(); await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address(); if (!address || typeof address === "string") throw new Error("No loopback port");
  await new Promise<void>(resolve => socket.close(() => resolve())); return address.port;
}

/** A temporary worker speaks the existing Rust worker's protocol. It is deliberately not a PTY test. */
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "workbench-terminal-remote-")), worker = join(directory, "fixture-worker.mjs");
  writeFileSync(worker, `#!${process.execPath}\nimport readline from 'node:readline';\nimport http from 'node:http';\nconst emit = x => process.stdout.write(JSON.stringify(x)+'\\n');\nconst output = x => emit({type:'data',data:Buffer.from(x).toString('base64')});\nlet initialized=false, server;\nreadline.createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);if(!initialized){initialized=true;emit({type:'ready',pid:process.pid});output('한글 시작 😀\\r\\n');if(message.env?.PORT){server=http.createServer((req,res)=>{const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{output('HTTP '+req.url+'\\r\\n');const reply=()=>{res.setHeader('content-type','application/json');res.setHeader('set-cookie','must-not-escape=1');res.end(JSON.stringify({path:req.url,headers:req.headers,body:Buffer.concat(chunks).toString('utf8')}));};if(req.url==='/slow')setTimeout(reply,2000);else reply();});});server.listen(Number(message.env.PORT),'127.0.0.1',()=>output('LISTENING\\r\\n'));}return;}if(message.type==='input')output('INPUT:'+Buffer.from(message.data,'base64').toString('utf8')+'\\r\\n');else if(message.type==='resize')emit({type:'resized',cols:message.cols,rows:message.rows});else if(message.type==='close'){emit({type:'exit',code:0});server?.closeAllConnections();server?.close();process.exit(0);}});\nprocess.stdin.on('end',()=>process.exit(0));\n`, { mode: 0o700 });
  const store = new Store(join(directory, "state.sqlite")), bus = new EventBus();
  const manager = new SessionManager(store, bus, { hostId: "terminal-test-host", hostLabel: "터미널 검사", dataDir: directory, managedWorksDir: join(directory, "works"), ptyBinary: worker });
  cleanup.push(async () => { await manager.shutdown(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const work = manager.createWork({ title: "허용된 터미널", cwd: directory });
  return { directory, store, bus, manager, work };
}

test("Paseo replays and searches every retained page without restarting a historical terminal", async () => {
  const { store, manager, work } = fixture();
  const id = "retained-history", now = Date.now();
  const session: TerminalSession = { id, workspaceId: work.defaultWorkspaceId!, workId: work.id, hostId: "terminal-test-host", cwd: work.cwd,
    label: "기록", shell: null, args: [], status: "exited", pid: null, exitCode: 0, error: null, cols: 80, rows: 24, outputStart: 0, outputEnd: 0, createdAt: now, updatedAt: now };
  for (let index = 0; index < 25; index++) {
    const bytes = Buffer.from(`\x1b[32m${index === 24 ? "마지막 한글 😀" : "앞선 줄 " + index}\x1b[0m\r\n`);
    store.appendTerminalOutput(id, session.outputEnd, bytes, 2 * 1024 * 1024); session.outputEnd += bytes.length;
  }
  store.saveTerminal(session);
  const historical = new Terminals(store, manager.workspaces, "");
  const result = historical.search(id, { query: "마지막 한글" });
  expect(result.matches).toEqual([{ line: 25, text: "마지막 한글 😀", from: 0, to: 6 }]);
  expect(result.end).toBe(session.outputEnd);
  const replay = await historical.replay(id);
  expect(replay.cursor).toBe(session.outputEnd);
  expect(Buffer.from(replay.data, "base64").toString()).toContain("마지막 한글 😀");
  expect(replay.terminal.status).toBe("exited"); expect(historical.ownsRunning(id)).toBe(false);
  await historical.shutdown();
});

test("original controller follows encrypted journal output and confines service HTTP to the current device grant", async () => {
  const f = fixture(), localToken = "private-owner-" + randomUUID();
  let origin = "";
  const devices = new DeviceService({ manager: f.manager, bus: f.bus, dataDir: f.directory, localToken, localOrigin: () => origin, webDir: null });
  const server = createHttpServer(f.manager, f.bus, { token: localToken, webDir: null, devices });
  const peers: RemotePeer[] = [], sockets: Promise<void>[] = [];
  cleanup.push(async () => {
    for (const peer of peers) peer.close(); devices.close();
    await Promise.all(sockets);
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing HTTP fixture");
  origin = "http://127.0.0.1:" + address.port;
  await devices.start();
  const local = async <T>(path: string, body?: unknown, method = "POST") => {
    const response = await fetch(origin + path, { method, headers: { authorization: "Bearer " + localToken, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result)); return result as T;
  };
  await local("/api/devices/config", { enabled: true, listenHost: "127.0.0.1", port: 0 }, "PUT");
  const enroll = async (permissions: DeviceApproval["permissions"]) => {
    const offer = parseRemoteOffer((await local<{ url: string }>("/api/devices/offers")).url);
    const peer = new RemotePeer({ url: offer.workbench.endpoint, daemonPublicKeyB64: offer.daemonPublicKeyB64, serverId: offer.serverId,
      webSocketFactory: (url, options) => { const raw = defaultWebSocketFactory(url, options); sockets.push(new Promise<void>(resolve => { if (raw.addEventListener) raw.addEventListener("close", () => resolve()); else raw.on?.("close", () => resolve()); })); return raw; } });
    peers.push(peer); await peer.connect();
    const ticket = await peer.rpc<PairingRequestTicket>("pair", { offer: offer.workbench, name: "단말", platform: "loopback-test" });
    await local(`/api/devices/enrollments/${ticket.requestId}/approve`, { permissions, workIds: [f.work.id] });
    const claim = await peer.rpc<PairingCredentialResult>("claim", { requestId: ticket.requestId, claimToken: ticket.claimToken });
    if (claim.status !== "approved") throw new Error("Pairing not approved"); await peer.connect(claim.credential);
    return { peer, claim };
  };
  const writer = await enroll(["read", "terminal"]), reader = await enroll(["read"]);
  const port = await freePort(), service = await f.manager.services.start(f.work.defaultWorkspaceId!, { requestId: randomUUID(), label: "서비스 검사", command: "fixture-owned-worker", port });
  await until(() => f.manager.terminals.search(service.terminalId, { query: "LISTENING" }).matches.length > 0, "Owned service did not start");
  const call = async <T>(peer: RemotePeer, path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> => {
    const response = await peer.fetch(path, { method, signal, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json(); if (!response.ok) throw Object.assign(new Error(value.message), { status: response.status }); return value as T;
  };
  const api: TerminalApi = {
    terminalOutput: (id, cursor = 0, signal) => call(writer.peer, `/api/terminals/${id}?cursor=${cursor}`, "GET", undefined, signal),
    terminalReplay: (id, signal) => call(writer.peer, `/api/terminals/${id}/replay`, "GET", undefined, signal),
    terminalInput: (id, data) => call(writer.peer, `/api/terminals/${id}/input`, "POST", { data }),
    resizeTerminal: (id, cols, rows, owner) => call(writer.peer, `/api/terminals/${id}/resize`, "POST", { cols, rows, ...owner }),
  };
  const observed: Uint8Array[] = [], status: string[] = [];
  const transport = new WorkbenchTerminalClient(api, { pollMilliseconds: 20 });
  const controller = new TerminalStreamController({ client: transport, getPreferredSize: () => null,
    onReplay: ({ replay }) => { if (replay.type === "data") observed.push(replay.data); }, onOutput: ({ data }) => observed.push(data),
    onStatusChange: next => { if (!next.isAttaching && !next.error && next.terminalId) status.push("ready"); } });
  cleanup.push(async () => { controller.dispose(); transport.dispose(); });
  controller.setTerminal({ terminalId: service.terminalId });
  await until(() => status.includes("ready"), "Original controller did not attach");
  transport.sendTerminalInput(service.terminalId, { type: "input", data: "모바일 한글 👩‍💻" });
  await until(() => Buffer.concat(observed.map(bytes => Buffer.from(bytes))).toString().includes("INPUT:모바일 한글 👩‍💻"), "Unicode input did not return through the journal");
  const first = await call<{ applied: boolean }>(writer.peer, `/api/terminals/${service.terminalId}/resize`, "POST", { ownerId: "first-pane", intent: "claim", rows: 40, cols: 120 }); expect(first.applied).toBe(true);
  const other = await call<{ applied: boolean }>(writer.peer, `/api/terminals/${service.terminalId}/resize`, "POST", { ownerId: "background-pane", intent: "update", rows: 20, cols: 40 }); expect(other.applied).toBe(false);
  const logs = await call<{ matches: unknown[] }>(reader.peer, `/api/services/${service.id}/logs?q=${encodeURIComponent("모바일 한글")}`); expect(logs.matches).toHaveLength(1);
  const response = await writer.peer.fetch(`/api/services/${service.id}/proxy?path=${encodeURIComponent("/echo?q=한글")}`, { method: "POST", headers: { authorization: "Bearer " + localToken, cookie: "secret=1", "content-type": "application/json" }, body: '{"test":"원문"}' });
  expect(response.status).toBe(200); expect(response.headers.get("set-cookie")).toBeNull();
  const echoed = await response.json() as { path: string; body: string; headers: Record<string, string> };
  expect(echoed.body).toBe('{"test":"원문"}'); expect(echoed.headers.authorization).toBeUndefined(); expect(echoed.headers.cookie).toBeUndefined();
  expect((await reader.peer.fetch(`/api/services/${service.id}/proxy?path=/`)).status).toBe(403);
  expect((await writer.peer.fetch(`/api/services/${service.id}/proxy?path=${encodeURIComponent("http://example.com/")}`)).status).toBe(400);
  const foreign = f.manager.createWork({ title: "다른 프로젝트" });
  const foreignService = await f.manager.services.start(foreign.defaultWorkspaceId!, { requestId: randomUUID(), label: "범위 밖", command: "fixture-owned-worker" });
  expect((await writer.peer.fetch(`/api/services/${foreignService.id}/logs?q=private`)).status).toBe(403);
  controller.dispose(); transport.dispose(); expect(f.manager.terminals.ownsRunning(service.terminalId)).toBe(true);
  const pending = writer.peer.fetch(`/api/services/${service.id}/proxy?path=/slow`).then(response => response.text());
  const rejected = pending.then(() => false, () => true);
  await until(() => f.manager.services.search(service.id, { query: "HTTP /slow" }).matches.length > 0, "Proxy did not reach the owned service");
  devices.registry.update(writer.claim.grant.deviceId, { permissions: ["read", "terminal"], workIds: [] });
  expect(await rejected).toBe(true);
  expect((await reader.peer.fetch(`/api/terminals/${service.terminalId}/replay`)).status).toBe(200);
  expect(f.manager.terminals.ownsRunning(service.terminalId)).toBe(true);
}, 20_000);
