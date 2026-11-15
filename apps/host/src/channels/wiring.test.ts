import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ChannelsState, DeviceGrant } from "@workbench/contracts";
import { EventBus } from "../bus.ts";
import { scopedEvent, scopedRoute } from "../devices/scope.ts";
import { createHttpServer } from "../http.ts";
import { OfficeVault } from "../office-vault.ts";
import { Pkm } from "../pkm.ts";
import { Projects } from "../project.ts";
import { SessionManager } from "../sessions.ts";
import { Store } from "../store.ts";
import { UpdatePolicy } from "../update-policy.ts";
import { FAKE_TOKEN, FakeTelegram } from "./fake-telegram.ts";
import { gatewayChannels } from "./gateway.ts";
import { ChannelService } from "./service.ts";
import { StandInEngine, until } from "./test-kit.ts";

// The channel as the gateway runs it: mounted on the gateway's HTTP server behind its local token,
// out of reach of paired remote devices, started in either host mode, reconnected after the PC
// slept, and part of the gateway's update and stop paths. Every Bot API call goes to a stand-in on
// 127.0.0.1.

const TOKEN = "local-token-for-tests-0123456789abcdef";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

async function gateway(options: { wake?: { everyMs: number; now: () => number }; projects?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wb-channel-wiring-"));
  const dataDir = join(dir, "data");
  mkdirSync(dataDir, { recursive: true });
  const fake = new FakeTelegram();
  await fake.start();
  const store = new Store(join(dataDir, "state.sqlite"));
  const bus = new EventBus();
  const manager = new SessionManager(store, bus, { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dataDir, "works"), dataDir });
  const engine = new StandInEngine(() => manager.sink);
  manager.registerAdapter(engine);
  const vault = new OfficeVault(dataDir, async () => ({ id: "d".repeat(32), key: Buffer.alloc(32, 5) }));
  const projects = options.projects ? new Projects(store, bus, manager, new Pkm(store, bus, manager, { dataDir })) : undefined;
  const channels = new ChannelService({ dataDir, store, manager, bus, vault, telegramUrl: fake.url, telegram: { pollSeconds: 1, minSendGapMs: 0 }, ...(options.wake ? { wake: options.wake } : {}), ...(projects ? { projects } : {}) });
  const updatePolicy = new UpdatePolicy(manager, store);
  const server: Server = createHttpServer(manager, bus, { token: TOKEN, webDir: null, channels, updatePolicy });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await channels.start();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await channels.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await manager.shutdown();
    store.close();
    await fake.stop();
    rmSync(dir, { recursive: true, force: true });
  };
  cleanups.push(close);
  const api = async (method: string, path: string, body?: unknown, token: string | null = TOKEN) => {
    const response = await fetch(`${origin}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, text, json: (text ? JSON.parse(text) : null) as Record<string, unknown> };
  };
  const state = async () => (await api("GET", "/api/channels")).json as unknown as ChannelsState;
  const pair = async () => {
    expect((await api("POST", "/api/channels/telegram/bots", { token: FAKE_TOKEN })).status).toBe(200);
    const started = await api("POST", `/api/channels/telegram/bots/${fake.botId}/pairing`, {});
    fake.message(`/start ${new URL(String(started.json.link)).searchParams.get("start")!}`);
    await until(async () => Boolean((await state()).bots[0]?.pairing.request));
    const request = (await state()).bots[0]!.pairing.request!;
    expect((await api("POST", `/api/channels/telegram/bots/${fake.botId}/pairing/${request.id}`, { approve: true })).status).toBe(200);
    await until(() => fake.texts().some((text) => text.startsWith("연결되었습니다")));
  };
  return { dataDir, fake, store, manager, engine, channels, updatePolicy, api, state, pair, close, projects };
}

describe("on the gateway's HTTP server", () => {
  it("answers /api/channels only with the gateway's local token, and never gives the token back", async () => {
    const g = await gateway();
    expect((await g.api("GET", "/api/channels", undefined, null)).status).toBe(401);
    expect((await g.api("POST", "/api/channels/telegram/bots", { token: FAKE_TOKEN }, "wrong-token")).status).toBe(401);
    expect(await g.state()).toEqual({ bots: [] });
    const registered = await g.api("POST", "/api/channels/telegram/bots", { token: FAKE_TOKEN });
    expect(registered.status).toBe(200);
    expect(registered.text).not.toContain(FAKE_TOKEN);
    expect((await g.state()).bots).toMatchObject([{ id: g.fake.botId, token: "sealed" }]);
    expect((await g.api("GET", "/api/channels/nothing-here")).status).toBe(404);
  });

  it("gives the pairing link once with its QR picture, and no later answer repeats the one-time value", async () => {
    const g = await gateway();
    await g.api("POST", "/api/channels/telegram/bots", { token: FAKE_TOKEN });
    const started = await g.api("POST", `/api/channels/telegram/bots/${g.fake.botId}/pairing`, {});
    expect(started.status).toBe(200);
    expect(String(started.json.qr)).toMatch(/^data:image\/svg\+xml;base64,/);
    const value = new URL(String(started.json.link)).searchParams.get("start")!;
    expect(value).toHaveLength(22);
    // The picture is of that link and nothing else.
    expect(Buffer.from(String(started.json.qr).split(",")[1]!, "base64").toString("utf8")).toContain("<svg");
    for (const path of ["/api/channels", "/api/channels/audit"]) expect((await g.api("GET", path)).text).not.toContain(value);
  });
});

describe("the menu through the Telegram adapter", () => {
  it("edits one message in place, binds its buttons to that message, and reaches the project note the gateway gives it", async () => {
    const g = await gateway({ projects: true });
    const work = g.manager.createWork({ title: "연구계획서", titleSource: "user" });
    g.manager.createSession(work.id, { provider: "claude", purpose: "예산표 정리", access: "full" });
    await g.pair();
    g.fake.message("메뉴");
    await until(() => g.fake.texts().some((text) => text.startsWith("메뉴 · 지금:")));
    const note = g.fake.button("프로젝트 노트");
    const sentBefore = g.fake.of("sendMessage").length;
    g.fake.press(note.data, { messageId: note.messageId });
    await until(() => (g.fake.shown(note.messageId) ?? "").startsWith("「연구계획서」 노트"));
    // The same message was edited; nothing new was sent.
    expect(g.fake.of("sendMessage").length).toBe(sentBefore);
    const add = g.fake.button("결정 추가");
    expect(add.messageId).toBe(note.messageId);
    // Pressed on another message (a copied keyboard): nothing.
    g.fake.press(add.data, { messageId: 999 });
    await until(() => g.fake.of("answerCallbackQuery").some((call) => call.params.text === "쓸 수 없는 버튼입니다"));
    expect(g.fake.shown(note.messageId)).toMatch(/^「연구계획서」 노트/);
    g.fake.press(add.data, { messageId: add.messageId });
    await until(() => g.fake.shown(note.messageId) === "'결정'에 남길 말을 적어 보내 주세요.");
    g.fake.message("2차 심사는 12월 첫 주로");
    await until(() => g.fake.texts().includes("「연구계획서」 노트 '결정'에 추가했습니다."));
    expect(g.projects!.note(work).decisions.map((entry) => entry.text)).toEqual([expect.stringContaining("2차 심사는 12월 첫 주로")]);
    expect(g.engine.sent).toEqual([]);
  });
});

describe("files through the Telegram adapter", () => {
  it("takes a picture from the phone as an attachment of the request, and sends back a file the answer names", async () => {
    const g = await gateway();
    await g.pair();
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    g.fake.file("ph-1", "photos/file_3.jpg", png);
    g.fake.message("이거 표로 정리해 줘", { extra: { photo: [{ file_id: "ph-1", file_size: png.length, width: 1, height: 1 }] } });
    await until(() => g.engine.sent.length === 1, 8000);
    const { sessionId } = g.engine.sent[0]!;
    const request = g.manager.items(sessionId).items.find((item) => item.kind === "user");
    expect(request).toMatchObject({ kind: "user", attachments: [expect.objectContaining({ mime: "image/png", size: png.length })] });
    const cwd = g.manager.workCwd(g.manager.snapshot().sessions.find((entry) => entry.id === sessionId)!.workId);
    writeFileSync(join(cwd, "일정표.csv"), "주,내용\n1,개강\n");
    // A name in the project folder for a file of the gateway's own data folder: kept back, whatever it is called.
    writeFileSync(join(g.dataDir, "kept.json"), "{}");
    symlinkSync(join(g.dataDir, "kept.json"), join(cwd, "백업.txt"));
    g.engine.say(sessionId, "칠판의 일정표를 표로 옮겼습니다.\n파일: 일정표.csv\n파일: 백업.txt");
    g.engine.finish(sessionId);
    await until(() => g.fake.of("sendDocument").length === 1, 8000);
    expect(g.fake.of("sendDocument")[0]!.file).toMatchObject({ field: "document", name: "일정표.csv", bytes: Buffer.byteLength("주,내용\n1,개강\n") });
    expect(g.fake.texts().find((text) => text.startsWith("칠판의 일정표를 표로 옮겼습니다."))).toContain("「백업.txt」은(는) 비밀이 들어 있을 수 있어 보내지 않았습니다.");
    // The file's address at Telegram (it carries the token) is nowhere in the data folder.
    const files = readdirSync(g.dataDir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
    for (const file of files) expect(readFileSync(join(file.parentPath, file.name), "latin1").includes(FAKE_TOKEN), file.name).toBe(false);
  });
});

describe("an upload failing mid-answer through the Telegram adapter (C2)", () => {
  it.each([["refuse", "「나.txt」은(는) 보내지 못했습니다. PC에서 열어 보세요."], ["busy", "「나.txt」은(는) 전달되지 않았을 수 있습니다. PC에서 확인해 주세요."]] as const)("sends the answer once when an upload answers %s, and names the file that did not go", async (fault, line) => {
    const g = await gateway();
    await g.pair();
    g.fake.message("파일 세 개 만들어 줘");
    await until(() => g.engine.sent.length === 1, 8000);
    const { sessionId } = g.engine.sent[0]!;
    const cwd = g.manager.workCwd(g.manager.snapshot().sessions.find((entry) => entry.id === sessionId)!.workId);
    for (const name of ["가.txt", "나.txt", "다.txt"]) writeFileSync(join(cwd, name), name);
    g.fake.nextUpload = [null, fault];
    g.engine.say(sessionId, "세 파일을 만들었습니다.\n파일: 가.txt\n파일: 나.txt\n파일: 다.txt");
    g.engine.finish(sessionId);
    await until(() => g.fake.texts().includes(line), 8000);
    // Long enough for the core's own retries (1 s, 3 s) to have sent it again, had it read the send as failed.
    await new Promise((done) => setTimeout(done, 4500));
    expect(g.fake.texts().filter((text) => text.startsWith("세 파일을 만들었습니다."))).toHaveLength(1);
    expect(g.fake.of("sendDocument").map((call) => call.file?.name)).toEqual(["가.txt", "다.txt"]);
    const binding = (await g.state()).bots[0]!.bindings[0]!;
    expect(binding.undelivered ?? null).toBeNull();
    expect(binding.uncertain ?? null).toBeNull();
  }, 20_000);
});

describe("a Hangul document's first page through the Telegram adapter", () => {
  it("reaches the chat as a photo with a PNG signature, the original as a document", async () => {
    const g = await gateway();
    await g.pair();
    g.fake.message("강의계획서 만들어 줘");
    await until(() => g.engine.sent.length === 1, 8000);
    const { sessionId } = g.engine.sent[0]!;
    const workId = g.manager.snapshot().sessions.find((entry) => entry.id === sessionId)!.workId;
    const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "강의계획서.hwpx");
    writeFileSync(join(g.manager.workCwd(workId), "강의계획서.hwpx"), readFileSync(fixture));
    const artifact = g.manager.openFile(workId, "강의계획서.hwpx");
    g.manager.sink.upsertItem(sessionId, { kind: "artifact", id: "artifact:1", artifactId: artifact.id, revision: artifact.revision, change: "created", at: Date.now() });
    g.engine.say(sessionId, "강의계획서를 만들었습니다.");
    g.engine.finish(sessionId);
    await until(() => g.fake.of("sendPhoto").length === 1, 20_000);
    expect(g.fake.of("sendDocument").map((call) => call.file)).toEqual([{ field: "document", name: "강의계획서.hwpx", bytes: readFileSync(fixture).length, head: readFileSync(fixture).subarray(0, 8).toString("hex") }]);
    expect(g.fake.of("sendPhoto")[0]!.file).toMatchObject({ field: "photo", name: "강의계획서 1쪽.png", head: "89504e470d0a1a0a" });
    expect(g.fake.of("sendPhoto")[0]!.params.caption).toBe("1쪽 미리보기 · 강의계획서.hwpx");
  }, 30_000);
});

describe("paired remote devices", () => {
  it("cannot reach any channel route, not even with every permission, and are not sent its events", async () => {
    const g = await gateway();
    const grant = { deviceId: "d1", name: "다른 기기", permissions: ["read", "send", "approve", "cancel", "terminal"], workIds: [], createdAt: 0, activatedAt: 0, expiresAt: null, revokedAt: null, platform: null } as unknown as DeviceGrant;
    const routes: [string, string, Record<string, unknown>][] = [
      ["GET", "/api/channels", {}],
      ["GET", "/api/channels/audit", {}],
      ["POST", "/api/channels/telegram/bots", { token: FAKE_TOKEN }],
      ["POST", `/api/channels/telegram/bots/${g.fake.botId}/pairing`, {}],
      ["POST", `/api/channels/telegram/bots/${g.fake.botId}/pairing/r1`, { approve: true }],
      ["PATCH", "/api/channels/bindings/b1", { locked: false }],
      ["DELETE", `/api/channels/telegram/bots/${g.fake.botId}`, {}],
    ];
    for (const [method, path, body] of routes) {
      let refused: unknown = null;
      try { scopedRoute(g.manager, method, path, body); } catch (error) { refused = error; }
      expect(refused, `${method} ${path}`).toMatchObject({ status: 403, code: "CAPABILITY_DENIED" });
    }
    expect(scopedEvent({ type: "channels.changed", seq: 1 } as never, g.manager, grant)).toBeNull();
  });
});

describe("the gateway's update and stop paths", () => {
  it("an idle channel does not hold up an update; a turn the channel runs holds it up like any other turn", async () => {
    const g = await gateway();
    await g.pair();
    await until(async () => (await g.state()).bots[0]!.status.state === "connected");
    expect(g.updatePolicy.status().blockers).toEqual([]);
    expect(g.updatePolicy.prepare()).toMatchObject({ state: "ready", blockers: [] });
    g.updatePolicy.cancel();

    g.fake.message("논문 세 편 요약해 줘");
    await until(() => g.engine.sent.length === 1);
    const turn = g.engine.sent[0]!;
    await until(() => g.updatePolicy.status().blockers.length > 0);
    expect(g.updatePolicy.prepare()).toMatchObject({ state: "draining" });
    g.engine.finish(turn.sessionId);
    await until(() => g.updatePolicy.status().state === "ready");

    // While the gateway waits for an update, a line from the phone starts nothing and is answered.
    g.fake.message("하나 더 해 줘");
    await until(() => g.fake.texts().includes("PC가 업데이트를 준비하고 있어 지금은 새 일을 시작하지 않습니다. 업데이트가 끝나면 다시 보내 주세요."));
    expect(g.engine.sent).toHaveLength(1);
    expect(g.channels.core.auditList()[0]).toMatchObject({ action: "refused", result: "updating" });
  });

  it("stops receiving when the gateway stops: no request reaches the Bot API afterwards", async () => {
    const g = await gateway();
    await g.pair();
    await until(async () => (await g.state()).bots[0]!.status.state === "connected");
    await g.channels.close();
    const calls = g.fake.calls.length;
    await new Promise((done) => setTimeout(done, 1_300));
    expect(g.fake.calls.length).toBe(calls);
  });
});

describe("sleep", () => {
  it("connects again at once when the PC wakes (the wall clock jumped), not after the old poll times out", async () => {
    let now = Date.now();
    const g = await gateway({ wake: { everyMs: 20, now: () => now } });
    await g.api("POST", "/api/channels/telegram/bots", { token: FAKE_TOKEN });
    await until(async () => (await g.state()).bots[0]!.status.state === "connected");
    const starts = () => g.fake.of("deleteWebhook").length;
    const before = starts();
    // Ticks in step with the clock: no reconnect.
    for (let i = 0; i < 5; i += 1) { now += 20; await new Promise((done) => setTimeout(done, 20)); }
    expect(starts()).toBe(before);
    // Ten minutes pass between two ticks: the PC slept.
    now += 10 * 60_000;
    await until(() => starts() === before + 1);
    await until(async () => (await g.state()).bots[0]!.status.state === "connected");
  });
});

describe("which gateway runs the channel", () => {
  const deps = () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-channel-env-"));
    const store = new Store(join(dir, "state.sqlite"));
    const bus = new EventBus();
    const manager = new SessionManager(store, bus, { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works"), dataDir: dir });
    cleanups.push(async () => { await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
    return { dataDir: dir, store, manager, bus };
  };

  it("runs in the window's gateway and in the background service alike, but not in a one-off command-line gateway", () => {
    expect(gatewayChannels({ WORKBENCH_HOST_MODE: "service" }, deps())).toBeInstanceOf(ChannelService);
    expect(gatewayChannels({}, deps())).toBeInstanceOf(ChannelService);
    expect(gatewayChannels({ WORKBENCH_CLI_INPUT: "/tmp/x.hwpx" }, deps())).toBeUndefined();
  });

  it("lets a check point the Bot API at a stand-in on this machine only", () => {
    expect(gatewayChannels({ WORKBENCH_TELEGRAM_API: "http://127.0.0.1:4567" }, deps())!.telegramApi).toBe("http://127.0.0.1:4567");
    expect(gatewayChannels({ WORKBENCH_TELEGRAM_API: "http://localhost:4567/" }, deps())!.telegramApi).toBe("http://localhost:4567");
    for (const elsewhere of ["https://evil.example", "http://10.0.0.2:80", "http://127.0.0.1.evil.example", "not a url"])
      expect(gatewayChannels({ WORKBENCH_TELEGRAM_API: elsewhere }, deps())!.telegramApi, elsewhere).toBe("https://api.telegram.org");
    expect(gatewayChannels({}, deps())!.telegramApi).toBe("https://api.telegram.org");
  });
});

describe("fix round 1", () => {
  it("lets the PC pause, lock, unlock, resume and disconnect while an update is being prepared, and nothing else of the channel", async () => {
    const g = await gateway();
    await g.pair();
    const binding = (await g.state()).bots[0]!.bindings[0]!;
    g.updatePolicy.prepare();
    for (const body of [{ paused: true }, { locked: true }, { locked: false }, { paused: false }, { revoked: true }])
      expect((await g.api("PATCH", `/api/channels/bindings/${binding.id}`, body)).status, JSON.stringify(body)).toBe(200);
    expect((await g.state()).bots[0]!.bindings).toEqual([]);
    expect((await g.api("POST", "/api/channels/telegram/bots", { token: FAKE_TOKEN })).json).toMatchObject({ code: "host_draining" });
    expect((await g.api("POST", `/api/channels/telegram/bots/${g.fake.botId}/pairing`, {})).json).toMatchObject({ code: "host_draining" });
  });

  it("a gateway stop does not wait for a start still under way: close cancels it and nothing keeps running", async () => {
    const g = await gateway();
    await g.api("POST", "/api/channels/telegram/bots", { token: FAKE_TOKEN });
    await g.channels.close();
    // A start that has not got far yet, then the stop.
    const starting = g.channels.start();
    const closing = g.channels.close();
    await closing;
    await starting;
    expect(g.channels.core.running).toBe(false);
    const polls = g.fake.of("getUpdates").length;
    await new Promise((done) => setTimeout(done, 1_300));
    expect(g.fake.of("getUpdates").length).toBe(polls);
  });

  it("the record keeps the names of chats that were disconnected", async () => {
    const g = await gateway();
    await g.pair();
    const binding = (await g.state()).bots[0]!.bindings[0]!;
    await g.api("PATCH", `/api/channels/bindings/${binding.id}`, { revoked: true });
    const record = (await g.api("GET", "/api/channels/audit")).json as { rows: { bindingId: string | null }[]; names: Record<string, string> };
    expect(record.rows.some((row) => row.bindingId === binding.id)).toBe(true);
    expect(record.names).toEqual({ [binding.id]: "길동 홍" });
  });

  it("the wake reconnect leaves a bot in conflict alone", async () => {
    let now = Date.now();
    const g = await gateway({ wake: { everyMs: 20, now: () => now } });
    await g.api("POST", "/api/channels/telegram/bots", { token: FAKE_TOKEN });
    g.fake.conflict = true;
    await until(async () => (await g.state()).bots[0]!.status.state === "conflict", 8_000);
    const starts = g.fake.of("deleteWebhook").length;
    now += 10 * 60_000;
    await new Promise((done) => setTimeout(done, 200));
    expect(g.fake.of("deleteWebhook").length).toBe(starts);
    expect((await g.state()).bots[0]!.status.state).toBe("conflict");
  });
});

describe("fix round 2", () => {
  it("cancels an unscanned pairing value through DELETE …/pairing, and removing the bot cancels it too", async () => {
    const g = await gateway();
    await g.api("POST", "/api/channels/telegram/bots", { token: FAKE_TOKEN });
    const first = await g.api("POST", `/api/channels/telegram/bots/${g.fake.botId}/pairing`, {});
    expect((await g.api("DELETE", `/api/channels/telegram/bots/${g.fake.botId}/pairing`)).status).toBe(200);
    g.fake.message(`/start ${new URL(String(first.json.link)).searchParams.get("start")}`);
    await new Promise((done) => setTimeout(done, 400));
    expect((await g.state()).bots[0]!.pairing.request).toBeNull();
    // Removing the bot leaves no live value behind either.
    const second = await g.api("POST", `/api/channels/telegram/bots/${g.fake.botId}/pairing`, {});
    await g.api("DELETE", `/api/channels/telegram/bots/${g.fake.botId}`);
    await g.api("POST", "/api/channels/telegram/bots", { token: FAKE_TOKEN });
    g.fake.message(`/start ${new URL(String(second.json.link)).searchParams.get("start")}`);
    await new Promise((done) => setTimeout(done, 400));
    expect((await g.state()).bots[0]!.pairing.request).toBeNull();
  });
});

describe("seams before install", () => {
  it("seals the bot token with the vault the gateway gives it (one vault, one key creation)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-channel-vault-"));
    const fake = new FakeTelegram();
    await fake.start();
    const store = new Store(join(dir, "state.sqlite"));
    const bus = new EventBus();
    const manager = new SessionManager(store, bus, { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works"), dataDir: dir });
    const loads: boolean[] = [];
    const vault = new OfficeVault(dir, async (create) => { loads.push(create); return { id: "e".repeat(32), key: Buffer.alloc(32, 9) }; });
    const channels = gatewayChannels({ WORKBENCH_TELEGRAM_API: fake.url }, { dataDir: dir, store, manager, bus, vault })!;
    cleanups.push(async () => { await channels.close(); await manager.shutdown(); store.close(); await fake.stop(); rmSync(dir, { recursive: true, force: true }); });
    await channels.start();
    await channels.registerTelegram(FAKE_TOKEN);
    expect(loads).toEqual([true]);
    expect(readFileSync(join(dir, "channels", "bots.json"), "utf8")).toContain(`sealed:v1:workbench:${"e".repeat(32)}:channel:`);
  });

  it("stop all work: the channel is closed before the turns are interrupted, so nothing is sent while the gateway exits", async () => {
    const g = await gateway();
    await g.pair();
    g.updatePolicy.beforeInterrupt = () => g.channels.close();
    g.fake.message("논문 세 편 요약해 줘");
    await until(() => g.engine.sent.length === 1);
    await until(() => g.fake.texts().includes("작업 중 · 0:00"));
    const sent = g.fake.of("sendMessage").length;
    await g.updatePolicy.stop("interrupt");
    expect(g.engine.interrupted).toHaveLength(1);
    expect(g.channels.core.running).toBe(false);
    await new Promise((done) => setTimeout(done, 300));
    expect(g.fake.of("sendMessage").length).toBe(sent);
  });

  it("a drain (prepare-update) does not close the channel", async () => {
    const g = await gateway();
    await g.pair();
    let closed = false;
    g.updatePolicy.beforeInterrupt = async () => { closed = true; };
    await g.updatePolicy.stop("drain");
    expect(closed).toBe(false);
  });
});
