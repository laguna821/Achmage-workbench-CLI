import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { EventBus } from "../bus.ts";
import { installScrubber } from "../credentials/install.ts";
import { CredentialService } from "../credentials/service.ts";
import { HttpError } from "../errors.ts";
import { OfficeVault } from "../office-vault.ts";
import { SessionManager } from "../sessions.ts";
import { Store } from "../store.ts";
import { FAKE_APP_TOKEN, FAKE_BOT_TOKEN, FakeSlack } from "./fake-slack.ts";
import { FAKE_TOKEN, FakeTelegram } from "./fake-telegram.ts";
import { ChannelService } from "./service.ts";
import { StandInEngine, until } from "./test-kit.ts";

// ONE Telegram bot and ONE Slack app registered and running at the same time (the owner, 2026-11-15:
// "텔레그램을 연결해놨으면 슬랙을 따로 연결을 할수가 없어"). Each is set up, replaced and removed on
// its own, and nothing of one messenger's chat (a line, an answer, a file, a notice, a button, a
// secret input, a gate, a schedule) reaches the other's. Both stand-ins on 127.0.0.1; nothing here
// reaches Telegram or Slack.

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

type Rig = Awaited<ReturnType<typeof open>>;
const SLACK_CHAT = "D0HONG", TELEGRAM_CHAT = 555;

/** A gateway's channel with both stand-ins, a stand-in keyring and engine, and the credential store. */
async function open(at: { dir?: string; tg?: FakeTelegram; slack?: FakeSlack; key?: { id: string; key: Buffer } } = {}) {
  const dir = at.dir ?? mkdtempSync(join(tmpdir(), "wb-two-messengers-"));
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
  const credentials = new CredentialService({ dataDir, vault, manager });
  installScrubber(store, manager, credentials.scrubber);
  const lines: string[] = [];
  const channels = new ChannelService({ dataDir, store, manager, bus, vault, credentials, telegramUrl: tg.url, telegram: { pollSeconds: 1, minSendGapMs: 0 }, slackUrl: slack.api, slack: { minSendGapMs: 0, pingMs: 5_000 }, log: (line) => lines.push(line) });
  await channels.start();
  await credentials.start();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await channels.close();
    credentials.close();
    await manager.shutdown();
    store.close();
  };
  cleanups.push(close);
  if (!at.tg && !at.slack) cleanups.unshift(async () => { await tg.stop(); await slack.stop(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, dataDir, tg, slack, store, manager, engine, credentials, channels, lines, close };
}

const kindsOf = (r: Rig) => r.channels.state().bots.map((bot) => bot.kind).sort();
const botOf = (r: Rig, kind: "telegram" | "slack") => r.channels.state().bots.find((bot) => bot.kind === kind);
const connected = (r: Rig, kind: "telegram" | "slack") => botOf(r, kind)?.status.state === "connected";
const bindingOf = (r: Rig, kind: "telegram" | "slack") => r.store.channels.bindings().find((binding) => binding.kind === kind && !binding.revokedAt)!;
const tgTexts = (r: Rig) => r.tg.texts(TELEGRAM_CHAT);
const slackTexts = (r: Rig) => r.slack.texts(SLACK_CHAT);
/** A message that begins with this (an answer may carry the footer line under it). */
const said = (list: string[], text: string) => list.some((line) => line.startsWith(text));
/** Everything the gateway ever sent to each messenger (any chat, any method that carries a text). */
const allTelegram = (r: Rig) => r.tg.calls.filter((call) => ["sendMessage", "editMessageText", "sendDocument", "sendPhoto"].includes(call.method)).map((call) => String(call.params.text ?? call.params.caption ?? ""));
const allSlack = (r: Rig) => r.slack.calls.filter((call) => ["chat.postMessage", "chat.update"].includes(call.method)).map((call) => String(call.params.text ?? ""));

async function registerBoth(r: Rig, first: "telegram" | "slack" = "telegram") {
  const telegram = () => r.channels.registerTelegram(FAKE_TOKEN);
  const slack = () => r.channels.registerSlack(FAKE_BOT_TOKEN, FAKE_APP_TOKEN, { appName: "Workbench 노트북" });
  if (first === "telegram") { await telegram(); await slack(); } else { await slack(); await telegram(); }
  await until(() => connected(r, "telegram") && connected(r, "slack"));
}
async function pairTelegram(r: Rig) {
  const { code } = r.channels.core.beginPairing("telegram", r.tg.botId);
  r.tg.message(`/start ${code}`);
  await until(() => Boolean(r.channels.core.pairing("telegram", r.tg.botId).request));
  await r.channels.core.approvePairing("telegram", r.tg.botId, r.channels.core.pairing("telegram", r.tg.botId).request!.id);
  await until(() => tgTexts(r).some((text) => text.startsWith("연결되었습니다")));
}
async function pairSlack(r: Rig) {
  const { say } = await r.channels.beginPairing("slack", r.slack.botId);
  r.slack.message(say!);
  await until(() => Boolean(r.channels.core.pairing("slack", r.slack.botId).request));
  await r.channels.core.approvePairing("slack", r.slack.botId, r.channels.core.pairing("slack", r.slack.botId).request!.id);
  await until(() => slackTexts(r).some((text) => text.startsWith("연결되었습니다")));
}
/** Both registered and both paired, by one person on each messenger. */
async function both() {
  const r = await open();
  await registerBoth(r);
  await pairTelegram(r);
  await pairSlack(r);
  return r;
}
/** A line from one messenger reaches the engine; returns the conversation it went to. */
async function ask(r: Rig, kind: "telegram" | "slack", text: string) {
  const before = r.engine.sent.length;
  if (kind === "telegram") r.tg.message(text); else r.slack.message(text);
  await until(() => r.engine.sent.length > before && r.engine.sent.some((entry) => entry.text.includes(text)));
  return r.engine.sent.find((entry) => entry.text.includes(text))!.sessionId;
}
const settled = async (r: Rig) => { for (let round = 0; round < 3; round += 1) { await r.channels.core.idle(); await new Promise((done) => setTimeout(done, 20)); } };

describe("one Telegram bot AND one Slack app", () => {
  it("both register and run together, in either order, each with its own row in the state", async () => {
    for (const first of ["telegram", "slack"] as const) {
      const r = await open();
      await registerBoth(r, first);
      expect(kindsOf(r)).toEqual(["slack", "telegram"]);
      expect(botOf(r, "telegram")).toMatchObject({ id: r.tg.botId, token: "sealed", bindings: [] });
      expect(botOf(r, "slack")).toMatchObject({ id: r.slack.botId, token: "sealed", appName: "Workbench 노트북", bindings: [] });
      // Each receives: Telegram polls, Slack holds its one socket.
      await until(() => r.tg.of("getUpdates").length > 1);
      expect(r.slack.open()).toBe(1);
    }
  });

  it("a second Telegram bot or a second Slack app is still refused, in words that say which and what to do", async () => {
    const r = await open();
    await registerBoth(r);
    const other = "7000000002:AAF" + "m".repeat(8) + "-Fake_token-for-loopback-02";
    r.tg.others.add(other);
    const refused = await r.channels.registerTelegram(other).then(() => null, (error: unknown) => error);
    expect(refused).toBeInstanceOf(HttpError);
    expect(refused).toMatchObject({ status: 409, code: "channel_bot_exists", message: "텔레그램 봇은 하나만 등록합니다. 다른 봇을 쓰려면 지금 봇을 먼저 지워 주세요." });
    // Another Slack app already registered (as a gateway would have kept it): this one is refused.
    const kept = JSON.parse(r.store.getMeta("channel.slack")!) as { id: string }[];
    r.store.setMeta("channel.slack", JSON.stringify(kept.map((bot) => ({ ...bot, id: "B0OTHERAPP1" }))));
    const second = await r.channels.registerSlack(FAKE_BOT_TOKEN, FAKE_APP_TOKEN).then(() => null, (error: unknown) => error);
    expect(second).toMatchObject({ status: 409, code: "channel_bot_exists", message: "Slack 앱은 하나만 등록합니다. 다른 앱을 쓰려면 지금 앱을 먼저 지워 주세요." });
    expect(r.channels.state().bots.map((bot) => `${bot.kind}:${bot.id}`).sort()).toEqual(["slack:B0OTHERAPP1", `telegram:${r.tg.botId}`]);
  });

  it("a line from Telegram is answered in Telegram and one from Slack in Slack, each in its own conversation, nothing crossing", async () => {
    const r = await both();
    const slackBefore = allSlack(r).length, tgBefore = allTelegram(r).length;
    const fromTelegram = await ask(r, "telegram", "텔레그램에서 시킨 일");
    r.engine.say(fromTelegram, "텔레그램 답입니다.");
    r.engine.finish(fromTelegram);
    await until(() => said(tgTexts(r), "텔레그램 답입니다."));
    await settled(r);
    expect(allSlack(r).length).toBe(slackBefore);
    const fromSlack = await ask(r, "slack", "슬랙에서 시킨 일");
    expect(fromSlack).not.toBe(fromTelegram);
    r.engine.say(fromSlack, "슬랙 답입니다.");
    r.engine.finish(fromSlack);
    await until(() => said(slackTexts(r), "슬랙 답입니다."));
    await settled(r);
    expect(allTelegram(r).some((text) => text.includes("슬랙"))).toBe(false);
    expect(allSlack(r).some((text) => text.includes("텔레그램"))).toBe(false);
    // Each chat points at its own conversation.
    expect(bindingOf(r, "telegram").pointerSessionId).toBe(fromTelegram);
    expect(bindingOf(r, "slack").pointerSessionId).toBe(fromSlack);
    expect(allTelegram(r).length).toBeGreaterThan(tgBefore);
  });

  it("a long answer's file goes only to the messenger whose request it answers", async () => {
    const r = await both();
    const fromSlack = await ask(r, "slack", "긴 보고서 써 줘");
    r.engine.say(fromSlack, `슬랙 보고서\n\n${"가나다라 마바사 ".repeat(900)}`);
    r.engine.finish(fromSlack);
    await until(() => slackTexts(r).some((text) => text.startsWith("슬랙 보고서")));
    await until(() => r.slack.calls.some((call) => call.method === "files.completeUploadExternal"));
    await settled(r);
    expect(r.tg.of("sendDocument")).toEqual([]);
    const fromTelegram = await ask(r, "telegram", "텔레그램 긴 보고서");
    const uploads = r.slack.of("files.completeUploadExternal").length;
    r.engine.say(fromTelegram, `텔레그램 보고서\n\n${"가나다라 마바사 ".repeat(900)}`);
    r.engine.finish(fromTelegram);
    await until(() => r.tg.of("sendDocument").length === 1);
    await settled(r);
    expect(r.slack.of("files.completeUploadExternal").length).toBe(uploads);
  });

  it("a button sent to one messenger does nothing when pressed in the other", async () => {
    const r = await both();
    const session = await ask(r, "telegram", "선택지를 줘");
    r.engine.say(session, "어느 쪽으로 할까요?\n[[선택: 가안 | 나안]]");
    r.engine.finish(session);
    await until(() => tgTexts(r).some((text) => text.startsWith("어느 쪽으로")));
    const telegramButton = r.tg.button("가안");
    const sent = r.engine.sent.length;
    r.slack.press(telegramButton.data);
    await until(() => r.store.channels.auditList().some((row) => row.kind === "slack" && row.action === "refused" && row.result === "button"));
    await settled(r);
    expect(r.engine.sent.length).toBe(sent);
    // Pressed in Telegram it still works.
    r.tg.press(telegramButton.data, { messageId: telegramButton.messageId });
    await until(() => r.engine.sent.length === sent + 1);
    expect(r.engine.sent.at(-1)!.text).toContain("가안");
  });

  it("PC-side notices: each paired chat that turned a project on hears of the PC's work there once — both, when both did; neither twice", async () => {
    const r = await both();
    const work = r.manager.createWork({ title: "연구계획서", titleSource: "user" });
    for (const kind of ["telegram", "slack"] as const) {
      const binding = bindingOf(r, kind);
      r.store.channels.updateBinding(binding.id, { prefs: { ...binding.prefs, notify: [work.id] } });
    }
    const session = r.manager.createSession(work.id, { provider: "claude", purpose: "예산표 정리", access: "full" });
    await r.manager.send(session.id, "pc-1", "PC에서 시킨 일");
    r.engine.finish(session.id);
    const notice = "PC에서 시킨 일이 끝났습니다 · 「연구계획서」 › 「예산표 정리」";
    await until(() => said(tgTexts(r), notice) && said(slackTexts(r), notice));
    await settled(r);
    expect(tgTexts(r).filter((text) => text === notice)).toHaveLength(1);
    expect(slackTexts(r).filter((text) => text === notice)).toHaveLength(1);
    // A desktop question there: asked once in each.
    await r.manager.send(session.id, "pc-2", "다음 일");
    r.engine.ask(session.id, "파일을 지워도 될까요?", null);
    await until(() => tgTexts(r).some((text) => text.includes("파일을 지워도 될까요?")) && slackTexts(r).some((text) => text.includes("파일을 지워도 될까요?")));
    await settled(r);
    expect(tgTexts(r).filter((text) => text.includes("파일을 지워도 될까요?"))).toHaveLength(1);
    expect(slackTexts(r).filter((text) => text.includes("파일을 지워도 될까요?"))).toHaveLength(1);
    // Only the Slack chat turned it on: only Slack hears.
    const telegram = bindingOf(r, "telegram");
    r.store.channels.updateBinding(telegram.id, { prefs: { ...telegram.prefs, notify: [] } });
    const quiet = r.manager.createSession(work.id, { provider: "claude", purpose: "회의록", access: "full" });
    await r.manager.send(quiet.id, "pc-3", "회의록 정리");
    r.engine.finish(quiet.id);
    await until(() => slackTexts(r).some((text) => text.includes("「회의록」")));
    await settled(r);
    expect(allTelegram(r).some((text) => text.includes("「회의록」"))).toBe(false);
  });

  it("a secret input opened in the Telegram chat is answered only there: a value typed in Slack meanwhile is Slack's ordinary line", async () => {
    const r = await both();
    const NEED = ["need", "--name", "학술정보원", "--kind", "login", "--site", "lib.example.ac.kr", "--fields", "아이디,비밀번호"];
    const session = await ask(r, "telegram", "도서관 대출 목록 정리해 줘");
    expect(await r.credentials.run(session, NEED)).toMatchObject({ stdout: "fail:handover_sent\n" });
    r.engine.finish(session);
    await until(() => tgTexts(r).some((text) => text.includes("다음에 보내는 메시지를")));
    const handoff = r.credentials.state().waiting[0]!;
    // The hand-over is Telegram's: nothing of it in Slack.
    expect(allSlack(r).some((text) => text.includes("학술정보원"))).toBe(false);
    const VALUE = "zz-two-messengers-0001";
    const slackSession = await ask(r, "slack", `아이디는 ${VALUE}`);
    expect(slackSession).not.toBe(session);
    expect(r.credentials.store.filled(handoff.id)).toEqual([]);
    expect(r.slack.of("chat.delete")).toEqual([]);
    const window = JSON.parse(r.store.getMeta(`channel.secret:telegram:${r.tg.botId}:${TELEGRAM_CHAT}`)!) as { window: unknown };
    expect(window.window).not.toBeNull();
    expect(r.store.getMeta(`channel.secret:slack:${r.slack.botId}:${SLACK_CHAT}`)).toBeNull();
    // Typed in Telegram, it is taken (and its message deleted there).
    const typed = r.tg.message("zz-user-0001");
    await until(() => r.credentials.store.filled(handoff.id).includes("아이디"));
    await until(() => r.tg.of("deleteMessage").some((call) => call.params.message_id === ((typed as Record<string, unknown>).message as { message_id: number }).message_id));
    expect(r.slack.of("chat.delete")).toEqual([]);
  });

  it("a hand-over asked in a Slack conversation is said in Slack only", async () => {
    const r = await both();
    const session = await ask(r, "slack", "도서관 로그인 해 줘");
    expect(await r.credentials.run(session, ["need", "--name", "도서관", "--kind", "login", "--site", "lib.example.ac.kr", "--fields", "아이디,비밀번호"])).toMatchObject({ stdout: "fail:handover_sent\n" });
    r.engine.finish(session);
    await until(() => slackTexts(r).some((text) => text.includes("'도서관'")));
    await settled(r);
    expect(allTelegram(r).some((text) => text.includes("도서관"))).toBe(false);
    expect(r.store.getMeta(`channel.secret:telegram:${r.tg.botId}:${TELEGRAM_CHAT}`)).toBeNull();
  });

  it("멈춰, 잠금 and 새 대화 act on the chat they were typed in; a PC pause of one leaves the other running", async () => {
    const r = await both();
    const tgSession = await ask(r, "telegram", "텔레그램 일");
    const slackSession = await ask(r, "slack", "슬랙 일");
    r.slack.message("멈춰");
    await until(() => r.engine.interrupted.includes(slackSession));
    await settled(r);
    expect(r.engine.interrupted).not.toContain(tgSession);
    expect(r.engine.running(tgSession)).toBe(true);
    // 새 대화 in Slack: Slack's pointer moves, Telegram's stays.
    r.slack.message("새 대화");
    await until(() => bindingOf(r, "slack").pointerSessionId !== slackSession);
    expect(bindingOf(r, "telegram").pointerSessionId).toBe(tgSession);
    // 잠금 in Telegram: Telegram's chat locked and its work stopped; Slack still answers.
    r.tg.message("잠금");
    await until(() => Boolean(bindingOf(r, "telegram").lockedAt) && r.engine.interrupted.includes(tgSession));
    expect(bindingOf(r, "slack").lockedAt).toBeNull();
    const next = await ask(r, "slack", "잠근 뒤 슬랙 일");
    r.engine.say(next, "슬랙은 됩니다.");
    r.engine.finish(next);
    await until(() => said(slackTexts(r), "슬랙은 됩니다."));
    // The PC pauses Slack: Telegram (unlocked at the PC) still runs.
    r.channels.core.unlock(bindingOf(r, "telegram").id);
    r.channels.core.pause(bindingOf(r, "slack").id, true);
    const count = r.engine.sent.length;
    r.slack.message("멈춘 동안 슬랙");
    await until(() => said(slackTexts(r), "지금은 PC에서 채널을 멈춰 두었습니다."));
    expect(r.engine.sent.length).toBe(count);
    const tgNext = await ask(r, "telegram", "슬랙 멈춘 동안 텔레그램");
    r.engine.say(tgNext, "텔레그램은 됩니다.");
    r.engine.finish(tgNext);
    await until(() => said(tgTexts(r), "텔레그램은 됩니다."));
  });

  it("a schedule made from Slack runs as Slack's and reports to Slack only", async () => {
    const r = await both();
    const slackSession = await ask(r, "slack", "슬랙 대화");
    r.engine.finish(slackSession);
    await settled(r);
    const binding = bindingOf(r, "slack");
    r.manager.schedules.create({ sessionId: slackSession, text: "예약된 슬랙 일", when: { kind: "once", at: Date.now() + 200 } }, { channel: "slack", bindingId: binding.id });
    await new Promise((done) => setTimeout(done, 300));
    await r.manager.schedules.tick();
    await until(() => r.engine.sent.some((entry) => entry.text.includes("예약된 슬랙 일")));
    r.engine.say(slackSession, "예약 답입니다.");
    r.engine.finish(slackSession);
    await until(() => said(slackTexts(r), "예약 답입니다."));
    await settled(r);
    expect(allTelegram(r).some((text) => text.includes("예약"))).toBe(false);
  });

  it("the record names the messenger of every row", async () => {
    const r = await both();
    const rows = r.channels.core.auditList();
    expect(rows.filter((row) => row.action === "paired").map((row) => row.kind).sort()).toEqual(["slack", "telegram"]);
    expect(rows.filter((row) => row.action === "bot.registered").map((row) => row.kind).sort()).toEqual(["slack", "telegram"]);
  });

  it("replacing one's token never reconnects, re-pairs or re-registers the other", async () => {
    const r = await both();
    const tgBinding = bindingOf(r, "telegram"), slackBinding = bindingOf(r, "slack");
    const sockets = r.slack.open(), opened = r.slack.of("apps.connections.open").length;
    await r.channels.registerTelegram(FAKE_TOKEN);
    await until(() => connected(r, "telegram"));
    expect(r.slack.of("apps.connections.open").length).toBe(opened);
    expect(r.slack.open()).toBe(sockets);
    expect(bindingOf(r, "slack").id).toBe(slackBinding.id);
    const getMe = r.tg.of("getMe").length;
    await r.channels.registerSlack(FAKE_BOT_TOKEN, FAKE_APP_TOKEN);
    await until(() => connected(r, "slack"));
    expect(r.tg.of("getMe").length).toBe(getMe);
    expect(bindingOf(r, "telegram").id).toBe(tgBinding.id);
    // Both still answer.
    for (const kind of ["telegram", "slack"] as const) {
      const session = await ask(r, kind, `${kind} 바꾼 뒤`);
      r.engine.say(session, `${kind} 바꾼 뒤 답`);
      r.engine.finish(session);
      await until(() => said((kind === "telegram" ? tgTexts(r) : slackTexts(r)), `${kind} 바꾼 뒤 답`));
    }
    const audit = r.channels.core.auditList().filter((row) => row.action === "token.replaced").map((row) => row.kind).sort();
    expect(audit).toEqual(["slack", "telegram"]);
  });

  it("removing Telegram leaves Slack connected and answering; removing Slack leaves Telegram", async () => {
    for (const gone of ["telegram", "slack"] as const) {
      const r = await both();
      const kept = gone === "telegram" ? "slack" : "telegram";
      const keptBinding = bindingOf(r, kept);
      const sockets = r.slack.of("apps.connections.open").length;
      await r.channels.removeBot(gone, gone === "telegram" ? r.tg.botId : r.slack.botId);
      expect(kindsOf(r)).toEqual([kept]);
      expect(connected(r, kept)).toBe(true);
      expect(r.channels.core.running).toBe(true);
      if (kept === "slack") expect(r.slack.of("apps.connections.open").length).toBe(sockets);
      expect(bindingOf(r, kept).id).toBe(keptBinding.id);
      expect(r.store.channels.bindings().find((binding) => binding.kind === gone)!.revokedAt).not.toBeNull();
      const session = await ask(r, kept, "지운 뒤에도");
      r.engine.say(session, "남은 쪽 답");
      r.engine.finish(session);
      await until(() => said((kept === "telegram" ? tgTexts(r) : slackTexts(r)), "남은 쪽 답"));
    }
  });

  it("after a restart both come back connected and paired, nothing asked again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-two-messengers-"));
    const tg = new FakeTelegram(), slack = new FakeSlack();
    await tg.start();
    await slack.start();
    cleanups.push(async () => { await tg.stop(); await slack.stop(); rmSync(dir, { recursive: true, force: true }); });
    const first = await open({ dir, tg, slack });
    await registerBoth(first);
    await pairTelegram(first);
    await pairSlack(first);
    const ids = first.store.channels.bindings().map((binding) => binding.id).sort();
    await first.close();
    const r = await open({ dir, tg, slack });
    await until(() => connected(r, "telegram") && connected(r, "slack"));
    expect(r.store.channels.bindings().filter((binding) => !binding.revokedAt).map((binding) => binding.id).sort()).toEqual(ids);
    for (const kind of ["telegram", "slack"] as const) {
      const session = await ask(r, kind, `${kind} 다시 켠 뒤`);
      r.engine.say(session, `${kind} 다시 켠 뒤 답`);
      r.engine.finish(session);
      await until(() => said((kind === "telegram" ? tgTexts(r) : slackTexts(r)), `${kind} 다시 켠 뒤 답`));
    }
  });
});

describe("the owner's state from the installed build (one Telegram bot, paired) survives the update", () => {
  /** scripts/fixtures/base-telegram-state: written by the build of 6d19ad43 (make-base-telegram-state.ts). */
  const FIXTURE = new URL("../../../../scripts/fixtures/base-telegram-state/", import.meta.url);
  /** The stand-in keyring's key the fixture was sealed with (scripts/fixtures/fake-secret.mjs). */
  const FIXTURE_KEY = { id: "c".repeat(32), key: Buffer.alloc(32, 7) };

  it("starts with that bot connected, its binding, pointer and outbox as they were; nothing asked again; Slack can be added beside it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-two-messengers-base-"));
    mkdirSync(join(dir, "data", "channels"), { recursive: true });
    writeFileSync(join(dir, "data", "state.sqlite"), gunzipSync(readFileSync(new URL("state.sqlite.gz", FIXTURE))));
    copyFileSync(new URL("bots.json", FIXTURE), join(dir, "data", "channels", "bots.json"));
    const db = new DatabaseSync(join(dir, "data", "state.sqlite"), { readOnly: true });
    const outbox = db.prepare("SELECT * FROM channel_outbox ORDER BY key").all();
    const bindings = db.prepare("SELECT id, kind, bot_id, chat_id, user_id, pointer_session_id, revoked_at FROM channel_bindings").all();
    db.close();
    expect(bindings).toHaveLength(1);
    const tg = new FakeTelegram(), slack = new FakeSlack();
    // The real Bot API numbers updates on from where the old run confirmed (the stand-in starts at 1000).
    (tg as unknown as { nextUpdate: number }).nextUpdate = 5000;
    await tg.start();
    await slack.start();
    cleanups.push(async () => { await tg.stop(); await slack.stop(); rmSync(dir, { recursive: true, force: true }); });
    const r = await open({ dir, tg, slack, key: FIXTURE_KEY });
    await until(() => connected(r, "telegram"));
    const state = r.channels.state();
    expect(state.bots).toHaveLength(1);
    expect(state.bots[0]).toMatchObject({ kind: "telegram", id: tg.botId, token: "sealed", pairing: { request: null } });
    const binding = state.bots[0]!.bindings[0]!;
    expect(binding.id).toBe((bindings[0] as { id: string }).id);
    expect(binding.pointerSessionId).toBe((bindings[0] as { pointer_session_id: string }).pointer_session_id);
    // Nothing re-sent, nothing re-asked, no Slack key written for a Telegram-only PC.
    await settled(r);
    expect(tg.of("sendMessage")).toEqual([]);
    expect(r.store.getMeta("channel.slack")).toBeNull();
    const now = new DatabaseSync(join(dir, "data", "state.sqlite"), { readOnly: true });
    expect(now.prepare("SELECT * FROM channel_outbox ORDER BY key").all()).toEqual(outbox);
    now.close();
    // The phone writes: answered in the conversation it was in.
    const session = await ask(r, "telegram", "업데이트 뒤 첫 일");
    expect(session).toBe(binding.pointerSessionId);
    r.engine.say(session, "업데이트 뒤 답");
    r.engine.finish(session);
    await until(() => said(tgTexts(r), "업데이트 뒤 답"));
    // Slack added beside it: the Telegram bot, chat and conversation untouched; an older gateway still reads channel.bots as before.
    await r.channels.registerSlack(FAKE_BOT_TOKEN, FAKE_APP_TOKEN);
    await until(() => connected(r, "slack") && connected(r, "telegram"));
    expect(bindingOf(r, "telegram").id).toBe(binding.id);
    expect((JSON.parse(r.store.getMeta("channel.bots")!) as { kind: string }[]).map((bot) => bot.kind)).toEqual(["telegram"]);
  });
});
