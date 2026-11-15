import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../store.ts";
import { FAKE_TOKEN, FakeTelegram } from "./fake-telegram.ts";
import { readable } from "./format.ts";
import { ChannelLog } from "./log.ts";
import { Redactor } from "./redact.ts";
import { TelegramAdapter } from "./telegram.ts";
import { ChannelSendError, type ChatRef } from "./types.ts";
import { COMMAND_LIST } from "./words.ts";

// Formatted messages, the plain fallback and which message a keyboard sits on, against the
// stand-in Bot API on loopback (strict about entities). No test here reaches Telegram.

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

async function rig() {
  const dir = mkdtempSync(join(tmpdir(), "wb-telegram-format-"));
  const fake = new FakeTelegram();
  await fake.start();
  const store = new Store(join(dir, "state.sqlite"));
  const redactor = new Redactor();
  redactor.add("telegram", FAKE_TOKEN);
  const lines: string[] = [];
  const log = new ChannelLog(redactor, (line) => lines.push(line));
  const adapter = new TelegramAdapter({ botId: fake.botId, token: () => FAKE_TOKEN, baseUrl: fake.url, journal: store.channels, log, pollSeconds: 1, minSendGapMs: 0, sleep: async () => {} });
  cleanups.push(async () => { await fake.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const chat: ChatRef = { kind: "telegram", botId: fake.botId, chatId: "555", chatType: "dm" };
  return { dir, fake, adapter, chat, lines };
}

const sends = (fake: FakeTelegram) => fake.of("sendMessage").map((call) => call.params);

describe("the stand-in Bot API is strict about formatting", () => {
  it("refuses entities out of the text, crossing, or nested as Telegram does not allow", async () => {
    const r = await rig();
    const post = (params: Record<string, unknown>) => fetch(`${r.fake.url}/bot${FAKE_TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: 555, ...params }) }).then((response) => response.status);
    expect(await post({ text: "굵게", entities: [{ type: "bold", offset: 0, length: 3 }] })).toBe(400);
    expect(await post({ text: "abcdef", entities: [{ type: "bold", offset: 0, length: 4 }, { type: "italic", offset: 2, length: 4 }] })).toBe(400);
    expect(await post({ text: "abcdef", entities: [{ type: "code", offset: 0, length: 6 }, { type: "bold", offset: 1, length: 2 }] })).toBe(400);
    expect(await post({ text: "abcdef", entities: [{ type: "blockquote", offset: 0, length: 6 }, { type: "text_link", offset: 1, length: 2, url: "https://a.example" }] })).toBe(400);
    expect(await post({ text: "😀a", entities: [{ type: "bold", offset: 1, length: 2 }] })).toBe(400);
    expect(await post({ text: "x".repeat(4097) })).toBe(400);
    expect(await post({ text: "abcdef", entities: [{ type: "bold", offset: 0, length: 6 }, { type: "italic", offset: 2, length: 2 }] })).toBe(200);
    expect(r.fake.of("sendMessage")).toHaveLength(1);
  });
});

describe("a formatted message", () => {
  it("goes as entities over the text as the phone shows it, without a parse mode", async () => {
    const r = await rig();
    const { text, marks } = readable("**결과**: [문서](https://example.com) 와 `a_b`\n```py\nprint(1)\n```");
    await r.adapter.send(r.chat, { text, marks });
    expect(sends(r.fake)).toHaveLength(1);
    const sent = sends(r.fake)[0]!;
    expect(sent.text).toBe("결과: 문서 와 a_b\nprint(1)");
    expect(sent.parse_mode).toBeUndefined();
    expect(sent.entities).toEqual([
      { type: "bold", offset: 0, length: 2 },
      { type: "text_link", offset: 4, length: 2, url: "https://example.com" },
      { type: "code", offset: 9, length: 3 },
      { type: "pre", offset: 13, length: 8, language: "py" },
    ]);
  });

  it("a long one is cut on its text: every part fits 4096 UTF-16 units and the stand-in takes each", async () => {
    const r = await rig();
    const { text, marks } = readable(`**머리**\n\n\`\`\`\n${"😀 코드 줄 *x*\n".repeat(900)}\`\`\`\n\n**끝**`);
    expect(text.length).toBeGreaterThan(9000);
    await r.adapter.send(r.chat, { text, marks });
    const parts = sends(r.fake);
    expect(parts.length).toBeGreaterThanOrEqual(3);
    for (const part of parts) expect(String(part.text).length).toBeLessThanOrEqual(4096);
    expect(parts.every((part) => Array.isArray(part.entities))).toBe(true);
  });

  it("refused as formatted, it goes once more as plain text, and the send names that message", async () => {
    const r = await rig();
    r.fake.refuseFormatted = 1;
    const { text, marks } = readable("**굵게**입니다");
    const { messageId } = await r.adapter.send(r.chat, { text, marks, buttons: [[{ label: "진행", token: "t-1" }]] });
    expect(sends(r.fake)).toHaveLength(1);
    expect(sends(r.fake)[0]).toMatchObject({ text: "굵게입니다" });
    expect(sends(r.fake)[0]!.entities).toBeUndefined();
    expect(r.fake.button("진행").messageId).toBe(Number(messageId));
    expect(r.lines.join("\n")).toContain("format_refused");
  });

  it("the plain copy keeps what the marks carried: a link's address is written after its words", async () => {
    const r = await rig();
    r.fake.refuseFormatted = 1;
    const { text, marks } = readable("[문서](https://a.example/d) 를 보세요");
    await r.adapter.send(r.chat, { text, marks });
    expect(sends(r.fake)).toHaveLength(1);
    expect(sends(r.fake)[0]).toMatchObject({ text: "문서 (https://a.example/d) 를 보세요" });
    expect(sends(r.fake)[0]!.entities).toBeUndefined();
  });

  it("a Mini App keyboard goes with the formatted text and with its plain copy, and names the send (merge with units 7-8)", async () => {
    const r = await rig();
    const webApp = { label: "값 넣기", url: "https://seal.example/v1" };
    const { text, marks } = readable("**학술정보원**의 값을 넣어 주세요");
    const path = join(r.dir, "안내.md");
    writeFileSync(path, "안내\n");
    const formatted = await r.adapter.send(r.chat, { text, marks, webApp, files: [{ path, name: "안내.md", mime: "text/markdown" }] });
    expect(sends(r.fake)[0]).toMatchObject({ reply_markup: { keyboard: [[{ text: "값 넣기", web_app: { url: webApp.url } }]] } });
    expect(sends(r.fake)[0]!.entities).toBeDefined();
    // Named by the text that carries the keyboard, not by the file after it.
    const textId = r.fake.calls.filter((call) => call.method === "sendMessage").at(-1)!.messageId;
    const fileId = r.fake.calls.filter((call) => call.method === "sendDocument").at(-1)!.messageId;
    expect(textId).toBeDefined();
    expect(fileId).not.toBe(textId);
    expect(Number(formatted.messageId)).toBe(textId);
    r.fake.refuseFormatted = 1;
    await r.adapter.send(r.chat, { text, marks, webApp });
    expect(sends(r.fake).at(-1)!.entities).toBeUndefined();
    expect(sends(r.fake).at(-1)).toMatchObject({ reply_markup: { keyboard: [[{ text: "값 넣기", web_app: { url: webApp.url } }]] } });
  });

  it("refused as formatted and as plain: it fails as not delivered, after exactly two tries", async () => {
    const r = await rig();
    // Both refused with a 400 (the first as formatted); a third refusal stays unused.
    r.fake.nextSend = ["refuse", "refuse", "refuse"];
    const { text, marks } = readable("**굵게**");
    const error = await r.adapter.send(r.chat, { text, marks }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChannelSendError);
    expect((error as ChannelSendError).delivered).toBe("no");
    expect(r.fake.nextSend).toEqual(["refuse"]);
  });

  it("a plain text without marks never carries entities and is not sent twice when refused", async () => {
    const r = await rig();
    r.fake.nextSend = ["refuse"];
    await expect(r.adapter.send(r.chat, { text: "그냥 글" })).rejects.toBeInstanceOf(ChannelSendError);
    expect(r.fake.nextSend).toEqual([]);
  });

  it("an edit uses the same conversion, and falls back to plain once when refused", async () => {
    const r = await rig();
    const { messageId } = await r.adapter.send(r.chat, { text: "작업 중" });
    const { text, marks } = readable("**계획**\n- 첫째");
    await r.adapter.edit(r.chat, messageId, { text, marks });
    const edits = r.fake.of("editMessageText");
    expect(edits.at(-1)!.params).toMatchObject({ text: "계획\n• 첫째", entities: [{ type: "bold", offset: 0, length: 2 }] });
    r.fake.refuseFormatted = 1;
    await r.adapter.edit(r.chat, messageId, { text, marks });
    expect(r.fake.of("editMessageText")).toHaveLength(2);
    expect(r.fake.of("editMessageText").at(-1)!.params.entities).toBeUndefined();
  });
});

describe("buttons are bound to the message that carries them", () => {
  it("text, then a file: the send is named by the text message (the keyboard's), not the file's", async () => {
    const r = await rig();
    const path = join(r.dir, "plan.md");
    writeFileSync(path, "# 계획\n");
    const { messageId } = await r.adapter.send(r.chat, { text: "계획입니다", buttons: [[{ label: "진행", token: "t-go" }]], files: [{ path, name: "계획.md", mime: "text/markdown" }] });
    expect(r.fake.of("sendDocument")).toHaveLength(1);
    expect(Number(messageId)).toBe(r.fake.button("진행").messageId);
  });

  it("a text over the limit: named by its last part, where the keyboard is", async () => {
    const r = await rig();
    const { messageId } = await r.adapter.send(r.chat, { text: `${"가".repeat(4000)}\n\n${"나".repeat(3000)}`, buttons: [[{ label: "고르기", token: "t-pick" }]] });
    expect(sends(r.fake)).toHaveLength(2);
    expect(sends(r.fake)[0]!.reply_markup).toBeUndefined();
    expect(Number(messageId)).toBe(r.fake.button("고르기").messageId);
  });
});

describe("the command button", () => {
  it("lists the nine everyday commands with Korean descriptions, each a valid Bot API command", async () => {
    const r = await rig();
    const abort = new AbortController();
    const running = r.adapter.start(async () => {}, abort.signal);
    for (let wait = 0; wait < 200 && !r.fake.of("setMyCommands").length; wait += 1) await new Promise((done) => setTimeout(done, 5));
    abort.abort();
    await running;
    const commands = r.fake.of("setMyCommands")[0]!.params.commands as { command: string; description: string }[];
    expect(commands.map((entry) => entry.command)).toEqual(["menu", "new", "chats", "model", "status", "usage", "retry", "stop", "help"]);
    expect(commands).toEqual(COMMAND_LIST);
    for (const entry of commands) {
      expect(entry.command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeLessThanOrEqual(256);
      expect(entry.description).toMatch(/[가-힣]/);
    }
  });
});
