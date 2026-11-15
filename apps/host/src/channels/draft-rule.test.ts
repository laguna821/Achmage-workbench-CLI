import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventBus } from "../bus.ts";
import { formsOf } from "../credentials/forms.ts";
import { installScrubber } from "../credentials/install.ts";
import { CredentialService } from "../credentials/service.ts";
import { OfficeVault } from "../office-vault.ts";
import { SessionManager } from "../sessions.ts";
import { Store } from "../store.ts";
import { FAKE_TOKEN, FakeTelegram } from "./fake-telegram.ts";
import { ChannelService } from "./service.ts";
import { StandInEngine, until } from "./test-kit.ts";

// Ruling R6 (c), fix round 3: a draft typed at the PC (a waiting request, a schedule's text) is the
// person's own and stays as typed on their own surfaces; whatever leaves the PC for a third party
// (the messenger's lines, its log, the audit trail) never carries a stored value, at any time.
// The messenger of units 7-8 lists no draft text (its 상태 says how many wait); every line it sends
// passes the redactor. Made-up values only.
const VALUE = "zz-secret-draft-0041";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

describe("R6 (c): drafts toward the messenger, the log and the audit trail", () => {
  it("a draft with a stored value is raw at the PC and never in anything the chat, the log or the audit gets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-draft-rule-"));
    const dataDir = join(dir, "data");
    mkdirSync(dataDir, { recursive: true });
    const fake = new FakeTelegram();
    await fake.start();
    const store = new Store(join(dataDir, "state.sqlite"));
    const bus = new EventBus();
    const manager = new SessionManager(store, bus, { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dataDir, "works"), dataDir });
    const engine = new StandInEngine(() => manager.sink);
    manager.registerAdapter(engine);
    const vault = new OfficeVault(dataDir, async () => ({ id: "d".repeat(32), key: Buffer.alloc(32, 5) }));
    const credentials = new CredentialService({ dataDir, vault, manager });
    installScrubber(store, manager, credentials.scrubber);
    const lines: string[] = [];
    const channels = new ChannelService({ dataDir, store, manager, bus, vault, credentials, telegramUrl: fake.url, telegram: { pollSeconds: 1, minSendGapMs: 0 }, log: (line) => lines.push(line) });
    await channels.start();
    cleanups.push(async () => { await channels.close(); credentials.close(); await manager.shutdown(); store.close(); await fake.stop(); rmSync(dir, { recursive: true, force: true }); });
    await channels.registerTelegram(FAKE_TOKEN, { memoryOnly: true });
    const { code } = channels.core.beginPairing("telegram", fake.botId);
    fake.message(`/start ${code}`);
    await until(() => Boolean(channels.core.pairing("telegram", fake.botId).request));
    await channels.core.approvePairing("telegram", fake.botId, channels.core.pairing("telegram", fake.botId).request!.id);
    fake.message("도서관 대출 목록 정리해 줘");
    await until(() => engine.sent.length === 1);
    const sessionId = channels.core.bindings()[0]!.pointerSessionId!;
    await credentials.add({ name: "포털", kind: "other", site: "", values: { 값: VALUE } });
    // At the PC: a request typed while the chat's request runs, and a schedule.
    const typed = `다음엔 ${VALUE} 로 로그인`;
    // As the PC's composer and schedule form make them (marked as the person's own).
    await manager.send(sessionId, "pc1", typed, [], null, null, "queue", { draft: true });
    manager.schedules.create({ sessionId, text: `내일 ${VALUE} 로 확인`, when: { kind: "once", at: Date.now() + 3_600_000 }, draft: true });
    expect(manager.snapshot().sessions.find((session) => session.id === sessionId)!.queued.map((entry) => entry.text)).toEqual([typed]);
    expect(manager.snapshot().schedules![0]!.text).toBe(`내일 ${VALUE} 로 확인`);
    // The chat asks for the state: it hears how many wait, never what.
    fake.message("상태");
    await until(() => fake.texts().some((text) => text.includes("기다리는 요청 1개")));
    // The draft is sent, answered with the value in it, and the answer goes to the chat.
    engine.say(sessionId, "목록입니다");
    engine.finish(sessionId);
    await until(() => engine.sent.some((entry) => entry.text === typed));
    engine.say(sessionId, `로그인했습니다: ${VALUE}`);
    engine.finish(sessionId);
    fake.message("결과 알려 줘");
    await until(() => engine.sent.some((entry) => entry.text.includes("결과 알려 줘")));
    engine.say(sessionId, `결과: ${VALUE} 로 로그인했습니다`);
    engine.finish(sessionId);
    await until(() => fake.texts().some((text) => text.includes("결과:")));
    fake.message("상태");
    await until(() => fake.texts().filter((text) => text.startsWith("지금:")).length === 2);
    const leaks = (text: string) => formsOf(VALUE).filter((form) => text.includes(form));
    expect(leaks(JSON.stringify(fake.calls.filter((call) => call.method !== "getUpdates"))), "the messenger").toEqual([]);
    expect(leaks(lines.join("\n")), "the log").toEqual([]);
    expect(leaks(JSON.stringify(channels.core.auditList({}))), "the audit").toEqual([]);
    // Not vacuous: the answer with the value did go to the chat, hidden.
    expect(fake.texts().some((text) => text.includes("결과: [비밀: 포털] 로 로그인했습니다"))).toBe(true);
  });
});

describe("R6 (c), the menu's lists (merge with units 5-6): a value across the cut is hidden before the cut", () => {
  it("[상태·대기열] and [예약 목록] list a draft whose stored value sits across the cut with the placeholder and no part of it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-draft-cut-"));
    const dataDir = join(dir, "data");
    mkdirSync(dataDir, { recursive: true });
    const fake = new FakeTelegram();
    await fake.start();
    const store = new Store(join(dataDir, "state.sqlite"));
    const bus = new EventBus();
    const manager = new SessionManager(store, bus, { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dataDir, "works"), dataDir });
    const engine = new StandInEngine(() => manager.sink);
    manager.registerAdapter(engine);
    const vault = new OfficeVault(dataDir, async () => ({ id: "d".repeat(32), key: Buffer.alloc(32, 5) }));
    const credentials = new CredentialService({ dataDir, vault, manager });
    installScrubber(store, manager, credentials.scrubber);
    const lines: string[] = [];
    const channels = new ChannelService({ dataDir, store, manager, bus, vault, credentials, telegramUrl: fake.url, telegram: { pollSeconds: 1, minSendGapMs: 0 }, log: (line) => lines.push(line) });
    await channels.start();
    cleanups.push(async () => { await channels.close(); credentials.close(); await manager.shutdown(); store.close(); await fake.stop(); rmSync(dir, { recursive: true, force: true }); });
    await channels.registerTelegram(FAKE_TOKEN, { memoryOnly: true });
    const { code } = channels.core.beginPairing("telegram", fake.botId);
    fake.message(`/start ${code}`);
    await until(() => Boolean(channels.core.pairing("telegram", fake.botId).request));
    await channels.core.approvePairing("telegram", fake.botId, channels.core.pairing("telegram", fake.botId).request!.id);
    fake.message("도서관 대출 목록 정리해 줘");
    await until(() => engine.sent.length === 1);
    const sessionId = channels.core.bindings()[0]!.pointerSessionId!;
    await credentials.add({ name: "포털", kind: "other", site: "", values: { 값: VALUE } });
    // The queue list cuts at 60 characters and the schedule list at 40: the value starts before each cut and ends after it.
    await manager.send(sessionId, "pc1", `${"가".repeat(50)}${VALUE} 로 로그인`, [], null, null, "queue", { draft: true });
    manager.schedules.create({ sessionId, text: `${"나".repeat(30)}${VALUE} 로 확인`, when: { kind: "once", at: Date.now() + 3_600_000 }, draft: true });
    const pieces = (text: string) => [...Array(VALUE.length - 5).keys()].map((at) => VALUE.slice(at, at + 6)).filter((piece) => text.includes(piece));
    fake.message("메뉴");
    await until(() => fake.texts().some((text) => text.startsWith("메뉴 · 지금:")));
    const status = fake.button("상태·대기열");
    fake.press(status.data, { messageId: status.messageId });
    await until(() => (fake.shown(status.messageId) ?? "").includes("1. "));
    const queueList = fake.shown(status.messageId)!;
    expect(queueList).toContain("[비밀: 포털]");
    expect(pieces(queueList)).toEqual([]);
    fake.message("메뉴");
    await until(() => fake.texts().filter((text) => text.startsWith("메뉴 · 지금:")).length === 2);
    const schedule = fake.button("예약");
    fake.press(schedule.data, { messageId: schedule.messageId });
    await until(() => { try { return Boolean(fake.button("예약 목록")); } catch { return false; } });
    const list = fake.button("예약 목록");
    fake.press(list.data, { messageId: list.messageId });
    await until(() => (fake.shown(list.messageId) ?? "").startsWith("예약 1개"));
    const scheduleList = fake.shown(list.messageId)!;
    expect(scheduleList).toContain("[비밀: 포털]");
    expect(pieces(scheduleList)).toEqual([]);
    expect(pieces(JSON.stringify(fake.calls.filter((call) => call.method !== "getUpdates")))).toEqual([]);
    // The PC still has both as typed.
    expect(manager.snapshot().sessions.find((session) => session.id === sessionId)!.queued[0]!.text).toContain(VALUE);
  });
});

