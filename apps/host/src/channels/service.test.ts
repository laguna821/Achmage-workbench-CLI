import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelsState } from "@workbench/contracts";
import { EventBus } from "../bus.ts";
import { HttpError } from "../errors.ts";
import { sendJson } from "../http.ts";
import { OfficeVault, nativeOfficeVault } from "../office-vault.ts";
import { SessionManager } from "../sessions.ts";
import { Store } from "../store.ts";
import { FAKE_TOKEN, FakeTelegram } from "./fake-telegram.ts";
import { ChannelService } from "./service.ts";
import { StandInEngine, until } from "./test-kit.ts";

// The channel as the PC screen will use it: over HTTP, with a stand-in Bot API on loopback, a
// stand-in keyring and a stand-in engine. No test here reaches Telegram or the OS keyring.

type Rig = Awaited<ReturnType<typeof rig>>;
const rigs: { stop(): Promise<void> }[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const entry of rigs.splice(0)) await entry.stop(); });

async function open(dir: string, fake: FakeTelegram, keyring: boolean) {
  const dataDir = join(dir, "data");
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(join(dataDir, "state.sqlite"));
  const bus = new EventBus();
  const manager = new SessionManager(store, bus, { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dataDir, "works"), dataDir });
  const engine = new StandInEngine(() => manager.sink);
  manager.registerAdapter(engine);
  const vault = keyring
    ? new OfficeVault(dataDir, async () => ({ id: "d".repeat(32), key: Buffer.alloc(32, 5) }))
    : new OfficeVault(dataDir, nativeOfficeVault(dataDir, "/missing-workbench-secret-binary"));
  const service = new ChannelService({ dataDir, store, manager, bus, vault, telegramUrl: fake.url, telegram: { pollSeconds: 1, minSendGapMs: 0 } });
  // As the gateway's HTTP server does for its other services: the handler behind the local token check.
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    service.handleManagement(req, res, url).then((handled) => { if (!handled) sendJson(res, 404, { code: "not_found", message: "" }); })
      .catch((error: unknown) => sendJson(res, error instanceof HttpError ? error.status : 500, { code: error instanceof HttpError ? error.code : "error", message: error instanceof Error ? error.message : "" }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${origin}${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, text, json: (text ? JSON.parse(text) : null) as Record<string, unknown> };
  };
  await service.start();
  const close = async () => {
    await service.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await manager.shutdown();
    store.close();
  };
  return { dataDir, store, bus, manager, engine, service, api, close };
}

async function rig(options: { keyring?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wb-channel-service-"));
  const fake = new FakeTelegram();
  await fake.start();
  let gateway = await open(dir, fake, options.keyring !== false);
  let running = true;
  const down = async () => { if (running) { running = false; await gateway.close(); } };
  const up = async (keyring = options.keyring !== false) => { gateway = await open(dir, fake, keyring); running = true; };
  const entry = {
    dir, fake, down, up,
    get g() { return gateway; },
    /** The gateway stops and starts again on the same data folder. */
    async restart(keyring = options.keyring !== false) { await down(); await up(keyring); },
    async stop() { await down(); await fake.stop(); rmSync(dir, { recursive: true, force: true }); },
    state: async () => (await gateway.api("GET", "/api/channels")).json as unknown as ChannelsState,
  };
  rigs.push(entry);
  return entry;
}
/** Every file under the data folder, as text. */
function everything(dir: string): string {
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => readFileSync(join(entry.parentPath, entry.name), "latin1")).join("\n");
}
async function register(r: Rig) {
  const response = await r.g.api("POST", "/api/channels/telegram/bots", { token: FAKE_TOKEN });
  expect(response.status).toBe(200);
  return response;
}
/** Pair the stand-in phone (user 555) through the routes the PC screen uses. */
async function pair(r: Rig) {
  const started = await r.g.api("POST", `/api/channels/telegram/bots/${r.fake.botId}/pairing`, {});
  const code = new URL(String(started.json.link)).searchParams.get("start")!;
  r.fake.message(`/start ${code}`);
  await until(async () => Boolean((await r.state()).bots[0]?.pairing.request));
  const request = (await r.state()).bots[0]!.pairing.request!;
  const approved = await r.g.api("POST", `/api/channels/telegram/bots/${r.fake.botId}/pairing/${request.id}`, { approve: true });
  expect(approved.status).toBe(200);
  await until(() => r.fake.texts().some((text) => text.startsWith("연결되었습니다")));
  return { started, request };
}

describe("registering a bot", () => {
  it("checks the token with getMe, seals it, starts receiving, and never gives the token back", async () => {
    const r = await rig();
    expect(await r.state()).toEqual({ bots: [] });
    const response = await register(r);
    const state = response.json as unknown as ChannelsState;
    expect(state.bots).toMatchObject([{ kind: "telegram", id: r.fake.botId, username: "wb_7k3q9x_bot", name: "홍길동의 Workbench", token: "sealed", pairing: { expiresAt: null, request: null, lockedUntil: null }, bindings: [] }]);
    expect(response.text).not.toContain(FAKE_TOKEN);
    expect((await r.g.api("GET", "/api/channels")).text).not.toContain(FAKE_TOKEN);
    // On disk only as a sealed value; nowhere in the database or the log.
    expect(readFileSync(join(r.g.dataDir, "channels", "bots.json"), "utf8")).toContain("sealed:v1:workbench:");
    expect(everything(r.g.dataDir)).not.toContain(FAKE_TOKEN);
    await until(() => r.fake.of("getUpdates").length > 0);
    await until(async () => (await r.state()).bots[0]!.status.state === "connected");
    expect(r.fake.of("setMyDescription")[0]!.params.description).toBe("이 봇은 PC가 켜져 있을 때 답합니다.");
  });

  it("refuses a token Telegram does not know and keeps nothing", async () => {
    const r = await rig();
    const wrong = "7000000009:AAF" + "q".repeat(8) + "-Fake_token-for-loopback-09";
    const response = await r.g.api("POST", "/api/channels/telegram/bots", { token: wrong });
    expect(response).toMatchObject({ status: 400, json: { code: "channel_token_invalid" } });
    expect(response.text).not.toContain(wrong);
    expect(await r.state()).toEqual({ bots: [] });
    expect(existsSync(join(r.g.dataDir, "channels", "bots.json"))).toBe(false);
  });

  it("without an OS keyring stores nothing and says why; the token can be kept for this run only", async () => {
    const r = await rig({ keyring: false });
    const refused = await r.g.api("POST", "/api/channels/telegram/bots", { token: FAKE_TOKEN });
    expect(refused).toMatchObject({ status: 503, json: { code: "office_vault_unavailable" } });
    expect(await r.state()).toEqual({ bots: [] });
    expect(everything(r.g.dataDir)).not.toContain(FAKE_TOKEN);
    const kept = await r.g.api("POST", "/api/channels/telegram/bots", { token: FAKE_TOKEN, memoryOnly: true });
    expect(kept.status).toBe(200);
    expect((kept.json as unknown as ChannelsState).bots[0]).toMatchObject({ id: r.fake.botId, token: "memory" });
    await until(() => r.fake.of("getUpdates").length > 0);
    expect(everything(r.g.dataDir)).not.toContain(FAKE_TOKEN);
    // After a restart the bot is still listed, without a token: it has to be entered again.
    const polls = r.fake.of("getUpdates").length;
    await r.restart(false);
    expect((await r.state()).bots[0]).toMatchObject({ id: r.fake.botId, token: "none", status: { state: "stopped", detail: "토큰을 다시 넣어 주세요." } });
    await new Promise((done) => setTimeout(done, 60));
    expect(r.fake.of("getUpdates").length).toBe(polls);
  });

  it("takes a new token for the same bot, and refuses another bot while one is registered", async () => {
    const r = await rig();
    await register(r);
    expect((await r.g.api("POST", "/api/channels/telegram/bots", { token: FAKE_TOKEN })).status).toBe(200);
    expect((await r.state()).bots).toHaveLength(1);
    const other = "7000000002:AAF" + "m".repeat(8) + "-Fake_token-for-loopback-02";
    r.fake.others.add(other);
    expect(await r.g.api("POST", "/api/channels/telegram/bots", { token: other })).toMatchObject({ status: 409, json: { code: "channel_bot_exists" } });
    expect((await r.state()).bots.map((bot) => bot.id)).toEqual([r.fake.botId]);
    expect(everything(r.g.dataDir)).not.toContain(other);
  });
});

describe("from the phone to the conversation and back", () => {
  it("pairs through the PC's link, runs a line once in a full-access conversation, and answers in the chat", async () => {
    const r = await rig();
    await register(r);
    const { started, request } = await pair(r);
    expect(String(started.json.link)).toMatch(/^https:\/\/t\.me\/wb_7k3q9x_bot\?start=[A-Za-z0-9_-]{22}$/);
    expect(request).toMatchObject({ displayName: "길동 홍", handle: "hong" });
    expect(r.fake.texts()[0]).toBe(`PC 화면에 같은 숫자가 보이면 PC에서 [연결]을 눌러 주세요: ${request.digits.split("").join(" ")}`);
    expect((await r.state()).bots[0]!.bindings).toMatchObject([{ displayName: "길동 홍", userId: "555", pausedAt: null, lockedAt: null }]);

    r.fake.message("3학년만 뽑아서 따로 저장해 줘");
    await until(() => r.g.engine.sent.length === 1);
    const turn = r.g.engine.sent[0]!;
    expect(turn.access).toBe("full");
    expect(turn.text.endsWith("3학년만 뽑아서 따로 저장해 줘")).toBe(true);
    await until(() => r.fake.texts().includes("작업 중 · 0:00"));
    r.g.engine.say(turn.sessionId, "3학년 27명을 「명단-3학년.xlsx」로 저장했습니다.");
    r.g.engine.finish(turn.sessionId);
    // The answer, with the footer under it (unit 14).
    await until(() => r.fake.texts().some((text) => text.startsWith("3학년 27명을 「명단-3학년.xlsx」로 저장했습니다.\n\nClaude · ")));
    expect(r.fake.of("editMessageText").at(-1)!.params.text).toMatch(/^끝남 · \d+:\d{2}$/);
    // The pointer is shown to the PC screen by name.
    expect((await r.state()).bots[0]!.bindings[0]!.pointerLabel).toMatch(/^「휴대폰」 › 「휴대폰 · \d+\/\d+」/);
    // The stop word, and a group: it leaves.
    r.fake.message("오래 걸리는 일");
    await until(() => r.g.engine.sent.length === 2);
    r.fake.message("/stop");
    await until(() => r.g.engine.interrupted.length === 1);
    await until(() => r.fake.texts().includes("멈췄습니다."));
    r.fake.message("안녕", { chatId: -100200, chatType: "group" });
    await until(() => r.fake.of("leaveChat").length === 1);
    expect(r.g.engine.sent).toHaveLength(2);
    // Nothing that was said is in the log or the audit trail; no token anywhere.
    const audit = (await r.g.api("GET", "/api/channels/audit")).text;
    const log = readFileSync(join(r.g.dataDir, "channels", "channel.log"), "utf8");
    for (const secret of ["3학년", "오래 걸리는 일", FAKE_TOKEN]) expect(audit + log).not.toContain(secret);
    expect((JSON.parse(audit) as { rows: { action: string }[] }).rows.map((row) => row.action)).toEqual(expect.arrayContaining(["pairing.started", "paired", "request", "stop", "refused"]));
  });

  it("runs once a line that arrived while the gateway was down, after a restart with the sealed token", async () => {
    const r = await rig();
    await register(r);
    await pair(r);
    r.fake.message("첫 일");
    await until(() => r.g.engine.sent.length === 1);
    await until(() => r.fake.pending() === 0);
    await r.down();
    r.fake.message("꺼져 있는 동안 온 일");
    await r.up();
    await until(() => r.g.engine.sent.length === 1);
    expect(r.g.engine.sent[0]!.text.endsWith("꺼져 있는 동안 온 일")).toBe(true);
    await until(() => r.fake.pending() === 0);
    await new Promise((done) => setTimeout(done, 100));
    expect(r.g.engine.sent).toHaveLength(1);
    expect((await r.state()).bots[0]).toMatchObject({ token: "sealed", status: { state: "connected" } });
  });

  it("shows a conflict at the PC, and connects again when asked to after it is gone", async () => {
    const r = await rig();
    r.fake.conflict = true;
    await register(r);
    await until(async () => (await r.state()).bots[0]!.status.state === "conflict");
    expect((await r.state()).bots[0]!.status.detail).toContain("다른 PC나 프로그램이 이 봇을 쓰고 있습니다.");
    r.fake.conflict = false;
    expect((await r.g.api("POST", `/api/channels/telegram/bots/${r.fake.botId}/reconnect`, {})).status).toBe(200);
    await until(async () => (await r.state()).bots[0]!.status.state === "connected");
  });
});

describe("the PC's switches", () => {
  it("pauses, resumes, unlocks and disconnects a paired chat, and lists the record", async () => {
    const r = await rig();
    await register(r);
    await pair(r);
    const bindingId = (await r.state()).bots[0]!.bindings[0]!.id;
    const patch = (body: unknown) => r.g.api("PATCH", `/api/channels/bindings/${bindingId}`, body);
    expect(((await patch({ paused: true })).json as unknown as ChannelsState).bots[0]!.bindings[0]!.pausedAt).not.toBeNull();
    r.fake.message("멈춘 동안 보낸 일");
    await until(() => r.fake.texts().includes("지금은 PC에서 채널을 멈춰 두었습니다."));
    expect(r.g.engine.sent).toEqual([]);
    expect(((await patch({ paused: false })).json as unknown as ChannelsState).bots[0]!.bindings[0]!.pausedAt).toBeNull();
    r.fake.message("잠금");
    await until(async () => (await r.state()).bots[0]!.bindings[0]!.lockedAt !== null);
    expect(((await patch({ locked: false })).json as unknown as ChannelsState).bots[0]!.bindings[0]!.lockedAt).toBeNull();
    expect(((await patch({ revoked: true })).json as unknown as ChannelsState).bots[0]!.bindings).toEqual([]);
    r.fake.message("끊긴 뒤에 보낸 일");
    await until(() => r.fake.texts().includes("이 봇은 개인용입니다."));
    expect(r.g.engine.sent).toEqual([]);
    const audit = (await r.g.api("GET", `/api/channels/audit?bindingId=${bindingId}&limit=50`)).json as { rows: { action: string; bindingId: string }[] };
    expect(audit.rows.map((row) => row.action)).toEqual(["revoked", "unlock", "lock", "resume", "refused", "pause", "paired"]);
    expect((await r.g.api("PATCH", "/api/channels/bindings/nobody", { paused: true })).status).toBe(404);
  });

  it("locks a chat from the PC too: what it runs stops, and only the PC unlocks it", async () => {
    const r = await rig();
    await register(r);
    await pair(r);
    const bindingId = (await r.state()).bots[0]!.bindings[0]!.id;
    r.fake.message("오래 걸리는 일");
    await until(() => r.g.engine.sent.length === 1);
    const locked = await r.g.api("PATCH", `/api/channels/bindings/${bindingId}`, { locked: true });
    expect(locked.status).toBe(200);
    expect((locked.json as unknown as ChannelsState).bots[0]!.bindings[0]!.lockedAt).not.toBeNull();
    await until(() => r.g.engine.interrupted.length === 1);
    r.fake.message("하나 더");
    await until(() => r.fake.texts().includes("채널이 잠겨 있습니다. PC에서만 풀 수 있습니다."));
    expect(r.g.engine.sent).toHaveLength(1);
  });

  it("says on the PC when Telegram refused an answer for good, and does not try it again", async () => {
    const r = await rig();
    await register(r);
    await pair(r);
    const bindingId = (await r.state()).bots[0]!.bindings[0]!.id;
    r.fake.message("요약해 줘");
    await until(() => r.g.engine.sent.length === 1);
    await until(() => r.fake.texts().includes("작업 중 · 0:00"));
    r.fake.nextSend.push("forbid");
    r.g.engine.say(r.g.engine.sent[0]!.sessionId, "요약했습니다.");
    r.g.engine.finish(r.g.engine.sent[0]!.sessionId);
    await until(async () => Boolean((await r.state()).bots[0]!.bindings[0]!.undelivered));
    const binding = (await r.state()).bots[0]!.bindings[0]!;
    expect(binding).toMatchObject({ id: bindingId, undelivered: { count: 1, reason: "텔레그램이 답을 받지 않았습니다(봇을 차단했을 수 있습니다)." } });
    const sends = r.fake.of("sendMessage").length;
    await r.restart();
    await until(async () => (await r.state()).bots[0]!.status.state === "connected");
    await new Promise((done) => setTimeout(done, 100));
    expect(r.fake.of("sendMessage").length).toBe(sends);
  });

  it("says no to a phone's request, and refuses a second owner", async () => {
    const r = await rig();
    await register(r);
    const started = await r.g.api("POST", `/api/channels/telegram/bots/${r.fake.botId}/pairing`, {});
    r.fake.message(`/start ${new URL(String(started.json.link)).searchParams.get("start")!}`);
    await until(async () => Boolean((await r.state()).bots[0]?.pairing.request));
    const request = (await r.state()).bots[0]!.pairing.request!;
    expect((await r.g.api("POST", `/api/channels/telegram/bots/${r.fake.botId}/pairing/${request.id}`, { approve: false })).status).toBe(200);
    expect((await r.state()).bots[0]).toMatchObject({ bindings: [], pairing: { request: null } });
    await pair(r);
    expect(await r.g.api("POST", `/api/channels/telegram/bots/${r.fake.botId}/pairing`, {})).toMatchObject({ status: 409, json: { code: "channel_owner_exists" } });
    expect((await r.g.api("POST", `/api/channels/telegram/bots/${r.fake.botId}/pairing`, { additional: true })).status).toBe(200);
  });

  it("removes a bot: its chats are disconnected, its token forgotten, its polling stopped", async () => {
    const r = await rig();
    await register(r);
    await pair(r);
    await until(() => r.fake.of("getUpdates").length > 1);
    expect((await r.g.api("DELETE", `/api/channels/telegram/bots/${r.fake.botId}`)).json).toEqual({ bots: [] });
    expect(readFileSync(join(r.g.dataDir, "channels", "bots.json"), "utf8")).not.toContain("sealed:v1:");
    await new Promise((done) => setTimeout(done, 250));
    const polls = r.fake.of("getUpdates").length;
    await new Promise((done) => setTimeout(done, 250));
    expect(r.fake.of("getUpdates").length).toBe(polls);
    expect(r.g.service.core.bindings().every((binding) => binding.revokedAt !== null)).toBe(true);
  });

  it("with no bot registered, starting touches nothing: no file, no listener, no hook, no timer; the first bot starts it and removing the last stops it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-channel-inert-"));
    const fake = new FakeTelegram();
    await fake.start();
    const dataDir = join(dir, "data");
    mkdirSync(dataDir, { recursive: true });
    const store = new Store(join(dataDir, "state.sqlite"));
    const bus = new EventBus();
    const manager = new SessionManager(store, bus, { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dataDir, "works"), dataDir });
    const vault = new OfficeVault(dataDir, async () => ({ id: "d".repeat(32), key: Buffer.alloc(32, 5) }));
    const service = new ChannelService({ dataDir, store, manager, bus, vault, telegramUrl: fake.url, telegram: { pollSeconds: 1, minSendGapMs: 0 } });
    rigs.push({ async stop() { await service.close(); await manager.shutdown(); store.close(); await fake.stop(); rmSync(dir, { recursive: true, force: true }); } });
    const listeners = (bus as unknown as { listeners: Set<unknown> }).listeners;
    const before = listeners.size;
    const intervals = vi.spyOn(globalThis, "setInterval"), timeouts = vi.spyOn(globalThis, "setTimeout");
    await service.start();
    expect(intervals).not.toHaveBeenCalled();
    expect(timeouts).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    expect(existsSync(join(dataDir, "channels"))).toBe(false);
    expect(listeners.size).toBe(before);
    expect(manager.channelHook).toBeNull();
    // The first registration starts the channel.
    await service.registerTelegram(FAKE_TOKEN);
    expect(manager.channelHook).not.toBeNull();
    expect(listeners.size).toBe(before + 1);
    await until(() => fake.of("getUpdates").length > 0);
    // Removing the last bot stops it again.
    await service.removeBot("telegram", fake.botId);
    expect(manager.channelHook).toBeNull();
    expect(listeners.size).toBe(before);
  });

  it("answers only its own routes", async () => {
    const r = await rig();
    expect((await r.g.api("GET", "/api/other")).status).toBe(404);
    expect((await r.g.api("GET", "/api/channels/nothing-here")).status).toBe(404);
    expect((await r.g.api("POST", "/api/channels/telegram/bots/1/pairing", {})).status).toBe(404);
    expect((await r.g.api("POST", "/api/channels/telegram/bots", { token: 12 })).status).toBe(400);
  });
});
