import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../store.ts";
import { FAKE_TOKEN, FakeTelegram } from "./fake-telegram.ts";
import { ChannelLog } from "./log.ts";
import { Redactor } from "./redact.ts";
import { TelegramAdapter, identifyTelegram, splitText } from "./telegram.ts";
import { until } from "./test-kit.ts";
import { ChannelSendError, type ChatRef, type Inbound } from "./types.ts";

// The Telegram adapter against a stand-in Bot API on loopback. No test here reaches Telegram.

type Rig = Awaited<ReturnType<typeof rig>>;
const rigs: { stop: () => Promise<void> }[] = [];
afterEach(async () => { for (const entry of rigs.splice(0)) await entry.stop(); });

/** A log that writes what it is given as it is: what the adapter itself puts in an error is what shows. */
const passthrough = { apply: (text: string) => text, error: (error: unknown) => { const parts: string[] = []; for (let at: unknown = error; at; at = at instanceof Error ? at.cause : null) parts.push(at instanceof Error ? at.message : String(at)); return parts.join(" ← "); } } as unknown as Redactor;

/** A loopback port nothing listens on: bound once, then closed. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

async function rig(options: { gapMs?: number; backoff?: boolean; unredacted?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wb-telegram-"));
  const fake = new FakeTelegram();
  await fake.start();
  const store = new Store(join(dir, "state.sqlite"));
  const lines: string[] = [];
  const redactor = new Redactor();
  redactor.add("telegram", FAKE_TOKEN);
  const log = new ChannelLog(options.unredacted ? passthrough : redactor, (line) => lines.push(line));
  const sleeps: number[] = [];
  const make = () => new TelegramAdapter({
    botId: fake.botId, token: () => FAKE_TOKEN, baseUrl: fake.url, journal: store.channels, log, pollSeconds: 1, minSendGapMs: options.gapMs ?? 0,
    random: () => 0.5,
    // Waits between retries are recorded, not sat through.
    sleep: async (ms) => { sleeps.push(ms); await new Promise((done) => setTimeout(done, options.backoff ? 5 : Math.min(ms, 20))); },
  });
  let adapter = make();
  let abort = new AbortController();
  const events: Inbound[] = [];
  const listen = () => { void adapter.start(async (event) => { events.push(event); }, abort.signal); };
  const stop = async () => {
    abort.abort();
    await fake.stop();
    try { store.close(); } catch { /* Already closed. */ }
    rmSync(dir, { recursive: true, force: true });
  };
  const entry = {
    dir, fake, store, lines, sleeps, events, listen, stop,
    get adapter() { return adapter; },
    /** The adapter stops and a new one starts on the same data, as after a gateway restart. */
    restart() { abort.abort(); abort = new AbortController(); adapter = make(); listen(); },
    halt() { abort.abort(); },
  };
  rigs.push(entry);
  return entry;
}
const dm = (r: Rig, chatId = "555"): ChatRef => ({ kind: "telegram", botId: r.fake.botId, chatId, chatType: "dm" });
const secretFree = (r: Rig) => expect(r.lines.join("\n")).not.toContain(FAKE_TOKEN);

describe("checking a token", () => {
  it("asks the Bot API who the bot is", async () => {
    const r = await rig();
    expect(await identifyTelegram(FAKE_TOKEN, r.fake.url)).toEqual({ id: r.fake.botId, username: "wb_7k3q9x_bot", name: "홍길동의 Workbench" });
  });

  it("refuses a value that is not token-shaped without calling anything, and a token the API does not know", async () => {
    const r = await rig();
    await expect(identifyTelegram("not a token", r.fake.url)).rejects.toMatchObject({ status: 400, code: "channel_token_invalid" });
    expect(r.fake.calls).toEqual([]);
    const wrong = "7000000009:AAF" + "q".repeat(8) + "-Fake_token-for-loopback-09";
    const failure = await identifyTelegram(wrong, r.fake.url).catch((error: unknown) => error as Error & { status: number; code: string });
    expect(failure).toMatchObject({ status: 400, code: "channel_token_invalid" });
    // The refusal does not repeat the value.
    expect(String((failure as Error).message)).not.toContain(wrong);
  });

  it("says the Bot API could not be reached, without the address that carries the token", async () => {
    const r = await rig();
    await r.fake.stop();
    const failure = await identifyTelegram(FAKE_TOKEN, r.fake.url).catch((error: unknown) => error as Error & { status: number; code: string });
    expect(failure).toMatchObject({ status: 502, code: "channel_unreachable" });
    expect(String((failure as Error).message)).not.toContain(FAKE_TOKEN);
  });
});

describe("receiving by long polling", () => {
  it("turns updates into the core's events: a direct message, a caption with a file, a button press, a group", async () => {
    const r = await rig();
    r.listen();
    r.fake.message("명단 정리해 줘");
    r.fake.message("", { extra: { caption: "이거 표로 정리해 줘", photo: [{ file_id: "small", file_size: 100 }, { file_id: "large", file_size: 9000 }] } });
    r.fake.message("", { extra: { document: { file_id: "doc1", file_name: "성적표.pdf", mime_type: "application/pdf", file_size: 12345 } } });
    r.fake.press("tok-0123456789abcdefghij");
    r.fake.message("안녕", { chatId: -100200, chatType: "supergroup" });
    r.fake.addedToGroup(-100300);
    await until(() => r.events.length === 6);
    const [text, photo, document, button, group, added] = r.events;
    expect(text).toMatchObject({ type: "message", chat: { kind: "telegram", botId: r.fake.botId, chatId: "555", chatType: "dm" }, from: { userId: "555", displayName: "길동 홍", handle: "hong" }, text: "명단 정리해 줘", files: [] });
    expect(text!.eventId).toMatch(/^\d+$/);
    expect(photo).toMatchObject({ text: "이거 표로 정리해 줘", files: [{ fileRef: "large", mime: "image/jpeg", size: 9000, kind: "photo" }] });
    expect(document).toMatchObject({ text: "", files: [{ fileRef: "doc1", name: "성적표.pdf", mime: "application/pdf", size: 12345, kind: "file" }] });
    expect(button).toMatchObject({ type: "button", token: "tok-0123456789abcdefghij", chat: { chatId: "555", chatType: "dm" }, from: { userId: "555" } });
    expect((button as Extract<Inbound, { type: "button" }>).ackHandle).toMatch(/^cb-/);
    expect(group).toMatchObject({ type: "message", chat: { chatId: "-100200", chatType: "group" } });
    expect(added).toMatchObject({ type: "message", chat: { chatId: "-100300", chatType: "group" }, text: "" });
    expect(r.adapter.status()).toEqual({ state: "connected", detail: null });
  });

  it("writes a batch to the inbox together with the next offset, and confirms it only with the following request", async () => {
    const r = await rig();
    r.listen();
    const first = r.fake.message("하나");
    await until(() => r.events.length === 1);
    const next = String(Number(first.update_id) + 1);
    expect(r.store.channels.offset("telegram", r.fake.botId)).toBe(next);
    expect(r.store.channels.seen("telegram", r.fake.botId, String(first.update_id))).toBe("received");
    // The following getUpdates carries that offset, which is what confirms the update at Telegram.
    await until(() => r.fake.of("getUpdates").some((call) => call.params.offset === Number(next)));
    await until(() => r.fake.pending() === 0);
    expect(r.fake.of("getUpdates")[0]!.params).toMatchObject({ timeout: 1, allowed_updates: ["message", "edited_message", "callback_query", "my_chat_member"] });
    expect(r.fake.of("getUpdates")[0]!.params.offset).toBeUndefined();
  });

  it("continues from the stored offset after a restart, so an update it already wrote down is not taken again", async () => {
    const r = await rig();
    r.listen();
    const first = r.fake.message("하나");
    await until(() => r.events.length === 1);
    r.halt();
    const before = r.fake.of("getUpdates").length;
    // Telegram delivers it again (the gateway stopped before its offset was confirmed) with a new one.
    r.fake.redeliver(first);
    const second = r.fake.message("둘");
    r.restart();
    await until(() => r.events.length >= 2);
    expect(r.fake.of("getUpdates")[before]!.params.offset).toBe(Number(first.update_id) + 1);
    // The confirmed one is not handed over again; only the new one is.
    expect(r.events.map((event) => event.eventId)).toEqual([String(first.update_id), String(second.update_id)]);
  });

  it("marks the first of the messages that waited at Telegram while the PC was off, per chat", async () => {
    const r = await rig();
    const old = Math.floor(Date.now() / 1000) - 3 * 60 * 60;
    r.fake.message("밀린 하나", { date: old });
    r.fake.message("밀린 둘", { date: old + 5 });
    r.fake.message("방금", {});
    r.listen();
    await until(() => r.events.length === 3);
    expect(r.events.map((event) => (event.type === "message" ? event.backlog ?? 0 : -1))).toEqual([2, 0, 0]);
  });

  it("retries a failing connection with a growing, jittered wait, says which try it is, and comes back", async () => {
    const r = await rig({ backoff: true });
    r.fake.failPolls = 4;
    r.listen();
    await until(() => r.sleeps.length >= 2);
    expect(r.adapter.status().state).toBe("retrying");
    expect(r.adapter.status().detail).toMatch(/^다시 연결 중 \(\d+번째\)$/);
    r.fake.message("돌아왔나");
    await until(() => r.events.length === 1);
    expect(r.adapter.status()).toEqual({ state: "connected", detail: null });
    // 1, 2, 4, 8 seconds (jitter at its middle here), and never more than a minute.
    expect(r.sleeps.slice(0, 4)).toEqual([1000, 2000, 4000, 8000]);
    secretFree(r);
  });

  it("caps the wait at a minute", async () => {
    const r = await rig({ backoff: true });
    r.fake.failPolls = 9;
    r.listen();
    await until(() => r.sleeps.length >= 9);
    expect(Math.max(...r.sleeps)).toBe(60_000);
    r.halt();
  });

  it("stops as a conflict when another program polls with the same token, and says what to do", async () => {
    const r = await rig();
    r.fake.conflict = true;
    r.listen();
    await until(() => r.adapter.status().state === "conflict");
    expect(r.adapter.status().detail).toBe("다른 PC나 프로그램이 이 봇을 쓰고 있습니다. 같은 봇을 두 곳에서 쓸 수 없습니다. 봇 토큰이 새었을 수도 있으니 [토큰 바꾸기]를 눌러 새 토큰을 넣어 주세요.");
    const polls = r.fake.of("getUpdates").length;
    await new Promise((done) => setTimeout(done, 80));
    // It does not keep fighting over the bot.
    expect(r.fake.of("getUpdates").length).toBe(polls);
    expect(polls).toBe(2);
  });

  it("does not call one overlapping poll of its own a conflict", async () => {
    const r = await rig();
    r.fake.conflictOnce = 1;
    r.listen();
    r.fake.message("하나");
    await until(() => r.events.length === 1);
    expect(r.adapter.status().state).toBe("connected");
  });

  it("stops and asks for a new token when Telegram no longer knows the token", async () => {
    const r = await rig();
    r.fake.unauthorized = true;
    r.listen();
    await until(() => r.adapter.status().state === "stopped");
    expect(r.adapter.status().detail).toContain("토큰");
    secretFree(r);
  });
});

describe("sending", () => {
  it("sends text with buttons that carry only their token, quietly when asked", async () => {
    const r = await rig();
    const { messageId } = await r.adapter.send(dm(r), { text: "「예산표 정리」 · 명령 실행 허용?", buttons: [[{ label: "허용", token: "aaaaaaaaaaaaaaaaaaaaaa" }, { label: "거절", token: "bbbbbbbbbbbbbbbbbbbbbb" }]], silent: true });
    expect(messageId).toMatch(/^\d+$/);
    const [call] = r.fake.of("sendMessage");
    expect(call!.params).toMatchObject({
      chat_id: 555, text: "「예산표 정리」 · 명령 실행 허용?", disable_notification: true,
      reply_markup: { inline_keyboard: [[{ text: "허용", callback_data: "aaaaaaaaaaaaaaaaaaaaaa" }, { text: "거절", callback_data: "bbbbbbbbbbbbbbbbbbbbbb" }]] },
    });
    // Plain text: nothing in an answer is read as markup.
    expect(call!.params.parse_mode).toBeUndefined();
  });

  it("splits a text longer than 4096 UTF-16 units, never inside a character, and puts the buttons on the last part", async () => {
    const r = await rig();
    const long = `${"가나다 라마바😀 ".repeat(900)}끝`;
    expect(long.length).toBeGreaterThan(8192);
    await r.adapter.send(dm(r), { text: long, buttons: [[{ label: "전체 답", token: "cccccccccccccccccccccc" }]] });
    const calls = r.fake.of("sendMessage");
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const call of calls) expect(String(call.params.text).length).toBeLessThanOrEqual(4096);
    // Nothing lost, nothing cut inside a surrogate pair.
    expect(calls.map((call) => String(call.params.text)).join(" ").replace(/\s+/g, " ")).toBe(long.replace(/\s+/g, " "));
    for (const call of calls) expect(String(call.params.text)).not.toMatch(/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/);
    expect(calls.map((call) => Boolean(call.params.reply_markup))).toEqual([...calls.slice(1).map(() => false), true]);
  });

  it("splits at paragraph and line ends when it can", () => {
    const paragraph = "문단입니다. ".repeat(300).trim();
    const parts = splitText(`${paragraph}\n\n${paragraph}\n\n${paragraph}`, 4096);
    expect(parts).toEqual([paragraph, paragraph, paragraph]);
    expect(splitText("짧은 글", 4096)).toEqual(["짧은 글"]);
    expect(splitText("😀".repeat(3000), 4096).every((part) => part.length <= 4096 && part.length % 2 === 0)).toBe(true);
  });

  it("never cuts inside a character at a hard cut, also at an odd offset, in a joined emoji or a flag", () => {
    const graphemes = (text: string) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((part) => part.segment);
    for (const text of [`a${"😀".repeat(3000)}`, `a${"👨\u200d👩\u200d👧\u200d👦".repeat(800)}`, `a${"🇰🇷".repeat(2100)}`, `a${"한글".normalize("NFD").repeat(1500)}`]) {
      const parts = splitText(text, 4096);
      expect(parts.length).toBeGreaterThan(1);
      expect(parts.join("")).toBe(text);
      for (const part of parts) expect(part.length).toBeLessThanOrEqual(4096);
      expect(parts.flatMap(graphemes)).toEqual(graphemes(text));
    }
  });

  it("keeps sends to one chat apart, and does not hold up another chat", async () => {
    const r = await rig({ gapMs: 120 });
    await Promise.all([r.adapter.send(dm(r), { text: "하나" }), r.adapter.send(dm(r), { text: "둘" }), r.adapter.send(dm(r, "777"), { text: "다른 채팅" })]);
    const mine = r.fake.of("sendMessage").filter((call) => call.params.chat_id === 555);
    const other = r.fake.of("sendMessage").find((call) => call.params.chat_id === 777)!;
    expect(mine.map((call) => call.params.text)).toEqual(["하나", "둘"]);
    expect(mine[1]!.at - mine[0]!.at).toBeGreaterThanOrEqual(110);
    expect(other.at - mine[0]!.at).toBeLessThan(110);
  });

  it("asks once more right before a message leaves its chat's send line, and drops one no longer wanted", async () => {
    const r = await rig({ gapMs: 120 });
    let wanted = true;
    const first = r.adapter.send(dm(r), { text: "하나" });
    const second = r.adapter.send(dm(r), { text: "둘" }, { stillWanted: () => wanted });
    await first;
    // The second waits its turn in the line; the chat is closed meanwhile.
    wanted = false;
    await expect(second).rejects.toMatchObject({ delivered: "no", code: "withdrawn", permanent: false });
    expect(r.fake.texts()).toEqual(["하나"]);
    // Between the parts of a long one too: what already went may have been read, the rest does not go.
    let parts = 0;
    const long = await r.adapter.send(dm(r), { text: `${"가".repeat(4000)}\n\n${"나".repeat(4000)}` }, { stillWanted: () => parts++ === 0 }).catch((error: unknown) => error);
    expect(long).toMatchObject({ delivered: "unknown", code: "withdrawn" });
    expect(r.fake.texts()).toHaveLength(2);
  });

  it("waits as long as Telegram says when it is told to slow down, then sends once", async () => {
    const r = await rig();
    r.fake.retryAfter = 7;
    r.fake.nextSend.push("limit");
    await r.adapter.send(dm(r), { text: "천천히" });
    expect(r.fake.texts()).toEqual(["천천히"]);
    expect(r.sleeps).toEqual([7000]);
  });

  it("does not sit through a long wait Telegram asks for: it gives the message back as not gone, with the wait", async () => {
    const r = await rig();
    r.fake.retryAfter = 45;
    r.fake.nextSend.push("limit");
    const failure = await r.adapter.send(dm(r), { text: "나중에" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ChannelSendError);
    expect(failure).toMatchObject({ delivered: "no", permanent: false, retryAfterMs: 45_000 });
    expect(r.sleeps).toEqual([]);
    expect(r.fake.texts()).toEqual([]);
  });

  it("calls 400, 403 and 404 refusals permanent, and a rate limit or a server error not", async () => {
    const r = await rig();
    for (const fault of ["refuse", "forbid", "gone"] as const) {
      r.fake.nextSend.push(fault);
      await expect(r.adapter.send(dm(r), { text: "안 가는 글" }), fault).rejects.toMatchObject({ delivered: "no", permanent: true });
    }
    r.fake.nextSend.push("limit", "limit", "limit", "limit");
    await expect(r.adapter.send(dm(r), { text: "천천히" })).rejects.toMatchObject({ delivered: "no", permanent: false });
    r.fake.nextSend.push("busy");
    await expect(r.adapter.send(dm(r), { text: "바쁨" })).rejects.toMatchObject({ permanent: false });
  });

  // The two kinds of lost connection, each made so that it cannot be taken for the other. (Stopping
  // the stand-in after earlier sends raced: a kept-alive socket it had just closed reads as a cut
  // after the request went, a new connection as refused.)
  it("a connection that was never made (nothing listens): certainly not gone, and worth trying again", async () => {
    const r = await rig();
    const adapter = new TelegramAdapter({ botId: r.fake.botId, token: () => FAKE_TOKEN, baseUrl: `http://127.0.0.1:${await closedPort()}`, journal: r.store.channels, log: new ChannelLog(passthrough, () => undefined), minSendGapMs: 0 });
    await expect(adapter.send(dm(r), { text: "닿지 않는 글" })).rejects.toMatchObject({ delivered: "no", permanent: false, code: "not_connected" });
  });

  it("a connection cut after the request went (read in full, no answer): may have gone, so it is not sent again", async () => {
    const r = await rig();
    r.fake.nextSend.push("cut-after");
    const before = r.fake.of("sendMessage").length;
    const error = await r.adapter.send(dm(r), { text: "갔을 수도 있는 글" }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ChannelSendError);
    expect(error).toMatchObject({ delivered: "unknown", permanent: false, code: "no_answer" });
    // The stand-in took it once; the adapter did not try a second time.
    expect(r.fake.of("sendMessage").length - before).toBe(1);
  });

  it("puts no address and no token into its own errors and log lines, whatever the redactor would hide", async () => {
    const r = await rig({ unredacted: true, backoff: true });
    r.fake.failPolls = 1;
    r.listen();
    await until(() => r.sleeps.length >= 1);
    const failures: unknown[] = [];
    for (const fault of ["refuse", "forbid", "cut-after", "busy"] as const) {
      r.fake.nextSend.push(fault);
      failures.push(await r.adapter.send(dm(r), { text: "글" }).catch((error: unknown) => error));
    }
    failures.push(await r.adapter.edit(dm(r), "1", { text: "x" }).then(() => null, (error: unknown) => error));
    r.halt();
    await r.fake.stop();
    failures.push(await r.adapter.send(dm(r), { text: "글" }).catch((error: unknown) => error));
    const written = [...failures.map((error) => (error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error))), ...r.lines].join("\n");
    expect(written).not.toContain(FAKE_TOKEN);
    expect(written).not.toContain(r.fake.botId + ":");
    expect(written).not.toMatch(/\/bot\d/);
  });

  it("says a refused message certainly did not go, and one whose connection was cut after the work may have gone", async () => {
    const r = await rig();
    r.fake.nextSend.push("refuse");
    await expect(r.adapter.send(dm(r), { text: "거절될 글" })).rejects.toMatchObject({ delivered: "no" });
    r.fake.nextSend.push("forbid");
    await expect(r.adapter.send(dm(r), { text: "막힌 글" })).rejects.toMatchObject({ delivered: "no" });
    r.fake.nextSend.push("cut-after");
    const unsure = await r.adapter.send(dm(r), { text: "갔을 수도 있는 글" }).catch((error: unknown) => error);
    expect(unsure).toBeInstanceOf(ChannelSendError);
    expect(unsure).toMatchObject({ delivered: "unknown" });
    // No error carries the message or the token.
    for (const line of r.lines) expect(line).not.toMatch(/거절될 글|막힌 글|갔을 수도/);
    secretFree(r);
  });

  it("says a message certainly did not go when the Bot API cannot be reached at all", async () => {
    const r = await rig();
    const adapter = new TelegramAdapter({ botId: r.fake.botId, token: () => FAKE_TOKEN, baseUrl: `http://127.0.0.1:${await closedPort()}`, journal: r.store.channels, log: new ChannelLog(passthrough, () => undefined), minSendGapMs: 0 });
    await expect(adapter.send(dm(r), { text: "닿지 않는 글" })).rejects.toMatchObject({ delivered: "no" });
  });

  it("edits a message, takes 'not modified' as done, and cuts an over-long status to the limit", async () => {
    const r = await rig();
    await r.adapter.edit(dm(r), "42", { text: "끝남 · 0:48" });
    expect(r.fake.of("editMessageText")[0]!.params).toMatchObject({ chat_id: 555, message_id: 42, text: "끝남 · 0:48", reply_markup: { inline_keyboard: [] } });
    r.fake.nextSend.push("unchanged");
    await expect(r.adapter.edit(dm(r), "42", { text: "끝남 · 0:48" })).resolves.toBeUndefined();
    await r.adapter.edit(dm(r), "42", { text: "가".repeat(5000) });
    expect(String(r.fake.of("editMessageText").at(-1)!.params.text).length).toBe(4096);
    // The cut steps back off a character it would split.
    await r.adapter.edit(dm(r), "42", { text: `${"가".repeat(4094)}${"😀".repeat(5)}` });
    expect(String(r.fake.of("editMessageText").at(-1)!.params.text)).toBe(`${"가".repeat(4094)}…`);
  });

  it("answers a button press, shows typing, deletes a message and leaves a group", async () => {
    const r = await rig();
    await r.adapter.ackButton("cb-1", "허용함");
    await r.adapter.typing(dm(r));
    expect(await r.adapter.remove(dm(r), "7")).toBe(true);
    await r.adapter.leave({ kind: "telegram", botId: r.fake.botId, chatId: "-100200", chatType: "group" });
    expect(r.fake.of("answerCallbackQuery")[0]!.params).toEqual({ callback_query_id: "cb-1", text: "허용함" });
    expect(r.fake.of("sendChatAction")[0]!.params).toEqual({ chat_id: 555, action: "typing" });
    expect(r.fake.of("deleteMessage")[0]!.params).toEqual({ chat_id: 555, message_id: 7 });
    expect(r.fake.of("leaveChat")[0]!.params).toEqual({ chat_id: -100200 });
  });

  it("uploads a document and a picture with a caption of at most 1024 characters", async () => {
    const r = await rig();
    const file = join(r.dir, "명단-3학년.xlsx"), picture = join(r.dir, "미리보기.png");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, Buffer.alloc(2048, 7));
    writeFileSync(picture, Buffer.alloc(512, 9));
    const { messageId } = await r.adapter.send(dm(r), { text: "", files: [{ path: file, name: "명단-3학년.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", caption: "가".repeat(2000) }, { path: picture, name: "미리보기.png", mime: "image/png" }] });
    expect(messageId).toMatch(/^\d+$/);
    const [document] = r.fake.of("sendDocument"), [photo] = r.fake.of("sendPhoto");
    expect(document!.file).toMatchObject({ field: "document", name: "명단-3학년.xlsx", bytes: 2048 });
    expect(String(document!.params.caption).length).toBe(1024);
    expect(document!.params.chat_id).toBe(555);
    expect(photo!.file).toMatchObject({ field: "photo", name: "미리보기.png", bytes: 512 });
    expect(r.fake.of("sendMessage")).toEqual([]);
  });

  it("sends a drawing Telegram does not show as a photo (an SVG page) as a file", async () => {
    const r = await rig();
    const svg = join(r.dir, "강의계획서 1쪽.svg");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(svg, "<svg xmlns='http://www.w3.org/2000/svg'/>");
    await r.adapter.send(dm(r), { text: "", files: [{ path: svg, name: "강의계획서 1쪽.svg", mime: "image/svg+xml", caption: "1쪽 미리보기" }] });
    expect(r.fake.of("sendPhoto")).toEqual([]);
    expect(r.fake.of("sendDocument")[0]!.file).toMatchObject({ field: "document", name: "강의계획서 1쪽.svg" });
  });
});

describe("a picture whose shape Telegram does not take as a photo (fix round 3)", () => {
  // A PNG header only: the signature and an IHDR chunk with the width and height.
  const png = (width: number, height: number) => {
    const head = Buffer.alloc(33);
    Buffer.from("89504e470d0a1a0a", "hex").copy(head, 0);
    head.writeUInt32BE(13, 8); head.write("IHDR", 12, "latin1"); head.writeUInt32BE(width, 16); head.writeUInt32BE(height, 20);
    return head;
  };

  it("goes as a file when width + height is over 10,000 or one side is over 20 times the other", async () => {
    const r = await rig();
    const { writeFileSync } = await import("node:fs");
    // A JPEG: SOI, an APP0 segment, then SOF0 with height and width.
    const jpeg = (width: number, height: number) => Buffer.concat([Buffer.from("ffd8ffe000044a46", "hex"), Buffer.from([0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255]), Buffer.alloc(16)]);
    const shapes: Record<string, Buffer> = { "긴 쪽.png": png(400, 9000), "큰 쪽.png": png(6000, 5000), "긴 사진.jpg": jpeg(300, 6500), "보통 쪽.png": png(1200, 1697), "보통 사진.jpg": jpeg(1280, 960) };
    for (const [name, bytes] of Object.entries(shapes)) writeFileSync(join(r.dir, name), bytes);
    await r.adapter.send(dm(r), { text: "", files: Object.keys(shapes).map((name) => ({ path: join(r.dir, name), name, mime: name.endsWith(".jpg") ? "image/jpeg" : "image/png" })) });
    expect(r.fake.of("sendDocument").map((call) => call.file!.name)).toEqual(["긴 쪽.png", "큰 쪽.png", "긴 사진.jpg"]);
    expect(r.fake.of("sendPhoto").map((call) => call.file!.name)).toEqual(["보통 쪽.png", "보통 사진.jpg"]);
  });
});

describe("an answer whose files fail part-way (C2)", () => {
  const files = async (r: Rig) => {
    const { writeFileSync } = await import("node:fs");
    const a = join(r.dir, "가.txt"), b = join(r.dir, "나.txt"), c = join(r.dir, "다.txt");
    writeFileSync(a, "가"); writeFileSync(b, "나"); writeFileSync(c, "다");
    return [{ path: a, name: "가.txt", mime: "text/plain" }, { path: b, name: "나.txt", mime: "text/plain" }, { path: c, name: "다.txt", mime: "text/plain" }];
  };

  it.each([["refuse", "no"], ["busy", "unknown"], ["limit", "no"]] as const)("does not fail the whole send when an upload after the text answers %s: the rest goes, and what did not is named", async (fault, delivered) => {
    const r = await rig();
    r.fake.retryAfter = 60;
    r.fake.nextUpload = [null, fault];
    const sent = await r.adapter.send(dm(r), { text: "끝냈습니다.", files: await files(r) });
    expect(sent.messageId).toMatch(/^\d+$/);
    expect(sent.unsent).toEqual([{ name: "나.txt", delivered }]);
    expect(r.fake.texts()).toEqual(["끝냈습니다."]);
    expect([...r.fake.of("sendDocument")].map((call) => call.file?.name)).toEqual(["가.txt", "다.txt"]);
  });

  it("names the files left when the chat closed between them as not sent (they certainly did not go)", async () => {
    const r = await rig();
    let asked = 0;
    const sent = await r.adapter.send(dm(r), { text: "끝냈습니다.", files: await files(r) }, { stillWanted: () => (asked += 1) <= 2 });
    expect(sent.unsent).toEqual([{ name: "나.txt", delivered: "no" }, { name: "다.txt", delivered: "no" }]);
  });

  it("still fails as before when nothing has gone yet (the first part is a file)", async () => {
    const r = await rig();
    r.fake.nextUpload = ["refuse"];
    await expect(r.adapter.send(dm(r), { text: "", files: await files(r) })).rejects.toMatchObject({ delivered: "no", permanent: true });
  });
});

describe("fetching a received file", () => {
  it("saves it through getFile, and keeps the address that carries the token to itself", async () => {
    const r = await rig();
    r.fake.file("doc1", "documents/file_12.pdf", Buffer.from("%PDF-1.7 내용"));
    const to = join(r.dir, "받은파일.pdf");
    await r.adapter.download({ fileRef: "doc1", name: "성적표.pdf", mime: "application/pdf", size: 16, kind: "file" }, to);
    expect(readFileSync(to, "utf8")).toBe("%PDF-1.7 내용");
    const missing = await r.adapter.download({ fileRef: "nope", name: "x", mime: "x", size: 1, kind: "file" }, join(r.dir, "x")).catch((error: unknown) => error as Error);
    expect(String((missing as Error).message)).not.toMatch(/file\/bot|7000000001:/);
    secretFree(r);
  });

  it("stops and says the limit when a file turns out larger than a bot may fetch while it is fetched", async () => {
    const r = await rig();
    r.fake.file("grows", "documents/grows.bin", Buffer.alloc(20 * 1024 * 1024 + 1, 1), 1000);
    const to = join(r.dir, "grows.bin");
    await expect(r.adapter.download({ fileRef: "grows", name: "grows.bin", mime: "application/octet-stream", size: 1000, kind: "file" }, to)).rejects.toMatchObject({ code: "too_large" });
    expect(existsSync(to)).toBe(false);
  });

  it("refuses a file larger than a bot may fetch (20 MB) without fetching it", async () => {
    const r = await rig();
    r.fake.file("big", "documents/big.bin", Buffer.alloc(10));
    const to = join(r.dir, "big.bin");
    await expect(r.adapter.download({ fileRef: "big", name: "big.bin", mime: "application/octet-stream", size: 21 * 1024 * 1024, kind: "file" }, to)).rejects.toMatchObject({ code: "too_large" });
    expect(existsSync(to)).toBe(false);
    expect(r.fake.of("getFile")).toEqual([]);
  });
});
