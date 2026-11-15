import { readFileSync, writeFileSync } from "node:fs";
import type { ChannelKind } from "@workbench/contracts";
import { ChannelSendError, type ChannelAdapter, type ChannelStatus, type ChatRef, type InFile, type Inbound, type Out, type SendOptions, type Sender } from "./types.ts";

type Sent = { chat: ChatRef; out: Out; messageId: string };

// A messenger never gives two events the same id, also not after the gateway restarts.
let nextEvent = 1;

/**
 * A messenger that lives in memory, for the core's tests: it hands over the events a test gives
 * it, keeps what the core sent, edited, removed and acknowledged, and can fail a send either way
 * (certainly not gone / may have gone).
 */
export class FakeAdapter implements ChannelAdapter {
  readonly kind: ChannelKind;
  readonly botId: string;
  readonly limits = { text: 4096, caption: 1024, uploadBytes: 50 * 1024 * 1024, downloadBytes: 20 * 1024 * 1024, minEditGapMs: 15_000 };
  readonly sent: Sent[] = [];
  readonly edits: { chat: ChatRef; messageId: string; out: Out }[] = [];
  readonly removed: { chat: ChatRef; messageId: string }[] = [];
  readonly acks: { handle: string; note: string | undefined }[] = [];
  readonly typings: ChatRef[] = [];
  /** Files a test puts at the messenger, by file reference (what `download` fetches). */
  readonly files = new Map<string, Buffer>();
  /** Files that went to the chat, with their bytes as they were when sent. */
  readonly uploads: { name: string; mime: string; caption?: string; bytes: Buffer }[] = [];
  /** Every message as sent and as each edit left it, in order. */
  readonly history: Sent[] = [];
  readonly left: ChatRef[] = [];
  /**
   * How the next sends fail, first in first out: certainly not gone and worth trying again ("no"),
   * may have gone ("unknown"), refused for good ("permanent"), or told to wait ({ retryAfterMs }).
   */
  readonly failures: ("no" | "unknown" | "permanent" | { retryAfterMs: number })[] = [];
  /** Runs as a send begins, before it can fail or land (a test closes a gate at that moment). */
  beforeSend: (() => void) | null = null;
  /** Held open while a send is on its way (a test decides when it lands): as the messenger's send line holds it. */
  sendGate: Promise<void> | null = null;
  /** Sends waiting at the gate now. */
  waiting = 0;
  state: ChannelStatus = { state: "stopped", detail: null };
  private sink: ((event: Inbound) => Promise<void>) | null = null;
  private nextMessage = 1;

  constructor(kind: ChannelKind = "telegram", botId = "7000000001") {
    this.kind = kind;
    this.botId = botId;
  }

  async start(sink: (event: Inbound) => Promise<void>, signal: AbortSignal) {
    this.sink = sink;
    this.state = { state: "connected", detail: null };
    signal.addEventListener("abort", () => { this.sink = null; this.state = { state: "stopped", detail: null }; });
  }

  /** The messenger delivers an event (the same one may be delivered again). */
  async deliver(event: Inbound) {
    if (!this.sink) throw new Error("the fake messenger is not started");
    await this.sink(event);
  }

  dm(userId = "555"): ChatRef { return { kind: this.kind, botId: this.botId, chatId: userId, chatType: "dm" }; }
  person(userId = "555", displayName = "홍길동", handle = "hong"): Sender { return { userId, displayName, handle }; }

  /** A text message from a person in their direct chat. */
  message(text: string, options: { userId?: string; eventId?: string; chat?: ChatRef; at?: number; from?: Sender; files?: InFile[]; backlog?: number } = {}): Extract<Inbound, { type: "message" }> {
    const userId = options.userId ?? "555";
    return { type: "message", eventId: options.eventId ?? String(nextEvent++), chat: options.chat ?? this.dm(userId), from: options.from ?? this.person(userId), text, files: options.files ?? [], at: options.at ?? Date.now(), ...(options.backlog ? { backlog: options.backlog } : {}) };
  }

  /** A press of a button the core sent (on the message it sits on, when given). */
  press(token: string, options: { userId?: string; eventId?: string; chat?: ChatRef; messageId?: string } = {}): Extract<Inbound, { type: "button" }> {
    const userId = options.userId ?? "555";
    const eventId = options.eventId ?? String(nextEvent++);
    return { type: "button", eventId, chat: options.chat ?? this.dm(userId), from: this.person(userId), token, ackHandle: `ack-${eventId}`, at: Date.now(), ...(options.messageId ? { messageId: options.messageId } : {}) };
  }

  async send(chat: ChatRef, out: Out, options: SendOptions = {}) {
    this.beforeSend?.();
    this.waiting += 1;
    await this.sendGate;
    this.waiting -= 1;
    // As a real send line does: asked once more right before the message leaves.
    if (options.stillWanted && !options.stillWanted()) throw new ChannelSendError("no", "withdrawn", "the message was no longer wanted");
    const failure = this.failures.shift();
    if (failure === "permanent") throw new ChannelSendError("no", "blocked", "the messenger refused the message for good", { permanent: true });
    if (typeof failure === "object") throw new ChannelSendError("no", "slow_down", "the messenger asked to wait", { retryAfterMs: failure.retryAfterMs });
    if (failure) throw new ChannelSendError(failure, failure === "no" ? "refused" : "timeout", failure === "no" ? "the messenger refused the message" : "no answer from the messenger");
    const messageId = `m${this.nextMessage++}`;
    const unsent = out.text ? (out.files ?? []).filter((file) => this.refuseFiles.has(file.name)).map((file) => ({ name: file.name, delivered: "no" as const })) : [];
    for (const file of (out.files ?? []).filter((entry) => !unsent.some((left) => left.name === entry.name))) this.uploads.push({ name: file.name, mime: file.mime, ...(file.caption ? { caption: file.caption } : {}), bytes: readFileSync(file.path) });
    this.sent.push({ chat, out, messageId });
    this.history.push({ chat, out, messageId });
    return unsent.length ? { messageId, unsent } : { messageId };
  }

  /** Files with these names do not go when sent with text (they come back as `unsent`, refused). */
  readonly refuseFiles = new Set<string>();
  /** Edits fail while set (the messenger refused or did not answer). */
  failEdits = false;

  async edit(chat: ChatRef, messageId: string, out: Out) {
    if (this.failEdits) throw new ChannelSendError("unknown", "no_answer", "the messenger did not answer the edit");
    this.edits.push({ chat, messageId, out });
    this.history.push({ chat, out, messageId });
  }
  async remove(chat: ChatRef, messageId: string) { this.removed.push({ chat, messageId }); return true; }
  async ackButton(handle: string, note?: string) { this.acks.push({ handle, note }); }
  async typing(chat: ChatRef) { this.typings.push(chat); }
  async download(file: InFile, toPath: string) {
    const bytes = this.files.get(file.fileRef);
    if (!bytes) throw new ChannelSendError("no", "file_unavailable", "the fake messenger has no such file");
    writeFileSync(toPath, bytes, { mode: 0o600 });
  }
  async leave(chat: ChatRef) { this.left.push(chat); }
  status() { return this.state; }

  /** Texts sent to a chat, in order. */
  texts(chatId = "555") { return this.sent.filter((entry) => entry.chat.chatId === chatId).map((entry) => entry.out.text); }
  /** The last message sent to a chat. */
  last(chatId = "555") { return this.sent.findLast((entry) => entry.chat.chatId === chatId) ?? null; }
  /** The token of a button on the last message carrying one with this label. */
  tokenOf(label: string, chatId = "555") {
    return this.buttonOf(label, chatId).token;
  }
  /** A button with this label as the chat shows it now (a message's last edit counts), and the message it sits on. */
  buttonOf(label: string, chatId = "555"): { token: string; messageId: string } {
    const seen = new Set<string>();
    for (const entry of [...this.history].reverse()) {
      if (entry.chat.chatId !== chatId || seen.has(entry.messageId)) continue;
      seen.add(entry.messageId);
      const button = entry.out.buttons?.flat().find((candidate) => candidate.label === label);
      if (button) return { token: button.token, messageId: entry.messageId };
    }
    // A button an edit has taken off still exists for the messenger's old copy (a second press of it).
    for (const entry of [...this.sent].reverse()) {
      if (entry.chat.chatId !== chatId) continue;
      const button = entry.out.buttons?.flat().find((candidate) => candidate.label === label);
      if (button) return { token: button.token, messageId: entry.messageId };
    }
    throw new Error(`no button labelled ${label}`);
  }
  /** Labels of the buttons a message shows now. */
  labelsOf(messageId: string) {
    return this.shown(messageId)?.buttons?.flat().map((button) => button.label) ?? [];
  }
  /** What a message shows now (its last edit, else as sent). */
  shown(messageId: string) {
    return this.edits.findLast((entry) => entry.messageId === messageId)?.out ?? this.sent.find((entry) => entry.messageId === messageId)?.out ?? null;
  }
}
