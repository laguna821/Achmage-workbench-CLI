import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../store.ts";

// The channel's own tables, added beside the existing ones: who is paired, what was received, what
// was sent (once), which buttons are live, and what happened.

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function open(path?: string) {
  const dir = path ? null : mkdtempSync(join(tmpdir(), "wb-channel-store-"));
  if (dir) dirs.push(dir);
  const file = path ?? join(dir!, "state.sqlite");
  const store = new Store(file);
  return { store, channels: store.channels, file };
}
const OWNER = { kind: "telegram" as const, botId: "7012345678", chatId: "555", userId: "555", displayName: "홍길동", handle: "hong" };

describe("paired chats", () => {
  it("keeps a binding with its pointer, pause, lock and revocation, across a restart", () => {
    const { store, channels, file } = open();
    const binding = channels.addBinding(OWNER);
    expect(binding).toMatchObject({ ...OWNER, revokedAt: null, pausedAt: null, lockedAt: null, pointerWorkId: null, pointerSessionId: null, prefs: {} });
    channels.updateBinding(binding.id, { pointerWorkId: "w1", pointerSessionId: "s1", pausedAt: 10, prefs: { quiet: true } });
    store.close();
    const again = open(file);
    expect(again.channels.binding(binding.id)).toMatchObject({ pointerWorkId: "w1", pointerSessionId: "s1", pausedAt: 10, lockedAt: null, prefs: { quiet: true } });
    expect(again.channels.activeBinding("telegram", OWNER.botId, "555", "555")?.id).toBe(binding.id);
    again.channels.updateBinding(binding.id, { revokedAt: 20 });
    // Default deny: a revoked chat, another chat and another user are nobody.
    expect(again.channels.activeBinding("telegram", OWNER.botId, "555", "555")).toBeNull();
    expect(again.channels.activeBinding("telegram", OWNER.botId, "556", "555")).toBeNull();
    expect(again.channels.activeBinding("telegram", OWNER.botId, "555", "777")).toBeNull();
    expect(again.channels.activeBinding("telegram", "another-bot", "555", "555")).toBeNull();
    expect(again.channels.bindings().map((entry) => entry.id)).toEqual([binding.id]);
  });
});

describe("the inbox", () => {
  it("records a batch and the next offset together, once per event however often it is delivered", () => {
    const { channels } = open();
    expect(channels.offset("telegram", "1")).toBeNull();
    expect(channels.record("telegram", "1", [{ eventId: "100", payload: "{\"a\":1}" }, { eventId: "101", payload: "{\"a\":2}" }], "102")).toEqual(["100", "101"]);
    expect(channels.offset("telegram", "1")).toBe("102");
    // Delivered again (a reconnect, a crash before the offset was confirmed): nothing new.
    expect(channels.record("telegram", "1", [{ eventId: "101", payload: "{\"a\":2}" }, { eventId: "102", payload: "{\"a\":3}" }], "103")).toEqual(["102"]);
    expect(channels.pending("telegram", "1").map((entry) => entry.eventId)).toEqual(["100", "101", "102"]);
    // Another bot's ids are its own.
    expect(channels.record("telegram", "2", [{ eventId: "100", payload: "{}" }], "101")).toEqual(["100"]);
    expect(channels.offset("telegram", "1")).toBe("103");
  });

  it("writes neither the events nor the offset when the batch cannot be written", () => {
    const { channels } = open();
    channels.record("telegram", "1", [{ eventId: "1", payload: "{}" }], "2");
    expect(() => channels.record("telegram", "1", [{ eventId: "2", payload: "{}" }, { eventId: "3", payload: null as unknown as string }], "4")).toThrow();
    expect(channels.offset("telegram", "1")).toBe("2");
    expect(channels.pending("telegram", "1").map((entry) => entry.eventId)).toEqual(["1"]);
  });

  it("keeps what was received until it is handled, then forgets the message itself", () => {
    const { store, channels, file } = open();
    channels.record("telegram", "1", [{ eventId: "7", payload: "{\"text\":\"본문\"}" }], "8");
    store.close();
    // The gateway died before handling it: it is still there to handle.
    const again = open(file);
    expect(again.channels.pending("telegram", "1")).toEqual([{ eventId: "7", payload: "{\"text\":\"본문\"}" }]);
    again.channels.done("telegram", "1", "7");
    expect(again.channels.pending("telegram", "1")).toEqual([]);
    expect(again.channels.seen("telegram", "1", "7")).toBe("done");
    expect(again.channels.record("telegram", "1", [{ eventId: "7", payload: "{\"text\":\"본문\"}" }], "8")).toEqual([]);
    again.store.close();
    // The body does not stay in the database once handled.
    const raw = new DatabaseSync(file, { readOnly: true });
    expect(raw.prepare("SELECT payload FROM channel_inbox WHERE event_id = '7'").get()?.payload).toBeNull();
    raw.close();
  });
});

describe("a message that waits for the person to say where it goes", () => {
  it("is kept with its text, is not handled again by itself, and is forgotten when used or after a day", () => {
    const { store, channels, file } = open();
    channels.record("telegram", "1", [{ eventId: "5", payload: "{\"text\":\"보관한 뒤에 보낸 일\"}" }, { eventId: "6", payload: "{}" }], "7");
    channels.park("telegram", "1", "5");
    expect(channels.seen("telegram", "1", "5")).toBe("parked");
    store.close();
    const again = open(file);
    // Not among what a restart handles again.
    expect(again.channels.pending("telegram", "1").map((entry) => entry.eventId)).toEqual(["6"]);
    expect(again.channels.parked("telegram", "1", "5")).toBe("{\"text\":\"보관한 뒤에 보낸 일\"}");
    expect(again.channels.parked("telegram", "1", "6")).toBeNull();
    again.channels.done("telegram", "1", "5");
    expect(again.channels.parked("telegram", "1", "5")).toBeNull();
    // One nobody came back to loses its text after a day; its id stays.
    again.channels.record("telegram", "1", [{ eventId: "8", payload: "{\"text\":\"잊힐 글\"}" }], "9");
    again.channels.park("telegram", "1", "8");
    again.channels.pruneInbox(0, Date.now() + 1);
    expect(again.channels.parked("telegram", "1", "8")).toBeNull();
    expect(again.channels.seen("telegram", "1", "8")).toBe("done");
  });
});

describe("the outbox", () => {
  it("keeps the record of an answer when old rows are cleared, so the request is never answered twice", () => {
    const { channels } = open();
    channels.owe("final:s1:r1", { bindingId: "b1", sessionId: "s1", requestId: "r1" });
    channels.begin("final:s1:r1");
    channels.settle("final:s1:r1", "sent", "m1");
    channels.owe("ack:telegram:1:5:0", { bindingId: "b1" });
    channels.begin("ack:telegram:1:5:0");
    channels.settle("ack:telegram:1:5:0", "sent", "m2");
    channels.owe("ack:telegram:1:6:0", { bindingId: "b1" });
    channels.pruneOutbox(Date.now() + 1, Date.now() + 1);
    expect(channels.outbox("final:s1:r1")?.state).toBe("sent");
    expect(channels.owe("final:s1:r1", { bindingId: "b1", sessionId: "s1", requestId: "r1" })).toBe(false);
    expect(channels.outbox("ack:telegram:1:5:0")).toBeNull();
    expect(channels.outbox("ack:telegram:1:6:0")).toBeNull();
  });

  it("lets one message be sent under a key once", () => {
    const { channels } = open();
    expect(channels.owe("final:s1:r1", { bindingId: "b1", sessionId: "s1", requestId: "r1" })).toBe(true);
    expect(channels.owe("final:s1:r1", { bindingId: "b1", sessionId: "s1", requestId: "r1" })).toBe(false);
    expect(channels.begin("final:s1:r1")).toBe(true);
    // A second sender (a re-sent event, a second listener) does not get to send.
    expect(channels.begin("final:s1:r1")).toBe(false);
    channels.settle("final:s1:r1", "sent", "m1");
    expect(channels.begin("final:s1:r1")).toBe(false);
    expect(channels.outbox("final:s1:r1")).toMatchObject({ state: "sent", messageId: "m1", bindingId: "b1", sessionId: "s1", requestId: "r1" });
  });

  it("lets a message that certainly did not go be tried again, and one that may have gone never", () => {
    const { channels } = open();
    channels.owe("notice:a", { bindingId: "b1" });
    channels.begin("notice:a");
    channels.settle("notice:a", "pending");
    expect(channels.begin("notice:a")).toBe(true);
    channels.settle("notice:a", "unknown");
    expect(channels.begin("notice:a")).toBe(false);
    expect(channels.outbox("notice:a")?.state).toBe("unknown");
  });

  it("marks what was being sent when the gateway stopped as unknown, and does not send it again", () => {
    const { store, channels, file } = open();
    channels.owe("final:s1:r1", { bindingId: "b1", sessionId: "s1", requestId: "r1" });
    channels.owe("final:s1:r2", { bindingId: "b1", sessionId: "s1", requestId: "r2" });
    channels.begin("final:s1:r1");
    store.close();
    const again = open(file);
    expect(again.channels.interrupted().map((row) => row.key)).toEqual(["final:s1:r1"]);
    expect(again.channels.outbox("final:s1:r1")?.state).toBe("unknown");
    expect(again.channels.begin("final:s1:r1")).toBe(false);
    // What was never started is still owed.
    expect(again.channels.owed("b1").map((row) => row.key)).toEqual(["final:s1:r2"]);
    // Told to the person once.
    expect(again.channels.untold("b1").map((row) => row.key)).toEqual(["final:s1:r1"]);
    again.channels.told(["final:s1:r1"]);
    expect(again.channels.untold("b1")).toEqual([]);
  });
});

describe("buttons", () => {
  const button = { bindingId: "b1", chatId: "555", userId: "555", sessionId: "s1", itemId: "approval:1", kind: "approve", data: null, expiresAt: 1_000 };
  it("is used once, and not after it expired", () => {
    const { channels } = open();
    channels.addButton({ token: "t-allow", ...button });
    channels.addButton({ token: "t-late", ...button, itemId: "approval:2" });
    expect(channels.button("t-allow")).toMatchObject({ token: "t-allow", kind: "approve", usedAt: null, messageId: null });
    expect(channels.useButton("t-allow", 500)).toBe(true);
    expect(channels.useButton("t-allow", 501)).toBe(false);
    expect(channels.button("t-allow")?.usedAt).toBe(500);
    expect(channels.useButton("t-late", 1_000)).toBe(false);
    expect(channels.button("t-late")?.usedAt).toBeNull();
    expect(channels.useButton("nobody-made-this", 1)).toBe(false);
  });

  it("retires the other buttons of the same question together", () => {
    const { channels } = open();
    channels.addButton({ token: "t-allow", ...button });
    channels.addButton({ token: "t-deny", ...button, kind: "decline" });
    channels.addButton({ token: "t-other", ...button, itemId: "approval:9" });
    channels.setButtonMessage(["t-allow", "t-deny"], "m7");
    expect(channels.useButton("t-allow", 10)).toBe(true);
    expect(channels.retireButtons("b1", "s1", "approval:1", 10).map((entry) => entry.token)).toEqual(["t-deny"]);
    expect(channels.useButton("t-deny", 11)).toBe(false);
    expect(channels.button("t-deny")).toMatchObject({ messageId: "m7", usedAt: 10 });
    expect(channels.useButton("t-other", 11)).toBe(true);
  });
});

describe("the audit trail", () => {
  it("lists what happened, newest first, by binding and time", () => {
    const { channels } = open();
    channels.audit({ at: 1, bindingId: "b1", kind: "telegram", action: "paired", target: "555", result: "ok" });
    channels.audit({ at: 2, bindingId: "b1", kind: "telegram", action: "request", sessionId: "s1", requestId: "ch:telegram:1:100", result: "turn" });
    channels.audit({ at: 3, bindingId: null, kind: "telegram", action: "refused", target: "user:999", result: "stranger" });
    expect(channels.auditList().map((row) => row.action)).toEqual(["refused", "request", "paired"]);
    expect(channels.auditList({ bindingId: "b1" }).map((row) => row.action)).toEqual(["request", "paired"]);
    expect(channels.auditList({ since: 2, until: 3 }).map((row) => row.action)).toEqual(["request"]);
    expect(channels.auditList({ limit: 1 })).toMatchObject([{ at: 3, action: "refused", target: "user:999", result: "stranger", sessionId: null, requestId: null }]);
    expect(channels.lastAudit("refused", "user:999")?.at).toBe(3);
    expect(channels.lastAudit("refused", "user:1000")).toBeNull();
  });

  it("never stores a secret-shaped value, even when a caller passes one by mistake", () => {
    const { store, channels, file } = open();
    const token = "7012345678:AAH" + "z".repeat(8) + "-Fake_token-for-tests-0003";
    channels.audit({ at: 1, bindingId: "b1", kind: "telegram", action: "error", target: `https://api.telegram.org/file/bot${token}/a.pdf`, result: `failed ${token}` });
    expect(JSON.stringify(channels.auditList())).not.toContain(token);
    store.close();
    const raw = new DatabaseSync(file, { readOnly: true });
    expect(JSON.stringify(raw.prepare("SELECT * FROM channel_audit").all())).not.toContain(token);
    raw.close();
  });
});

describe("an older gateway", () => {
  it("still opens the data: the schema version is unchanged and its tables are as they were", () => {
    const { store, channels, file } = open();
    channels.addBinding(OWNER);
    channels.record("telegram", "1", [{ eventId: "1", payload: "{}" }], "2");
    store.saveRequest("r1", "s1", "h1");
    store.close();
    const raw = new DatabaseSync(file);
    // What the older gateway checks before it opens a database (store.ts): the version it knows.
    expect(Number(raw.prepare("PRAGMA user_version").get()?.user_version)).toBe(1);
    // Its own tables keep their columns in place (the new one is added last and may be null).
    expect(raw.prepare("SELECT name FROM pragma_table_info('requests') ORDER BY cid").all().map((row) => row.name)).toEqual(["request_id", "session_id", "text_hash", "created_at", "origin"]);
    for (const table of ["folders", "works", "sessions", "items", "meta", "artifacts", "revisions", "hub_deliveries"]) {
      expect(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)).toBeTruthy();
    }
    // The channel's tables are new ones, which the older gateway never reads.
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'channel_%' ORDER BY name").all().map((row) => row.name))
      .toEqual(["channel_audit", "channel_bindings", "channel_buttons", "channel_inbox", "channel_outbox"]);
    raw.close();
  });
});
