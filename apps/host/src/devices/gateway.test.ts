import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { defaultWebSocketFactory } from "@getpaseo/client/internal/daemon-client-websocket-transport";
import type {
  DeviceApproval, DeviceGrant, EventCursor, PairingCredentialResult, PairingRequestTicket,
  RemoteOffer, SequencedEvent, Snapshot, TranscriptItem,
} from "@workbench/contracts";
import { RemotePeer, parseRemoteOffer, type RemotePeerStatus } from "../../../../packages/client/src/remote.ts";
import type { WebSocketFactory } from "../../../../packages/client/src/remote-transport.ts";
import { Store } from "../store.ts";
import { EventBus } from "../bus.ts";
import { SessionManager } from "../sessions.ts";
import { createHttpServer } from "../http.ts";
import { DeviceService } from "./service.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  const results = await Promise.allSettled(cleanup.splice(0).reverse().map(close => close()));
  const failed = results.find(result => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
});

async function until(predicate: () => boolean, message: string, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw Error(message);
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
}
async function bounded<T>(promise: Promise<T>, message: string, timeout = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error(message)), timeout);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Uses the real SessionManager + SQLite fixture from automation-api.test.ts.
 * Only loopback ports are opened. There is no provider or external service call.
 */
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "workbench-device-gateway-"));
  const store = new Store(join(directory, "state.sqlite"));
  const bus = new EventBus(8);
  const manager = new SessionManager(store, bus, {
    hostId: "loopback-host", hostLabel: "연결 검사 호스트",
    dataDir: directory, managedWorksDir: join(directory, "works"),
  });
  const ownerToken = "test-local-owner-" + randomUUID();
  let origin: string | null = null;
  const devices = new DeviceService({ dataDir: directory, manager, bus, localToken: ownerToken, localOrigin: () => origin, webDir: null });
  const server = createHttpServer(manager, bus, { token: ownerToken, webDir: null, devices });
  const clients: ReturnType<typeof openPeer>[] = [];

  cleanup.push(async () => {
    for (const client of clients) client.peer.close();
    devices.close();
    try {
      await bounded(Promise.all(clients.flatMap(client => client.sockets.map(socket => socket.closed))), "Owned WebSockets did not close");
    } finally {
      try {
        await new Promise<void>((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve());
          server.closeAllConnections();
        });
      } finally {
        try { await manager.shutdown(); }
        finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing test listener");
  origin = "http://127.0.0.1:" + address.port;
  await devices.start();

  const local = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const headers = new Headers(init.headers);
    headers.set("authorization", "Bearer " + ownerToken);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    const response = await fetch(origin + path, { ...init, headers });
    const value: unknown = await response.json();
    if (!response.ok) throw Error("Local fixture request failed " + response.status + " " + JSON.stringify(value));
    return value as T;
  };
  await local("/api/devices/config", { method: "PUT", body: JSON.stringify({ enabled: true, listenHost: "127.0.0.1", port: 0 }) });
  const ownWork = manager.createWork({ title: "허용 프로젝트" });
  const foreignWork = manager.createWork({ title: "다른 기기의 비공개 프로젝트" });
  const ownSession = manager.createSession(ownWork.id, { provider: "codex" });
  const foreignSession = manager.createSession(foreignWork.id, { provider: "codex" });
  manager.sink.upsertItem(ownSession.id, { kind: "assistant", id: "own-item", text: "허용된 원문", streaming: false, at: Date.now() });
  manager.sink.upsertItem(foreignSession.id, { kind: "assistant", id: "foreign-item", text: "다른 기기만 볼 원문", streaming: false, at: Date.now() });

  async function offer() {
    const value = await local<{ url: string }>("/api/devices/offers", { method: "POST" });
    // Exercise the exact QR/link payload emitted by the host, not a hand-built offer.
    return parseRemoteOffer(value.url);
  }
  function peer(offer: RemoteOffer) {
    const client = openPeer(offer);
    clients.push(client);
    return client;
  }
  async function approve(requestId: string, approval: DeviceApproval) {
    return local<DeviceGrant>("/api/devices/enrollments/" + requestId + "/approve", {
      method: "POST", body: JSON.stringify(approval),
    });
  }
  async function enroll(workId: string, permissions: DeviceApproval["permissions"] = ["read"]) {
    const nextOffer = await offer(), client = peer(nextOffer);
    await client.peer.connect();
    const ticket = await client.peer.rpc<PairingRequestTicket>("pair", { offer: nextOffer.workbench, name: "검사 기기", platform: "test-loopback" });
    await approve(ticket.requestId, { permissions, workIds: [workId] });
    const claim = await client.peer.rpc<PairingCredentialResult>("claim", { requestId: ticket.requestId, claimToken: ticket.claimToken });
    if (claim.status !== "approved") throw Error("Expected local approval");
    const authentication = await client.peer.connect(claim.credential);
    return { ...client, claim, authentication };
  }
  return { manager, bus, devices, local, origin, ownerToken, ownWork, foreignWork, ownSession, foreignSession, offer, peer, approve, enroll };
}

function openPeer(offer: RemoteOffer) {
  const sockets: { raw: ReturnType<WebSocketFactory>; closed: Promise<void> }[] = [];
  const wire: string[] = [], securityModes: string[] = [], statuses: RemotePeerStatus[] = [];
  const webSocketFactory: WebSocketFactory = (url, options) => {
    // Original factory and real loopback WebSocket. Only observe raw frames and closure.
    const raw = defaultWebSocketFactory(url, options);
    const closed = new Promise<void>(resolve => {
      if (raw.addEventListener) raw.addEventListener("close", () => resolve());
      else if (raw.on) raw.on("close", () => resolve());
      else throw Error("Cannot observe owned WebSocket shutdown");
    });
    const send = raw.send.bind(raw);
    raw.send = data => {
      wire.push(typeof data === "string" ? data : Buffer.from(data instanceof Uint8Array ? data : new Uint8Array(data)).toString("utf8"));
      send(data);
    };
    sockets.push({ raw, closed });
    return raw;
  };
  const peer = new RemotePeer({
    url: offer.workbench.endpoint, daemonPublicKeyB64: offer.daemonPublicKeyB64,
    serverId: offer.serverId, webSocketFactory, onSecurityMode: mode => { securityModes.push(mode); },
  });
  peer.onStatus(status => statuses.push(status));
  return { peer, sockets, wire, securityModes, statuses };
}

function observe(peer: RemotePeer, cursor: EventCursor) {
  const events: SequencedEvent[] = [], statuses: boolean[] = [];
  let resyncs = 0;
  const release = peer.events(cursor, event => events.push(event), () => { resyncs++; }, connected => statuses.push(connected));
  return { events, statuses, release, resyncs: () => resyncs };
}
async function json<T>(peer: RemotePeer, path: string): Promise<T> {
  const response = await peer.fetch(path);
  expect(response.status).toBe(200);
  return await response.json() as T;
}

test("scoped remote attachments preserve bytes and stop access when a project grant is narrowed", async () => {
  const f = await fixture(), client = await f.enroll(f.ownWork.id, ["read", "send"]);
  const peer = client.peer;
  const ownImage = f.manager.attachments.save(Buffer.from("own-image-bytes"), "picture.png", "application/octet-stream");
  const foreignImage = f.manager.attachments.save(Buffer.from("private-image-bytes"), "private.png", "application/octet-stream");
  f.manager.sink.upsertItem(f.ownSession.id, { kind: "assistant", id: "own-image", text: "그림", media: [{ source: "picture.png", attachment: ownImage }], streaming: false, at: Date.now() });
  f.manager.sink.upsertItem(f.foreignSession.id, { kind: "assistant", id: "private-image", text: "비공개 그림", media: [{ source: "private.png", attachment: foreignImage }], streaming: false, at: Date.now() });
  const allowed = await peer.fetch("/api/attachments/" + ownImage.id);
  expect(allowed.status).toBe(200);
  expect(await allowed.text()).toBe("own-image-bytes");
  const hidden = await peer.fetch("/api/attachments/" + foreignImage.id);
  expect(hidden.status).toBe(403); await hidden.arrayBuffer();

  // JSON files are bytes, not RPC envelopes. Upload identity belongs to the
  // originating Composer's workId, even before the file enters a transcript.
  const content = '{"message":"첨부 원문"}';
  const upload = await peer.fetch("/api/attachments", { method: "POST", body: content,
    headers: { "content-type": "application/json", "x-file-name": "document.json", "x-workbench-work": f.ownWork.id } });
  expect(upload.status).toBe(201);
  const attachment = await upload.json() as import("@workbench/contracts").Attachment;
  const downloaded = await peer.fetch("/api/attachments/" + attachment.id);
  expect(downloaded.status).toBe(200); expect(await downloaded.text()).toBe(content);
  const crossWork = await peer.fetch("/api/attachments", { method: "POST", body: "wrong project",
    headers: { "content-type": "text/plain", "x-file-name": "wrong.txt", "x-workbench-work": f.foreignWork.id } });
  expect(crossWork.status).toBe(403); await crossWork.arrayBuffer();
  const injection = await peer.fetch("/api/sessions/" + f.ownSession.id + "/messages", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId: "foreign-media", text: "첨부 보기", attachments: [foreignImage] }) });
  expect(injection.status).toBe(403); await injection.arrayBuffer();
  expect(f.manager.items(f.ownSession.id).items.some(item => item.id === "foreign-media")).toBe(false);
  const presence = await peer.fetch("/api/attention/presence", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: "local-owner", sessionId: f.ownSession.id, visible: true }) });
  expect(presence.status).toBe(200); await presence.arrayBuffer();

  const socket = client.sockets.at(-1)!;
  f.devices.registry.update(client.claim.grant.deviceId, { permissions: ["read"], workIds: [] });
  await bounded(socket.closed, "Narrowed grant did not close its existing streams");
  await peer.connect(client.claim.credential);
  const snapshot = await json<Snapshot>(peer, "/api/snapshot");
  expect(snapshot.works).toEqual([]);
  const removed = await peer.fetch("/api/attachments/" + attachment.id);
  expect(removed.status).toBe(403); await removed.arrayBuffer();
}, 20_000);

test("two protected loopback peers pair through local approval and keep scoped authority independent after revocation", async () => {
  const f = await fixture();
  const firstOffer = await f.offer(), first = f.peer(firstOffer), second = f.peer(firstOffer);
  await Promise.all([first.peer.connect(), second.peer.connect()]);
  const ticket = await first.peer.rpc<PairingRequestTicket>("pair", { offer: firstOffer.workbench, name: "첫 기기", platform: "test-loopback" });
  expect(await first.peer.rpc("claim", { requestId: ticket.requestId, claimToken: ticket.claimToken })).toMatchObject({ status: "pending" });
  await expect(second.peer.rpc("pair", { offer: firstOffer.workbench, name: "복사한 링크", platform: "test-loopback" })).rejects.toMatchObject({ status: 409, code: "offer_used" });
  await expect(second.peer.rpc("claim", { requestId: ticket.requestId, claimToken: ticket.claimToken })).rejects.toMatchObject({ status: 401, code: "invalid_claim" });
  const untrustedManagement = await fetch(f.origin + "/api/devices");
  expect(untrustedManagement.status).toBe(401);
  await untrustedManagement.arrayBuffer();

  const approved = await f.approve(ticket.requestId, { permissions: ["read"], workIds: [f.ownWork.id] });
  expect(approved).not.toHaveProperty("credential");
  const claim = await first.peer.rpc<PairingCredentialResult>("claim", { requestId: ticket.requestId, claimToken: ticket.claimToken });
  if (claim.status !== "approved") throw Error("Expected first credential");
  const authentication = await first.peer.connect(claim.credential);
  expect(authentication.grant.deviceId).toBe(approved.deviceId);
  await expect(first.peer.rpc("claim", { requestId: ticket.requestId, claimToken: ticket.claimToken })).rejects.toMatchObject({ status: 409, code: "pairing_used" });

  const secondOffer = await f.offer();
  const otherTicket = await second.peer.rpc<PairingRequestTicket>("pair", { offer: secondOffer.workbench, name: "두 번째 기기", platform: "test-loopback" });
  await f.approve(otherTicket.requestId, { permissions: ["read"], workIds: [f.foreignWork.id] });
  const otherClaim = await second.peer.rpc<PairingCredentialResult>("claim", { requestId: otherTicket.requestId, claimToken: otherTicket.claimToken });
  if (otherClaim.status !== "approved") throw Error("Expected second credential");
  await second.peer.connect(otherClaim.credential);

  const localSnapshot = await f.local<Snapshot>("/api/snapshot");
  expect(localSnapshot.works).toHaveLength(2);
  const snapshot = await json<Snapshot>(first.peer, "/api/snapshot");
  expect(snapshot.works.map(work => work.id)).toEqual([f.ownWork.id]);
  expect(snapshot.sessions.map(session => session.id)).toEqual([f.ownSession.id]);
  expect(JSON.stringify(snapshot)).not.toContain(f.foreignWork.id);
  expect(JSON.stringify(snapshot)).not.toContain(f.ownerToken);
  const items = await json<{ items: TranscriptItem[] }>(first.peer, "/api/sessions/" + f.ownSession.id + "/items");
  expect(items.items).toContainEqual(expect.objectContaining({ id: "own-item", text: "허용된 원문" }));

  const foreign = await first.peer.fetch("/api/sessions/" + f.foreignSession.id + "/items");
  expect(foreign.status).toBe(403);
  expect(await foreign.json()).toMatchObject({ code: "work_scope_denied" });
  const send = await first.peer.fetch("/api/sessions/" + f.ownSession.id + "/messages", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId: "must-not-send", text: "권한 없는 입력" }),
  });
  expect(send.status).toBe(403);
  expect(await send.json()).toMatchObject({ code: "permission_denied" });
  expect(f.manager.items(f.ownSession.id).items.some(item => item.kind === "user" && item.text === "권한 없는 입력")).toBe(false);
  const management = await first.peer.fetch("/api/devices");
  expect(management.status).toBe(403);
  await management.arrayBuffer();

  const firstSocket = first.sockets[0]!;
  await f.local("/api/devices/" + claim.grant.deviceId + "/revoke", { method: "POST" });
  await bounded(firstSocket.closed, "Revoked device connection remained open");
  await expect(first.peer.connect(claim.credential)).rejects.toMatchObject({ status: 401 });
  const otherItems = await json<{ items: TranscriptItem[] }>(second.peer, "/api/sessions/" + f.foreignSession.id + "/items");
  expect(otherItems.items).toContainEqual(expect.objectContaining({ id: "foreign-item", text: "다른 기기만 볼 원문" }));
  expect(second.statuses.at(-1)).toMatchObject({ status: "connected", authenticated: true });
  expect(first.securityModes).toContain("protected");
  expect(second.securityModes).toContain("protected");
  expect(first.wire.join("\n")).not.toContain(claim.credential);
  expect(second.wire.join("\n")).not.toContain(otherClaim.credential);
}, 20_000);

test("protected reconnect replays scoped events once and requires resync for epoch changes or replay gaps", async () => {
  const f = await fixture(), client = await f.enroll(f.ownWork.id);
  const hidden = f.bus.publish({ type: "project.changed", workId: f.foreignWork.id });
  const replayed = f.bus.publish({ type: "project.changed", workId: f.ownWork.id });
  const live = observe(client.peer, client.authentication.cursor);
  await until(() => live.events.some(event => event.seq === replayed.seq), "Scoped replay was not delivered");
  expect(live.resyncs()).toBe(0);
  expect(live.events.some(event => event.seq === hidden.seq)).toBe(false);
  const hiddenLive = f.bus.publish({ type: "project.changed", workId: f.foreignWork.id });
  const allowedLive = f.bus.publish({ type: "project.changed", workId: f.ownWork.id });
  await until(() => live.events.some(event => event.seq === allowedLive.seq), "Live event after filtered cursor was not delivered");
  expect(live.events.some(event => event.seq === hiddenLive.seq)).toBe(false);

  const priorSocket = client.sockets.at(-1)!, priorCount = client.sockets.length;
  priorSocket.raw.close(1000, "owned loopback reconnection check");
  await bounded(priorSocket.closed, "Owned connection did not close");
  const missed = f.bus.publish({ type: "project.changed", workId: f.ownWork.id });
  await until(() => client.sockets.length > priorCount && live.events.some(event => event.seq === missed.seq), "Original reconnect path did not restore event membership");
  expect(live.events.filter(event => event.seq === missed.seq)).toHaveLength(1);
  expect(live.events.filter(event => event.seq === replayed.seq)).toHaveLength(1);
  expect(live.resyncs()).toBe(0);
  live.release();

  const oldEpoch = observe(client.peer, { epoch: "different-host-incarnation", seq: f.bus.currentSeq });
  await until(() => oldEpoch.resyncs() === 1, "Stale epoch did not require resync");
  expect(oldEpoch.events).toEqual([]);
  oldEpoch.release();

  const staleCursor: EventCursor = { epoch: f.bus.epoch, seq: f.bus.currentSeq };
  for (let index = 0; index < 9; index++) f.bus.publish({ type: "project.changed", workId: f.ownWork.id });
  const gap = observe(client.peer, staleCursor);
  await until(() => gap.resyncs() === 1, "Replay-window gap did not require resync");
  expect(gap.events).toEqual([]);
  gap.release();

  const fresh = await json<Snapshot>(client.peer, "/api/snapshot");
  expect(fresh.epoch).toBe(f.bus.epoch);
  const recovered = observe(client.peer, { epoch: f.bus.epoch, seq: fresh.seq });
  await until(() => recovered.statuses.includes(true), "Fresh cursor was not subscribed");
  const afterResync = f.bus.publish({ type: "project.changed", workId: f.ownWork.id });
  await until(() => recovered.events.some(event => event.seq === afterResync.seq), "Fresh snapshot could not resume live events");
  expect(recovered.resyncs()).toBe(0);
  recovered.release();
}, 20_000);
