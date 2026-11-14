import type { ChannelKind } from "@workbench/contracts";

// What a messenger platform has to do, and nothing more. Pairing, who may speak, which
// conversation a message goes to, what is sent once, and the audit trail belong to the core
// (core.ts), the same for every platform.

export type { ChannelKind };
export type ChatRef = { kind: ChannelKind; botId: string; chatId: string; chatType: "dm" | "group" | "channel" };
export type Sender = { userId: string; displayName: string; handle?: string };
export type InFile = { fileRef: string; name: string; mime: string; size: number; kind: "photo" | "voice" | "audio" | "file" };
export type Inbound =
  | {
      type: "message"; eventId: string; chat: ChatRef; from: Sender; text: string; files: InFile[]; at: number;
      /** Set on the first of the messages that waited at the messenger while this PC was off or asleep: how many waited. */
      backlog?: number;
      /**
       * What waited at the messenger and is not run (older than it holds lines, or more than are run
       * at once): how many and the earliest; `more`, more than could be read. Carried by an event of
       * its own with no text, before those that run.
       */
      skipped?: { count: number; since: number; more?: boolean };
    }
  | {
      type: "button"; eventId: string; chat: ChatRef; from: Sender; token: string; ackHandle: string; at: number;
      /** The message the pressed button sat on (a button is bound to it: pressed on any other, it does nothing). */
      messageId?: string;
    }
  /**
   * A message taken out before the inbox because the chat's secret input was open (design §6.3,
   * channels/secret-window.ts). It never carries the value: that goes to the credential store in
   * memory only. `outcome`: a typed value, a sealed Mini App form, "취소", a message of another kind
   * (refused and deleted), a Mini App answer nobody asked for, a line an open input cannot take
   * (held), a line caught after an input ended (fix round 4, ruling P2: by its shape, or because it
   * found the input ended before the person was told), or an app word sent as a reply to a hand-over.
   * `shape`: what a caught line looked like ("code", "link"; absent: caught because it found the end).
   */
  | { type: "secret"; eventId: string; chat: ChatRef; from: Sender; handoffId: string; field: number; messageId: string; outcome: "value" | "sealed" | "cancel" | "refused" | "stray" | "held" | "caught" | "word"; at: number; shape?: "code" | "link" };

/** `token`: a random value from the core's table; it carries no meaning of its own. */
export type Button = { label: string; token: string };
/** `webApp`: a keyboard button that opens a Mini App (Telegram: only such a button lets it send data back). */
export type Out = {
  text: string; buttons?: Button[][]; files?: { path: string; name: string; mime: string; caption?: string }[]; silent?: boolean; webApp?: { label: string; url: string };
  /** The text is an engine's markdown: the core makes it readable text + `marks` before an adapter sees it. */
  markdown?: boolean;
  /**
   * The formatting hook: stretches of `text` to show formatted, in UTF-16 units. Each messenger
   * shows them its own way (Telegram as entities); one that cannot sends the text as it is.
   */
  marks?: Mark[];
  /** The core's own plain lines under a markdown text (added after formatting, never read as markdown); adapters never see it. */
  tail?: string;
};
/** `continues`: the stretch goes on in the next part of a text cut into several messages. */
export type Mark = { type: "bold" | "italic" | "strike" | "code" | "pre" | "link" | "quote"; offset: number; length: number; url?: string; language?: string; continues?: boolean };
/**
 * `stillWanted`: asked right before each request leaves (after any wait in the chat's send line,
 * and before each part of a long text). When it says no, nothing more is sent and the send fails
 * with code `withdrawn` ("no" when nothing had gone yet, else "unknown").
 */
export type SendOptions = { stillWanted?: () => boolean };
export type SecretAsk = { requestId: string; title: string; fields: string[] };

export type ChannelStatus = { state: "connected" | "retrying" | "conflict" | "stopped"; detail: string | null };

/**
 * A send, edit or other call that failed. `delivered: "no"`: it certainly did not reach the
 * messenger (refused, or the connection was never made). `"unknown"`: it may have arrived, so it is
 * never sent a second time. `permanent`: refused in a way trying again cannot change (the person
 * blocked the bot, the chat is gone, the message is malformed): it is not tried again.
 * `retryAfterMs`: the messenger asked not to be called again before this long.
 */
export class ChannelSendError extends Error {
  readonly delivered: "no" | "unknown";
  readonly code: string;
  readonly permanent: boolean;
  readonly retryAfterMs: number | null;
  constructor(delivered: "no" | "unknown", code: string, message: string, options: { permanent?: boolean; retryAfterMs?: number } = {}) {
    super(message);
    this.delivered = delivered;
    this.code = code;
    this.permanent = delivered === "no" && options.permanent === true;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

export interface ChannelAdapter {
  readonly kind: ChannelKind;
  readonly botId: string;
  readonly limits: { text: number; caption: number; uploadBytes: number; downloadBytes: number; minEditGapMs: number };
  /**
   * Receive until `signal` aborts. An event counts as received by the messenger (offset, ack) only
   * after `sink` has stored it; the same event may be handed over more than once.
   */
  start(sink: (event: Inbound) => Promise<void>, signal: AbortSignal): Promise<void>;
  /**
   * `unsent`: files that did not go after something of the message had already gone (the message is
   * delivered; these are named to the person instead of sending the whole again). "unknown": it may
   * have gone.
   */
  send(chat: ChatRef, out: Out, options?: SendOptions): Promise<{ messageId: string; unsent?: { name: string; delivered: "no" | "unknown" }[] }>;
  edit(chat: ChatRef, messageId: string, out: Out): Promise<void>;
  /** Delete a message in the chat (a received secret, design §6.3). */
  remove(chat: ChatRef, messageId: string): Promise<boolean>;
  /** Answer a button press, so the phone stops showing it as in progress. */
  ackButton(handle: string, note?: string): Promise<void>;
  typing(chat: ChatRef): Promise<void>;
  /** Fetch a received file to a local path. The platform's file address (it may carry the token) stays inside. */
  download(file: InFile, toPath: string): Promise<void>;
  /** Open a human-only input (design §6.3). Not built yet on any platform. */
  askSecret?(chat: ChatRef, request: SecretAsk): Promise<{ messageId: string }>;
  /**
   * The messenger names the sender itself and a bare word pairs (the adapter supplies the PC's
   * one-time value), so the value proves nothing about who saw the PC: a second account while one
   * request waits is told to wait (never a cancel), and a person the PC declined is refused for the
   * lock time, also in the next window. Slack: true. Telegram: absent (the value is the proof).
   */
  readonly pairingByWord?: boolean;
  /**
   * false: the messenger cannot take a value out before the inbox (no `divert` / `press` hook) nor
   * delete the person's message, so the vault never opens an in-chat input here and never asks for a
   * value in the chat: values are entered on the PC. Slack: false (until a modal exists). Telegram:
   * absent (its input is the chat's own). An adapter without the hooks must say false.
   */
  readonly secretInput?: boolean;
  /** Leave a chat that is not a direct one (the channel works in direct chats only). */
  leave?(chat: ChatRef): Promise<void>;
  status(): ChannelStatus;
}
