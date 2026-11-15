import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { EventBus } from "../bus.ts";
import { OfficeVault } from "../office-vault.ts";
import { SessionManager } from "../sessions.ts";
import { Store } from "../store.ts";
import { FAKE_APP_TOKEN, FAKE_BOT_TOKEN, FakeSlack } from "./fake-slack.ts";
import { FAKE_TOKEN, FakeTelegram } from "./fake-telegram.ts";
import { ChannelService } from "./service.ts";
import { StandInEngine, until } from "./test-kit.ts";

// A messenger's home as the gateway runs it: one per messenger (텔레그램's and Slack's are different
// places), made on first use and only for a registered messenger, marked "registered" while its bot
// is (the PC's list locks it then), left with its conversations when the bot is removed; and an old
// data folder (the owner's 0.5.0 state) starts with what was planted untouched. Both stand-ins on
// 127.0.0.1; nothing here reaches Telegram or Slack.

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

type Rig = Awaited<ReturnType<typeof open>>;
const SLACK_CHAT = "D0HONG", TELEGRAM_CHAT = 555;

async function open(at: { dir?: string; tg?: FakeTelegram; slack?: FakeSlack; key?: { id: string; key: Buffer } } = {}) {
  const dir = at.dir ?? mkdtempSync(join(tmpdir(), "wb-messenger-home-"));
  const dataDir = join(dir, "data");
  mkdirSync(dataDir, { recursive: true });
  const tg = at.tg ?? new FakeTelegram(), slack = at.slack ?? new FakeSlack();
  if (!at.tg) await tg.start();
  if (!at.slack) await slack.start();
  const store = new Store(join(dataDir, "state.sqlite"));
  const bus = new EventBus();
  const manager = new SessionManager(store, bus, { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dataDir, "works"), dataDir });
  const engine = new StandInEngine(() => manager.sink);
  manager.registerAdapter(engine);
  const key = at.key ?? { id: "d".repeat(32), key: Buffer.alloc(32, 5) };
  const vault = new OfficeVault(dataDir, async () => key);
  const channels = new ChannelService({ dataDir, store, manager, bus, vault, telegramUrl: tg.url, telegram: { pollSeconds: 1, minSendGapMs: 0 }, slackUrl: slack.api, slack: { minSendGapMs: 0, pingMs: 5_000 }, log: () => undefined });
  await channels.start();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await channels.close();
    await manager.shutdown();
    store.close();
  };
  cleanups.push(close);
  if (!at.tg && !at.slack) cleanups.unshift(async () => { await tg.stop(); await slack.stop(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, tg, slack, store, manager, engine, channels, close };
}

const connected = (r: Rig, kind: "telegram" | "slack") => r.channels.state().bots.find((bot) => bot.kind === kind)?.status.state === "connected";
const bindingOf = (r: Rig, kind: "telegram" | "slack") => r.store.channels.bindings().find((binding) => binding.kind === kind && !binding.revokedAt)!;
const works = (r: Rig) => r.manager.snapshot().works;
const homeOf = (r: Rig, kind: "telegram" | "slack") => works(r).find((work) => work.messengerHome?.kind === kind && !work.archivedAt);
const sessionOf = (r: Rig, id: string) => r.manager.snapshot().sessions.find((entry) => entry.id === id)!;
const settled = async (r: Rig) => { for (let round = 0; round < 3; round += 1) { await r.channels.core.idle(); await new Promise((done) => setTimeout(done, 20)); } };

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
/** A line from one messenger reaches the engine; returns the conversation it went to. */
async function ask(r: Rig, kind: "telegram" | "slack", text: string) {
  if (kind === "telegram") r.tg.message(text); else r.slack.message(text);
  await until(() => r.engine.sent.some((entry) => entry.text.includes(text)));
  return r.engine.sent.find((entry) => entry.text.includes(text))!.sessionId;
}

describe("one home per messenger", () => {
  it("텔레그램's and Slack's are different places, each made on its chat's first conversation, and the person's project gets nothing", async () => {
    const r = await open();
    const mine = r.manager.createWork({ title: "샘플 프로젝트", titleSource: "user" });
    r.manager.createSession(mine.id, { provider: "claude", purpose: "PC에서 하던 대화" });
    await r.channels.registerTelegram(FAKE_TOKEN);
    await r.channels.registerSlack(FAKE_BOT_TOKEN, FAKE_APP_TOKEN, { appName: "Workbench 노트북" });
    await until(() => connected(r, "telegram") && connected(r, "slack"));
    await pairTelegram(r);
    await pairSlack(r);
    // Registered and paired: no home until a chat needs one.
    expect(works(r).map((work) => work.title)).toEqual(["샘플 프로젝트"]);
    const fromTelegram = await ask(r, "telegram", "텔레그램에서 시킨 일");
    expect(homeOf(r, "telegram")).toMatchObject({ title: "텔레그램 대화", messengerHome: { kind: "telegram", registered: true } });
    expect(homeOf(r, "slack")).toBeUndefined();
    const fromSlack = await ask(r, "slack", "슬랙에서 시킨 일");
    expect(homeOf(r, "slack")).toMatchObject({ title: "Slack 대화", messengerHome: { kind: "slack", registered: true } });
    expect(sessionOf(r, fromTelegram).workId).toBe(homeOf(r, "telegram")!.id);
    expect(sessionOf(r, fromSlack).workId).toBe(homeOf(r, "slack")!.id);
    expect(homeOf(r, "telegram")!.id).not.toBe(homeOf(r, "slack")!.id);
    expect(r.manager.snapshot().sessions.filter((session) => session.workId === mine.id).map((session) => session.purpose)).toEqual(["PC에서 하던 대화"]);
    r.engine.finish(fromTelegram);
    r.engine.finish(fromSlack);
    await settled(r);
    // 새 대화 in each: each its own home.
    r.tg.message("새 대화");
    r.slack.message("새 대화");
    await until(() => bindingOf(r, "telegram").pointerSessionId !== fromTelegram && bindingOf(r, "slack").pointerSessionId !== fromSlack);
    expect(bindingOf(r, "telegram").pointerWorkId).toBe(homeOf(r, "telegram")!.id);
    expect(bindingOf(r, "slack").pointerWorkId).toBe(homeOf(r, "slack")!.id);
    expect(works(r).map((work) => work.title).sort()).toEqual(["Slack 대화", "샘플 프로젝트", "텔레그램 대화"]);
  });

  it("removing a messenger leaves its home and conversations, free to archive; the other's stays locked; registered again it uses the same home", async () => {
    const r = await open();
    await r.channels.registerTelegram(FAKE_TOKEN);
    await r.channels.registerSlack(FAKE_BOT_TOKEN, FAKE_APP_TOKEN);
    await until(() => connected(r, "telegram") && connected(r, "slack"));
    await pairTelegram(r);
    await pairSlack(r);
    const fromTelegram = await ask(r, "telegram", "텔레그램 일");
    const fromSlack = await ask(r, "slack", "슬랙 일");
    r.engine.finish(fromTelegram);
    r.engine.finish(fromSlack);
    await settled(r);
    const home = homeOf(r, "telegram")!;
    await r.channels.removeBot("telegram", r.tg.botId);
    expect(works(r).find((work) => work.id === home.id)).toMatchObject({ title: "텔레그램 대화", archivedAt: null, messengerHome: { kind: "telegram", registered: false } });
    expect(sessionOf(r, fromTelegram)).toMatchObject({ workId: home.id, archivedAt: null });
    expect(homeOf(r, "slack")!.messengerHome).toEqual({ kind: "slack", registered: true });
    expect(() => r.manager.updateWork(homeOf(r, "slack")!.id, { archived: true })).toThrow("Slack을 연결해 둔 동안에는");
    // Registered again (the same bot): the home that is there is the home again.
    await r.channels.registerTelegram(FAKE_TOKEN);
    await until(() => connected(r, "telegram"));
    expect(works(r).find((work) => work.id === home.id)!.messengerHome).toEqual({ kind: "telegram", registered: true });
    await pairTelegram(r);
    const again = await ask(r, "telegram", "다시 연결한 뒤");
    expect(sessionOf(r, again).workId).toBe(home.id);
    expect(works(r).filter((work) => work.messengerHome?.kind === "telegram")).toHaveLength(1);
    // Removed and archived by the person: allowed now.
    r.engine.finish(again);
    await settled(r);
    await r.channels.removeBot("telegram", r.tg.botId);
    expect(r.manager.updateWork(home.id, { archived: true }).archivedAt).not.toBeNull();
  });

  it("a gateway that starts with a home but no bot for it (removed while it was off) shows the home free", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-messenger-home-"));
    const tg = new FakeTelegram(), slack = new FakeSlack();
    await tg.start();
    await slack.start();
    cleanups.push(async () => { await tg.stop(); await slack.stop(); rmSync(dir, { recursive: true, force: true }); });
    const first = await open({ dir, tg, slack });
    await first.channels.registerTelegram(FAKE_TOKEN);
    await until(() => connected(first, "telegram"));
    await pairTelegram(first);
    first.engine.finish(await ask(first, "telegram", "첫 일"));
    await settled(first);
    const home = homeOf(first, "telegram")!;
    // The bot's record goes while the gateway is off (an older build's removal, a restored store).
    first.store.setMeta("channel.bots", "[]");
    await first.close();
    const r = await open({ dir, tg, slack });
    expect(works(r).find((work) => work.id === home.id)!.messengerHome).toEqual({ kind: "telegram", registered: false });
  });
});

describe("an old data folder (the owner's state from the installed 0.5.0: one Telegram bot, paired, a conversation planted in a project)", () => {
  const FIXTURE = new URL("../../../../scripts/fixtures/base-telegram-state/", import.meta.url);
  const FIXTURE_KEY = { id: "c".repeat(32), key: Buffer.alloc(32, 7) };

  it("starts with every project and conversation where it was and no home made; a line goes on in the planted conversation; the next 새 대화 goes home with the line, once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-messenger-home-base-"));
    mkdirSync(join(dir, "data", "channels"), { recursive: true });
    writeFileSync(join(dir, "data", "state.sqlite"), gunzipSync(readFileSync(new URL("state.sqlite.gz", FIXTURE))));
    copyFileSync(new URL("bots.json", FIXTURE), join(dir, "data", "channels", "bots.json"));
    const tg = new FakeTelegram(), slack = new FakeSlack();
    (tg as unknown as { nextUpdate: number }).nextUpdate = 5000;
    await tg.start();
    await slack.start();
    cleanups.push(async () => { await tg.stop(); await slack.stop(); rmSync(dir, { recursive: true, force: true }); });
    const r = await open({ dir, tg, slack, key: FIXTURE_KEY });
    await until(() => connected(r, "telegram"));
    await settled(r);
    // As it was written: one project "휴대폰" with the planted conversation; nothing added, nothing marked.
    expect(works(r).map((work) => ({ title: work.title, home: work.messengerHome ?? null, archivedAt: work.archivedAt }))).toEqual([{ title: "휴대폰", home: null, archivedAt: null }]);
    const planted = bindingOf(r, "telegram").pointerSessionId!;
    const project = sessionOf(r, planted).workId;
    expect(r.tg.of("sendMessage")).toEqual([]);
    // The phone writes: answered in the conversation it was in, still in its project.
    expect(await ask(r, "telegram", "업데이트 뒤 첫 일")).toBe(planted);
    r.engine.finish(planted);
    await settled(r);
    expect(homeOf(r, "telegram")).toBeUndefined();
    r.tg.message("새 대화");
    await until(() => bindingOf(r, "telegram").pointerSessionId !== planted);
    await until(() => r.tg.texts(TELEGRAM_CHAT).some((text) => text.startsWith("새 대화를 만들었습니다")));
    const home = homeOf(r, "telegram")!;
    expect(home).toMatchObject({ title: "텔레그램 대화", messengerHome: { kind: "telegram", registered: true } });
    expect(bindingOf(r, "telegram").pointerWorkId).toBe(home.id);
    expect(r.tg.texts(TELEGRAM_CHAT).at(-1)!.split("\n")[1]).toBe("새 대화는 이제 '텔레그램 대화'에 만듭니다. 프로젝트에서 하려면 메뉴의 [프로젝트 바꾸기]에서 고르세요.");
    // What was planted stays where it was, untouched.
    expect(sessionOf(r, planted)).toMatchObject({ workId: project, archivedAt: null });
    expect(works(r).find((work) => work.id === project)).toMatchObject({ title: "휴대폰", archivedAt: null });
    await settled(r);
    const first = bindingOf(r, "telegram").pointerSessionId;
    r.tg.message("새 대화");
    await until(() => bindingOf(r, "telegram").pointerSessionId !== first);
    await settled(r);
    expect(bindingOf(r, "telegram").pointerWorkId).toBe(home.id);
    expect(r.tg.texts(TELEGRAM_CHAT).filter((text) => text.includes("이제 '텔레그램 대화'에"))).toHaveLength(1);
  });
});
