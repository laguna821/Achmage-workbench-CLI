import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import type { DaemonArgs, DaemonAnswer, HostPage } from "../browse-host.ts";
import { EventBus } from "../bus.ts";
import { LoginFiller } from "../credentials/fill.ts";
import { installScrubber } from "../credentials/install.ts";
import { CredentialService } from "../credentials/service.ts";
import { OfficeVault } from "../office-vault.ts";
import { SessionManager } from "../sessions.ts";
import { Store } from "../store.ts";
import { FAKE_APP_TOKEN, FAKE_BOT_TOKEN, FakeSlack } from "./fake-slack.ts";
import { FAKE_TOKEN, FakeTelegram } from "./fake-telegram.ts";
import { ChannelService } from "./service.ts";
import { tick, until } from "./test-kit.ts";
import { StandInEngine } from "./test-kit.ts";

// For the input matrices only (input-end-matrix.test.ts, input-shape-matrix.test.ts): one whole
// gateway per cell (the real Telegram adapter against the stand-in Bot API, or the real Slack adapter
// against the stand-in Slack, both on 127.0.0.1, the real ChannelCore, VaultChat/LoginChat,
// CredentialService and LoginFiller with a stand-in page and a stand-in engine). Nothing here is used
// by the gateway itself, and nothing here reaches a messenger or a site. Made-up values only.

export const SITE_TG = "http://127.0.0.1:41233";
export const SITE_SLACK = "https://lib.example.ac.kr";
export const CODE = "482913";
export const KEY = "zz-notion-key-0909";
export const LINK = (site: string) => `${site}/magic?t=zz-fake-magic-0909`;

export type Messenger = "telegram" | "slack";
export type Kind = "secret" | "code" | "link" | "approve" | "pcCode" | "pcLink";
export type Ending =
  | "open" | "taken" | "cancelWord" | "cancelButton" | "timeoutTick" | "timeoutFound"
  | "stopWord" | "stopButton" | "newWord" | "newButton" | "retryWord" | "retryButton" | "lockWord" | "lockButton"
  | "pause" | "lockPc" | "unpaired" | "aiSide" | "restartTick" | "restartFound";
export type Next = "awaited" | "marked" | "number" | "ordinary" | "appWord";
/** caught: held from the AI, answered once with [그대로 보내기] (deleted on Telegram); value: taken by the open input;
 * ai: reaches the conversation; app: answered by the app; gate: answered that the chat is paused/locked;
 * archived: answered that the conversation is archived (with a way to move it); stranger: not paired any more, nothing runs. */
export type Outcome = "caught" | "value" | "ai" | "app" | "gate" | "archived" | "stranger";

export const KINDS: Kind[] = ["secret", "code", "link", "approve", "pcCode", "pcLink"];
export const ENDINGS: Ending[] = ["open", "taken", "cancelWord", "cancelButton", "timeoutTick", "timeoutFound", "stopWord", "stopButton", "newWord", "newButton", "retryWord", "retryButton", "lockWord", "lockButton", "pause", "lockPc", "unpaired", "aiSide", "restartTick", "restartFound"];
export const NEXTS: Next[] = ["awaited", "marked", "number", "ordinary", "appWord"];
export const MESSENGERS: Messenger[] = ["telegram", "slack"];

/** What an input of a kind awaited, as text, and how it is caught after it ended (ruling P2). */
export const catchOf = (kind: Kind): "code" | "link" | "none" => (kind === "code" || kind === "pcCode" || kind === "approve" ? "code" : kind === "link" || kind === "pcLink" ? "link" : "none");

// The rig: one whole gateway per cell, on a fresh data folder

/** A cell fails fast: what it waits for comes within milliseconds when it comes at all. */
export const wait = (check: () => boolean | Promise<boolean>, timeoutMs = 2_500) => until(check, timeoutMs);

export const cleanups: (() => Promise<void> | void)[] = [];
/** Each test file runs these after each test: `afterEach(cleanAll)`. */
export async function cleanAll() { for (const clean of cleanups.splice(0).reverse()) await clean(); }

export function standInPage(url: string) {
  const state = { url, typed: [] as [string, string][], pressed: [] as string[], went: [] as string[], elements: { e4: { tag: "input", type: "text" }, e6: { tag: "input", type: "password" }, e7: { tag: "button", type: "submit" } } as Record<string, { tag: string; type: string }> };
  const marked: string[] = [];
  const page: HostPage = {
    typed: (_label, values) => { marked.push(...values); },
    forget: () => undefined,
    live: () => marked.length > 0,
    hide: (text) => marked.reduce((out, value) => out.replaceAll(value, "[비밀]"), text),
    run: async (args: DaemonArgs): Promise<DaemonAnswer> => {
      const [command, first, second] = args._;
      if (command === "eval") {
        if (second) { const element = state.elements[second]; return element ? { error: false, text: JSON.stringify(JSON.stringify({ ...element, frame: state.url })) } : { error: true, text: `Ref ${second} not found` }; }
        if (first!.includes("location.href")) return { error: false, text: JSON.stringify(state.url) };
        if (first!.includes("document.title")) return { error: false, text: JSON.stringify("로그인") };
        if (first!.includes("innerText")) return { error: false, text: JSON.stringify(JSON.stringify({ values: [], text: "로그인", blind: 0 })) };
      }
      if (command === "fill") { state.typed.push([first!, second!]); return { error: false, text: "" }; }
      if (command === "click") { state.pressed.push(first!); return { error: false, text: "" }; }
      if (command === "goto") { state.went.push(first!); return { error: false, text: "" }; }
      if (command === "screenshot") { writeFileSync(String(args.filename), Buffer.from("89504e470d0a1a0a0000000d49484452", "hex")); return { error: false, text: "" }; }
      return { error: true, text: "unknown" };
    },
  };
  return { page, state };
}

export type Gateway = { store: Store; manager: SessionManager; engine: StandInEngine; credentials: CredentialService; logins: LoginFiller; channels: ChannelService; close(): Promise<void> };

export async function gateway(dataDir: string, messenger: Messenger, page: HostPage, urls: { telegram: string; slack: string }): Promise<Gateway> {
  const store = new Store(join(dataDir, "state.sqlite"));
  const bus = new EventBus();
  const manager = new SessionManager(store, bus, { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dataDir, "works"), dataDir });
  const engine = new StandInEngine(() => manager.sink);
  manager.registerAdapter(engine);
  const vault = new OfficeVault(dataDir, async () => ({ id: "d".repeat(32), key: Buffer.alloc(32, 5) }));
  const credentials = new CredentialService({ dataDir, vault, manager });
  installScrubber(store, manager, credentials.scrubber);
  const logins = new LoginFiller({ service: credentials, dataDir, page: () => page });
  logins.install();
  const channels = new ChannelService({ dataDir, store, manager, bus, vault, credentials, logins, telegramUrl: urls.telegram, telegram: { pollSeconds: 1, minSendGapMs: 0 }, slackUrl: urls.slack, slack: { minSendGapMs: 0, pingMs: 5_000 }, log: () => undefined });
  await channels.start();
  await credentials.start();
  void messenger;
  let closed = false;
  return {
    store, manager, engine, credentials, logins, channels,
    async close() {
      if (closed) return;
      closed = true;
      await channels.close();
      credentials.close();
      await manager.shutdown();
      store.close();
    },
  };
}

/** What carries the words of a message: typed text, a forwarded message (Telegram), a photo's caption. */
export type Carrier = "text" | "forward" | "caption";
/** The bytes of the made-up photo a caption comes with. */
export const PHOTO = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

export type Rig = {
  messenger: Messenger;
  dataDir: string;
  g: Gateway;
  site: string;
  page: ReturnType<typeof standInPage>;
  sessionId: string;
  /** The person sends a line; `carrier`: as typed, as a forwarded message, or as the caption of a photo (fix round 5, Q2). */
  send(text: string, carrier?: Carrier): { deleted(): boolean };
  press(label: string): void;
  /** A press of a button by its token (one planted in the store). */
  pressToken(token: string): void;
  has(label: string): boolean;
  texts(): string[];
  /** Labels of the buttons of the last message whose text matches. */
  labels(match: (text: string) => boolean): string[];
  restart(): Promise<void>;
};

export async function rig(messenger: Messenger): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), "wb-input-matrix-"));
  const dataDir = join(dir, "data");
  mkdirSync(dataDir, { recursive: true });
  const telegram = new FakeTelegram();
  const slack = new FakeSlack();
  await telegram.start();
  if (messenger === "slack") await slack.start();
  const site = messenger === "telegram" ? SITE_TG : SITE_SLACK;
  const page = standInPage(`${site}/login`);
  const urls = { telegram: telegram.url, slack: messenger === "slack" ? slack.api : "http://127.0.0.1:9" };
  let g = await gateway(dataDir, messenger, page.page, urls);
  cleanups.push(async () => { await g.close(); await telegram.stop(); if (messenger === "slack") await slack.stop(); rmSync(dir, { recursive: true, force: true }); });
  if (messenger === "telegram") {
    await g.channels.registerTelegram(FAKE_TOKEN, {});
    const { code } = g.channels.core.beginPairing("telegram", telegram.botId);
    telegram.message(`/start ${code}`);
    await wait(() => Boolean(g.channels.core.pairing("telegram", telegram.botId).request));
    await g.channels.core.approvePairing("telegram", telegram.botId, g.channels.core.pairing("telegram", telegram.botId).request!.id);
  } else {
    const state = await g.channels.registerSlack(FAKE_BOT_TOKEN, FAKE_APP_TOKEN, {});
    const botId = state.bots[0]!.id;
    await wait(() => g.channels.state().bots[0]?.status.state === "connected");
    const { code } = g.channels.core.beginPairing("slack", botId);
    slack.message(`연결 ${code}`);
    await wait(() => Boolean(g.channels.core.pairing("slack", botId).request));
    await g.channels.core.approvePairing("slack", botId, g.channels.core.pairing("slack", botId).request!.id);
    await wait(() => slack.texts().some((text) => text.startsWith("연결되었습니다")));
  }
  let photos = 0;
  const sendTelegram = (text: string, carrier: Carrier = "text") => {
    const fileId = `zz-photo-${++photos}`;
    if (carrier === "caption") telegram.file(fileId, `photos/${fileId}.jpg`, PHOTO);
    const update = (carrier === "caption" ? telegram.message("", { extra: { caption: text, photo: [{ file_id: fileId, file_size: PHOTO.length, width: 1, height: 1 }] } })
      : carrier === "forward" ? telegram.message(text, { extra: { forward_origin: { type: "user", date: Math.floor(Date.now() / 1000), sender_user: { id: 777, is_bot: false, first_name: "문자" } }, forward_date: Math.floor(Date.now() / 1000) } })
        : telegram.message(text)) as unknown as { message: { message_id: number } };
    return { deleted: () => telegram.of("deleteMessage").some((call) => call.params.message_id === update.message.message_id) };
  };
  const sendSlack = (text: string, carrier: Carrier = "text") => {
    if (carrier === "forward") throw new Error("Slack has no forwarded message in a DM event");
    const sent = slack.message(text, carrier === "caption" ? { files: [slack.file(`zz-photo-${++photos}.png`, PHOTO, { mimetype: "image/png" })] } : {});
    return { deleted: () => slack.of("chat.delete").some((call) => call.params.ts === sent.ts) };
  };
  const r: Rig = {
    messenger, dataDir, site, page, sessionId: "",
    get g() { return g; },
    send: messenger === "telegram" ? sendTelegram : sendSlack,
    press(label) {
      if (messenger === "telegram") { const button = telegram.button(label); telegram.press(button.data, { messageId: button.messageId }); return; }
      const button = slack.button(label);
      slack.press(button.value, { messageTs: button.ts, actionId: button.actionId });
    },
    pressToken(token) { if (messenger === "telegram") telegram.press(token); else slack.press(token); },
    has(label) { try { if (messenger === "telegram") telegram.button(label); else slack.button(label); return true; } catch { return false; } },
    texts: () => (messenger === "telegram" ? telegram.texts() : slack.texts()),
    labels(match) {
      if (messenger === "telegram") {
        const call = telegram.of("sendMessage").findLast((entry) => match(String(entry.params.text)));
        const rows = (call?.params.reply_markup as { inline_keyboard?: { text: string }[][] } | undefined)?.inline_keyboard ?? [];
        return rows.flat().map((entry) => entry.text);
      }
      const message = slack.messages.findLast((entry) => Boolean(entry.bot_id) && match(entry.text));
      return message ? slack.labels(message.ts) : [];
    },
    async restart() {
      await g.close();
      g = await gateway(dataDir, messenger, page.page, urls);
      if (messenger === "slack") await wait(() => g.channels.state().bots[0]?.status.state === "connected");
    },
  } as Rig;
  r.send("도서관 대출 목록 정리해 줘");
  await wait(() => g.engine.sent.length === 1);
  r.sessionId = g.channels.core.bindings()[0]!.pointerSessionId!;
  return r;
}

export const binding = (r: Rig) => r.g.channels.core.bindings().find((entry) => !entry.revokedAt) ?? r.g.channels.core.bindings()[0]!;
export const endTurn = (r: Rig) => { if (r.g.manager.view.sessions.get(r.sessionId)?.status === "running") { r.g.engine.say(r.sessionId, "기다립니다."); r.g.engine.finish(r.sessionId); } };
/** Whether a text reached the AI's conversation (sent, steered, queued, or in its record as the person's). */
export function reached(r: Rig, text: string): boolean {
  if ([...r.g.engine.sent, ...r.g.engine.steered].some((entry) => entry.text.includes(text))) return true;
  for (const session of r.g.manager.view.sessions.values()) {
    if (session.queued.some((entry) => entry.text.includes(text))) return true;
    if (r.g.manager.items(session.id).items.some((item) => item.kind === "user" && item.text.includes(text))) return true;
  }
  return false;
}
/** The extension (VaultChat/LoginChat) the service made: its tick is called by hand here. */
export const extension = (r: Rig) => (r.g.channels as unknown as { vault: { expire(): Promise<void> } }).vault;
export const metaKey = (r: Rig) => { const b = binding(r); return `channel.secret:${b.kind}:${b.botId}:${b.chatId}`; };
/** The chat's open input runs out (its stored expiry moved into the past). */
export function age(r: Rig) {
  const raw = r.g.store.getMeta(metaKey(r));
  const state = raw ? (JSON.parse(raw) as { window?: { expiresAt: number } | null }) : {};
  expect(state.window, "an input is open before it runs out").toBeTruthy();
  state.window!.expiresAt = Date.now() - 1_000;
  r.g.store.setMeta(metaKey(r), JSON.stringify(state));
}

/** The ending line of ruling P1. */
export const ENDED = "지금부터 보내는 글은 AI에게 갑니다";
/** The answer to a caught line (the ending line says "AI에게 보내지 않…" too, so this is its own start). */
export const CAUGHT = /^(?:방금 보낸 글은|입력이 닫힌 것을 알리기 전에 온 글이라)|\n방금 보낸 글은/;
export const RELEASE = "그대로 보내기";

export async function openInput(r: Rig, kind: Kind) {
  if (kind === "secret") {
    await r.g.credentials.run(r.sessionId, ["need", "--name", "노션 키", "--kind", "api-key", "--site", "notion.so", "--fields", "키"]);
    endTurn(r);
    await wait(() => r.texts().some((text) => text.includes("'노션 키' API 키가 필요합니다")));
    return;
  }
  await r.g.credentials.add({ name: "도서관", kind: "login", site: r.site, values: { 아이디: "zz-user-0909", 비밀번호: "zz-pass-0909" } });
  const args = kind === "code" || kind === "pcCode" ? ["step", "--name", "도서관", "--kind", "code", "--ref", "e6", "--submit", "e7"]
    : kind === "approve" ? ["step", "--name", "도서관", "--kind", "approve", "--app", "카카오톡"] : ["step", "--name", "도서관", "--kind", "link"];
  expect((await r.g.credentials.run(r.sessionId, args)).stdout).toBe("fail:handover_sent\n");
  endTurn(r);
  await wait(() => r.texts().some((text) => text.includes("'도서관' 로그인") && !text.endsWith("로그인 화면")));
}

/** The person (or the PC) ends the input this way; resolves once the gateway has handled it. */
export async function end(r: Rig, kind: Kind, ending: Ending) {
  const said = r.texts().length;
  const settled = () => wait(() => r.texts().length > said);
  switch (ending) {
    case "open": return;
    case "taken":
      if (kind === "secret") { r.send(KEY); return wait(() => r.texts().some((text) => text.includes("받았습니다"))); }
      if (kind === "approve") { r.press("했어요"); return wait(() => reached(r, "승인했다고 합니다")); }
      if (kind === "pcCode" || kind === "pcLink") { r.send("이어서"); return wait(() => reached(r, "이어서")); }
      r.send(kind === "code" ? CODE : LINK(r.site));
      return wait(() => reached(r, kind === "code" ? "넣었습니다" : "열었습니다"));
    case "cancelWord": r.send("취소"); return settled();
    case "cancelButton": r.press("나중에"); return settled();
    case "timeoutTick": age(r); await extension(r).expire(); return settled();
    case "timeoutFound": age(r); return;
    case "stopWord": r.send("멈춰"); return wait(() => r.texts().some((text) => text.includes("멈췄") || text.includes("멈출")));
    case "newWord": r.send("새 대화"); return wait(() => r.texts().some((text) => text.startsWith("새 대화를 만들었습니다")));
    case "newButton":
      r.send("메뉴");
      await wait(() => r.has("새 대화"));
      r.press("새 대화");
      return wait(() => binding(r).pointerSessionId !== r.sessionId);
    case "retryWord": r.send("다시 시도"); return settled();
    case "retryButton": {
      const b = binding(r);
      const first = r.g.manager.items(r.sessionId).items.find((item) => item.kind === "user")!;
      r.g.store.channels.addButton({ token: "zzretry0909", bindingId: b.id, chatId: b.chatId, userId: b.userId, sessionId: r.sessionId, itemId: null, kind: "retry", data: JSON.stringify({ requestId: first.id.replace(/^user:/, "") }), expiresAt: Date.now() + 60_000 });
      const before = r.g.engine.sent.length;
      r.pressToken("zzretry0909");
      return wait(() => r.g.engine.sent.length > before || r.texts().length > said);
    }
    case "lockWord": r.send("잠금"); return wait(() => Boolean(binding(r).lockedAt) && r.texts().length > said);
    case "lockButton":
      r.send("메뉴");
      await wait(() => r.has("채널 잠금"));
      r.press("채널 잠금");
      return wait(() => Boolean(binding(r).lockedAt));
    case "pause": r.g.channels.core.pause(binding(r).id, true); return settled();
    case "lockPc": r.g.channels.core.lock(binding(r).id); return settled();
    case "unpaired": r.g.channels.core.revoke(binding(r).id); await tick(30); return;
    case "aiSide":
      endTurn(r);
      r.g.manager.updateSession(r.sessionId, { archived: true });
      await r.g.credentials.tick();
      await extension(r).expire();
      return settled();
    case "restartTick": await r.restart(); await extension(r).expire(); return settled();
    case "restartFound": await r.restart(); return;
    case "stopButton":
      throw new Error("not applicable");
  }
}

// Fix round 5, ruling Q6: the shapes of the next message. Each form is written down with what the
// rulings (Q3) say it is, never with a product helper: "code" is caught after a CODE input ended,
// "link" after a LINK input ended, "none" passes either. The samples are put together from parts.

export type Form = { name: string; text: (site: string) => string; is: "code" | "link" | "none" };
const C = CODE;
const wide = (digits: string) => [...digits].map((digit) => String.fromCharCode(0xff10 + Number(digit))).join("");
const split3 = (digits: string, by: string) => `${digits.slice(0, 3)}${by}${digits.slice(3)}`;
const OTHER = "https://news.example.com/a";

/** The forms of re-review 4's list and of Q3 (caught and passing), and round 4's caught forms (they stay caught). */
export const FORMS: Form[] = [
  // Code: caught after a code input ended (Q3).
  { name: "bare code", text: () => C, is: "code" },
  { name: "[Web발신] SMS", text: () => `[Web발신]\n[도서관] 인증번호 [${C}]를 입력해 주세요.`, is: "code" },
  { name: "[국민은행] code", text: () => `[국민은행] ${C}`, is: "code" },
  { name: "Your code is", text: () => `Your code is ${C}`, is: "code" },
  { name: "is your Instagram code", text: () => `${C} is your Instagram code`, is: "code" },
  { name: "[토스] 본인확인 번호", text: () => `[토스] 본인확인 번호 ${C}`, is: "code" },
  { name: "보안코드", text: () => `보안코드 ${C}`, is: "code" },
  { name: "확인번호", text: () => `확인번호 ${C}`, is: "code" },
  { name: "일회용 비밀번호", text: () => `일회용 비밀번호 ${C}`, is: "code" },
  { name: "full-width digits", text: () => wide(C), is: "code" },
  { name: "full-width in an SMS", text: () => `[Web발신] 인증번호 ${wide(C)}`, is: "code" },
  { name: "코드 … 넣어 줘", text: () => `코드 ${C} 넣어 줘`, is: "code" },
  { name: "… 입력해줘", text: () => `${C} 입력해줘`, is: "code" },
  { name: "여기요 …", text: () => `여기요 ${C}`, is: "code" },
  { name: "인증번호는 … 입니다", text: () => `인증번호는 ${C} 입니다`, is: "code" },
  { name: "Your verification code is", text: () => `Your verification code is ${C}`, is: "code" },
  { name: "hyphen inside", text: () => split3(C, "-"), is: "code" },
  { name: "single digits spaced", text: () => [...C].join(" "), is: "code" },
  { name: "space inside", text: () => split3(C, " "), is: "code" },
  { name: "G- … Google", text: () => `G-${C} is your Google verification code.`, is: "code" },
  { name: "[카카오] 인증번호(…)", text: () => `[카카오] 인증번호(${C}) 타인에게 절대 알려주지 마세요.`, is: "code" },
  { name: "인증번호 with a phone number", text: () => `인증번호: ${C}, 문의 1588-1234`, is: "code" },
  { name: "[Web발신] 보안코드, long", text: () => `[Web발신]\n[학교] 보안코드 ${C} 를 3분 안에 입력하세요. 타인에게 알려주지 마세요.`, is: "code" },
  { name: "letters and digits", text: () => `ZQ7K${C.slice(0, 2)}`, is: "code" },
  { name: "PIN", text: () => `PIN ${C.slice(0, 4)}`, is: "code" },
  { name: "passcode", text: () => `passcode: ${C}`, is: "code" },
  // Code: passes (Q3's passing forms, and ordinary requests with a number).
  { name: "room number", text: () => "회의는 1430호에서 해요", is: "none" },
  { name: "character count", text: () => "문서 1500자로 써 줘", is: "none" },
  { name: "date", text: () => "2026-11-14", is: "none" },
  { name: "인증서 … 1500자", text: () => "인증서 갱신 문서 1500자로 써 줘", is: "none" },
  { name: "OTP device count", text: () => "OTP 기기 2개 주문해 줘", is: "none" },
  { name: "a time", text: () => "14:30에 회의 잡아 줘", is: "none" },
  { name: "a phone number", text: () => "010-1234-5678로 전화 달라고 메모해 줘", is: "none" },
  { name: "one number in a long request", text: () => `이번 주 학과 회의 자료를 정리하고 예산 표에서 ${C} 항목이 맞는지 봐 줘`, is: "none" },
  { name: "ordinary", text: () => "다른 일 해 줘", is: "none" },
  // Link: caught after a link input ended (Q3).
  { name: "bare link", text: (site) => LINK(site), is: "link" },
  { name: "(link)", text: (site) => `(${LINK(site)})`, is: "link" },
  { name: "<link>", text: (site) => `<${LINK(site)}>`, is: "link" },
  { name: "\"link\"", text: (site) => `"${LINK(site)}"`, is: "link" },
  { name: "<<link>>", text: (site) => `<<${LINK(site)}>>`, is: "link" },
  { name: "메일 왔어요 <link>", text: (site) => `메일 왔어요 <${LINK(site)}>`, is: "link" },
  { name: "링크 <link>", text: (site) => `링크 <${LINK(site)}>`, is: "link" },
  { name: "여기 링크요:", text: (site) => `여기 링크요: ${LINK(site)}`, is: "link" },
  { name: "<link> 열어 줘", text: (site) => `<${LINK(site)}> 열어 줘`, is: "link" },
  { name: "login mail", text: (site) => `[도서관] 로그인하려면 아래 링크를 누르세요. ${LINK(site)}`, is: "link" },
  // Link: passes.
  { name: "a link in a longer request", text: () => `${OTHER} 이 글 요약해 주고 중요한 내용만 세 줄로 정리해서 보내 줘`, is: "none" },
  { name: "two links", text: (site) => `${LINK(site)} 와 ${OTHER} 두 글을 비교해 줘`, is: "none" },
];

/** The forms a cell of this input kind sends: those of its own shape and the passing ones of the same family. */
export const formsFor = (kind: "code" | "link") => {
  const at = FORMS.findIndex((form) => form.is === "link");
  return kind === "code" ? FORMS.slice(0, at) : FORMS.slice(at);
};

export type ShapeCell = { messenger: Messenger; kind: Kind; ending: Ending; form: Form; carrier: Carrier; expect: "caught" | "ai" | { na: string } };
/** Q6's endings: 취소, 멈춰, a timeout and a restart (each said, then the late catch); on Slack also the hold while the step waits at the PC. */
export const SHAPE_ENDINGS: Record<Messenger, Ending[]> = { telegram: ["cancelWord", "stopWord", "timeoutTick", "restartTick"], slack: ["open", "cancelWord", "timeoutTick", "restartTick"] };
const CARRIERS: Carrier[] = ["text", "forward", "caption"];

/** The cells, and each one's outcome from the rulings' table (Q2: whatever carries the words; Q3: the form's shape). */
export function shapeCells(messenger: Messenger): ShapeCell[] {
  const cells: ShapeCell[] = [];
  const kinds: Kind[] = messenger === "telegram" ? ["code", "link"] : ["pcCode", "pcLink"];
  for (const kind of kinds) for (const ending of SHAPE_ENDINGS[messenger]) for (const form of formsFor(catchOf(kind) as "code" | "link")) for (const carrier of CARRIERS) {
    const na = messenger === "slack" && carrier === "forward" ? { na: "Slack has no forwarded message in a DM: a shared message comes as its own text, or as a link the adapter does not open" } : null;
    cells.push({ messenger, kind, ending, form, carrier, expect: na ?? (form.is === catchOf(kind) ? "caught" : "ai") });
  }
  return cells;
}

/** One shape cell: the input opens, ends this way, then the form is sent by this carrier; what reached the AI, what the chat was told, what was deleted. */
export async function runShapeCell(cell: ShapeCell) {
  const r = await rig(cell.messenger);
  await openInput(r, cell.kind);
  await end(r, cell.kind, cell.ending);
  if (cell.ending !== "open") await wait(() => r.texts().some((text) => text.includes("입력을 닫았습니다") || text.includes("그만두었습니다")), 1_500).catch(() => undefined);
  const typed = cell.form.text(r.site);
  // Slack writes a link the person typed in angle brackets as its own markup; the adapter gives the line back with the link bare.
  const text = cell.messenger === "slack" ? typed.replace(/<(https?:[^|>\s]+)>/g, "$1") : typed;
  const said = r.texts().length;
  const sent = r.send(typed, cell.carrier);
  if (cell.expect === "ai") {
    await wait(() => reached(r, text)).catch((error: unknown) => { throw new Error(`${String(error)}; told: ${JSON.stringify(r.texts().slice(said))}`); });
    await r.g.channels.core.idle();
    expect(sent.deleted(), "a passing line is not deleted").toBe(false);
    expect(r.texts().slice(said).some((line) => CAUGHT.test(line)), "a passing line is not answered as caught").toBe(false);
    return;
  }
  await wait(() => r.texts().slice(said).some((line) => CAUGHT.test(line))).catch((error: unknown) => { throw new Error(`${String(error)}; reached the AI: ${reached(r, text)}; told: ${JSON.stringify(r.texts().slice(said))}`); });
  await r.g.channels.core.idle();
  await tick(20);
  expect(reached(r, text), "a caught line does not reach the AI").toBe(false);
  expect(r.texts().slice(said).filter((line) => CAUGHT.test(line)), "answered once").toHaveLength(1);
  if (cell.messenger === "telegram") await wait(() => sent.deleted());
  else expect(sent.deleted()).toBe(false);
  expect(r.labels((line) => CAUGHT.test(line))).toContain(RELEASE);
  r.press(RELEASE);
  await wait(() => reached(r, text));
}
