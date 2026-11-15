import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../bus.ts";
import { formsOf } from "../credentials/forms.ts";
import { installScrubber } from "../credentials/install.ts";
import { CredentialService } from "../credentials/service.ts";
import { HttpError } from "../errors.ts";
import { OfficeVault } from "../office-vault.ts";
import { SessionManager } from "../sessions.ts";
import { Store } from "../store.ts";
import { FAKE_TOKEN, FakeTelegram } from "./fake-telegram.ts";
import { ChannelService } from "./service.ts";
import { StandInEngine, tick, until } from "./test-kit.ts";

const sealPageCode = /\/\* seal:begin \*\/([\s\S]*?)\/\* seal:end \*\//.exec(readFileSync(new URL("./seal-v1.html", import.meta.url), "utf8"))![1]!;
/** The sealing code of seal-v1.html itself (what the phone runs). */
const sealFields = new Function(`${sealPageCode}; return sealFields;`)() as (key: string, nonce: string, fields: Record<string, string>) => Promise<string>;

// Unit 8, (i) 보내고 바로 지우기, through the real Telegram adapter against the stand-in Bot API on
// 127.0.0.1: a value typed in the chat never reaches the inbox, the record, a log or a transcript,
// goes straight to the store, and its message is deleted; and the crash cases, precisely. The values
// are made up; every search below is shown able to find one that was planted.

const ID = "zz-secret-user-0009";
const PASSWORD = "zz-secret-pass-0009";
const NEED = ["need", "--name", "학술정보원", "--kind", "login", "--site", "lib.example.ac.kr", "--fields", "아이디,비밀번호"];
const KEY_NEED = ["need", "--name", "노션 키", "--kind", "api-key", "--site", "notion.so", "--fields", "키"];

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); vi.restoreAllMocks(); });

type Rig = Awaited<ReturnType<typeof open>>;

async function open(at: { dir?: string; fake?: FakeTelegram; keyring?: boolean; sealPage?: string } = {}) {
  const dir = at.dir ?? mkdtempSync(join(tmpdir(), "wb-secret-input-"));
  const dataDir = join(dir, "data");
  mkdirSync(dataDir, { recursive: true });
  const fake = at.fake ?? new FakeTelegram();
  if (!at.fake) await fake.start();
  const store = new Store(join(dataDir, "state.sqlite"));
  const bus = new EventBus();
  const manager = new SessionManager(store, bus, { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dataDir, "works"), dataDir });
  const engine = new StandInEngine(() => manager.sink);
  manager.registerAdapter(engine);
  const vault = new OfficeVault(dataDir, at.keyring === false ? async () => { throw new HttpError(503, "office_vault_unavailable", "없음"); } : async () => ({ id: "d".repeat(32), key: Buffer.alloc(32, 5) }));
  const credentials = new CredentialService({ dataDir, vault, manager });
  installScrubber(store, manager, credentials.scrubber);
  const lines: string[] = [];
  const channels = new ChannelService({ dataDir, store, manager, bus, vault, credentials, telegramUrl: fake.url, telegram: { pollSeconds: 1, minSendGapMs: 0 }, log: (line) => lines.push(line), ...(at.sealPage ? { sealPage: at.sealPage } : {}) });
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
  if (!at.fake) cleanups.unshift(async () => { await fake.stop(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, dataDir, fake, store, manager, engine, credentials, channels, lines, close };
}

async function paired(options: { keyring?: boolean; sealPage?: string } = {}) {
  const r = await open(options);
  await r.channels.registerTelegram(FAKE_TOKEN, { memoryOnly: options.keyring === false });
  const { code } = r.channels.core.beginPairing("telegram", r.fake.botId);
  r.fake.message(`/start ${code}`);
  await until(() => Boolean(r.channels.core.pairing("telegram", r.fake.botId).request));
  await r.channels.core.approvePairing("telegram", r.fake.botId, r.channels.core.pairing("telegram", r.fake.botId).request!.id);
  r.fake.message("도서관 대출 목록 정리해 줘");
  await until(() => r.engine.sent.length === 1);
  return { ...r, sessionId: r.channels.core.bindings()[0]!.pointerSessionId! };
}

/** The AI asks for what only the person has, and ends its turn; the hand-over message opens the input with it (R4). */
async function askAndOpen(r: Rig & { sessionId: string }, need = NEED) {
  expect(await r.credentials.run(r.sessionId, need)).toMatchObject({ stdout: "fail:handover_sent\n" });
  r.engine.say(r.sessionId, "로그인이 필요해 요청했습니다.");
  r.engine.finish(r.sessionId);
  await until(() => r.fake.texts().some((text) => text.includes("필요합니다") && text.includes("다음에 보내는 메시지를") && text.includes("이 값은 텔레그램을 거쳐 옵니다. 받는 즉시 지웁니다.")));
}
/** The secret input's stored state for the paired chat (moved in time by tests). */
function windowState(r: Rig) {
  const key = `channel.secret:telegram:${r.fake.botId}:555`;
  return { get: () => JSON.parse(r.store.getMeta(key)!) as { window: { expiresAt: number } | null }, set: (value: unknown) => r.store.setMeta(key, JSON.stringify(value)) };
}
type Update = Record<string, unknown>;
const messageOf = (update: Update) => (update.message ?? update.edited_message) as { message_id: number };
const deleted = (r: Rig, update: Update) => r.fake.of("deleteMessage").filter((call) => call.params.message_id === messageOf(update).message_id).length;
const continued = (r: Rig) => r.engine.sent.filter((entry) => entry.text.includes("가 준비되었습니다. 멈춘 곳에서 이어 하세요."));
/** A press of the button with this label, on the message it sits on (as Telegram sends it). */
const pressOn = (r: Rig, label: string) => { const button = r.fake.button(label); return r.fake.press(button.data, { messageId: button.messageId }); };
const toAi = (r: Rig, value: string) => [...r.engine.sent, ...r.engine.steered].some((entry) => entry.text.includes(value));

/** Every byte under the data folder (database and its log, the inbox and record in it, logs, store, spool), and the channel's log lines. */
function everywhere(r: Rig, value: string): string[] {
  let all = r.lines.join("\n");
  for (const entry of readdirSync(r.dataDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const bytes = readFileSync(join(entry.parentPath, entry.name));
    all += bytes.toString("latin1") + bytes.toString("utf8");
  }
  return formsOf(value).filter((form) => all.includes(form));
}

describe("(i) 보내고 바로 지우기", () => {
  it("takes each field from its own message, deletes the message, stores it sealed, and continues the conversation once", async () => {
    const r = await paired();
    await askAndOpen(r);
    expect(r.fake.texts().find((text) => text.includes("필요합니다"))).toContain("다음에 보내는 메시지를 '학술정보원'의 아이디로 받습니다. (1/2)");
    const first = r.fake.message(ID);
    await until(() => deleted(r, first) === 1 && r.fake.texts().some((text) => text.startsWith("'학술정보원'의 아이디를 받았습니다") && text.includes("비밀번호로 받습니다")));
    const second = r.fake.message(PASSWORD);
    await until(() => deleted(r, second) === 1 && continued(r).length === 1);
    expect(r.fake.texts().some((text) => text.startsWith("'학술정보원'의 비밀번호를 받았습니다. 보관함에 봉인해 두었고 이 채팅에서는 지웠습니다."))).toBe(true);
    expect(await r.credentials.run(r.sessionId, NEED)).toMatchObject({ stdout: "ok\n" });
    expect(toAi(r, ID) || toAi(r, PASSWORD)).toBe(false);
    // The record says what happened, not what was said.
    expect(r.channels.core.auditList({}).some((row) => row.action === "secret.received")).toBe(true);
    // The continuation's answer comes to the chat as any answer does.
    r.engine.say(r.sessionId, `대출 7권 · 로그인 ${PASSWORD}`);
    r.engine.finish(r.sessionId);
    await until(() => r.fake.texts().some((text) => text.includes("대출 7권")));
    expect(r.fake.texts().find((text) => text.includes("대출 7권"))).toContain("[비밀: 학술정보원]");
    await r.close();
    expect(everywhere(r, ID)).toEqual([]);
    expect(everywhere(r, PASSWORD)).toEqual([]);
    writeFileSync(join(r.dataDir, "planted"), Buffer.from(PASSWORD).toString("base64"));
    expect(everywhere(r, PASSWORD).length).toBeGreaterThan(0);
  });

  it("says so in one line when the message could not be deleted, and still stores the value", async () => {
    const r = await paired();
    await askAndOpen(r, KEY_NEED);
    r.fake.failDelete = 1;
    r.fake.message(PASSWORD);
    await until(() => continued(r).length === 1);
    expect(r.fake.texts().filter((text) => text === "보낸 메시지를 지우지 못했습니다. 텔레그램에서 직접 지워 주세요.")).toHaveLength(1);
  });

  it("closes on 취소: nothing is stored, and the next line goes to the AI as usual", async () => {
    const r = await paired();
    await askAndOpen(r);
    r.fake.message("취소");
    // Fix round 4 (P1): the input's one ending line, with [다시 넣기].
    await until(() => r.fake.texts().some((text) => text.startsWith("'학술정보원' 아이디 입력을 닫았습니다. 지금부터 보내는 글은 AI에게 갑니다. 값은 여기 적지 마세요.")));
    expect(r.fake.buttonData("다시 넣기")).toBeTruthy();
    r.fake.message("목록만 먼저 보여 줘");
    await until(() => toAi(r, "목록만 먼저 보여 줘"));
    expect(r.credentials.store.summaries()).toEqual([]);
  });

  it("refuses and deletes a picture, a sticker, a forwarded or an edited message, passes none to the AI, and still takes the text after", async () => {
    const r = await paired();
    await askAndOpen(r, KEY_NEED);
    const updates = [r.fake.message("", { extra: { photo: [{ file_id: "p1", file_size: 10 }] } }), r.fake.message("", { extra: { sticker: { file_id: "s1" } } }), r.fake.message(PASSWORD, { extra: { forward_origin: { type: "user" } } })];
    const edited = r.fake.edit(messageOf(updates[2]!), `${PASSWORD}!`);
    await until(() => updates.every((update) => deleted(r, update) >= 1) && deleted(r, edited) >= 1);
    await until(() => r.fake.texts().filter((text) => text.startsWith("글로만 받습니다.")).length === 4);
    expect(r.credentials.store.summaries()).toEqual([]);
    expect(toAi(r, PASSWORD)).toBe(false);
    r.fake.message(PASSWORD);
    await until(() => continued(r).length === 1);
    expect(r.credentials.store.find("노션 키")).not.toBeNull();
  });

  it("lets 멈춰 through (the input closes), and takes nothing after", async () => {
    const r = await paired();
    await askAndOpen(r, KEY_NEED);
    r.fake.message("멈춰");
    await until(() => r.fake.texts().some((text) => text === "지금 멈출 일이 없습니다."));
    r.fake.message("다른 일 해 줘");
    await until(() => toAi(r, "다른 일 해 줘"));
    expect(r.credentials.store.summaries()).toEqual([]);
  });

  it("without a keyring keeps the value in memory only, for one use, and says so", async () => {
    const r = await paired({ keyring: false });
    await askAndOpen(r, KEY_NEED);
    r.fake.message(PASSWORD);
    await until(() => continued(r).length === 1);
    expect(r.fake.texts().some((text) => text.includes("보안 저장소가 없어 저장하지 않았습니다. 이번 한 번만 쓰고 버립니다."))).toBe(true);
    expect(r.credentials.store.find("노션 키")).toMatchObject({ held: "memory" });
    await r.close();
    expect(everywhere(r, PASSWORD)).toEqual([]);
  });
});

describe("merge with unit 14", () => {
  it("while a secret input is open, an everyday word is the app's (round 3, ruling A): answered, never taken, never passed on; the input stays for the value", async () => {
    const r = await paired();
    await askAndOpen(r, KEY_NEED);
    const line = r.fake.message("도움말");
    await until(() => r.fake.texts().some((text) => text.startsWith("'노션 키'의 키를 기다리고 있습니다.")));
    expect(deleted(r, line)).toBe(0);
    expect(toAi(r, "도움말")).toBe(false);
    const value = r.fake.message(PASSWORD);
    await until(() => deleted(r, value) === 1 && continued(r).length === 1);
    expect(toAi(r, PASSWORD)).toBe(false);
  });

  it("ruling A: 상태, then 메뉴 and a menu button, leave the input open: the value sent next is taken", async () => {
    const r = await paired();
    await askAndOpen(r, KEY_NEED);
    r.fake.message("상태");
    await until(() => r.fake.texts().filter((text) => text === "'노션 키'의 키를 기다리고 있습니다.").length === 1);
    r.fake.message("메뉴");
    await until(() => r.fake.texts().filter((text) => text === "'노션 키'의 키를 기다리고 있습니다.").length === 2);
    pressOn(r, "사용량");
    await tick(50);
    const value = r.fake.message(PASSWORD);
    await until(() => deleted(r, value) === 1 && continued(r).length === 1);
    expect(r.credentials.store.find("노션 키")).not.toBeNull();
    expect(toAi(r, PASSWORD)).toBe(false);
    expect(r.engine.sent.some((entry) => ["상태", "메뉴"].includes(entry.text.trim()))).toBe(false);
  });

  it("a stored value wrapped in markup, or split by it, never reaches the Bot API in any form", async () => {
    const r = await paired();
    const value = "zz_secret_pass_0010";
    await r.credentials.add({ name: "도서관", kind: "login", site: "", values: { 비밀번호: value } });
    r.engine.say(r.sessionId, `값: **${value}** 와 *${value}* 와 \`${value}\` 와 zz_secret**_pass_0010** 와 [링크](https://a.example/${value})`);
    r.engine.finish(r.sessionId);
    await until(() => r.fake.texts().some((text) => text.startsWith("값:")));
    const wire = JSON.stringify(r.fake.calls.map((call) => call.params));
    expect(formsOf(value).filter((form) => wire.includes(form))).toEqual([]);
    expect(r.fake.texts().find((text) => text.startsWith("값:"))).toContain("[비밀: 도서관]");
  });
});

describe("edits", () => {
  it("of an earlier message outside an input are not a new request", async () => {
    const r = await paired();
    const line = r.fake.message("둘째 줄");
    await until(() => toAi(r, "둘째 줄"));
    const before = r.engine.sent.length + r.engine.steered.length;
    r.fake.edit(messageOf(line), "고친 줄");
    await until(() => r.fake.pending() === 0);
    await new Promise((done) => setTimeout(done, 300));
    expect(r.engine.sent.length + r.engine.steered.length).toBe(before);
    expect(toAi(r, "고친 줄")).toBe(false);
  });
});

describe("(i) across a crash", () => {
  it("between receiving and storing: nothing stored, nothing to the AI, the message deleted, and the person asked again", async () => {
    const first = await paired();
    await askAndOpen(first, KEY_NEED);
    // The gateway dies right after the adapter wrote the event and its offset, before the core handled it.
    vi.spyOn(first.channels.core, "receive").mockImplementation(async (_adapter, event) => { if (event.type === "secret") throw new Error("crash"); });
    const update = first.fake.message(PASSWORD);
    await until(() => first.fake.pending() === 0 && first.lines.some((line) => line.includes("sink_failed")));
    vi.restoreAllMocks();
    await first.close();
    const again = await open({ dir: first.dir, fake: first.fake });
    await until(() => deleted(again, update) === 1 && again.fake.texts().some((text) => text.includes("받지 못했습니다")) && again.fake.texts().some((text) => text.startsWith("다음에 보내는 메시지를 '노션 키'의 키로 받습니다")));
    expect(again.credentials.store.summaries()).toEqual([]);
    expect(toAi(again, PASSWORD)).toBe(false);
    // Telegram was told the offset: the update is not delivered again.
    expect(again.fake.pending()).toBe(0);
    // Sent again, it is taken.
    again.fake.message(PASSWORD);
    await until(() => continued(again).length === 1);
    await again.close();
    expect(everywhere(again, PASSWORD)).toEqual([]);
  });

  it("before the inbox was written: the update comes again, is taken again (never as a request to the AI), and stored once", async () => {
    const r = await paired();
    await askAndOpen(r, KEY_NEED);
    // The inbox write fails once: the offset is not kept, so Telegram delivers the update again.
    const record = r.store.channels.record.bind(r.store.channels);
    let failed = false;
    vi.spyOn(r.store.channels, "record").mockImplementation((kind, botId, events, next) => {
      if (!failed && events.some((event) => event.payload.includes("\"secret\""))) { failed = true; throw new Error("disk full"); }
      return record(kind, botId, events, next);
    });
    r.fake.message(PASSWORD);
    await until(() => continued(r).length === 1);
    expect(failed).toBe(true);
    expect(r.credentials.store.summaries()).toHaveLength(1);
    expect(toAi(r, PASSWORD)).toBe(false);
  });

  it("between storing and acknowledging: started again, the event is not stored twice, the message not deleted twice, the conversation continued once", async () => {
    const first = await paired();
    await askAndOpen(first, KEY_NEED);
    const done = first.store.channels.done.bind(first.store.channels);
    vi.spyOn(first.store.channels, "done").mockImplementation((kind, botId, eventId) => {
      if (first.store.channels.seen(kind, botId, eventId) === "received" && first.credentials.store.summaries().length) throw new Error("crash");
      return done(kind, botId, eventId);
    });
    const update = first.fake.message(PASSWORD);
    await until(() => continued(first).length === 1 && deleted(first, update) === 1);
    vi.restoreAllMocks();
    const texts = first.fake.texts().length;
    await first.close();
    const again = await open({ dir: first.dir, fake: first.fake });
    await until(() => again.store.channels.seen("telegram", again.fake.botId, String(update.update_id)) === "done");
    expect(deleted(again, update)).toBe(1);
    expect(again.credentials.store.summaries()).toHaveLength(1);
    expect(continued(first).length + continued(again).length).toBe(1);
    // Nothing is said again: no second "받았습니다", no "받지 못했습니다", no "이미 끝나".
    await new Promise((done) => setTimeout(done, 300));
    expect(again.fake.texts().slice(texts).filter((text) => /받았습니다|받지 못했습니다|이미 끝나|지우지 못했습니다|글로만/.test(text))).toEqual([]);
  });

  it("an update delivered again after the input closed is neither stored twice nor a request to the AI", async () => {
    const r = await paired();
    await askAndOpen(r, KEY_NEED);
    const update = r.fake.message(PASSWORD);
    await until(() => continued(r).length === 1);
    r.fake.redeliver(update);
    await until(() => r.fake.pending() === 0);
    await new Promise((done) => setTimeout(done, 300));
    expect(r.credentials.store.summaries()).toHaveLength(1);
    expect(toAi(r, PASSWORD)).toBe(false);
    expect(deleted(r, update)).toBe(1);
  });
});

describe("(ii) the sealed Mini App form, only when a page address is set", () => {
  it("opens the form from a keyboard button; the sealed block is taken once, deleted, and fills every field", async () => {
    const r = await paired({ sealPage: "https://forms.example.invalid/seal-v1.html" });
    expect(await r.credentials.run(r.sessionId, NEED)).toMatchObject({ stdout: "fail:handover_sent\n" });
    r.engine.finish(r.sessionId);
    await until(() => r.fake.of("sendMessage").some((call) => JSON.stringify(call.params.reply_markup ?? {}).includes("web_app")));
    const markup = r.fake.of("sendMessage").find((call) => JSON.stringify(call.params.reply_markup ?? {}).includes("web_app"))!.params.reply_markup as { keyboard: { text: string; web_app: { url: string } }[][] };
    const url = new URL(markup.keyboard[0]![0]!.web_app.url);
    expect(`${url.origin}${url.pathname}`).toBe("https://forms.example.invalid/seal-v1.html");
    const hash = new URLSearchParams(url.hash.slice(1));
    const block = await sealFields(hash.get("k")!, hash.get("n")!, { 아이디: ID, 비밀번호: PASSWORD });
    const update = r.fake.webAppData(block);
    await until(() => continued(r).length === 1 && deleted(r, update) === 1);
    expect(r.credentials.store.find("학술정보원")).toMatchObject({ fields: ["아이디", "비밀번호"], held: "sealed" });
    // The same block again: nothing waits for it, it is not stored twice, and it is deleted.
    const again = r.fake.webAppData(block);
    await until(() => deleted(r, again) === 1 && r.fake.texts().some((text) => text.startsWith("받을 준비가 된 입력이 없습니다")));
    expect(r.credentials.store.summaries()).toHaveLength(1);
    expect(toAi(r, PASSWORD)).toBe(false);
    await r.close();
    expect(everywhere(r, PASSWORD)).toEqual([]);
  });

  it("without a page address, the control opens the chat's own input and no form", async () => {
    const r = await paired();
    await askAndOpen(r);
    expect(r.fake.of("sendMessage").some((call) => JSON.stringify(call.params.reply_markup ?? {}).includes("web_app"))).toBe(false);
  });
});

describe("fix round 1 (R4: a value the app asked for never reaches the AI)", () => {
  it("C2: a value sent after the input ran out (before the chat was told) is deleted, not kept, not passed on, and answered with [그대로 보내기]; the ending is said with [다시 넣기]; the next line is ordinary", async () => {
    const r = await paired();
    await askAndOpen(r, KEY_NEED);
    const state = windowState(r).get();
    windowState(r).set({ ...state, window: { ...state.window!, expiresAt: Date.now() - 1_000 } });
    const late = r.fake.message(PASSWORD);
    await until(() => deleted(r, late) === 1 && r.fake.texts().some((text) => text.startsWith("입력이 닫힌 것을 알리기 전에 온 글이라 AI에게 보내지 않고 지웠습니다.")));
    await until(() => r.fake.texts().some((text) => text.startsWith("입력 시간(10분)이 지나 '노션 키' 키 입력을 닫았습니다.")));
    expect(r.fake.buttonData("다시 넣기")).toBeTruthy();
    expect(r.fake.buttonData("그대로 보내기")).toBeTruthy();
    expect(r.credentials.store.summaries()).toEqual([]);
    r.fake.message("목록만 먼저 보여 줘");
    await until(() => toAi(r, "목록만 먼저 보여 줘"));
    expect(toAi(r, PASSWORD)).toBe(false);
    await r.close();
    expect(everywhere(r, PASSWORD)).toEqual([]);
  });

  it("C3: after a field fails to store, the input is open again at that field: the retry is kept as that field, and nothing reaches the AI", async () => {
    const r = await paired();
    await askAndOpen(r);
    const tooLong = r.fake.message(`zz-${"x".repeat(5000)}`);
    await until(() => deleted(r, tooLong) === 1 && r.fake.texts().some((text) => text.startsWith("받은 값을 저장하지 못했습니다")));
    r.fake.message(ID);
    await until(() => r.fake.texts().some((text) => text.startsWith("'학술정보원'의 아이디를 받았습니다")));
    r.fake.message(PASSWORD);
    await until(() => continued(r).length === 1);
    const entry = r.credentials.store.find("학술정보원")!;
    expect(await r.credentials.store.reveal(entry.id, r.sessionId)).toEqual({ 아이디: ID, 비밀번호: PASSWORD });
    expect(toAi(r, ID) || toAi(r, PASSWORD)).toBe(false);
  });

  it("I4: a reply to the hand-over message is the value, also after 나중에 closed the input", async () => {
    const r = await paired();
    await askAndOpen(r, KEY_NEED);
    const asked = r.fake.of("sendMessage").find((call) => String(call.params.text).includes("필요합니다"))!;
    pressOn(r, "나중에");
    await until(() => r.fake.texts().some((text) => text.includes("나중에 넣으려면")));
    const update = r.fake.message(PASSWORD, { extra: { reply_to_message: { message_id: r.fake.sentIdOf(asked) } } });
    await until(() => continued(r).length === 1 && deleted(r, update) === 1);
    expect(toAi(r, PASSWORD)).toBe(false);
  });

  it("I4: a press and the value in one batch: the value is taken, and the next ordinary line is not", async () => {
    const r = await paired();
    await askAndOpen(r, KEY_NEED);
    pressOn(r, "나중에");
    await until(() => r.fake.texts().some((text) => text.includes("나중에 넣으려면")));
    pressOn(r, "다시 넣기");
    const update = r.fake.message(PASSWORD);
    await until(() => continued(r).length === 1 && deleted(r, update) === 1);
    r.fake.message("그다음 출석부도 정리해 줘");
    await until(() => toAi(r, "그다음 출석부도 정리해 줘"));
    expect(toAi(r, PASSWORD)).toBe(false);
  });

  it("confirms each field by name with 다시 넣기, which takes the field again", async () => {
    const r = await paired();
    await askAndOpen(r);
    r.fake.message("오타난아이디");
    await until(() => r.fake.texts().some((text) => text.startsWith("'학술정보원'의 아이디를 받았습니다")));
    pressOn(r, "다시 넣기");
    await until(() => r.fake.texts().filter((text) => text.includes("아이디로 받습니다")).length === 2);
    r.fake.message(ID);
    await until(() => r.fake.texts().filter((text) => text.startsWith("'학술정보원'의 아이디를 받았습니다")).length === 2);
    r.fake.message(PASSWORD);
    await until(() => continued(r).length === 1);
    expect(await r.credentials.store.reveal(r.credentials.store.find("학술정보원")!.id, r.sessionId)).toEqual({ 아이디: ID, 비밀번호: PASSWORD });
  });

  it("I5 (fix round 4, P1): pausing or locking the chat ends its open input and says so; a value typed after is never kept and never reaches the AI", async () => {
    for (const gate of ["pause", "lock"] as const) {
      const r = await paired();
      await askAndOpen(r, KEY_NEED);
      const binding = r.channels.core.bindings()[0]!;
      if (gate === "pause") r.channels.core.pause(binding.id, true); else r.channels.core.lock(binding.id);
      // Fix round 5, Q1: what is true NOW (the chat is closed), never "goes to the AI".
      const state = gate === "pause" ? "멈춰" : "잠겨";
      await until(() => r.fake.texts().some((text) => text.startsWith(`채널이 ${state} '노션 키' 키 입력을 닫았습니다. 지금은 채널이 ${state} 있어 보내는 글이 전달되지 않습니다.`)));
      expect(r.fake.texts().some((text) => text.includes("지금부터 보내는 글은 AI에게 갑니다"))).toBe(false);
      r.fake.message(PASSWORD);
      await until(() => r.fake.texts().some((text) => text.includes(gate === "pause" ? "멈춰 두었습니다" : "잠겨 있습니다"))).catch((error: unknown) => { throw new Error(`${String(error)} ${JSON.stringify(r.fake.texts().slice(-3))}`); });
      expect(r.credentials.store.summaries()).toEqual([]);
      expect(toAi(r, PASSWORD)).toBe(false);
    }
  });

  it("Minor 1: editing an earlier ordinary message while an input is open does not delete it", async () => {
    const r = await paired();
    const earlier = r.fake.message("둘째 줄");
    await until(() => toAi(r, "둘째 줄"));
    await askAndOpen(r, KEY_NEED);
    const edit = r.fake.edit(messageOf(earlier), "고친 둘째 줄");
    await until(() => r.fake.pending() === 0);
    await new Promise((done) => setTimeout(done, 300));
    expect(deleted(r, edit)).toBe(0);
    r.fake.message(PASSWORD);
    await until(() => continued(r).length === 1);
  });
});

describe("fix round 2 (review N3, N4)", () => {
  it("N3: once the hand-over stops waiting (given at the PC, cancelled, expired), the next ordinary line is an ordinary line", async () => {
    for (const end of ["pc", "cancel", "expire"] as const) {
      const r = await paired();
      await askAndOpen(r, KEY_NEED);
      const [waiting] = r.credentials.state().waiting;
      if (end === "pc") {
        await r.credentials.add({ name: "노션 키", kind: "api-key", site: "", values: { 키: PASSWORD } });
        await until(() => r.fake.texts().some((text) => text.startsWith("PC에서 '노션 키'를 넣었습니다")));
      } else if (end === "cancel") r.credentials.cancel(waiting!.id);
      else {
        r.credentials.store.updateHandoff(waiting!.id, { expiresAt: Date.now() - 1 });
        await r.credentials.tick();
      }
      const line = r.fake.message(`고마워 이제 다음 일을 하자 (${end})`);
      await until(() => toAi(r, `고마워 이제 다음 일을 하자 (${end})`));
      expect(deleted(r, line), end).toBe(0);
    }
  });

  it("N3 (fix round 4, P1/P2): once its conversation is archived, the line that finds the input over is caught and answered with [그대로 보내기] (nobody was told yet), the ending is said; the next line is ordinary, and the tick ends the hand-over", async () => {
    const r = await paired();
    await askAndOpen(r, KEY_NEED);
    r.manager.updateSession(r.sessionId, { archived: true });
    const line = r.fake.message("보관한 뒤에 보낸 글");
    await until(() => deleted(r, line) === 1 && r.fake.texts().some((text) => text.startsWith("입력이 닫힌 것을 알리기 전에 온 글이라")));
    await until(() => r.fake.texts().some((text) => text.startsWith("요청이 끝나 '노션 키' 키 입력을 닫았습니다.")));
    const next = r.fake.message("그다음 글");
    await until(() => r.fake.pending() === 0);
    await new Promise((done) => setTimeout(done, 300));
    expect(deleted(r, next)).toBe(0);
    await r.credentials.tick();
    expect(r.credentials.store.handoffs().map((handoff) => handoff.state)).toEqual(["cancelled"]);
  });

  it("Minor: a second hand-over says which one a plain line answers; a reply to the first one's message still answers it", async () => {
    const r = await paired();
    await askAndOpen(r, KEY_NEED);
    expect(await r.credentials.run(r.sessionId, NEED)).toMatchObject({ stdout: "fail:handover_sent\n" });
    await until(() => r.fake.texts().some((text) => text.includes("'학술정보원' 로그인 정보가 필요합니다")));
    const second = r.fake.texts().find((text) => text.includes("'학술정보원' 로그인 정보가 필요합니다"))!;
    expect(second).toContain("다음에 보내는 메시지를 '학술정보원'의 아이디로 받습니다.");
    expect(second).toContain("앞의 '노션 키' 요청에는 그 메시지에 답장해서 넣어 주세요.");
    const first = r.fake.of("sendMessage").find((call) => String(call.params.text).includes("'노션 키' API 키가 필요합니다"))!;
    r.fake.message(PASSWORD, { extra: { reply_to_message: { message_id: r.fake.sentIdOf(first) } } });
    await until(() => r.fake.texts().some((text) => text.startsWith("'노션 키'의 키를 받았습니다")));
  });

  it("Minor: 다시 넣기 after the continuation went tells the AI once, in a queued line without the value", async () => {
    const r = await paired();
    await askAndOpen(r, KEY_NEED);
    r.fake.message("zz-secret-first-0009");
    await until(() => continued(r).length === 1);
    pressOn(r, "다시 넣기");
    await until(() => r.fake.texts().filter((text) => text.includes("키로 받습니다")).length === 2);
    r.fake.message(PASSWORD);
    await until(() => r.fake.texts().some((text) => text.startsWith("'노션 키'의 키를 다시 받았습니다")));
    const again = () => [...r.engine.sent, ...r.engine.steered].filter((entry) => entry.text.includes("[자동 이어 하기] '노션 키'의 키를 다시 넣었습니다. 앞에서 쓴 값 대신 이것을 쓰세요."));
    r.engine.finish(r.sessionId);
    await until(() => again().length === 1);
    expect(toAi(r, PASSWORD)).toBe(false);
  });

  it("N4: a hand-over asked while the chat is paused opens nothing; the person's lines are not deleted; at resume its message comes once and the input opens with it", async () => {
    const r = await paired();
    const binding = r.channels.core.bindings()[0]!;
    r.channels.core.pause(binding.id, true);
    expect(await r.credentials.run(r.sessionId, KEY_NEED)).toMatchObject({ stdout: "fail:handover_sent\n" });
    r.engine.finish(r.sessionId);
    const line = r.fake.message("멈춘 동안 보낸 글");
    await until(() => r.fake.texts().some((text) => text === "지금은 PC에서 채널을 멈춰 두었습니다."));
    expect(deleted(r, line)).toBe(0);
    expect(r.fake.texts().some((text) => text.includes("필요합니다"))).toBe(false);
    r.channels.core.pause(binding.id, false);
    await until(() => r.fake.texts().filter((text) => text.includes("'노션 키' API 키가 필요합니다")).length === 1);
    r.fake.message(PASSWORD);
    await until(() => continued(r).length === 1);
    expect(r.fake.texts().filter((text) => text.includes("'노션 키' API 키가 필요합니다"))).toHaveLength(1);
  });

  it("N4: a hand-over that expires unseen says so in the conversation and, when the chat reopens, in one line there", async () => {
    const r = await paired();
    const binding = r.channels.core.bindings()[0]!;
    r.channels.core.lock(binding.id);
    await r.credentials.run(r.sessionId, KEY_NEED);
    const [waiting] = r.credentials.state().waiting;
    r.credentials.store.updateHandoff(waiting!.id, { expiresAt: Date.now() - 1 });
    await r.credentials.tick();
    expect(r.manager.items(r.sessionId).items.some((item) => item.kind === "notice" && item.text.includes("'노션 키' 넘겨받기 시간이 지났습니다"))).toBe(true);
    r.channels.core.unlock(binding.id);
    await until(() => r.fake.texts().filter((text) => text.startsWith("'노션 키' 넘겨받기 시간이 지났습니다")).length === 1);
    expect(r.fake.texts().some((text) => text.includes("필요합니다"))).toBe(false);
  });
});

describe("fix round 3 (review N6, minors)", () => {
  it("N6: a hand-over message Telegram applied but whose answer was lost still opens the input: the value is taken, deleted, never in the inbox, never to the AI", async () => {
    const r = await paired();
    // The fault is for the hand-over message: the turn's status line has gone already.
    await until(() => r.fake.texts().some((text) => text.startsWith("작업 중")));
    r.fake.nextSend = ["cut-after"];
    expect(await r.credentials.run(r.sessionId, KEY_NEED)).toMatchObject({ stdout: "fail:handover_sent\n" });
    await until(() => r.fake.texts().some((text) => text.includes("'노션 키' API 키가 필요합니다")));
    r.engine.say(r.sessionId, "키가 필요해 요청했습니다.");
    r.engine.finish(r.sessionId);
    await until(() => r.credentials.store.handoffs()[0]?.askedAt != null);
    const update = r.fake.message(PASSWORD);
    await until(() => deleted(r, update) === 1 && continued(r).length === 1);
    expect(toAi(r, PASSWORD)).toBe(false);
    // The hand-over message itself went once (the confirmation repeats the request in its own line, fix round 4).
    expect(r.fake.texts().filter((text) => text.includes("'노션 키' API 키가 필요합니다") && text.includes("다음에 보내는 메시지를"))).toHaveLength(1);
    await r.close();
    expect(everywhere(r, PASSWORD)).toEqual([]);
  });

  it("N6: a hand-over message known not to have gone (a 4xx) opens nothing; the tick sends it once later, with its input", async () => {
    const r = await paired();
    // The fault is for the hand-over message: the turn's status line has gone already.
    await until(() => r.fake.texts().some((text) => text.startsWith("작업 중")));
    r.fake.nextSend = ["refuse"];
    expect(await r.credentials.run(r.sessionId, KEY_NEED)).toMatchObject({ stdout: "fail:handover_sent\n" });
    r.engine.finish(r.sessionId);
    await until(() => r.fake.of("sendMessage").length > 0 && r.fake.pending() === 0);
    await new Promise((done) => setTimeout(done, 300));
    expect(r.fake.texts().some((text) => text.includes("필요합니다"))).toBe(false);
    expect(r.store.getMeta(`channel.secret:telegram:${r.fake.botId}:555`) === null || windowState(r).get().window === null).toBe(true);
    expect(r.credentials.store.handoffs()[0]!.askedAt ?? null).toBeNull();
    expect(r.credentials.store.handoffs()[0]!.askRefusals).toBe(1);
    await r.credentials.tick();
    await r.credentials.tick();
    // (A refused call is not among the stand-in's delivered calls.)
    await until(() => r.fake.texts().filter((text) => text.includes("'노션 키' API 키가 필요합니다")).length === 1);
    r.fake.message(PASSWORD);
    await until(() => continued(r).length === 1);
    expect(r.fake.texts().filter((text) => text.includes("'노션 키' API 키가 필요합니다"))).toHaveLength(1);
  });

  it("the input-closing layer on its own: once the hand-over ends, its input and its replies are gone from the chat's state", async () => {
    const r = await paired();
    await askAndOpen(r, KEY_NEED);
    const raw = () => JSON.parse(r.store.getMeta(`channel.secret:telegram:${r.fake.botId}:555`)!) as { window: unknown; asks: Record<string, unknown> };
    expect(raw().window).not.toBeNull();
    expect(Object.keys(raw().asks)).toHaveLength(1);
    r.credentials.cancel(r.credentials.state().waiting[0]!.id);
    expect(raw().window).toBeNull();
    expect(raw().asks).toEqual({});
  });

  it("after the chat is disconnected and paired again, a hand-over that still waits is asked in the new chat, once", async () => {
    const r = await paired();
    const old = r.channels.core.bindings()[0]!;
    await askAndOpen(r, KEY_NEED);
    r.channels.core.revoke(old.id);
    const { code } = r.channels.core.beginPairing("telegram", r.fake.botId);
    r.fake.message(`/start ${code}`);
    await until(() => Boolean(r.channels.core.pairing("telegram", r.fake.botId).request));
    const fresh = await r.channels.core.approvePairing("telegram", r.fake.botId, r.channels.core.pairing("telegram", r.fake.botId).request!.id);
    expect(fresh.id).not.toBe(old.id);
    await until(() => r.fake.texts().filter((text) => text.includes("'노션 키' API 키가 필요합니다")).length === 2);
    expect(r.credentials.store.handoffs()[0]!.bindingId).toBe(fresh.id);
    await r.credentials.tick();
    r.fake.message(PASSWORD);
    await until(() => continued(r).length === 1);
    expect(r.fake.texts().filter((text) => text.includes("'노션 키' API 키가 필요합니다"))).toHaveLength(2);
  });
});

describe("fix round 4 (re-review 3: N8, minor)", () => {
  /** The AI asks while the next sendMessage meets `fault`; its turn ends. */
  async function askWith(r: Rig & { sessionId: string }, fault: "cut-after" | "cut-before") {
    await until(() => r.fake.texts().some((text) => text.startsWith("작업 중")));
    r.fake.nextSend = [fault];
    expect(await r.credentials.run(r.sessionId, KEY_NEED)).toMatchObject({ stdout: "fail:handover_sent\n" });
    r.engine.finish(r.sessionId);
    await until(() => r.credentials.store.handoffs()[0]?.askedAt != null);
  }

  it("N8 (probe K2): answer lost, then [나중에], then a reply carrying the value: taken as the value, deleted, never in the inbox, never to the AI", async () => {
    const r = await paired();
    await askWith(r, "cut-after");
    const asked = r.fake.of("sendMessage").find((call) => String(call.params.text).includes("'노션 키' API 키가 필요합니다"))!;
    r.fake.press(r.fake.buttonData("나중에"), { messageId: r.fake.sentIdOf(asked) });
    await until(() => r.fake.texts().some((text) => text.includes("나중에 넣으려면")));
    expect(r.fake.texts().find((text) => text.includes("나중에 넣으려면"))).toContain("답장");
    const update = r.fake.message(PASSWORD, { extra: { reply_to_message: { message_id: r.fake.sentIdOf(asked) } } });
    await until(() => deleted(r, update) === 1 && continued(r).length === 1);
    expect(toAi(r, PASSWORD)).toBe(false);
    await r.close();
    expect(everywhere(r, PASSWORD)).toEqual([]);
  });

  it("N8: when the hand-over message's id is still unknown, the [나중에] line does not offer a reply", async () => {
    const r = await paired();
    await askWith(r, "cut-after");
    r.fake.press(r.fake.buttonData("나중에"), { messageId: 0 });
    await until(() => r.fake.texts().some((text) => text.includes("나중에 넣으려면")));
    expect(r.fake.texts().find((text) => text.includes("나중에 넣으려면"))).not.toContain("답장");
  });

  it("a line taken while the request may not have arrived: the confirmation restates the request, and [값이 아니었어요] discards it and passes nothing on", async () => {
    const r = await paired();
    await askWith(r, "cut-before");
    expect(r.fake.texts().some((text) => text.includes("필요합니다"))).toBe(false);
    const line = r.fake.message("오늘 회의록 정리해 줘");
    await until(() => deleted(r, line) === 1 && r.fake.texts().some((text) => text.includes("'노션 키'의 키로 받았습니다 · 요청:")));
    const confirmation = r.fake.of("sendMessage").findLast((call) => String(call.params.text).includes("'노션 키'의 키로 받았습니다 · 요청:"))!;
    expect(String(confirmation.params.text)).toContain("'노션 키' API 키가 필요합니다");
    const labels = ((confirmation.params.reply_markup as { inline_keyboard: { text: string }[][] }).inline_keyboard).flat().map((button) => button.text);
    expect(labels).toEqual(["다시 넣기", "값이 아니었어요"]);
    const sentBefore = r.engine.sent.length + r.engine.steered.length;
    pressOn(r, "값이 아니었어요");
    await until(() => r.fake.texts().some((text) => text.startsWith("그 줄은 값으로 쓰지 않고 버렸습니다")));
    const said = r.fake.texts().find((text) => text.startsWith("그 줄은 값으로 쓰지 않고 버렸습니다"))!;
    expect(said).toContain("되살릴 수 없");
    expect(r.credentials.store.summaries().some((entry) => entry.name === "노션 키")).toBe(false);
    expect(toAi(r, "오늘 회의록 정리해 줘")).toBe(false);
    // Nothing of the line was passed on (the continuation that had already gone carries no value).
    expect([...r.engine.sent, ...r.engine.steered].slice(sentBefore).some((entry) => entry.text.includes("회의록"))).toBe(false);
  });
});

describe("[값이 아니었어요] after a hand-over finished gives up one field of the entry that hand-over made (N10)", () => {
  const finished = async () => {
    const r = await paired();
    await askAndOpen(r);
    const first = r.fake.message(ID);
    await until(() => deleted(r, first) === 1 && r.fake.texts().some((text) => text.includes("비밀번호로 받습니다")));
    const second = r.fake.message(PASSWORD);
    await until(() => deleted(r, second) === 1 && continued(r).length === 1);
    const handoff = r.credentials.store.handoffs().find((entry) => entry.name === "학술정보원")!;
    return { r, handoff };
  };

  it("only the field that was not a value goes; the fields that were right stay in the same entry", async () => {
    const { r, handoff } = await finished();
    const entry = r.credentials.store.find("학술정보원")!;
    expect(r.credentials.discardField(handoff.id, "비밀번호")).toBe("cleared");
    const kept = r.credentials.store.find("학술정보원")!;
    expect(kept.id).toBe(entry.id);
    expect(await r.credentials.store.reveal(kept.id, r.sessionId)).toEqual({ 아이디: ID });
  });

  it("an older button never touches an entry the person made afterwards under the same name", async () => {
    const { r, handoff } = await finished();
    r.credentials.removeEntry(r.credentials.store.find("학술정보원")!.id);
    const added = await r.credentials.add({ name: "학술정보원", kind: "login", site: "lib.example.ac.kr", values: { 아이디: ID, 비밀번호: PASSWORD } });
    expect(r.credentials.discardField(handoff.id, "비밀번호")).toBe("over");
    expect(await r.credentials.store.reveal(added.id, r.sessionId)).toEqual({ 아이디: ID, 비밀번호: PASSWORD });
  });
});

describe("the merge with units 5-6: the menu's schedule and files meet an open input", () => {
  it("a schedule's text sent while a hand-over's input is open: the input wins (taken as the value, deleted), and no schedule carries it", async () => {
    const r = await paired();
    r.fake.message("메뉴");
    await until(() => r.fake.texts().some((text) => text.startsWith("메뉴 · 지금:")));
    pressOn(r, "예약");
    await until(() => { try { return Boolean(r.fake.button("내일 08:00")); } catch { return false; } });
    await askAndOpen(r, KEY_NEED);
    pressOn(r, "내일 08:00");
    await until(() => r.fake.texts().some((text) => text.startsWith("무엇을 할까요?")) || [...r.fake.of("editMessageText")].some((call) => String(call.params.text).startsWith("무엇을 할까요?")));
    const line = r.fake.message(PASSWORD);
    await until(() => deleted(r, line) === 1 && continued(r).length === 1);
    expect(r.manager.schedules.all().some((schedule) => schedule.text.includes(PASSWORD))).toBe(false);
    expect(toAi(r, PASSWORD)).toBe(false);
    await r.close();
    expect(everywhere(r, PASSWORD)).toEqual([]);
  });

  it("a file sent into an open input is refused and deleted, never fetched or passed on; the input stays for the value", async () => {
    const r = await paired();
    await askAndOpen(r, KEY_NEED);
    const file = r.fake.message("", { extra: { caption: "이 파일 봐 줘", document: { file_id: "doc1", file_name: "키.txt", mime_type: "text/plain", file_size: 20 } } });
    await until(() => deleted(r, file) === 1 && r.fake.texts().some((text) => text.startsWith("글로만 받습니다")));
    expect(r.fake.of("getFile")).toHaveLength(0);
    expect(toAi(r, "이 파일 봐 줘")).toBe(false);
    r.fake.message(PASSWORD);
    await until(() => continued(r).length === 1);
  });
});

describe("fix round 4 minors", () => {
  it("NEW-M-e: an app word sent as the reply to a hand-over (meant as its value) is answered plainly and deleted; after an app word in an open input the chat hears the PC's way", async () => {
    const r = await paired();
    await askAndOpen(r, KEY_NEED);
    const asked = r.fake.of("sendMessage").find((call) => String(call.params.text).includes("필요합니다"))!;
    const reply = r.fake.message("도움말", { extra: { reply_to_message: { message_id: r.fake.sentIdOf(asked) } } });
    await until(() => r.fake.texts().includes("이 값은 앱의 명령어와 같아 채팅으로 받을 수 없습니다. PC의 비밀 보관함에서 넣어 주세요.")).catch((error: unknown) => { throw new Error(`${String(error)} ${JSON.stringify(r.fake.texts().slice(-3))}`); });
    expect(deleted(r, reply)).toBe(1);
    expect(toAi(r, "도움말")).toBe(false);
    r.fake.message("사용량");
    await until(() => r.fake.texts().some((text) => text.startsWith("'노션 키'의 키를 기다리고 있습니다.") && text.includes("PC의 비밀 보관함에서 넣어 주세요")));
  });
});
