// The messenger channel: the owner talks to this PC's conversations from a paired chat.

export type ChannelKind = "telegram" | "slack";

/**
 * Who sent a request that was not typed at this PC: a paired messenger chat. Kept on the request,
 * on the request while it waits in a queue, and on its user item. `context`: the version of the
 * phone preamble the engine reads with it (channels/preamble.ts), so a request that waited is told
 * the same thing when it goes.
 */
export type RequestOrigin = { channel: ChannelKind; bindingId: string; context?: number };

export const isRequestOrigin = (value: unknown): value is RequestOrigin => {
  if (!value || typeof value !== "object") return false;
  const origin = value as Record<string, unknown>;
  return (origin.channel === "telegram" || origin.channel === "slack") && typeof origin.bindingId === "string" && origin.bindingId.length > 0
    && (origin.context === undefined || Number.isSafeInteger(origin.context));
};

/** A paired chat as the PC screen shows it. */
export type ChannelBinding = {
  id: string;
  kind: ChannelKind;
  botId: string;
  chatId: string;
  userId: string;
  displayName: string;
  handle: string | null;
  createdAt: number;
  /** "연결 끊기" at the PC. */
  revokedAt: number | null;
  /** "멈춤" at the PC. */
  pausedAt: number | null;
  /** "잠금" from the chat; undone only at the PC. */
  lockedAt: number | null;
  /** The conversation the chat writes to ("지금 대화"); not the desktop's own current conversation. */
  pointerWorkId: string | null;
  pointerSessionId: string | null;
  /** That conversation by name, for the screen: 「project」 › 「conversation」 (engine · mode). */
  pointerLabel?: string | null;
  /**
   * Answers the messenger refused for good (the person blocked the bot, the chat is gone) or that
   * failed too often, since the last message that did reach the chat. They are not tried again.
   * Null (or absent from an older gateway) when there are none.
   */
  undelivered?: { count: number; at: number; reason: string } | null;
  /**
   * Answers whose arrival is unknown (the messenger gave no answer after the request went) since one
   * certainly arrived. They are never sent twice, so the PC says so ("전달됐는지 확인하지 못한 답").
   */
  uncertain?: { count: number; at: number } | null;
};

/**
 * A phone that opened the PC's one-time link and waits for the PC to approve the same digits.
 * `userId` is the messenger's numeric account id and `handle` its @name (without the @): the PC
 * shows them beside `displayName`, which anyone can set to anything.
 */
export type ChannelPairingRequest = {
  id: string; userId: string; displayName: string; handle: string | null; digits: string; at: number; expiresAt: number;
  /** Other accounts that asked while this one waited (Slack, where a bare word pairs): told to wait, never paired by it. */
  others?: { userId: string; displayName: string; handle: string | null }[];
};

/** An account refused for an hour after five wrong pairing values in ten minutes, or (`declined`, Slack) after the PC declined its request. */
export type ChannelRefusedSender = { userId: string; displayName: string; handle: string | null; until: number; declined?: boolean };

/**
 * Pairing of one bot: `expiresAt` while a one-time link is live, `request` once a phone opened it.
 * `notice`: why the last pairing ended without the PC (two accounts presented the same value),
 * until the PC starts a new one. `refusedSenders`: accounts refused after too many wrong values
 * (counted per account; they do not stop anyone else). `lockedUntil`: kept for data written by
 * the first version, which refused all pairing after five wrong values from anyone; a gateway
 * from fix round 1 on never sets it.
 */
export type ChannelPairing = {
  expiresAt: number | null;
  request: ChannelPairingRequest | null;
  lockedUntil: number | null;
  notice?: string | null;
  refusedSenders?: ChannelRefusedSender[];
};

/** One line of the channel's record ("기록"): what happened, never what was said. */
export type ChannelAuditRow = { id: number; at: number; bindingId: string | null; kind: ChannelKind; action: string; sessionId: string | null; requestId: string | null; target: string | null; result: string | null };

/** How a bot's token is held: sealed on disk, for this run only (no OS keyring), or not at all (enter it again). The token itself is never sent to a screen. */
export type ChannelTokenHold = "sealed" | "memory" | "none";

/** A bot's connection to its messenger. `conflict`: another program uses the same token. */
export type ChannelConnection = { state: "connected" | "retrying" | "conflict" | "stopped"; detail: string | null };

/** A registered bot with its pairing and its paired chats (disconnected ones are only in the record). */
export type ChannelBot = {
  kind: ChannelKind;
  id: string;
  username: string;
  name: string;
  /** Slack: the app's name as the person typed it in the wizard (what they search for in Slack); absent if not given. */
  appName?: string;
  createdAt: number;
  token: ChannelTokenHold;
  status: ChannelConnection;
  pairing: ChannelPairing;
  bindings: ChannelBinding[];
};

/** `GET /api/channels`: everything the "휴대폰 메신저" screen shows. */
export type ChannelsState = { bots: ChannelBot[] };

/**
 * `POST /api/channels/:kind/bots/:botId/pairing`: the link the phone opens, valid until `expiresAt`,
 * and its QR picture (an SVG data address). Given once; the screen shows the picture, not the link.
 * Slack: see `say`.
 */
export type ChannelPairingLink = {
  link: string; qr: string; expiresAt: number;
  /**
   * Slack (no start value in a link, so `link` and `qr` are empty): the exact line the person sends
   * in the app's DM, carrying the one-time value; and an address that opens that DM, when known.
   */
  say?: string;
  open?: string | null;
};
