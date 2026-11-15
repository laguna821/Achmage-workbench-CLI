import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChannelsState } from "@workbench/contracts";
import { EventBus } from "../bus.ts";
import { HttpError } from "../errors.ts";
import { sendJson } from "../http.ts";
import { OfficeVault } from "../office-vault.ts";
import { SessionManager } from "../sessions.ts";
import { Store } from "../store.ts";
import { FAKE_APP_TOKEN, FAKE_BOT_TOKEN, FakeSlack } from "./fake-slack.ts";
import { FAKE_TOKEN, FakeTelegram } from "./fake-telegram.ts";
import { ChannelService } from "./service.ts";
import { StandInEngine, until } from "./test-kit.ts";

// "이 메신저의 기본 엔진" as the gateway runs it: kept with each bot's record (one per messenger), set
// from the PC's screen (PATCH /api/channels/:kind/bots/:id) or from the chat's engine screen, each
// seeing what the other set. Both stand-ins on 127.0.0.1; nothing here reaches Telegram or Slack.

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

type Rig = Awaited<ReturnType<typeof open>>;
const SLACK_CHAT = "D0HONG", TELEGRAM_CHAT = 555;

/** A gateway's channel with both stand-ins, a stand-in keyring, both engines, and the PC's routes over HTTP. */
async function open(at: { dir?: string; tg?: FakeTelegram; slack?: FakeSlack; codex?: boolean } = {}) {
  const dir = at.dir ?? mkdtempSync(join(tmpdir(), "wb-default-engine-"));
  const dataDir = join(dir, "data");
  mkdirSync(dataDir, { recursive: true });
  const tg = at.tg ?? new FakeTelegram(), slack = at.slack ?? new FakeSlack();
  if (!at.tg) await tg.start();
  if (!at.slack) await slack.start();
  const store = new Store(join(dataDir, "state.sqlite"));
  const bus = new EventBus();
  const manager = new SessionManager(store, bus, { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dataDir, "works"), dataDir });
  const claude = new StandInEngine(() => manager.sink), codex = new StandInEngine(() => manager.sink, "codex");
  manager.registerAdapter(claude);
  if (at.codex !== false) manager.registerAdapter(codex);
  const vault = new OfficeVault(dataDir, async () => ({ id: "d".repeat(32), key: Buffer.alloc(32, 5) }));
  const channels = new ChannelService({ dataDir, store, manager, bus, vault, telegramUrl: tg.url, telegram: { pollSeconds: 1, minSendGapMs: 0 }, slackUrl: slack.api, slack: { minSendGapMs: 0, pingMs: 5_000 }, log: () => undefined });
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    channels.handleManagement(req, res, url).then((handled) => { if (!handled) sendJson(res, 404, { code: "not_found", message: "" }); })
      .catch((error: unknown) => sendJson(res, error instanceof HttpError ? error.status : 500, { code: error instanceof HttpError ? error.code : "error", message: error instanceof Error ? error.message : "" }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${origin}${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, json: (text ? JSON.parse(text) : null) as Record<string, unknown> };
  };
  const events: string[] = [];
  bus.subscribe((event) => { events.push(event.type); });
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
  };
  cleanups.push(close);
  if (!at.tg && !at.slack) cleanups.unshift(async () => { await tg.stop(); await slack.stop(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, tg, slack, store, manager, claude, codex, channels, api, events, close };
}

const botOf = (r: Rig, kind: "telegram" | "slack") => r.channels.state().bots.find((bot) => bot.kind === kind)!;
const engineOf = (r: Rig, kind: "telegram" | "slack") => botOf(r, kind).defaultEngine;
const connected = (r: Rig, kind: "telegram" | "slack") => botOf(r, kind)?.status.state === "connected";
const bindingOf = (r: Rig, kind: "telegram" | "slack") => r.store.channels.bindings().find((binding) => binding.kind === kind && !binding.revokedAt)!;
const sessionOf = (r: Rig, id: string) => r.manager.snapshot().sessions.find((entry) => entry.id === id)!;
const pointerOf = (r: Rig, kind: "telegram" | "slack") => sessionOf(r, bindingOf(r, kind).pointerSessionId!);
const path = (r: Rig, kind: "telegram" | "slack") => `/api/channels/${kind}/bots/${kind === "telegram" ? r.tg.botId : r.slack.botId}`;
const settled = async (r: Rig) => { for (let round = 0; round < 3; round += 1) { await r.channels.core.idle(); await new Promise((done) => setTimeout(done, 20)); } };

async function registerBoth(r: Rig) {
  await r.channels.registerTelegram(FAKE_TOKEN);
  await r.channels.registerSlack(FAKE_BOT_TOKEN, FAKE_APP_TOKEN, { appName: "Workbench 노트북" });
  await until(() => connected(r, "telegram") && connected(r, "slack"));
}
async function pairTelegram(r: Rig) {
  const { code } = r.channels.core.beginPairing("telegram", r.tg.botId);
  r.tg.message(`/start ${code}`);
  await until(() => Boolean(r.channels.core.pairing("telegram", r.tg.botId).request));
  await r.channels.core.approvePairing("telegram", r.tg.botId, r.channels.core.pairing("telegram", r.tg.botId).request!.id);
  await until(() => r.tg.texts(TELEGRAM_CHAT).some((text) => text.startsWith("연결되었습니다")));
}
async function pairSlack(r: Rig) {
  const { say } = await r.channels.beginPairing("slack", r.slack.botId);
  r.slack.message(say!);
  await until(() => Boolean(r.channels.core.pairing("slack", r.slack.botId).request));
  await r.channels.core.approvePairing("slack", r.slack.botId, r.channels.core.pairing("slack", r.slack.botId).request!.id);
  await until(() => r.slack.texts(SLACK_CHAT).some((text) => text.startsWith("연결되었습니다")));
}
async function both(at: Parameters<typeof open>[0] = {}) {
  const r = await open(at);
  await registerBoth(r);
  await pairTelegram(r);
  await pairSlack(r);
  return r;
}
/** A line from one messenger reaches an engine; returns which engine took it and in which conversation. */
async function ask(r: Rig, kind: "telegram" | "slack", text: string) {
  if (kind === "telegram") r.tg.message(text); else r.slack.message(text);
  const taken = () => [r.claude, r.codex].flatMap((engine) => engine.sent.filter((entry) => entry.text.includes(text)).map((entry) => ({ provider: engine.provider, sessionId: entry.sessionId })))[0];
  await until(() => Boolean(taken()));
  return taken()!;
}
/** Telegram's menu, then its engine screen: the text it shows. */
async function telegramEngineScreen(r: Rig) {
  r.tg.message("메뉴");
  await until(() => r.tg.texts(TELEGRAM_CHAT).some((text) => text.startsWith("메뉴 · 지금: ")));
  await settled(r);
  const key = r.tg.button("엔진·모델");
  r.tg.press(key.data, { messageId: key.messageId });
  await until(() => Boolean(r.tg.shown(key.messageId)?.includes("이 메신저의 기본 엔진: ")));
  return key.messageId;
}

describe("each messenger has its own default engine", () => {
  it("Telegram = Codex and Slack = Claude at once: each chat's conversations are made with its own messenger's engine", async () => {
    const r = await both();
    expect(engineOf(r, "telegram")).toBeNull();
    expect(engineOf(r, "slack")).toBeNull();
    r.channels.setDefaultEngine("telegram", r.tg.botId, "codex");
    // Setting Telegram's never changes Slack's.
    expect(engineOf(r, "telegram")).toBe("codex");
    expect(engineOf(r, "slack")).toBeNull();
    r.channels.setDefaultEngine("slack", r.slack.botId, "claude");
    expect(r.channels.state().bots.map((bot) => `${bot.kind}:${bot.defaultEngine}`).sort()).toEqual(["slack:claude", "telegram:codex"]);
    const fromTelegram = await ask(r, "telegram", "텔레그램에서 시킨 일");
    const fromSlack = await ask(r, "slack", "슬랙에서 시킨 일");
    expect(fromTelegram.provider).toBe("codex");
    expect(fromSlack.provider).toBe("claude");
    r.codex.finish(fromTelegram.sessionId);
    r.claude.finish(fromSlack.sessionId);
    await settled(r);
    // 새 대화 in each: still each its own, in the same project.
    r.tg.message("새 대화");
    r.slack.message("새 대화");
    await until(() => bindingOf(r, "telegram").pointerSessionId !== fromTelegram.sessionId && bindingOf(r, "slack").pointerSessionId !== fromSlack.sessionId);
    expect(pointerOf(r, "telegram").provider).toBe("codex");
    expect(pointerOf(r, "slack").provider).toBe("claude");
    // The other way round, on the same PC: Slack's chat follows Slack's, whatever Telegram's is.
    r.channels.setDefaultEngine("slack", r.slack.botId, "codex");
    r.channels.setDefaultEngine("telegram", r.tg.botId, "claude");
    const before = { telegram: bindingOf(r, "telegram").pointerSessionId, slack: bindingOf(r, "slack").pointerSessionId };
    r.tg.message("새 대화");
    r.slack.message("새 대화");
    await until(() => bindingOf(r, "telegram").pointerSessionId !== before.telegram && bindingOf(r, "slack").pointerSessionId !== before.slack);
    expect(pointerOf(r, "telegram").provider).toBe("claude");
    expect(pointerOf(r, "slack").provider).toBe("codex");
  });
});

describe("the PC's control and the chat's engine screen show what the other set", () => {
  it("the PC sets it (PATCH …/bots/:id): the state and an event carry it, the chat's engine screen says it, and the chat's next conversation uses it", async () => {
    const r = await both();
    const seen = r.events.length;
    const set = await r.api("PATCH", path(r, "telegram"), { defaultEngine: "codex" });
    expect(set.status).toBe(200);
    expect((set.json as unknown as ChannelsState).bots.map((bot) => `${bot.kind}:${bot.defaultEngine}`).sort()).toEqual(["slack:null", "telegram:codex"]);
    expect(r.events.slice(seen)).toContain("channels.changed");
    const screen = await telegramEngineScreen(r);
    expect(r.tg.shown(screen)).toMatch(/\n이 메신저의 기본 엔진: Codex$/);
    expect((await ask(r, "telegram", "첫 일")).provider).toBe("codex");
    // Cleared at the PC: said in the chat too.
    expect((await r.api("PATCH", path(r, "telegram"), { defaultEngine: null })).status).toBe(200);
    expect(engineOf(r, "telegram")).toBeNull();
  });

  it("the chat sets it: the PC's state carries it (with an event), for that messenger only; 정하지 않음 in the chat clears it at the PC", async () => {
    const r = await both();
    const first = await ask(r, "telegram", "첫 일");
    expect(first.provider).toBe("claude");
    r.claude.finish(first.sessionId);
    const screen = await telegramEngineScreen(r);
    expect(r.tg.shown(screen)).toMatch(/\n이 메신저의 기본 엔진: 정하지 않음$/);
    const seen = r.events.length;
    r.tg.press(r.tg.button("Codex").data, { messageId: screen });
    await until(() => engineOf(r, "telegram") === "codex");
    await until(() => Boolean(r.tg.shown(screen)?.includes("앞으로 이 메신저의 새 대화는 Codex로 만듭니다.")));
    expect(engineOf(r, "slack")).toBeNull();
    expect(r.events.slice(seen)).toContain("channels.changed");
    expect((await r.api("GET", "/api/channels")).json).toMatchObject({ bots: expect.arrayContaining([expect.objectContaining({ kind: "telegram", defaultEngine: "codex" })]) });
    await settled(r);
    r.tg.press(r.tg.button("기본 엔진: 정하지 않음").data, { messageId: screen });
    await until(() => engineOf(r, "telegram") === null);
  });

  it("the PC's route takes Claude, Codex or null only, and not an engine this PC does not have", async () => {
    const r = await open({ codex: false });
    await r.channels.registerTelegram(FAKE_TOKEN);
    const bad = await r.api("PATCH", path(r, "telegram"), { defaultEngine: "gemini" });
    expect(bad).toMatchObject({ status: 400, json: { code: "channel_input" } });
    expect((await r.api("PATCH", path(r, "telegram"), {})).status).toBe(400);
    const missing = await r.api("PATCH", path(r, "telegram"), { defaultEngine: "codex" });
    expect(missing).toMatchObject({ status: 409, json: { code: "channel_engine_missing", message: "Codex가 이 PC에 설치되어 있지 않습니다." } });
    expect(engineOf(r, "telegram")).toBeNull();
    expect((await r.api("PATCH", "/api/channels/telegram/bots/1", { defaultEngine: "claude" })).status).toBe(404);
    expect((await r.api("PATCH", path(r, "telegram"), { defaultEngine: "claude" })).status).toBe(200);
    expect(engineOf(r, "telegram")).toBe("claude");
  });
});

describe("kept with the bot's record", () => {
  it("survives a gateway restart and a token replace; removing the bot removes it; an install from before has none", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-default-engine-"));
    const tg = new FakeTelegram(), slack = new FakeSlack();
    await tg.start();
    await slack.start();
    cleanups.push(async () => { await tg.stop(); await slack.stop(); rmSync(dir, { recursive: true, force: true }); });
    const first = await open({ dir, tg, slack });
    await registerBoth(first);
    // Records as 0.5.0 wrote them: no default, and nothing is written for them until one is set.
    expect(JSON.parse(first.store.getMeta("channel.bots")!)[0]).not.toHaveProperty("defaultEngine");
    expect(first.channels.state().bots.map((bot) => bot.defaultEngine)).toEqual([null, null]);
    first.channels.setDefaultEngine("telegram", tg.botId, "codex");
    first.channels.setDefaultEngine("slack", slack.botId, "claude");
    expect(JSON.parse(first.store.getMeta("channel.bots")!)[0]).toMatchObject({ kind: "telegram", defaultEngine: "codex" });
    expect(JSON.parse(first.store.getMeta("channel.slack")!)[0]).toMatchObject({ kind: "slack", defaultEngine: "claude" });
    await first.close();
    const r = await open({ dir, tg, slack });
    await until(() => connected(r, "telegram") && connected(r, "slack"));
    expect(engineOf(r, "telegram")).toBe("codex");
    expect(engineOf(r, "slack")).toBe("claude");
    // 토큰 바꾸기 on each: the default stays.
    await r.channels.registerTelegram(FAKE_TOKEN);
    await r.channels.registerSlack(FAKE_BOT_TOKEN, FAKE_APP_TOKEN);
    expect(engineOf(r, "telegram")).toBe("codex");
    expect(engineOf(r, "slack")).toBe("claude");
    // Removing Telegram's bot removes Telegram's default only; registered again it has none.
    await r.channels.removeBot("telegram", tg.botId);
    expect(engineOf(r, "slack")).toBe("claude");
    await r.channels.registerTelegram(FAKE_TOKEN);
    expect(engineOf(r, "telegram")).toBeNull();
  });
});
