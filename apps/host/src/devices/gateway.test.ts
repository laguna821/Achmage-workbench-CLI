import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
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
import { newWorkRequest } from "./scope.ts";

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
async function fixture(serverOptions: Partial<Parameters<typeof createHttpServer>[2]> = {}) {
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
  const server = createHttpServer(manager, bus, { token: ownerToken, webDir: null, devices, ...serverOptions });
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
  return { worksDir: join(directory, "works"), manager, bus, devices, local, origin, ownerToken, ownWork, foreignWork, ownSession, foreignSession, offer, peer, approve, enroll };
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

// 0.5.5 알림 일괄 정리: one gateway call reads the device's own projects only; an open approval stays.
test("모두 읽음 over the gateway reads only the device's projects and keeps an open approval", async () => {
  const f = await fixture(), client = await f.enroll(f.ownWork.id, ["read"]);
  const finish = (sessionId: string, id: string) => {
    f.manager.sink.upsertItem(sessionId, { kind: "user", id: "user:" + id, text: "요청", at: Date.now() });
    f.manager.sink.upsertItem(sessionId, { kind: "turnEnd", id: "end-" + id, status: "completed", durationMs: 1, requestId: id, at: Date.now() });
  };
  finish(f.ownSession.id, "own-1"); finish(f.ownSession.id, "own-2"); finish(f.foreignSession.id, "foreign-1");
  f.manager.sink.upsertItem(f.ownSession.id, { kind: "approval", id: "own-approval", title: "명령 실행", detail: null, reason: null, decision: null, at: Date.now() });
  await until(() => f.manager.notifications.list().events.length === 4, "attention rows were not recorded", 15_000);
  const response = await client.peer.fetch("/api/attention/read-all", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  expect(response.status).toBe(200);
  const result = await response.json() as import("@workbench/contracts").AttentionReadAll;
  expect(result).toMatchObject({ read: 2, kept: 1, list: { unread: 1 } });
  expect(result.list.events.every(row => row.workId === f.ownWork.id)).toBe(true);
  const rows = f.manager.notifications.list().events;
  expect(rows.filter(row => row.workId === f.foreignWork.id).map(row => row.readAt)).toEqual([null]);
  expect(rows.find(row => row.kind === "input_needed")).toMatchObject({ readAt: null, resolvedAt: null });
  // The desktop's own call (no device scope) reads the rest, and still leaves the open approval.
  expect(await f.local("/api/attention/read-all", { method: "POST", body: "{}" })).toMatchObject({ read: 1, kept: 1, list: { unread: 1 } });
}, 30_000);

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

type Management = { pending: import("@workbench/contracts").PairingRequest[]; devices: DeviceGrant[] };
/** One pairing through the real protected channel, with what the device says about itself. */
async function register(f: Awaited<ReturnType<typeof fixture>>, about: { remember?: boolean; previousDeviceId?: string }, approval: (pending: Management) => DeviceApproval) {
  const offer = await f.offer(), client = f.peer(offer);
  await client.peer.connect();
  const ticket = await client.peer.rpc<PairingRequestTicket>("pair", { offer: offer.workbench, name: "내 휴대폰", platform: "test-loopback", ...about });
  const before = await f.local<Management>("/api/devices");
  await f.approve(ticket.requestId, approval(before));
  const claim = await client.peer.rpc<PairingCredentialResult>("claim", { requestId: ticket.requestId, claimToken: ticket.claimToken });
  if (claim.status !== "approved") throw Error("Expected local approval");
  await client.peer.connect(claim.credential);
  return { ...client, offer, ticket, claim, before };
}

test("a remembered device connects again on a later day without a new approval, shows as remembered on the PC, and is cut off at once by revocation", async () => {
  const f = await fixture();
  const phone = await register(f, { remember: true }, () => ({ permissions: ["read"], workIds: [f.ownWork.id] }));
  expect(phone.before.pending).toMatchObject([{ requestId: phone.ticket.requestId, remember: true }]);
  const listed = (await f.local<Management>("/api/devices")).devices;
  expect(listed).toHaveLength(1);
  expect(listed[0]).toMatchObject({ deviceId: phone.claim.grant.deviceId, revokedAt: null });
  expect(listed[0]!.rememberedAt).toBe(listed[0]!.approvedAt);
  expect(JSON.stringify(listed)).not.toContain(phone.claim.credential);

  // The tab or app was closed: nothing of the first connection is left, only the kept credential.
  phone.peer.close();
  await bounded(Promise.all(phone.sockets.map(socket => socket.closed)), "First connection did not close");
  const nextDay = f.peer(phone.offer);
  const authentication = await nextDay.peer.connect(phone.claim.credential);
  expect(authentication.grant).toMatchObject({ deviceId: phone.claim.grant.deviceId, rememberedAt: listed[0]!.rememberedAt });
  expect((await f.local<Management>("/api/devices")).pending).toEqual([]);
  const snapshot = await json<Snapshot>(nextDay.peer, "/api/snapshot");
  expect(snapshot.works.map(work => work.id)).toEqual([f.ownWork.id]);

  const live = nextDay.sockets.at(-1)!;
  await f.local("/api/devices/" + phone.claim.grant.deviceId + "/revoke", { method: "POST" });
  await bounded(live.closed, "Revoked remembered device stayed connected");
  await expect(nextDay.peer.connect(phone.claim.credential)).rejects.toMatchObject({ status: 401 });
  const stolen = f.peer(phone.offer);
  await expect(stolen.peer.connect(phone.claim.credential)).rejects.toMatchObject({ status: 401 });
  expect(nextDay.wire.join("\n")).not.toContain(phone.claim.credential);
}, 20_000);

test("registering the same device again leaves one entry: the earlier approval is removed and its connection ends", async () => {
  const f = await fixture();
  const first = await register(f, { remember: true }, () => ({ permissions: ["read", "send"], workIds: [f.ownWork.id] }));
  const other = await f.enroll(f.foreignWork.id);
  const firstSocket = first.sockets.at(-1)!;
  const again = await register(f, { remember: true, previousDeviceId: first.claim.grant.deviceId }, pending => {
    const request = pending.pending.find(entry => entry.requestId !== undefined && entry.previousDeviceId)!;
    // The PC is told which earlier entry the device names; the owner's approval removes it.
    expect(request.previousDeviceId).toBe(first.claim.grant.deviceId);
    return { permissions: ["read"], workIds: [f.ownWork.id], replaces: [request.previousDeviceId!] };
  });
  await bounded(firstSocket.closed, "The earlier approval's connection stayed open");
  const devices = (await f.local<Management>("/api/devices")).devices;
  expect(devices.map(device => device.deviceId).sort()).toEqual([again.claim.grant.deviceId, other.claim.grant.deviceId].sort());
  await expect(first.peer.connect(first.claim.credential)).rejects.toMatchObject({ status: 401 });
  // Nothing carries over from the earlier approval: the new one has only what the owner chose now.
  expect(again.claim.grant.permissions).toEqual(["read"]);
  expect((await json<Snapshot>(other.peer, "/api/snapshot")).works.map(work => work.id)).toEqual([f.foreignWork.id]);

  // Taking a device off the list is the owner's act on the PC: a connected device cannot do it to another.
  const attempt = await again.peer.fetch("/api/devices/" + other.claim.grant.deviceId + "/remove", { method: "POST" });
  expect(attempt.status).toBe(403); await attempt.arrayBuffer();
  expect((await f.local<Management>("/api/devices")).devices).toHaveLength(2);
  await f.local("/api/devices/" + other.claim.grant.deviceId + "/remove", { method: "POST" });
  await bounded(other.sockets.at(-1)!.closed, "A device taken off the list stayed connected");
  expect((await f.local<Management>("/api/devices")).devices.map(device => device.deviceId)).toEqual([again.claim.grant.deviceId]);
  await expect(other.peer.connect(other.claim.credential)).rejects.toMatchObject({ status: 401 });
}, 20_000);

test("skin 2 · B: a phone keeps its own layout record (device:<id>); the desktop's record is untouched and no device reaches another's", async () => {
  const f = await fixture();
  const desktop = { version: 2, focus: "a", panes: [{ id: "a", view: { kind: "new", folderId: null }, workId: null, sessionId: null, tabs: [{ id: "desk-tab", view: { kind: "new", folderId: null }, workId: null, sessionId: null }], activeTabId: "desk-tab", recentTabIds: ["desk-tab"] }] };
  await f.local("/api/layouts/global", { method: "PUT", body: JSON.stringify({ expectedRevision: 0, layout: desktop }) });
  const phone = await f.enroll(f.ownWork.id), other = await f.enroll(f.foreignWork.id);
  // A device without a record starts from the default: nothing to migrate.
  expect(await json<{ record: unknown }>(phone.peer, "/api/layouts/device")).toEqual({ record: null });
  const mine = { ...desktop, panes: [{ ...desktop.panes[0]!, tabs: [{ ...desktop.panes[0]!.tabs[0]!, id: "phone-tab" }], activeTabId: "phone-tab", recentTabIds: ["phone-tab"] }] };
  const put = await phone.peer.fetch("/api/layouts/device", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 0, layout: mine }) });
  expect(put.status).toBe(200);
  expect(await put.json()).toMatchObject({ record: { key: "device:" + phone.claim.grant.deviceId, revision: 1 } });
  // A second write from the phone builds on its own revision, never on the desktop's.
  const again = await phone.peer.fetch("/api/layouts/device", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 1, layout: mine }) });
  expect(again.status).toBe(200);
  const global = await f.local<{ record: { revision: number; layout: unknown } }>("/api/layouts/global");
  expect(global.record).toMatchObject({ revision: 1, layout: desktop });
  expect(await json<{ record: unknown }>(other.peer, "/api/layouts/device")).toEqual({ record: null });
  for (const path of ["/api/layouts/global", "/api/layouts/device:" + phone.claim.grant.deviceId]) {
    const denied = await other.peer.fetch(path);
    expect(denied.status).toBe(403);
    await denied.arrayBuffer();
  }
  const stored = await f.local<{ record: { layout: unknown } }>("/api/layouts/device:" + phone.claim.grant.deviceId);
  expect(stored.record.layout).toEqual(mine);
}, 20_000);

test("L3: connections that have not signed in are capped; a tailnet peer filling the gateway cannot keep a paired phone out", async () => {
  const { DeviceGateway, ANONYMOUS_SOCKET_LIMIT, DEVICE_SOCKET_LIMIT } = await import("./gateway.ts");
  const { DeviceRegistry } = await import("../devices.ts");
  const directory = mkdtempSync(join(tmpdir(), "workbench-device-anonymous-"));
  const store = new Store(join(directory, "state.sqlite"));
  const bus = new EventBus(8);
  const manager = new SessionManager(store, bus, { hostId: "loopback-host", hostLabel: "연결 검사 호스트", dataDir: directory, managedWorksDir: join(directory, "works") });
  const registry = new DeviceRegistry(directory, "loopback-host");
  const gateway = new DeviceGateway({ registry, manager, bus, localOrigin: () => null, localToken: "test-local-owner", dataDir: directory });
  cleanup.push(async () => { gateway.close(); registry.close(); await manager.shutdown(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  // A phone paired earlier: its credential, as the registry hands it out.
  const work = manager.createWork({ title: "휴대폰 프로젝트", cwd: directory });
  const offer = registry.createOffer({});
  const ticket = registry.requestPairing({ offerId: offer.offerId, token: offer.token, name: "내 휴대폰", connectionId: "phone-connection" });
  registry.approve(ticket.requestId, { permissions: ["read"], workIds: [work.id] });
  const claimed = registry.claimCredential({ requestId: ticket.requestId, claimToken: ticket.claimToken, connectionId: "phone-connection" });
  if (claimed.status !== "approved") throw Error("not approved");

  type Fake = { closed: number | null; sent: string[]; listeners: Map<string, ((...args: unknown[]) => void)[]>; send(data: string): void; close(code?: number): void; on(event: string, listener: (...args: unknown[]) => void): void; emit(event: string, ...args: unknown[]): void };
  const fake = (): Fake => {
    const socket: Fake = { closed: null, sent: [], listeners: new Map(),
      send(data) { socket.sent.push(String(data)); },
      close(code) { if (socket.closed === null) { socket.closed = code ?? 1000; socket.emit("close"); } },
      on(event, listener) { socket.listeners.set(event, [...(socket.listeners.get(event) ?? []), listener]); },
      emit(event, ...args) { for (const listener of socket.listeners.get(event) ?? []) listener(...args); } };
    return socket;
  };
  // A tailnet peer opens far more connections than the gateway holds and never signs in.
  const peer = Array.from({ length: DEVICE_SOCKET_LIMIT + 8 }, fake);
  for (const socket of peer) await gateway.attach(socket);
  expect(peer.filter(socket => socket.closed === null)).toHaveLength(ANONYMOUS_SOCKET_LIMIT);
  expect(peer.some(socket => socket.closed === 1008)).toBe(false);
  // The phone still gets in and signs in.
  const phone = fake();
  await gateway.attach(phone);
  expect(phone.closed).toBeNull();
  phone.emit("message", JSON.stringify({ type: "workbench", op: "authenticate", id: "a1", credential: claimed.credential }));
  await until(() => phone.sent.some(text => text.includes('"op":"result"') && text.includes('"id":"a1"')), "the phone did not sign in");
  expect(phone.closed).toBeNull();
  // Signed in, it keeps its room however many anonymous connections come after it.
  for (const socket of Array.from({ length: DEVICE_SOCKET_LIMIT }, fake)) await gateway.attach(socket);
  expect(phone.closed).toBeNull();
});

// 0.5.6 (phone over Tailscale): 새 프로젝트 and 새 문서 from the phone.
const post = (peer: RemotePeer, path: string, body: unknown, type = "application/json") =>
  peer.fetch(path, { method: "POST", headers: { "content-type": type }, body: JSON.stringify(body) });

test("새 프로젝트 from a paired phone: a name, made in the PC's projects folder, joins that phone's projects only; a PC folder, a hidden list folder, a read-only phone and an unpaired client are refused", async () => {
  const f = await fixture();
  // Unpaired: a connection holding no credential asks to make a project.
  const stranger = f.peer(await f.offer());
  await stranger.peer.connect();
  const before = f.manager.snapshot().works.length;
  await expect(stranger.peer.rpc("request", { request: { method: "POST", path: "/api/works", headers: { "content-type": "application/json" }, bytes: 0 } })).rejects.toMatchObject({ status: 401 });
  await expect(stranger.peer.fetch("/api/works", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).rejects.toMatchObject({ status: 401 });

  const reader = await f.enroll(f.ownWork.id, ["read"]);
  const readOnly = await post(reader.peer, "/api/works", { title: "읽기 기기", folderId: null, cwd: null });
  expect(readOnly.status).toBe(403); await readOnly.arrayBuffer();

  const phone = await f.enroll(f.ownWork.id, ["read", "send"]);
  const watch = observe(phone.peer, phone.authentication.cursor);
  await until(() => watch.statuses.includes(true), "the phone did not subscribe");
  const elsewhere = await post(phone.peer, "/api/works", { title: "PC 폴더", folderId: null, cwd: "/etc" });
  expect(elsewhere.status).toBe(403); expect((await elsewhere.json() as { code: string }).code).toBe("remote_project_folder");
  const hiddenFolder = f.manager.createFolder("다른 분류", null);
  const hidden = await post(phone.peer, "/api/works", { title: "숨은 분류", folderId: hiddenFolder.id, cwd: null });
  expect(hidden.status).toBe(403); await hidden.arrayBuffer();
  // A body that does not say it is JSON is refused before any route reads it.
  const smuggled = await post(phone.peer, "/api/works", { title: "몰래", folderId: null, cwd: "/etc" }, "text/plain");
  expect(smuggled.status).toBe(415); await smuggled.arrayBuffer();
  expect(f.manager.snapshot().works.length).toBe(before);

  const made = await post(phone.peer, "/api/works", { title: "휴대폰 프로젝트", folderId: null, cwd: null });
  expect(made.status).toBe(201);
  const work = await made.json() as import("@workbench/contracts").Work;
  expect(work.title).toBe("휴대폰 프로젝트");
  expect(work.cwd.startsWith(f.worksDir + "/")).toBe(true);
  // It joined this phone's grant (and nobody else's); the phone reloads its view and sees it at once.
  const devices = f.devices.registry.list();
  expect(devices.find(entry => entry.deviceId === phone.claim.grant.deviceId)?.workIds).toEqual([f.ownWork.id, work.id]);
  expect(devices.find(entry => entry.deviceId === reader.claim.grant.deviceId)?.workIds).toEqual([f.ownWork.id]);
  await until(() => watch.resyncs() > 0, "the phone was not told to reload its view");
  const snapshot = await json<Snapshot>(phone.peer, "/api/snapshot");
  expect(snapshot.works.map(entry => entry.id).sort()).toEqual([f.ownWork.id, work.id].sort());
  // Its row waits for its name (as on the PC): the title is the phone's to change.
  const named = await phone.peer.fetch(`/api/works/${work.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "휴대폰에서 지은 이름" }) });
  expect(named.status).toBe(200); await named.arrayBuffer();
  expect(f.manager.snapshot().works.find(entry => entry.id === work.id)?.title).toBe("휴대폰에서 지은 이름");
  // Round 2: 보관/고정/태그/옮기기 are the phone's too (see "round 2 · a project's …"); other fields and wrong shapes are not.
  for (const patch of [{ activeSessionId: null }, { title: 5 }, { pinned: "yes" }]) {
    const other = await phone.peer.fetch(`/api/works/${work.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
    expect(other.status).toBe(403); await other.arrayBuffer();
  }
  const foreignName = await phone.peer.fetch(`/api/works/${f.foreignWork.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "남의 프로젝트" }) });
  expect(foreignName.status).toBe(403); await foreignName.arrayBuffer();
  // The live connection stays (a project added is not a narrowed grant) and a conversation can start there.
  const session = await post(phone.peer, `/api/works/${work.id}/sessions`, { provider: "codex" });
  expect(session.status).toBe(201); await session.arrayBuffer();
  expect(phone.statuses.at(-1)).toMatchObject({ status: "connected", authenticated: true });
  watch.release();
}, 30_000);

test("새 문서 from a paired phone: the PC's kinds made in its own project; another project, another project's workspace, a path outside the project and an unpaired client are refused", async () => {
  const f = await fixture();
  const stranger = f.peer(await f.offer());
  await stranger.peer.connect();
  await expect(stranger.peer.rpc("request", { request: { method: "POST", path: `/api/works/${f.ownWork.id}/office-documents`, headers: { "content-type": "application/json" }, bytes: 0 } })).rejects.toMatchObject({ status: 401 });
  const phone = await f.enroll(f.ownWork.id, ["read", "send"]);
  for (const format of ["markdown", "html"] as const) {
    const made = await post(phone.peer, `/api/works/${f.ownWork.id}/office-documents`, { format, name: "휴대폰 메모" });
    expect(made.status).toBe(201);
    const artifact = await made.json() as import("@workbench/contracts").Artifact;
    expect(artifact.workId).toBe(f.ownWork.id);
  }
  const design = await post(phone.peer, `/api/works/${f.ownWork.id}/designs`, { name: "휴대폰 카드", preset: "square" });
  expect(design.status).toBe(201); await design.arrayBuffer();
  const foreign = await post(phone.peer, `/api/works/${f.foreignWork.id}/office-documents`, { format: "markdown" });
  expect(foreign.status).toBe(403); await foreign.arrayBuffer();
  const foreignSpace = await post(phone.peer, `/api/works/${f.ownWork.id}/office-documents`, { format: "markdown", workspaceId: f.foreignWork.defaultWorkspaceId });
  expect(foreignSpace.status).toBeGreaterThanOrEqual(400); await foreignSpace.arrayBuffer();
  for (const path of ["/etc/hostname", "../다른 프로젝트/비밀.md", "C:\\Users\\비밀.md"]) {
    const outside = await post(phone.peer, `/api/works/${f.ownWork.id}/artifacts`, { path });
    expect(outside.status).toBe(403); await outside.arrayBuffer();
  }
  expect(f.manager.snapshot().artifacts.filter(entry => entry.workId === f.foreignWork.id)).toEqual([]);
}, 30_000);

test("a phone reads its own project's page and its documents' page pictures; another project's and an unpaired client are refused", async () => {
  const f = await fixture();
  const stranger = f.peer(await f.offer());
  await stranger.peer.connect();
  await expect(stranger.peer.rpc("request", { request: { method: "GET", path: `/api/projects/${f.ownWork.id}`, headers: {}, bytes: 0 } })).rejects.toMatchObject({ status: 401 });
  const phone = await f.enroll(f.ownWork.id, ["read", "send"]);
  // Admitted (this fixture's gateway has no project notes service: what it answers is not a refusal).
  const own = await phone.peer.fetch(`/api/projects/${f.ownWork.id}`);
  expect([401, 403]).not.toContain(own.status); await own.arrayBuffer();
  const events = await phone.peer.fetch(`/api/projects/${f.ownWork.id}/events`);
  expect([401, 403]).not.toContain(events.status); await events.arrayBuffer();
  const foreign = await phone.peer.fetch(`/api/projects/${f.foreignWork.id}`);
  expect(foreign.status).toBe(403); await foreign.arrayBuffer();
  // Round 2: the own project's note writes are admitted (see "round 2 · project page"); another project's are not.
  const write = await phone.peer.fetch(`/api/projects/${f.foreignWork.id}/property`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "단계", values: ["진행"] }) });
  expect(write.status).toBe(403); await write.arrayBuffer();
  // Word page pictures: the route is the device's to ask (drawing them is the PC's business: any answer but a refusal).
  const made = await post(phone.peer, `/api/works/${f.ownWork.id}/office-documents`, { format: "docx", name: "휴대폰 워드" });
  const docx = await made.json() as import("@workbench/contracts").Artifact;
  const pictures = await phone.peer.fetch(`/api/artifacts/${docx.id}/office-pages?revision=${docx.revision}`);
  expect([401, 403]).not.toContain(pictures.status); await pictures.arrayBuffer();
  const foreignDoc = f.manager.documents.track(f.foreignWork.id, f.foreignWork.cwd, join(f.foreignWork.cwd, "비공개.md"), "user", null, "검사");
  if (foreignDoc) {
    const hidden = await phone.peer.fetch(`/api/artifacts/${foreignDoc.artifact.id}/office-pages?revision=1`);
    expect(hidden.status).toBe(403); await hidden.arrayBuffer();
  }
}, 30_000);

// Security review of 0.5.6 (4dda47f9..0d4624d9): each finding with its refusal.
test("review 1+4: 작업 폴더에서 열기 from a phone takes only a path string inside the project — an array, an outside path and a link leading out are refused", async () => {
  const f = await fixture();
  const phone = await f.enroll(f.ownWork.id, ["read", "send"]);
  const outside = join(f.foreignWork.cwd, "비공개.md");
  mkdirSync(f.foreignWork.cwd, { recursive: true }); mkdirSync(f.ownWork.cwd, { recursive: true });
  writeFileSync(outside, "# 다른 프로젝트의 글\n");
  for (const path of [[outside], ["../" + f.foreignWork.cwd.split("/").pop() + "/비공개.md"], { toString: outside }, 7]) {
    const refused = await post(phone.peer, `/api/works/${f.ownWork.id}/artifacts`, { path });
    expect(refused.status).toBe(403); await refused.arrayBuffer();
  }
  symlinkSync(outside, join(f.ownWork.cwd, "바로가기.md"));
  const viaLink = await post(phone.peer, `/api/works/${f.ownWork.id}/artifacts`, { path: "바로가기.md" });
  expect(viaLink.status).toBe(403); await viaLink.arrayBuffer();
  expect(f.manager.snapshot().artifacts.some(entry => entry.path === outside || entry.name === "바로가기.md")).toBe(false);
  writeFileSync(join(f.ownWork.cwd, "안의 글.md"), "# 안\n");
  const inside = await post(phone.peer, `/api/works/${f.ownWork.id}/artifacts`, { path: "안의 글.md" });
  expect(inside.status).toBe(200); await inside.arrayBuffer();
}, 30_000);

test("review 2: a phone at its 256 projects is refused before anything is made; and at most 5 new projects a minute", async () => {
  const f = await fixture();
  const full = { ...f.devices.registry.list()[0], permissions: ["read", "send"], workIds: Array.from({ length: 256 }, (_, index) => "w" + index) } as unknown as import("@workbench/contracts").DeviceGrant;
  expect(() => newWorkRequest(f.manager, full, { title: "넘침" })).toThrow(expect.objectContaining({ status: 409 }));
  const phone = await f.enroll(f.ownWork.id, ["read", "send"]);
  const before = f.manager.snapshot().works.length;
  const statuses: number[] = [];
  for (let at = 0; at < 7; at++) { const made = await post(phone.peer, "/api/works", { title: "연속 " + at }); statuses.push(made.status); await made.arrayBuffer(); }
  expect(statuses).toEqual([201, 201, 201, 201, 201, 429, 429]);
  expect(f.manager.snapshot().works.length).toBe(before + 5);
}, 30_000);

test("review 3: a new project's name from a phone is cut at 80 characters", async () => {
  const f = await fixture();
  const phone = await f.enroll(f.ownWork.id, ["read", "send"]);
  const made = await post(phone.peer, "/api/works", { title: "가".repeat(5000) });
  expect(made.status).toBe(201);
  const work = await made.json() as import("@workbench/contracts").Work;
  expect(Array.from(f.manager.snapshot().works.find(entry => entry.id === work.id)!.title).length).toBeLessThanOrEqual(80);
}, 30_000);

test("review 5: a project's page read from a phone carries no property names of other projects (knownKeys); the PC's still does", async () => {
  const page = (workId: string) => ({ workId, knownKeys: [{ key: "다른 프로젝트의 비밀 속성", type: "text" }] });
  const f = await fixture({ projects: async (_req, res, url) => {
    const id = url.pathname.split("/")[3]!;
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(page(id))); return true;
  } });
  const phone = await f.enroll(f.ownWork.id, ["read", "send"]);
  const seen = await json<Record<string, unknown>>(phone.peer, `/api/projects/${f.ownWork.id}`);
  expect(seen.workId).toBe(f.ownWork.id);
  expect(JSON.stringify(seen)).not.toContain("다른 프로젝트의 비밀 속성");
  expect((await f.local<Record<string, unknown>>(`/api/projects/${f.ownWork.id}`)).knownKeys).toEqual(page(f.ownWork.id).knownKeys);
}, 30_000);

test("review 6: a phone does not write a document's text (the phone reads documents only)", async () => {
  const f = await fixture();
  const phone = await f.enroll(f.ownWork.id, ["read", "send"]);
  const made = await post(phone.peer, `/api/works/${f.ownWork.id}/office-documents`, { format: "markdown", name: "읽기만" });
  const doc = await made.json() as import("@workbench/contracts").Artifact;
  const write = await phone.peer.fetch(`/api/artifacts/${doc.id}/text`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: doc.revision, text: "휴대폰에서 고친 글" }) });
  expect(write.status).toBe(403); await write.arrayBuffer();
  expect(f.manager.documents.get(doc.id)!.revision).toBe(doc.revision);
}, 30_000);

// ── Round 2 (owner, 2026-11-20): every phone action works inside its approved projects, or is not offered. ──
async function strangerRefused(f: Awaited<ReturnType<typeof fixture>>, method: string, path: string) {
  const stranger = f.peer(await f.offer());
  await stranger.peer.connect();
  await expect(stranger.peer.rpc("request", { request: { method, path, headers: { "content-type": "application/json" }, bytes: 0 } })).rejects.toMatchObject({ status: 401 });
}
const patch = (peer: RemotePeer, path: string, body: unknown) => peer.fetch(path, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const status = async (response: Response) => { const value = response.status; await response.arrayBuffer(); return value; };

test("round 2 · list folders: a phone makes one (no parent or one it sees), names its own; another's folder, a hidden parent, other fields and an unpaired client are refused", async () => {
  const f = await fixture();
  await strangerRefused(f, "POST", "/api/folders");
  const phone = await f.enroll(f.ownWork.id, ["read", "send"]);
  const hidden = f.manager.createFolder("PC의 분류", null);
  expect(await status(await post(phone.peer, "/api/folders", { name: "숨은 곳 아래", parentId: hidden.id }))).toBe(403);
  expect(await status(await post(phone.peer, "/api/folders", { name: "색", parentId: null, color: "red" }))).toBe(403);
  const made = await post(phone.peer, "/api/folders", { name: "휴대폰 분류", parentId: null });
  expect(made.status).toBe(201);
  const folder = await made.json() as import("@workbench/contracts").Folder;
  expect(f.devices.registry.list().find(entry => entry.deviceId === phone.claim.grant.deviceId)?.folderIds).toEqual([folder.id]);
  expect((await json<Snapshot>(phone.peer, "/api/snapshot")).folders.map(entry => entry.id)).toContain(folder.id);
  expect(await status(await post(phone.peer, "/api/folders", { name: "안쪽", parentId: folder.id }))).toBe(201);
  expect(await status(await patch(phone.peer, `/api/folders/${folder.id}`, { name: "휴대폰에서 지은 분류" }))).toBe(200);
  expect(f.manager.snapshot().folders.find(entry => entry.id === folder.id)?.name).toBe("휴대폰에서 지은 분류");
  expect(await status(await patch(phone.peer, `/api/folders/${folder.id}`, { name: "x", archived: true }))).toBe(403);
  expect(await status(await patch(phone.peer, `/api/folders/${hidden.id}`, { name: "남의 분류" }))).toBe(403);
  expect(f.manager.snapshot().folders.find(entry => entry.id === hidden.id)?.name).toBe("PC의 분류");
}, 30_000);

test("round 2 · 프로젝트 폴더 안에 새 폴더: inside the phone's project only; another project, .., a link leading out and an unpaired client are refused", async () => {
  const f = await fixture();
  const own = f.ownWork.defaultWorkspaceId!, foreign = f.foreignWork.defaultWorkspaceId!;
  await strangerRefused(f, "POST", `/api/workspaces/${own}/directories`);
  const phone = await f.enroll(f.ownWork.id, ["read", "send"]);
  const root = f.manager.workspaces.get(own).cwd;
  mkdirSync(root, { recursive: true }); mkdirSync(f.manager.workspaces.get(foreign).cwd, { recursive: true });
  expect(await status(await post(phone.peer, `/api/workspaces/${own}/directories`, { path: "휴대폰 자료" }))).toBe(201);
  expect(await status(await post(phone.peer, `/api/workspaces/${foreign}/directories`, { path: "남의 자료" }))).toBe(403);
  expect(await status(await post(phone.peer, `/api/workspaces/${own}/directories`, { path: "../밖" }))).toBe(400);
  symlinkSync(f.manager.workspaces.get(foreign).cwd, join(root, "바깥 연결"));
  expect(await status(await post(phone.peer, `/api/workspaces/${own}/directories`, { path: "바깥 연결/새 폴더" }))).toBe(403);
  expect(await status(await post(phone.peer, `/api/workspaces/${own}/directories`, { path: ["x"] }))).toBe(403);
}, 30_000);

test("round 2 · project page: a phone writes its own project's note and reads the shared choices; the summaries are its own; another project's note, what changes every project and an unpaired client are refused", async () => {
  const calls: string[] = [], listed: { workId: string }[] = [];
  const f = await fixture({ projects: async (req, res, url) => {
    calls.push(`${req.method} ${url.pathname}`);
    const answer = url.pathname === "/api/projects/" ? listed : { ok: true };
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(answer)); return true;
  } });
  listed.push({ workId: f.ownWork.id }, { workId: f.foreignWork.id });
  await strangerRefused(f, "PUT", `/api/projects/${f.ownWork.id}/property`);
  const phone = await f.enroll(f.ownWork.id, ["read", "send"]);
  const put = (path: string, body: unknown) => phone.peer.fetch(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const own = `/api/projects/${f.ownWork.id}`;
  expect(await status(await put(`${own}/property`, { key: "과목", values: ["질적 연구"] }))).toBe(200);
  expect(await status(await put(`${own}/stage`, { stage: "진행" }))).toBe(200);
  expect(await status(await post(phone.peer, `${own}/entries`, { section: "decision", text: "과제 마감은 그대로" }))).toBe(200);
  expect(await status(await put(`${own}/entries/3`, { done: true }))).toBe(200);
  expect(await status(await post(phone.peer, `${own}/revert`, {}))).toBe(200);
  expect(await status(await phone.peer.fetch("/api/projects/stages"))).toBe(200);
  expect(await status(await phone.peer.fetch(`/api/projects/changes?sessionId=${f.ownSession.id}`))).toBe(200);
  expect(await status(await phone.peer.fetch(`/api/projects/changes?sessionId=${f.foreignSession.id}`))).toBe(403);
  const summaries = await json<unknown[]>(phone.peer, "/api/projects/");
  expect(summaries).toEqual([{ workId: f.ownWork.id }]);
  expect(await status(await put(`/api/projects/${f.foreignWork.id}/property`, { key: "과목", values: ["남의"] }))).toBe(403);
  for (const [method, path] of [["PUT", "/api/projects/stages"], ["PUT", "/api/projects/template"], ["PUT", "/api/projects/types"], ["POST", "/api/projects/bases/export"], ["PUT", "/api/projects/folder-templates/x"]] as const) {
    expect(await status(await phone.peer.fetch(path, { method, headers: { "content-type": "application/json" }, body: "{}" }))).toBe(403);
  }
  expect(calls.some(call => call.includes(f.foreignWork.id) || call.endsWith("/stages") && call.startsWith("PUT"))).toBe(false);
}, 30_000);

test("round 2 · a project's 이름 / 보관 / 고정 / 태그 / 폴더로 옮기기 from a phone; a folder it does not see, other fields, another project and an unpaired client are refused", async () => {
  const f = await fixture();
  await strangerRefused(f, "PATCH", `/api/works/${f.ownWork.id}`);
  const phone = await f.enroll(f.ownWork.id, ["read", "send"]);
  const path = `/api/works/${f.ownWork.id}`;
  const work = () => f.manager.snapshot().works.find(entry => entry.id === f.ownWork.id)!;
  expect(await status(await patch(phone.peer, path, { pinned: true }))).toBe(200);
  expect(await status(await patch(phone.peer, path, { tags: ["강의", "3주차"] }))).toBe(200);
  const mine = await (await post(phone.peer, "/api/folders", { name: "휴대폰 분류", parentId: null })).json() as import("@workbench/contracts").Folder;
  expect(await status(await patch(phone.peer, path, { folderId: mine.id }))).toBe(200);
  expect(work()).toMatchObject({ pinned: true, tags: ["강의", "3주차"], folderId: mine.id });
  const hidden = f.manager.createFolder("PC만 보는 분류", null);
  expect(await status(await patch(phone.peer, path, { folderId: hidden.id }))).toBe(403);
  expect(await status(await patch(phone.peer, path, { activeSessionId: null }))).toBe(403);
  expect(await status(await patch(phone.peer, path, { tags: "강의" }))).toBe(403);
  expect(await status(await patch(phone.peer, `/api/works/${f.foreignWork.id}`, { pinned: true }))).toBe(403);
  expect(await status(await patch(phone.peer, path, { archived: true }))).toBe(200);
  expect(work().archivedAt).not.toBeNull();
  expect(await status(await patch(phone.peer, path, { archived: false }))).toBe(200);
  expect(await status(await phone.peer.fetch(path, { method: "DELETE" }))).toBe(403);
  expect(work().folderId).toBe(mine.id);
}, 30_000);

test("round 2 · a document's 이름 바꾸기 and 목록에서 빼기 from a phone (the file stays); 휴지통, another project's document and an unpaired client are refused", async () => {
  const f = await fixture();
  const phone = await f.enroll(f.ownWork.id, ["read", "send"]);
  const made = await (await post(phone.peer, `/api/works/${f.ownWork.id}/office-documents`, { format: "markdown", name: "휴대폰 메모" })).json() as import("@workbench/contracts").Artifact;
  await strangerRefused(f, "POST", `/api/artifacts/${made.id}/rename`);
  const plan = await json<{ actions: string[] }>(phone.peer, `/api/artifacts/${made.id}/removal`);
  expect(plan.actions).not.toContain("trash");
  expect(await status(await post(phone.peer, `/api/artifacts/${made.id}/rename`, { name: "고친 메모" }))).toBe(200);
  expect(f.manager.documents.get(made.id)!.name).toBe("고친 메모.md");
  expect(await status(await post(phone.peer, `/api/artifacts/${made.id}/remove`, { action: "trash" }))).toBe(403);
  const foreign = f.manager.documents.track(f.foreignWork.id, f.foreignWork.cwd, join(f.foreignWork.cwd, "남의.md"), "user", null, "검사");
  if (foreign) expect(await status(await post(phone.peer, `/api/artifacts/${foreign.artifact.id}/rename`, { name: "x" }))).toBe(403);
  const path = f.manager.documents.get(made.id)!.path;
  expect(await status(await post(phone.peer, `/api/artifacts/${made.id}/remove`, { action: "unlisted" }))).toBe(200);
  expect(f.manager.snapshot().artifacts.some(entry => entry.id === made.id)).toBe(false);
  expect(existsSync(path)).toBe(true);
}, 30_000);

test("round 2 · 불러오기 from a phone: a file into its own project (at most 25 MB), then Markdown 변환 beside it; another project, another project's folder, a file outside and an unpaired client are refused", async () => {
  const f = await fixture();
  await strangerRefused(f, "POST", `/api/works/${f.ownWork.id}/import-upload`);
  const phone = await f.enroll(f.ownWork.id, ["read", "send"]);
  mkdirSync(f.manager.workspaces.get(f.ownWork.defaultWorkspaceId!).cwd, { recursive: true });
  const upload = (workId: string, bytes: Uint8Array, headers: Record<string, string> = {}) => phone.peer.fetch(`/api/works/${workId}/import-upload`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent("휴대폰 자료.pdf"), ...headers }, body: new Blob([bytes as Uint8Array<ArrayBuffer>]) });
  const pdf = new TextEncoder().encode("%PDF-1.4\n%%EOF\n");
  const done = await upload(f.ownWork.id, pdf);
  expect(done.status).toBe(200);
  const files = (await done.json() as { files: { path: string }[] }).files;
  expect(files[0]!.path.startsWith(f.manager.workspaces.get(f.ownWork.defaultWorkspaceId!).cwd)).toBe(true);
  expect(await status(await upload(f.foreignWork.id, pdf))).toBe(403);
  // A folder named by the device is not passed on: the file lands in the project's own folder, whatever was asked.
  const asked = await upload(f.ownWork.id, pdf, { "x-workspace-id": f.foreignWork.defaultWorkspaceId! });
  expect(((await asked.json()) as { files: { path: string }[] }).files[0]!.path.startsWith(f.manager.workspaces.get(f.ownWork.defaultWorkspaceId!).cwd)).toBe(true);
  expect(await status(await upload(f.ownWork.id, new Uint8Array(25 * 1024 * 1024 + 1)))).toBe(413);
  // 변환 of a file outside the project (an absolute path elsewhere) is refused before the host reads it.
  mkdirSync(f.foreignWork.cwd, { recursive: true }); writeFileSync(join(f.foreignWork.cwd, "남의.pdf"), pdf);
  expect(await status(await post(phone.peer, `/api/works/${f.ownWork.id}/convert-to-markdown`, { path: join(f.foreignWork.cwd, "남의.pdf"), preset: "default", pages: "", images: false }))).toBe(403);
  expect([401, 403]).not.toContain(await status(await post(phone.peer, `/api/works/${f.ownWork.id}/convert-to-markdown`, { path: files[0]!.path, preset: "default", pages: "", images: false })));
}, 60_000);

test("round 2 · 한글로 내보내기 / Markdown 변환 / 변환해서 열기 from a phone (new files in its project); another project's document, the editor's raw bytes and an unpaired client are refused", async () => {
  const f = await fixture();
  const phone = await f.enroll(f.ownWork.id, ["read", "send"]);
  const made = await (await post(phone.peer, `/api/works/${f.ownWork.id}/office-documents`, { format: "markdown", name: "내보낼 글" })).json() as import("@workbench/contracts").Artifact;
  await strangerRefused(f, "POST", `/api/artifacts/${made.id}/export-hangul`);
  expect([401, 403]).not.toContain(await status(await phone.peer.fetch("/api/hangul-convert/choices")));
  for (const action of ["export-hangul", "convert-to-markdown", "open-converted", "word-to-hangul"]) {
    expect([401, 403]).not.toContain(await status(await post(phone.peer, `/api/artifacts/${made.id}/${action}`, { format: "hwpx", template: "기본", preset: "default", pages: "", images: false })));
  }
  expect([401, 403]).not.toContain(await status(await post(phone.peer, `/api/artifacts/${made.id}/word-to-hangul/commit`, { ticket: "없는 표" })));
  const foreign = f.manager.documents.track(f.foreignWork.id, f.foreignWork.cwd, join(f.foreignWork.cwd, "남의 글.md"), "user", null, "검사");
  if (foreign) expect(await status(await post(phone.peer, `/api/artifacts/${foreign.artifact.id}/export-hangul`, { format: "hwpx", template: "기본" }))).toBe(403);
  const raw = await phone.peer.fetch(`/api/artifacts/${made.id}/word-to-hangul?format=hwpx`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: new Blob([new Uint8Array([1, 2, 3])]) });
  expect(await status(raw)).toBe(415);
}, 60_000);

test("round 2 · 대화 ⋯ 마크다운으로 내보내기 → 작업 폴더에 저장 (and the text) from a phone; a path of the PC, another project's conversation and an unpaired client are refused", async () => {
  const f = await fixture();
  await strangerRefused(f, "POST", `/api/sessions/${f.ownSession.id}/export`);
  const phone = await f.enroll(f.ownWork.id, ["read", "send"]);
  mkdirSync(f.manager.workspaces.get(f.ownWork.defaultWorkspaceId!).cwd, { recursive: true });
  const saved = await post(phone.peer, `/api/sessions/${f.ownSession.id}/export`, { target: "work" });
  expect(saved.status).toBe(200);
  const result = await saved.json() as import("@workbench/contracts").ExportMarkdownResult;
  expect(result.path && existsSync(result.path)).toBeTruthy();
  expect(await status(await post(phone.peer, `/api/sessions/${f.ownSession.id}/export`, { target: "text" }))).toBe(200);
  expect(await status(await post(phone.peer, `/api/sessions/${f.ownSession.id}/export`, { target: "path", path: "/tmp/밖.md" }))).toBe(403);
  expect(await status(await post(phone.peer, `/api/sessions/${f.foreignSession.id}/export`, { target: "work" }))).toBe(403);
}, 30_000);

test("round 2 · on-screen from a phone: told as the phone's own client, its own conversations only; an unpaired client is refused", async () => {
  const f = await fixture();
  await strangerRefused(f, "POST", "/api/sessions/on-screen");
  const phone = await f.enroll(f.ownWork.id, ["read"]);
  const told = vi.spyOn(f.manager, "setShown");
  expect(await status(await post(phone.peer, "/api/sessions/on-screen", { client: "window-of-the-pc", ids: [f.ownSession.id, f.foreignSession.id] }))).toBe(200);
  expect(told).toHaveBeenCalledWith(`device:${phone.claim.grant.deviceId}`, [f.ownSession.id]);
}, 30_000);

// ── Security review of 2416cede..b93223c9: each with its refusal (failing on the code before the fix) ──
test("review2 1: a phone does not rename a listed file that lives outside the project's folders (목록에서 빼기 leaves it as it is)", async () => {
  const f = await fixture();
  const phone = await f.enroll(f.ownWork.id, ["read", "send"]);
  const desk = mkdtempSync(join(tmpdir(), "workbench-desktop-"));
  const outside = join(desk, "바탕화면 메모.md");
  writeFileSync(outside, "# 바탕화면\n");
  const listed = f.manager.openFile(f.ownWork.id, outside)!;
  expect(await status(await post(phone.peer, `/api/artifacts/${listed.id}/rename`, { name: "휴대폰이 바꾼 이름" }))).toBe(403);
  expect(existsSync(outside)).toBe(true);
  expect(await status(await post(phone.peer, `/api/artifacts/${listed.id}/remove`, { action: "unlisted" }))).toBe(200);
  expect(existsSync(outside)).toBe(true);
  rmSync(desk, { recursive: true, force: true });
}, 30_000);

test("review2 2: one per-device limit (10 a minute) on heavy work: uploads, conversions, exports and new folders inside the project", async () => {
  const f = await fixture();
  const phone = await f.enroll(f.ownWork.id, ["read", "send"]);
  const own = f.ownWork.defaultWorkspaceId!;
  mkdirSync(f.manager.workspaces.get(own).cwd, { recursive: true });
  const statuses: number[] = [];
  for (let at = 0; at < 11; at++) statuses.push(await status(await post(phone.peer, `/api/workspaces/${own}/directories`, { path: `폴더 ${at}` })));
  expect(statuses.slice(0, 10).every(value => value === 201)).toBe(true);
  expect(statuses[10]).toBe(429);
  expect(await status(await post(phone.peer, `/api/sessions/${f.ownSession.id}/export`, { target: "text" }))).toBe(429);
}, 60_000);

test("review2 3: a decision or question from a phone names only a conversation of its own projects", async () => {
  const f = await fixture({ projects: async (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); return true; } });
  const phone = await f.enroll(f.ownWork.id, ["read", "send"]);
  const entries = `/api/projects/${f.ownWork.id}/entries`;
  expect(await status(await post(phone.peer, entries, { section: "decision", text: "남의 대화로", sessionId: f.foreignSession.id }))).toBe(403);
  expect(await status(await post(phone.peer, entries, { section: "decision", text: "내 대화로", sessionId: f.ownSession.id }))).toBe(200);
  expect(await status(await post(phone.peer, entries, { section: "decision", text: "대화 없이" }))).toBe(200);
}, 30_000);

test("review2 4: a conversation exported from a phone names nothing of another project (\"다른 프로젝트의 …\"); the PC's export is unchanged", async () => {
  const f = await fixture();
  const phone = await f.enroll(f.ownWork.id, ["read", "send"]);
  mkdirSync(f.foreignWork.cwd, { recursive: true });
  writeFileSync(join(f.foreignWork.cwd, "비밀 계획.md"), "# 비밀\n");
  const secret = f.manager.openFile(f.foreignWork.id, join(f.foreignWork.cwd, "비밀 계획.md"))!;
  // The phone's own conversation names a document of another project and a conversation of another project.
  f.manager.sink.upsertItem(f.ownSession.id, { kind: "artifact", id: "artifact:secret", artifactId: secret.id, change: "modified", revision: 1, at: Date.now() } as never);
  f.manager.sink.upsertItem(f.ownSession.id, { kind: "user", id: "user:linked", text: "이어서", at: Date.now(), link: { hop: 1, of: 2, fromSessionId: f.foreignSession.id } } as never);
  const exported = await post(phone.peer, `/api/sessions/${f.ownSession.id}/export`, { target: "text" });
  expect(exported.status).toBe(200);
  const { markdown } = await exported.json() as { markdown: string };
  expect(markdown).not.toContain("비밀 계획");
  expect(markdown).not.toContain(f.foreignWork.title);
  expect(markdown).toContain("다른 프로젝트의 문서");
  expect(markdown).toContain("다른 프로젝트의 대화");
  // The PC's own export still names them.
  const pc = f.manager.exportMarkdown(f.ownSession.id, { target: "text" }).markdown;
  expect(pc).toContain("비밀 계획");
}, 30_000);

test("review2 5: a body the gateway read as JSON goes on to the PC as application/json, whatever type the device named", async () => {
  const types: string[] = [];
  const f = await fixture({ projects: async (req, res) => { types.push(String(req.headers["content-type"])); res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); return true; } });
  const phone = await f.enroll(f.ownWork.id, ["read", "send"]);
  const sent = await phone.peer.fetch(`/api/projects/${f.ownWork.id}/stage`, { method: "PUT", headers: { "content-type": "application/octet-stream;x=application/json" }, body: JSON.stringify({ stage: "진행" }) });
  expect(await status(sent)).toBe(200);
  expect(types.at(-1)).toBe("application/json");
}, 30_000);

test("review2 6: a file uploaded from a phone under a Windows device name (CON, NUL, COM1, LPT1 …) is written as _CON …", async () => {
  const f = await fixture();
  const phone = await f.enroll(f.ownWork.id, ["read", "send"]);
  mkdirSync(f.manager.workspaces.get(f.ownWork.defaultWorkspaceId!).cwd, { recursive: true });
  const pdf = new TextEncoder().encode("%PDF-1.4\n%%EOF\n");
  for (const name of ["CON.pdf", "nul.hwpx", "COM1.docx"]) {
    const done = await phone.peer.fetch(`/api/works/${f.ownWork.id}/import-upload`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(name) }, body: new Blob([pdf]) });
    expect(done.status).toBe(200);
    const path = ((await done.json()) as { files: { path: string }[] }).files[0]!.path;
    expect(path.split("/").pop()).toBe(`_${name}`);
  }
}, 30_000);
