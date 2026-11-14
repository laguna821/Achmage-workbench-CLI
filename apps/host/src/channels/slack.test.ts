import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../store.ts";
import { FAKE_APP_TOKEN, FAKE_BOT_TOKEN, FakeSlack } from "./fake-slack.ts";
import { ChannelLog } from "./log.ts";
import { Redactor } from "./redact.ts";
import { SlackAdapter, escapeSlack, identifySlack, plainSlack, slackParts } from "./slack.ts";
import { until } from "./test-kit.ts";
import { ChannelSendError, type ChatRef, type Inbound } from "./types.ts";

// The Slack adapter against a stand-in Slack on loopback (Web API + Socket Mode). No test here
// reaches Slack.

type Rig = Awaited<ReturnType<typeof rig>>;
const rigs: { stop: () => Promise<void> }[] = [];
afterEach(async () => { for (const entry of rigs.splice(0)) await entry.stop(); });

async function rig(options: { gapMs?: number; pingMs?: number; crowdedNoteMs?: number; sink?: (event: Inbound) => Promise<void>; pairing?: () => { value: string } | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wb-slack-"));
  const fake = new FakeSlack();
  await fake.start();
  const store = new Store(join(dir, "state.sqlite"));
  const lines: string[] = [];
  const redactor = new Redactor();
  redactor.add("slack:bot", FAKE_BOT_TOKEN);
  redactor.add("slack:app", FAKE_APP_TOKEN);
  const log = new ChannelLog(redactor, (line) => lines.push(line));
  const sleeps: number[] = [];
  /** What the journal was asked, in order, beside what the stand-in saw (for the order of writing down and acknowledging). */
  const journal = {
    offset: (kind: "slack", botId: string) => store.channels.offset(kind, botId),
    record: (...args: Parameters<Store["channels"]["record"]>) => {
      for (const event of args[2]) fake.trail.push(`record ${(JSON.parse(event.payload) as Inbound).eventId}`);
      return store.channels.record(...args);
    },
  };
  const make = () => new SlackAdapter({
    botId: fake.botId, botUserId: fake.botUserId, tokens: async () => ({ bot: FAKE_BOT_TOKEN, app: FAKE_APP_TOKEN }), baseUrl: fake.api, journal, log,
    minSendGapMs: options.gapMs ?? 0, pingMs: options.pingMs ?? 10_000, random: () => 0.5, teamId: fake.teamId,
    ...(options.crowdedNoteMs !== undefined ? { crowdedNoteMs: options.crowdedNoteMs } : {}), ...(options.pairing ? { pairing: options.pairing } : {}),
    sleep: async (ms) => { sleeps.push(ms); await new Promise((done) => setTimeout(done, Math.min(ms, 20))); },
  });
  let adapter = make();
  let abort = new AbortController();
  const events: Inbound[] = [];
  const sink = options.sink ?? (async (event: Inbound) => { events.push(event); });
  let running: Promise<void> | null = null;
  const listen = () => { running = adapter.start(async (event) => { if (options.sink) events.push(event); await sink(event); }, abort.signal); };
  const stop = async () => {
    abort.abort();
    await running;
    await fake.stop();
    try { store.close(); } catch { /* Already closed. */ }
    rmSync(dir, { recursive: true, force: true });
  };
  const entry = {
    dir, fake, store, lines, sleeps, events, listen, stop,
    get adapter() { return adapter; },
    get running() { return running; },
    restart() { abort.abort(); abort = new AbortController(); adapter = make(); listen(); },
    halt() { abort.abort(); return running; },
    connected: () => until(() => adapter.status().state === "connected"),
  };
  rigs.push(entry);
  return entry;
}
const dm = (r: Rig, chatId = "D0HONG"): ChatRef => ({ kind: "slack", botId: r.fake.botId, chatId, chatType: "dm" });
const secretFree = (r: Rig) => {
  const text = r.lines.join("\n");
  expect(text).not.toContain(FAKE_BOT_TOKEN);
  expect(text).not.toContain(FAKE_APP_TOKEN);
  expect(text).not.toContain("ticket=");
};

describe("checking the two tokens", () => {
  it("asks auth.test for the bot and opens (and leaves unused) a Socket Mode address for the app token", async () => {
    const r = await rig();
    expect(await identifySlack(FAKE_BOT_TOKEN, FAKE_APP_TOKEN, r.fake.api)).toEqual({ id: "B0FAKEBOT01", username: "workbench", name: "연구실", teamId: "T0FAKETEAM1", userId: "U0FAKEBOT01", appId: "A0FAKEAPP01" });
    expect(r.fake.of("auth.test")[0]).toMatchObject({ token: "bot" });
    expect(r.fake.of("apps.connections.open")[0]).toMatchObject({ token: "app" });
    expect(r.fake.open()).toBe(0);
  });

  it("says which field is wrong: swapped, not a bot token, not an app token, unknown to Slack, another app's, missing scopes", async () => {
    const r = await rig();
    await expect(identifySlack(FAKE_APP_TOKEN, FAKE_BOT_TOKEN, r.fake.api)).rejects.toMatchObject({ status: 400, code: "channel_token_swapped" });
    await expect(identifySlack("xoxp-123", FAKE_APP_TOKEN, r.fake.api)).rejects.toMatchObject({ code: "channel_token_invalid" });
    await expect(identifySlack(FAKE_BOT_TOKEN, "nothing", r.fake.api)).rejects.toMatchObject({ code: "channel_app_token_invalid" });
    expect(r.fake.calls).toHaveLength(0);
    await expect(identifySlack(`${FAKE_BOT_TOKEN}x`, FAKE_APP_TOKEN, r.fake.api)).rejects.toMatchObject({ status: 400, code: "channel_token_invalid" });
    await expect(identifySlack(FAKE_BOT_TOKEN, `${FAKE_APP_TOKEN}x`, r.fake.api)).rejects.toMatchObject({ status: 400, code: "channel_app_token_invalid" });
    r.fake.botApp = "A0OTHERAPP1";
    await expect(identifySlack(FAKE_BOT_TOKEN, FAKE_APP_TOKEN, r.fake.api)).rejects.toMatchObject({ code: "channel_tokens_mismatch" });
    r.fake.botApp = r.fake.appId;
    r.fake.scopes = ["chat:write", "im:history"];
    await expect(identifySlack(FAKE_BOT_TOKEN, FAKE_APP_TOKEN, r.fake.api)).rejects.toThrow("files:read, files:write, users:read");
  });

  it("tells an unreachable Slack from a wrong token, and repeats neither token", async () => {
    const r = await rig();
    r.fake.failAt("auth.test", 1, { kind: "busy" });
    const error = await identifySlack(FAKE_BOT_TOKEN, FAKE_APP_TOKEN, r.fake.api).then(() => new Error("checked"), (reason: unknown) => reason as Error);
    expect(error).toMatchObject({ status: 502, code: "channel_unreachable" });
    expect(JSON.stringify({ message: error.message })).not.toContain("xox");
  });
});

describe("the socket", () => {
  it("connects through apps.connections.open with the app token only, one socket, and says connected after hello", async () => {
    const r = await rig();
    r.listen();
    await r.connected();
    expect(r.fake.of("apps.connections.open").every((entry) => entry.token === "app")).toBe(true);
    expect(r.fake.open()).toBe(1);
    secretFree(r);
  });

  it("hands an event over only after it was written down and acknowledged — and the acknowledgement does not wait for the core", async () => {
    let release!: () => void;
    const held = new Promise<void>((done) => { release = done; });
    const r = await rig({ sink: () => held });
    r.listen();
    await r.connected();
    const sent = r.fake.message("안녕하세요");
    await until(() => r.fake.acked(sent.envelopeId!));
    const eventId = `m:D0HONG:${sent.ts}`;
    expect(r.fake.trail).toContain(`record ${eventId}`);
    // The core still holds the first event, and a second envelope is acknowledged all the same.
    const second = r.fake.message("둘째");
    await until(() => r.fake.acked(second.envelopeId!));
    const envelope = r.fake.envelopes.find((entry) => entry.id === second.envelopeId)!;
    expect(envelope.ackedAt! - envelope.sentAt).toBeLessThan(3_000);
    expect(r.events.map((event) => event.eventId)).toEqual([eventId]);
    release();
    await until(() => r.events.length === 2);
    expect(r.events[0]).toMatchObject({ type: "message", text: "안녕하세요", from: { userId: "U0HONG", displayName: "길동 (홍길동)", handle: "hong" }, chat: { kind: "slack", chatId: "D0HONG", chatType: "dm" } });
  });

  it("an envelope is acknowledged only once it is written down: one that cannot be is not (Slack sends it again), and then is", async () => {
    const r = await rig();
    r.listen();
    await r.connected();
    // The database refuses the first write (a full disk, a crash between the two steps).
    const record = r.store.channels.record.bind(r.store.channels);
    let refuse = true;
    r.store.channels.record = (...args) => { if (refuse) { refuse = false; throw new Error("disk full"); } return record(...args); };
    const sent = r.fake.message("기록 못 함");
    await until(() => r.lines.some((line) => line.includes("envelope_unrecorded")));
    await new Promise((done) => setTimeout(done, 50));
    expect(r.fake.acked(sent.envelopeId!)).toBe(false);
    expect(r.events).toHaveLength(0);
    r.fake.redeliver(sent.envelopeId!);
    await until(() => r.fake.acked(sent.envelopeId!) && r.events.length === 1);
    expect(r.store.channels.seen("slack", r.fake.botId, r.events[0]!.eventId)).toBe("received");
  });

  it("the same message by the socket (Slack's retry after a reconnect) and from the history has one id", async () => {
    const r = await rig();
    r.listen();
    await r.connected();
    r.fake.message("처음", { ts: `${Math.floor(Date.now() / 1000) - 900}.000050` });
    await until(() => r.events.length === 1);
    await r.halt();
    await until(() => r.fake.open() === 0);
    // Sent while no socket was open: Slack (here) delivers it again on the next socket, and it is in the history too.
    r.fake.message("둘 다로 옴");
    r.restart();
    await until(() => r.events.filter((event) => event.type === "message" && event.text === "둘 다로 옴").length === 2);
    const ids = r.events.filter((event) => event.type === "message" && event.text === "둘 다로 옴").map((event) => event.eventId);
    expect(new Set(ids).size).toBe(1);
  });

  it("an envelope delivered again has the same event id and is written down once", async () => {
    const r = await rig();
    r.listen();
    await r.connected();
    const sent = r.fake.message("한 번만");
    await until(() => r.events.length === 1);
    r.fake.redeliver(sent.envelopeId!);
    await until(() => r.events.length === 2);
    expect(r.events[1]!.eventId).toBe(r.events[0]!.eventId);
    expect(r.store.channels.record("slack", r.fake.botId, [{ eventId: r.events[0]!.eventId, payload: "{}" }])).toEqual([]);
  });

  it("the socket dropped in the middle of an event: a new one opens, the envelope comes again and is acknowledged there", async () => {
    const r = await rig();
    r.listen();
    await r.connected();
    const opened = r.fake.of("apps.connections.open").length;
    // The stand-in sends, then cuts before the acknowledgement can reach it.
    r.fake.redeliverUnacked = true;
    const first = r.fake.message("끊기는 중");
    r.fake.dropAfter(first.envelopeId!);
    await until(() => r.fake.of("apps.connections.open").length > opened && r.fake.acked(first.envelopeId!));
    await until(() => r.events.length >= 1);
    expect(new Set(r.events.map((event) => event.eventId)).size).toBe(1);
    expect(r.fake.maxOpen).toBe(1);
  });

  it("an event written down while its socket closed (during a slow name lookup) is still handed over at once", async () => {
    const r = await rig();
    r.fake.redeliverUnacked = false;
    r.fake.userDelayMs = 300;
    r.listen();
    await r.connected();
    const sent = r.fake.message("이름을 찾는 동안 끊김", { user: "U0KIM" });
    await new Promise((done) => setTimeout(done, 60));
    r.fake.cut();
    await until(() => r.events.length === 1, 3_000);
    expect(r.events[0]).toMatchObject({ text: "이름을 찾는 동안 끊김" });
    expect(r.fake.acked(sent.envelopeId!)).toBe(false);
  });

  it("a line sent while the socket was down runs after the reconnect, even when the core was busy and a newer live line came first", async () => {
    let release!: () => void;
    const held = new Promise<void>((done) => { release = done; });
    let first = true;
    const r = await rig({ sink: async () => { if (first) { first = false; await held; } } });
    r.fake.redeliverUnacked = false;
    r.listen();
    await r.connected();
    r.fake.message("A 처리 중");
    await until(() => r.events.length === 1);
    r.fake.cut();
    r.fake.message("B 끊긴 동안", { deliver: false });
    await until(() => r.fake.of("apps.connections.open").length === 2 && r.fake.open() === 1);
    await r.connected();
    const live = r.fake.message("C 다시 붙은 뒤");
    await until(() => r.fake.acked(live.envelopeId!));
    release();
    await until(() => r.events.some((event) => event.type === "message" && event.text === "B 끊긴 동안"), 3_000);
    expect(r.events.map((event) => event.type === "message" && event.text)).toEqual(["A 처리 중", "B 끊긴 동안", "C 다시 붙은 뒤", "C 다시 붙은 뒤"]);
  });

  it("'refresh_requested' replaces the socket at once (no wait); 'warning' opens nothing until Slack closes it", async () => {
    const r = await rig();
    r.listen();
    await r.connected();
    r.fake.warn();
    await new Promise((done) => setTimeout(done, 60));
    expect(r.fake.of("apps.connections.open")).toHaveLength(1);
    r.fake.refresh();
    await until(() => r.fake.of("apps.connections.open").length === 2 && r.fake.open() === 1);
    await r.connected();
    expect(r.sleeps).toEqual([]);
    expect(r.fake.maxOpen).toBe(1);
  });

  it("a cut connection is opened again with a growing wait; a refused open too, and Slack's own wait is kept", async () => {
    const r = await rig();
    r.fake.failAt("apps.connections.open", 1, { kind: "busy" });
    r.fake.failAt("apps.connections.open", 2, { kind: "cut-before" });
    r.fake.failAt("apps.connections.open", 3, { kind: "limit" });
    r.listen();
    await r.connected();
    expect(r.sleeps).toEqual([1_000, 2_000, 7_000]);
    r.fake.cut();
    await until(() => r.adapter.status().state === "retrying");
    await r.connected();
    expect(r.sleeps.slice(3)).toEqual([1_000]);
    secretFree(r);
  });

  it("stops (no retry) when Slack refuses the app token, and when Socket Mode was turned off", async () => {
    const r = await rig();
    r.fake.revoked = true;
    r.listen();
    await until(() => r.adapter.status().state === "stopped" && r.adapter.status().detail !== null);
    expect(r.adapter.status().detail).toContain("토큰 바꾸기");
    expect(r.fake.of("apps.connections.open")).toHaveLength(1);
    r.fake.revoked = false;
    r.restart();
    await r.connected();
    r.fake.linkDisabled();
    await until(() => r.adapter.status().state === "stopped");
    expect(r.adapter.status().detail).toContain("Socket Mode");
  });

  it("other connections of the app (normal after a sleep: up to 10 are allowed) never stop the channel; a quiet note only if they stay", async () => {
    const r = await rig({ pingMs: 20, crowdedNoteMs: 150 });
    r.fake.others = 1;
    r.listen();
    await r.connected();
    r.fake.refresh();
    await until(() => r.fake.of("apps.connections.open").length === 2);
    await r.connected();
    // Still connected, still receiving; nothing says the token leaked.
    const sent = r.fake.message("계속 받나요");
    await until(() => r.events.length === 1 && r.fake.acked(sent.envelopeId!));
    await until(() => (r.adapter.status().detail ?? "").includes("다른 곳에서도"));
    expect(r.adapter.status()).toMatchObject({ state: "connected" });
    expect(r.adapter.status().detail).not.toMatch(/토큰|새었/);
    expect(r.fake.of("apps.connections.open")).toHaveLength(2);
    // Gone again: the note goes without waiting for Slack's next refresh (the PC asks again while it shows).
    r.fake.others = 0;
    await until(() => r.adapter.status().detail === null, 3_000);
    expect(r.adapter.status()).toMatchObject({ state: "connected" });
    expect(r.fake.of("apps.connections.open").length).toBeGreaterThanOrEqual(3);
    expect(r.fake.maxOpen).toBe(1);
  });

  it("token problems that will never pass stop at once and say so (no endless reconnecting)", async () => {
    for (const code of ["missing_scope", "token_expired", "access_denied", "team_access_not_granted"]) {
      const r = await rig();
      r.fake.openRefusal = code;
      r.listen();
      await until(() => r.adapter.status().state === "stopped" && r.adapter.status().detail !== null);
      expect(r.fake.of("apps.connections.open")).toHaveLength(1);
      expect(r.adapter.status().detail).toContain("토큰");
      await r.stop();
    }
  });

  it("a silent connection (pings unanswered) is replaced", async () => {
    const r = await rig({ pingMs: 40 });
    r.listen();
    await r.connected();
    r.fake.freeze();
    await until(() => r.fake.of("apps.connections.open").length === 2, 3_000);
    // The stand-in's side of the frozen socket is paused and may never read the close, so its count
    // proves nothing: the adapter dropped the silent one once and is connected again.
    await until(() => r.adapter.status().state === "connected");
    expect(r.lines.filter((line) => line.includes("socket_silent"))).toHaveLength(1);
  });

  it("stops at once when told, and asks Slack for nothing more", async () => {
    const r = await rig();
    r.listen();
    await r.connected();
    await r.halt();
    await until(() => r.fake.open() === 0);
    const calls = r.fake.calls.length;
    r.fake.message("들리지 않음");
    await new Promise((done) => setTimeout(done, 50));
    expect(r.fake.calls.length).toBe(calls);
    expect(r.adapter.status().state).toBe("stopped");
  });
});

describe("what comes in", () => {
  it("leaves out the bot's own messages, edits and deletions; reads files and a pairing line", async () => {
    const r = await rig();
    r.listen();
    await r.connected();
    r.fake.raw("events_api", { type: "event_callback", event: { type: "message", channel: "D0HONG", bot_id: r.fake.botId, user: r.fake.botUserId, text: "봇 자신", ts: "1.000001" } });
    r.fake.message("고친 글", { subtype: "message_changed" });
    const pdf = r.fake.file("보고서.pdf", Buffer.from("%PDF-1.4"), { mimetype: "application/pdf" });
    const png = r.fake.file("칠판.png", Buffer.from("png"), { mimetype: "image/png" });
    r.fake.message("이 파일들 &amp; 정리 <https://example.org/a|링크>", { files: [pdf, png], subtype: "file_share" });
    r.fake.message(`연결 ${"A".repeat(22)}`);
    await until(() => r.events.length === 2);
    expect(r.events[0]).toMatchObject({ text: "이 파일들 & 정리 https://example.org/a", files: [{ name: "보고서.pdf", kind: "file", mime: "application/pdf" }, { name: "칠판.png", kind: "photo" }] });
    expect(r.events[1]).toMatchObject({ text: `/start ${"A".repeat(22)}` });
    // The inbox never holds the one-time value.
    expect(r.store.channels.pending("slack", r.fake.botId).map((row) => (JSON.parse(row.payload) as { text: string }).text)).toContain("/start");
    expect(JSON.stringify(r.store.channels.pending("slack", r.fake.botId))).not.toContain("A".repeat(22));
  });

  it("a press: the token, the presser (payload.user — not the message's author, which is the bot), the conversation and the message it was on", async () => {
    const r = await rig();
    r.listen();
    await r.connected();
    const env = r.fake.press("tok-123", { messageTs: "1700.000001" });
    await until(() => r.events.length === 1 && r.fake.acked(env));
    expect(r.events[0]).toMatchObject({ type: "button", token: "tok-123", messageId: "1700.000001", from: { userId: "U0HONG" }, chat: { chatId: "D0HONG", chatType: "dm" } });
    expect(r.fake.envelopes.find((entry) => entry.id === env)!.body).toMatchObject({ payload: { message: { user: r.fake.botUserId } } });
  });

  it("an event or a press from another workspace is acknowledged and dropped", async () => {
    const r = await rig();
    r.listen();
    await r.connected();
    const one = r.fake.message("다른 워크스페이스", { team: "T0OTHER" });
    const two = r.fake.press("tok", { team: "T0OTHER" });
    r.fake.message("이 워크스페이스");
    await until(() => r.events.length === 1 && r.fake.acked(one.envelopeId!) && r.fake.acked(two));
    expect(r.events[0]).toMatchObject({ text: "이 워크스페이스" });
  });

  it("a person of another organisation in the app's DM (Slack Connect) is dropped — by the event's user_team or by users.info — and one whose team cannot be read cannot pair", async () => {
    const value = "AbCdEfGhIjKlMnOpQrStUv";
    const r = await rig({ pairing: () => ({ value }) });
    r.listen();
    await r.connected();
    r.fake.message("연결", { user: "U0EXT" });
    r.fake.message("연결", { user: "U0KIM", userTeam: "T0OTHERORG" });
    // users.info does not know this one (as when the lookup fails): its team is in doubt.
    r.fake.message("연결", { user: "U0LOST" });
    r.fake.message("연결");
    await until(() => r.events.length === 2);
    await new Promise((done) => setTimeout(done, 50));
    expect(r.events.map((event) => event.type === "message" && [event.from.userId, event.text])).toEqual([["U0LOST", "연결"], ["U0HONG", `/start ${value}`]]);
    // A press by someone of another organisation, in the app's own workspace's payload, is dropped too.
    r.fake.press("tok", { user: "U0EXT" });
    r.fake.message("이 워크스페이스");
    await until(() => r.events.length === 3);
    await new Promise((done) => setTimeout(done, 50));
    expect(r.events[2]).toMatchObject({ text: "이 워크스페이스" });
  });

  it("the pairing line is read with backticks, quotes or a full stop around it; a bare 연결 takes the open window's value", async () => {
    let window: { value: string } | null = null;
    const r = await rig({ pairing: () => window });
    r.listen();
    await r.connected();
    const value = "AbCdEfGhIjKlMnOpQrStUv";
    for (const line of [`\`연결 ${value}\``, `"연결 ${value}".`, `연결 \`${value}\`.`]) r.fake.message(line);
    // No window open: a bare 연결 stays a word (the core answers it as from a stranger).
    r.fake.message("연결");
    await until(() => r.events.length === 4);
    expect(r.events.map((event) => event.type === "message" && event.text)).toEqual([`/start ${value}`, `/start ${value}`, `/start ${value}`, "연결"]);
    window = { value };
    for (const line of ["연결", "연결하기.", "Connect"]) r.fake.message(line);
    await until(() => r.events.length === 7);
    expect(r.events.slice(4).map((event) => event.type === "message" && event.text)).toEqual([`/start ${value}`, `/start ${value}`, `/start ${value}`]);
    // Whoever sends it: the core, not the adapter, keeps one request and tells a second person to wait.
    r.fake.message("연결", { user: "U0KIM" });
    await until(() => r.events.length === 8);
    expect(r.events[7]).toMatchObject({ text: `/start ${value}`, from: { userId: "U0KIM" } });
    expect(r.adapter.pairingByWord).toBe(true);
    expect(JSON.stringify(r.store.channels.pending("slack", r.fake.botId))).not.toContain(value);
  });

  it("a press in a channel is a channel's (the core refuses it); a message in a channel likewise", async () => {
    const r = await rig();
    r.listen();
    await r.connected();
    r.fake.message("채널에서", { channel: "C0ROOM", channelType: "channel" });
    r.fake.press("tok", { channel: "C0ROOM" });
    await until(() => r.events.length === 2);
    expect(r.events.map((event) => event.chat.chatType)).toEqual(["channel", "channel"]);
  });

  it("a modal's submission goes to the slot (nothing yet), is acknowledged with its answer, and never becomes a message", async () => {
    const r = await rig();
    const seen: unknown[] = [];
    r.listen();
    await r.connected();
    r.adapter.onViewSubmission = async (payload) => { seen.push(payload); return { response_action: "clear" }; };
    const env = r.fake.submitView({ field: { value: { value: "비밀 값" } } });
    await until(() => r.fake.acked(env));
    expect(seen).toHaveLength(1);
    expect(r.events).toHaveLength(0);
    expect(JSON.stringify(r.store.channels.pending("slack", r.fake.botId))).not.toContain("비밀 값");
  });

  it("what came while no socket was open is read from the history after the next one, oldest first, once, and marked as waited", async () => {
    const r = await rig();
    r.fake.redeliverUnacked = false;
    r.listen();
    await r.connected();
    // Slack's times only grow within a conversation: the last one heard was 15 minutes ago.
    r.fake.message("처음", { ts: `${Math.floor(Date.now() / 1000) - 900}.000050` });
    await until(() => r.events.length === 1);
    await r.halt();
    await until(() => r.fake.open() === 0);
    const old = `${Math.floor(Date.now() / 1000) - 600}.000100`;
    r.fake.message("꺼져 있던 동안 1", { deliver: false, ts: old });
    r.fake.message("꺼져 있던 동안 2", { deliver: false });
    r.fake.messages.push({ ts: `${Math.floor(Date.now() / 1000)}.900000`, channel: "D0HONG", bot_id: r.fake.botId, text: "봇의 답" });
    r.restart();
    await until(() => r.events.length === 3);
    expect(r.events.slice(1).map((event) => event.type === "message" && event.text)).toEqual(["꺼져 있던 동안 1", "꺼져 있던 동안 2"]);
    expect(r.events[1]).toMatchObject({ backlog: 1 });
    expect(r.fake.of("conversations.history")[0]!.params).toMatchObject({ channel: "D0HONG", limit: "200" });
    // Reconnecting again reads only what is newer.
    r.fake.refresh();
    await until(() => r.fake.of("conversations.history").length === 2);
    await new Promise((done) => setTimeout(done, 50));
    expect(r.events).toHaveLength(3);
  });

  it("what the history fill does not run (over the cap, or older than a day) is told once, with the true counts", async () => {
    const r = await rig();
    r.fake.redeliverUnacked = false;
    r.listen();
    await r.connected();
    const now = Math.floor(Date.now() / 1000);
    r.fake.message("시작", { ts: `${now - 3 * 86_400}.000001` });
    await until(() => r.events.length === 1);
    await r.halt();
    // Two lines older than a day, then 205 recent ones: 200 run, 7 do not.
    r.fake.message("이틀 전 1", { deliver: false, ts: `${now - 2 * 86_400}.000002` });
    r.fake.message("이틀 전 2", { deliver: false, ts: `${now - 2 * 86_400}.000003` });
    for (let index = 0; index < 205; index += 1) r.fake.message(`밀린 ${index}`, { deliver: false, ts: `${now - 3600 + index}.${String(index + 10).padStart(6, "0")}` });
    r.restart();
    await until(() => r.events.length === 202, 6_000);
    const notice = r.events[1]!;
    expect(notice).toMatchObject({ type: "message", text: "", files: [], skipped: { count: 7, since: (now - 2 * 86_400) * 1000 } });
    const run = r.events.slice(2).map((event) => event.type === "message" && event.text);
    expect(run[0]).toBe("밀린 5");
    expect(run.at(-1)).toBe("밀린 204");
    expect(r.events[2]).toMatchObject({ backlog: 200 });
    expect(r.fake.of("conversations.history").every((call) => call.params.limit === "200")).toBe(true);
  });

  it("the history in pages; a refused page is left for the next connection", async () => {
    const r = await rig();
    r.fake.redeliverUnacked = false;
    r.listen();
    await r.connected();
    r.fake.message("시작");
    await until(() => r.events.length === 1);
    await r.halt();
    for (let index = 0; index < 20; index += 1) r.fake.message(`밀린 ${index}`, { deliver: false });
    r.fake.failAt("conversations.history", 1, { kind: "limit" });
    r.restart();
    await until(() => r.lines.some((line) => line.includes("history_failed")));
    expect(r.events).toHaveLength(1);
    r.fake.refresh();
    await until(() => r.events.length === 21);
    expect(r.events.slice(1).map((event) => event.type === "message" && event.text)).toEqual(Array.from({ length: 20 }, (_, index) => `밀린 ${index}`));
  });

  it("a failed history read keeps the conversation's mark (also across a restart): a live line after it never loses the missed one", async () => {
    const r = await rig();
    r.fake.redeliverUnacked = false;
    r.listen();
    await r.connected();
    r.fake.message("A");
    await until(() => r.events.length === 1);
    r.fake.cut();
    r.fake.message("B 끊긴 동안", { deliver: false });
    r.fake.failAt("conversations.history", 1, { kind: "limit" });
    await until(() => r.lines.some((line) => line.includes("history_failed")));
    await r.connected();
    const live = r.fake.message("C 다시 붙은 뒤");
    await until(() => r.fake.acked(live.envelopeId!) && r.events.length === 2);
    r.restart();
    await until(() => r.events.some((event) => event.type === "message" && event.text === "B 끊긴 동안"), 3_000);
    await new Promise((done) => setTimeout(done, 50));
    const texts = r.events.map((event) => event.type === "message" && event.text);
    // B runs once, after C (C was live first); C read again from the history has C's id, so the core takes it once.
    expect(texts.filter((text) => text === "B 끊긴 동안")).toHaveLength(1);
    expect(texts.slice(0, 3)).toEqual(["A", "C 다시 붙은 뒤", "B 끊긴 동안"]);
    expect(new Set(r.events.filter((event) => event.type === "message" && event.text.startsWith("C")).map((event) => event.eventId)).size).toBe(1);
    // Once filled, the mark is gone: the next connection reads only what is newer.
    // (The stand-in keeps only answered calls: the refused read is not among them.)
    r.fake.refresh();
    await until(() => r.fake.of("conversations.history").length === 2);
    await new Promise((done) => setTimeout(done, 50));
    expect(r.events.filter((event) => event.type === "message" && event.text === "B 끊긴 동안")).toHaveLength(1);
    expect(Number(r.fake.of("conversations.history")[1]!.params.oldest)).toBeGreaterThan(Number(r.fake.of("conversations.history")[0]!.params.oldest));
  });

  it("a failed history read is not forgotten when a later connection's read, begun after the gap, succeeds", async () => {
    let release!: () => void;
    const held = new Promise<void>((done) => { release = done; });
    let first = true;
    const r = await rig({ sink: async () => { if (first) { first = false; await held; } } });
    r.fake.redeliverUnacked = false;
    r.listen();
    await r.connected();
    r.fake.message("A 처리 중");
    await until(() => r.events.length === 1);
    r.fake.cut();
    r.fake.message("B 끊긴 동안", { deliver: false });
    await until(() => r.fake.of("apps.connections.open").length === 2 && r.fake.open() === 1);
    await r.connected();
    const live = r.fake.message("C 다시 붙은 뒤");
    await until(() => r.fake.acked(live.envelopeId!));
    // A second connection before the first one's history read has run: its own read starts at C, after the gap.
    r.fake.cut();
    await until(() => r.fake.of("apps.connections.open").length === 3 && r.fake.open() === 1);
    await r.connected();
    // The first connection's read (from A) is refused; the second's (from C) is answered.
    r.fake.failAt("conversations.history", 1, { kind: "limit" });
    release();
    await until(() => r.events.some((event) => event.type === "message" && event.text === "B 끊긴 동안"), 3_000);
    await new Promise((done) => setTimeout(done, 50));
    expect(r.events.filter((event) => event.type === "message" && event.text === "B 끊긴 동안")).toHaveLength(1);
  });

  it("a failed history read is tried again while the socket stays up (no wait for the next connection)", async () => {
    const r = await rig({ pingMs: 60 });
    r.fake.redeliverUnacked = false;
    r.listen();
    await r.connected();
    r.fake.message("A");
    await until(() => r.events.length === 1);
    r.fake.cut();
    r.fake.message("B 끊긴 동안", { deliver: false });
    r.fake.failAt("conversations.history", 1, { kind: "limit" });
    await until(() => r.lines.some((line) => line.includes("history_failed")));
    r.fake.message("C 다시 붙은 뒤");
    await until(() => r.events.some((event) => event.type === "message" && event.text === "B 끊긴 동안"), 3_000);
    expect(r.fake.of("apps.connections.open")).toHaveLength(2);
  });
});

describe("what goes out", () => {
  it("formatting marks (the core's hook, unit 14) are not Slack's: the text goes plain and whole, each link's address written after its words, in a send and in an edit", async () => {
    const r = await rig();
    const marks = [{ type: "bold" as const, offset: 0, length: 2 }, { type: "link" as const, offset: 3, length: 2, url: "https://lib.example.ac.kr/a?b=1&c=2" }, { type: "code" as const, offset: 6, length: 4 }];
    const sent = await r.adapter.send(dm(r), { text: "결과 자료 npm1 끝", marks });
    const call = r.fake.of("chat.postMessage")[0]!;
    expect(call.params.text).toBe("결과 자료 (https://lib.example.ac.kr/a?b=1&amp;c=2) npm1 끝");
    // Nothing of Telegram's formatting is in the request (entities, parse mode).
    expect(Object.keys(call.params).filter((key) => /entit|parse/.test(key))).toEqual([]);
    await r.adapter.edit(dm(r), sent.messageId, { text: "고침 자료", marks: [{ type: "link", offset: 3, length: 2, url: "https://lib.example.ac.kr/b" }] });
    expect(r.fake.of("chat.update")[0]!.params.text).toBe("고침 자료 (https://lib.example.ac.kr/b)");
  });

  it("escapes &, < and > (no mention, link or tag can be made), puts buttons in actions blocks bound to their message", async () => {
    const r = await rig();
    const sent = await r.adapter.send(dm(r), { text: "a < b & <!channel> <@U1>", buttons: [[{ label: "진행", token: "t1" }, { label: "x".repeat(90), token: "t2" }], [{ label: "메뉴", token: "t3" }]] });
    const call = r.fake.of("chat.postMessage")[0]!;
    expect(call.params.text).toBe("a &lt; b &amp; &lt;!channel&gt; &lt;@U1&gt;");
    const blocks = JSON.parse(String(call.params.blocks)) as { type: string; elements?: { action_id: string; value: string; text: { text: string } }[] }[];
    expect(blocks.map((block) => block.type)).toEqual(["section", "actions", "actions"]);
    const elements = blocks.flatMap((block) => block.elements ?? []);
    expect(elements.map((element) => element.value)).toEqual(["t1", "t2", "t3"]);
    expect(new Set(elements.map((element) => element.action_id)).size).toBe(3);
    expect(elements[1]!.text.text).toHaveLength(75);
    expect(sent.messageId).toBe(r.fake.messages.at(-1)!.ts);
    expect(call.params).toMatchObject({ unfurl_links: "false", unfurl_media: "false" });
  });

  it("long text in parts of at most 3,000 characters after escaping, buttons on the last; the buttons' message is the one returned", async () => {
    const r = await rig();
    const text = `${"<가>".repeat(1200)}\n\n${"끝 ".repeat(500)}`;
    const sent = await r.adapter.send(dm(r), { text, buttons: [[{ label: "더", token: "t" }]] });
    const calls = r.fake.of("chat.postMessage");
    expect(calls.length).toBeGreaterThan(1);
    for (const entry of calls) expect(String(entry.params.text).length).toBeLessThanOrEqual(3000);
    expect(calls.map((entry) => JSON.parse(String(entry.params.blocks)).length)).toEqual([...calls.slice(1).map(() => 1), 2]);
    expect(sent.messageId).toBe(r.fake.messages.at(-1)!.ts);
    expect(plainSlack(calls.map((entry) => String(entry.params.text)).join("")).replace(/\s+/g, "")).toBe(text.replace(/\s+/g, ""));
  });

  it("a 429 is waited out as Slack says; a long one goes back to the core with the wait", async () => {
    const r = await rig();
    r.fake.failAt("chat.postMessage", 1, { kind: "limit" });
    await r.adapter.send(dm(r), { text: "한 번" });
    expect(r.sleeps).toEqual([7_000]);
    expect(r.fake.of("chat.postMessage")).toHaveLength(1);
    r.fake.retryAfter = 120;
    r.fake.failAt("chat.postMessage", 1, { kind: "limit" });
    const error = await r.adapter.send(dm(r), { text: "두 번" }).catch((reason: unknown) => reason as ChannelSendError);
    expect(error).toMatchObject({ delivered: "no", code: "slack_429", retryAfterMs: 120_000 });
  });

  it("tells what certainly did not go from what may have: refused for good, refused for now, a server error, a cut after, no connection", async () => {
    const r = await rig();
    r.fake.failAt("chat.postMessage", 1, { kind: "refuse", error: "channel_not_found" });
    await expect(r.adapter.send(dm(r), { text: "a" })).rejects.toMatchObject({ delivered: "no", permanent: true, code: "slack_channel_not_found" });
    r.fake.failAt("chat.postMessage", 1, { kind: "refuse", error: "internal_error" });
    await expect(r.adapter.send(dm(r), { text: "b" })).rejects.toMatchObject({ delivered: "unknown" });
    r.fake.failAt("chat.postMessage", 1, { kind: "busy" });
    await expect(r.adapter.send(dm(r), { text: "c" })).rejects.toMatchObject({ delivered: "unknown" });
    r.fake.failAt("chat.postMessage", 1, { kind: "cut-after" });
    await expect(r.adapter.send(dm(r), { text: "d" })).rejects.toMatchObject({ delivered: "unknown" });
    const server: Server = createServer();
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((done) => server.close(() => done()));
    const offline = new SlackAdapter({ botId: "B", botUserId: "U", tokens: async () => ({ bot: FAKE_BOT_TOKEN, app: FAKE_APP_TOKEN }), baseUrl: `http://127.0.0.1:${port}/api`, journal: r.store.channels, log: new ChannelLog(new Redactor()) });
    await expect(offline.send(dm(r), { text: "e" })).rejects.toMatchObject({ delivered: "no", permanent: false, code: "not_connected" });
  });

  it("the second part failing: what went is not sent again (may have gone)", async () => {
    const r = await rig();
    r.fake.failAt("chat.postMessage", 2, { kind: "refuse", error: "msg_too_long" });
    await expect(r.adapter.send(dm(r), { text: `${"가".repeat(2900)}\n\n${"나".repeat(2900)}` })).rejects.toMatchObject({ delivered: "unknown" });
  });

  it("a chat closed while the message waited to leave gets nothing more", async () => {
    const r = await rig();
    let open = true;
    await expect(r.adapter.send(dm(r), { text: "x" }, { stillWanted: () => (open = false) })).rejects.toMatchObject({ code: "withdrawn", delivered: "no" });
    expect(open).toBe(false);
    expect(r.fake.of("chat.postMessage")).toHaveLength(0);
  });

  it("edits a message in place (buttons replaced), and leaves a shared file alone", async () => {
    const r = await rig();
    const { messageId } = await r.adapter.send(dm(r), { text: "메뉴", buttons: [[{ label: "가", token: "a" }]] });
    await r.adapter.edit(dm(r), messageId, { text: "바뀐 <화면>", buttons: [[{ label: "나", token: "b" }]] });
    expect(r.fake.shown(messageId)).toBe("바뀐 &lt;화면&gt;");
    expect(r.fake.labels(messageId)).toEqual(["나"]);
    await r.adapter.edit(dm(r), messageId, { text: "버튼 없음" });
    expect(r.fake.labels(messageId)).toEqual([]);
    const ids = (call: { params: Record<string, unknown> }) => (JSON.parse(String(call.params.blocks)) as { block_id?: string }[]).flatMap((block) => (block.block_id ? [block.block_id] : []));
    expect(ids(r.fake.of("chat.update")[0]!)).not.toEqual(ids(r.fake.of("chat.postMessage")[0]!));
    await r.adapter.edit(dm(r), "file:F1", { text: "x" });
    expect(r.fake.of("chat.update")).toHaveLength(2);
    await r.adapter.edit(dm(r), messageId, { text: "&".repeat(4000) });
    expect(String(r.fake.of("chat.update").at(-1)!.params.text).length).toBeLessThanOrEqual(3000);
  });

  it("a note on a press goes to the presser only; no note, no call", async () => {
    const r = await rig();
    await r.adapter.ackButton("D0HONG U0HONG");
    await r.adapter.ackButton("D0HONG U0HONG", "이미 처리됨");
    expect(r.fake.ephemeral).toEqual([{ channel: "D0HONG", user: "U0HONG", text: "이미 처리됨" }]);
  });

  it("removes its own message; a person's message stays (false)", async () => {
    const r = await rig();
    const { messageId } = await r.adapter.send(dm(r), { text: "지울 것" });
    expect(await r.adapter.remove(dm(r), messageId)).toBe(true);
    const person = r.fake.message("사람의 글", { deliver: false });
    expect(await r.adapter.remove(dm(r), person.ts)).toBe(false);
  });
});

describe("files", () => {
  it("uploads the current way: an upload address, the bytes there without a token, then shared to the conversation", async () => {
    const r = await rig();
    const path = join(r.dir, "결과.md");
    writeFileSync(path, "# 결과");
    await r.adapter.send(dm(r), { text: "답", files: [{ path, name: "결과.md", mime: "text/markdown", caption: "전체 <답>" }] });
    expect(r.fake.of("files.getUploadURLExternal")[0]!.params).toMatchObject({ filename: "결과.md", length: String(Buffer.byteLength("# 결과")) });
    expect(r.fake.of("upload")[0]!.params).toMatchObject({ authorization: false });
    expect(r.fake.shared).toEqual([{ id: expect.any(String), name: "결과.md", title: "결과.md", channel: "D0HONG", comment: "전체 &lt;답&gt;", bytes: Buffer.byteLength("# 결과") }]);
  });

  it("an upload failing at the n-th step after the text went: the message is delivered and the file named; before anything went: the send fails", async () => {
    const r = await rig();
    const path = join(r.dir, "a.txt");
    writeFileSync(path, "a");
    const file = { path, name: "a.txt", mime: "text/plain" };
    r.fake.failAt("upload", 1, { kind: "busy" });
    expect(await r.adapter.send(dm(r), { text: "답", files: [file, { ...file, name: "b.txt" }] })).toMatchObject({ unsent: [{ name: "a.txt", delivered: "no" }] });
    expect(r.fake.shared.map((entry) => entry.name)).toEqual(["b.txt"]);
    r.fake.failAt("files.completeUploadExternal", 1, { kind: "cut-after" });
    expect(await r.adapter.send(dm(r), { text: "답", files: [file] })).toMatchObject({ unsent: [{ name: "a.txt", delivered: "unknown" }] });
    r.fake.failAt("files.getUploadURLExternal", 1, { kind: "refuse", error: "invalid_arguments" });
    await expect(r.adapter.send(dm(r), { text: "", files: [file] })).rejects.toMatchObject({ delivered: "no" });
  });

  it("fetches a received file with the bot token from Slack's file host only, within the size limit", async () => {
    const r = await rig();
    const ref = r.fake.file("표.xlsx", Buffer.from("PK\u0003\u0004 xlsx"));
    const to = join(r.dir, "in");
    await r.adapter.download({ fileRef: String(ref.id), name: "표.xlsx", mime: "application/octet-stream", size: 10, kind: "file" }, to);
    expect(readFileSync(to, "utf8")).toBe("PK\u0003\u0004 xlsx");
    expect(r.fake.of("download")[0]).toMatchObject({ token: "bot" });
    // A file address on another host gets no request (and so no token).
    let elsewhere = 0;
    const other = createServer((_req, res) => { elsewhere += 1; res.end("x"); });
    await new Promise<void>((done) => other.listen(0, "127.0.0.1", done));
    const foreign = r.fake.file("밖.txt", Buffer.from("x"), { url: `http://127.0.0.1:${(other.address() as AddressInfo).port}/f` });
    await expect(r.adapter.download({ fileRef: String(foreign.id), name: "밖.txt", mime: "text/plain", size: 1, kind: "file" }, to)).rejects.toMatchObject({ code: "file_unavailable" });
    expect(elsewhere).toBe(0);
    await new Promise<void>((done) => other.close(() => done()));
    // A remote file: its address is the other app's, and no token goes to it.
    const remote = r.fake.file("밖의 문서", Buffer.from("x"), { external: true });
    const downloads = r.fake.of("download").length;
    await expect(r.adapter.download({ fileRef: String(remote.id), name: "밖의 문서", mime: "text/plain", size: 1, kind: "file" }, to)).rejects.toMatchObject({ code: "file_external" });
    expect(r.fake.of("download").length).toBe(downloads);
    const big = r.fake.file("큰.bin", Buffer.from("x"), { reported: 26 * 1024 * 1024 });
    await expect(r.adapter.download({ fileRef: String(big.id), name: "큰.bin", mime: "x", size: 1, kind: "file" }, to)).rejects.toMatchObject({ code: "too_large" });
    secretFree(r);
  });
});

describe("text helpers", () => {
  it("escapes and unescapes", () => {
    expect(escapeSlack("<&>")).toBe("&lt;&amp;&gt;");
    expect(plainSlack("&lt;b&gt; &amp; <mailto:a@b.c|a@b.c>")).toBe("<b> & mailto:a@b.c");
  });

  it("never makes a part longer than the limit, also when escaping grows it", () => {
    for (const part of slackParts("&".repeat(10_000), 3000)) expect(part.length).toBeLessThanOrEqual(3000);
    expect(slackParts("&".repeat(10_000), 3000).join("")).toBe("&amp;".repeat(10_000));
  });
});
