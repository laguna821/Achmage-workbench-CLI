import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchPage } from "@workbench/contracts";
import { cleanKits, openKit, pair, press, restartKit, say, sessionOf, settle, startKit, type Kit } from "./test-kit.ts";

// Re-review 1 of units 5–6, fix round 2: a chat's schedules at boot and during a pause, the
// one-line input's refusals, the schedule list, and the words that must be true.

afterEach(() => { vi.restoreAllMocks(); cleanKits(); });

async function menu(kit: Kit) {
  await settle(kit);
  const before = kit.adapter.sent.length;
  await say(kit, "메뉴");
  return kit.adapter.sent.slice(before).find((entry) => entry.out.text.startsWith("메뉴 · 지금:"))!.messageId;
}

async function chatSchedule(kit: Kit, text = "매일 아침 요약") {
  await say(kit, "첫 일");
  kit.engine.finish(kit.engine.sent[0]!.sessionId);
  await menu(kit);
  await press(kit, "예약");
  await press(kit, "매일 09:00");
  await say(kit, text);
  return kit.manager.schedules.all().find((entry) => entry.text === text)!;
}

const ran = (kit: Pick<Kit, "engine">, text: string) => kit.engine.sent.filter((turn) => turn.text.includes(text));
const live = (kit: Pick<Kit, "manager">, id: string) => kit.manager.schedules.all().find((entry) => entry.id === id)!;

describe("an open chat's schedule that came due while the PC was off (R1)", () => {
  it("is deferred until the channel has started, then runs once and its answer comes to the chat", async () => {
    const kit = await startKit();
    await pair(kit);
    const schedule = await chatSchedule(kit, "회의 자료 정리");
    // "내일 08:00", and the PC is turned on at 08:20.
    const at = Date.now() - 20 * 60_000;
    const stored = JSON.parse(kit.store.getMeta("schedules")!) as { id: string }[];
    kit.store.setMeta("schedules", JSON.stringify(stored.map((entry) => (entry.id === schedule.id ? { ...entry, when: { kind: "once", at }, nextAt: at } : entry))));
    await kit.core.close();
    await kit.manager.shutdown();
    kit.store.close();
    const again = openKit(kit.dir, kit.clock);
    await again.manager.schedules.tick();
    expect(ran(again, "회의 자료 정리")).toEqual([]);
    expect(again.manager.schedules.journal.list(schedule.id)).toEqual([]);
    expect(live(again, schedule.id)).toMatchObject({ enabled: true, nextAt: at });
    // The channel starts: its start ends with a tick.
    await again.core.start();
    await settle(again);
    expect(ran(again, "회의 자료 정리")).toHaveLength(1);
    const { sessionId } = again.engine.sent.at(-1)!;
    again.engine.say(sessionId, "회의 자료를 정리했습니다.");
    again.engine.finish(sessionId);
    await settle(again);
    expect(again.adapter.texts()).toContain("회의 자료를 정리했습니다.");
    await again.manager.schedules.tick();
    expect(ran(again, "회의 자료 정리")).toHaveLength(1);
    await again.core.close();
    await again.manager.shutdown();
    again.store.close();
  });
});

describe("a pause (R2)", () => {
  it("does not turn the chat's schedules off; what came due meanwhile is named at resume with 지금 실행, once", async () => {
    const kit = await startKit();
    const binding = await pair(kit);
    const schedule = await chatSchedule(kit);
    kit.core.pause(binding.id, true);
    expect(live(kit, schedule.id).enabled).toBe(true);
    live(kit, schedule.id).nextAt = Date.now() - 60_000;
    await kit.manager.schedules.tick();
    await settle(kit);
    expect(ran(kit, "매일 아침 요약")).toEqual([]);
    // A daily schedule simply goes on from its next time.
    expect(live(kit, schedule.id)).toMatchObject({ enabled: true });
    expect(live(kit, schedule.id).nextAt!).toBeGreaterThan(Date.now());
    kit.core.pause(binding.id, false);
    await settle(kit);
    const told = kit.adapter.last()!;
    expect(told.out.text).toBe("멈춰 둔 동안 예약 1개가 실행되지 않았습니다.\n1. 매일 09:00 「휴대폰 · 11/12」: 매일 아침 요약");
    expect(told.out.buttons!.flat().map((button) => button.label)).toEqual(["1 지금 실행"]);
    await press(kit, "1 지금 실행");
    expect(ran(kit, "매일 아침 요약")).toHaveLength(1);
    await kit.adapter.deliver(kit.adapter.press(told.out.buttons![0]![0]!.token, { messageId: told.messageId }));
    await settle(kit);
    expect(ran(kit, "매일 아침 요약")).toHaveLength(1);
  });

  it("offers one 지금 실행 per skipped schedule: pressing one leaves the other", async () => {
    const kit = await startKit();
    const binding = await pair(kit);
    const first = await chatSchedule(kit, "첫째 예약");
    const second = kit.manager.schedules.create({ sessionId: first.sessionId, text: "둘째 예약", when: { kind: "daily", time: "10:00" } }, { channel: "telegram", bindingId: binding.id });
    kit.core.pause(binding.id, true);
    for (const id of [first.id, second.id]) live(kit, id).nextAt = Date.now() - 60_000;
    await kit.manager.schedules.tick();
    kit.core.pause(binding.id, false);
    await settle(kit);
    await press(kit, "1 지금 실행");
    kit.engine.finish(kit.engine.sent.at(-1)!.sessionId);
    await settle(kit);
    await press(kit, "2 지금 실행");
    expect(ran(kit, "첫째 예약")).toHaveLength(1);
    expect(ran(kit, "둘째 예약")).toHaveLength(1);
  });
});

describe("the one-line input refuses what does not fit (R3)", () => {
  const empty = (): SearchPage => ({ query: "", sessions: [], documents: [], tookMs: 1, scope: "all", total: 0, groupsTotal: 0, counts: { all: 0, project: 0, session: 0, document: 0, decision: 0, vault: 0 }, offset: 0, limit: 4, group: null, terms: [], groups: [] });

  it("refuses an over-long or multi-line project name or search, keeps the input open, and sends nothing to the AI", async () => {
    const asked: string[] = [];
    const kit = await startKit({ search: async (query) => { asked.push(query); return empty(); } });
    await pair(kit);
    await menu(kit);
    await press(kit, "프로젝트 바꾸기");
    await press(kit, "새 프로젝트");
    await say(kit, "가".repeat(412));
    expect(kit.adapter.texts().at(-1)).toBe("프로젝트 이름은 한 줄로 80자까지입니다(지금 412자). 만들지 않았습니다. 짧게 다시 보내거나 [취소]를 누르세요.");
    await say(kit, "첫 줄\n둘째 줄");
    expect(kit.engine.sent).toEqual([]);
    await say(kit, "가을 특강");
    expect(kit.manager.snapshot().works.some((work) => work.title === "가을 특강")).toBe(true);
    await menu(kit);
    await press(kit, "찾기");
    await say(kit, "나".repeat(201));
    expect(kit.adapter.texts().at(-1)).toBe("찾을 말은 한 줄로 200자까지입니다(지금 201자). 찾지 않았습니다. 짧게 다시 보내거나 [취소]를 누르세요.");
    await say(kit, "연구윤리");
    expect(asked).toEqual(["연구윤리"]);
    expect(kit.engine.sent).toEqual([]);
  });
});

describe("the small ones", () => {
  it("lists the chat's schedules with their state, and turns one back on after the offer has expired", async () => {
    const kit = await startKit();
    const binding = await pair(kit);
    const schedule = await chatSchedule(kit);
    const once = kit.manager.schedules.create({ sessionId: schedule.sessionId, text: "한 번만", when: { kind: "daily", time: "10:00" } }, { channel: "telegram", bindingId: binding.id });
    Object.assign(live(kit, once.id), { enabled: false, nextAt: null });
    await say(kit, "잠금");
    kit.core.unlock(binding.id);
    await settle(kit);
    kit.clock.now += 25 * 60 * 60_000;
    const id = await menu(kit);
    await press(kit, "예약");
    await press(kit, "예약 목록");
    expect(kit.adapter.shown(id)!.text).toBe("예약 2개\n1. 매일 09:00 「휴대폰 · 11/12」: 매일 아침 요약 · 잠금으로 꺼짐\n2. 매일 10:00 「휴대폰 · 11/12」: 한 번만 · 끝남");
    expect(kit.adapter.labelsOf(id)).toEqual(["1 켜기", "예약하기", "← 메뉴"]);
    await press(kit, "1 켜기");
    expect(live(kit, schedule.id).enabled).toBe(true);
  });

  it("refuses at the PC to turn on a schedule of a locked chat, saying why, and marks why it is off", async () => {
    const kit = await startKit();
    const binding = await pair(kit);
    const schedule = await chatSchedule(kit);
    await say(kit, "잠금");
    expect(live(kit, schedule.id)).toMatchObject({ enabled: false, offReason: "locked" });
    expect(() => kit.manager.schedules.update(schedule.id, { enabled: true })).toThrow("이 휴대폰 채팅이 잠겨 있어 켤 수 없습니다. 잠금을 푼 뒤 켜 주세요.");
    kit.core.unlock(binding.id);
    expect(kit.manager.schedules.update(schedule.id, { enabled: true })).toMatchObject({ enabled: true });
    expect(live(kit, schedule.id).offReason).toBeUndefined();
  });

  it("tells the chat after a restart that a line being acted on was not done", async () => {
    let hang: Promise<SearchPage> = new Promise(() => undefined);
    let kit = await startKit({ search: async () => hang });
    await pair(kit);
    await menu(kit);
    await press(kit, "찾기");
    void kit.adapter.deliver(kit.adapter.message("연구윤리"));
    await new Promise((done) => setTimeout(done, 30));
    hang = Promise.resolve({} as SearchPage);
    kit = await restartKit(kit);
    await settle(kit);
    expect(kit.adapter.texts().at(-1)).toBe("앞의 입력을 처리하는 중에 PC가 멈췄습니다. 처리되지 않았을 수 있으니, 결과가 없으면 다시 보내 주세요.");
    expect(kit.engine.sent).toEqual([]);
  });

  it("says a Codex conversation leaving full access mid-turn applies from the next request", async () => {
    const kit = await startKit({ codex: true });
    const binding = await pair(kit);
    const work = kit.manager.createWork({ title: "연구" });
    const codex = kit.manager.createSession(work.id, { provider: "codex", purpose: "코덱스 대화", access: "full" });
    kit.core.setPointer(binding.id, codex.id);
    await say(kit, "오래 걸리는 일");
    const id = await menu(kit);
    await press(kit, "엔진·모델");
    await press(kit, "묻기 · 매번 확인");
    expect(kit.adapter.shown(id)!.text).toMatch(/^바꿨습니다\. 다음 요청부터 적용합니다\(지금 하던 일은 그대로\)\./);
    expect(sessionOf(kit, codex.id).access).toBe("ask");
  });

  it("mentions an expired input only when the next line comes within an hour; later the line just goes on", async () => {
    const kit = await startKit({ search: async () => ({}) as SearchPage });
    await pair(kit);
    await menu(kit);
    await press(kit, "찾기");
    kit.clock.now += 3 * 60_000 + 2 * 60 * 60_000;
    const before = kit.adapter.sent.length;
    await say(kit, "한참 뒤의 요청");
    expect(kit.adapter.sent.slice(before).some((entry) => entry.out.text.includes("시간이 지나 닫혔습니다"))).toBe(false);
    expect(kit.engine.sent.at(-1)!.text).toContain("한참 뒤의 요청");
  });
});

describe("fix round 3 (unit 5)", () => {
  it("names what a pause skipped also when the chat is locked meanwhile and then unlocked", async () => {
    const kit = await startKit();
    const binding = await pair(kit);
    const schedule = await chatSchedule(kit);
    kit.core.pause(binding.id, true);
    live(kit, schedule.id).nextAt = Date.now() - 60_000;
    await kit.manager.schedules.tick();
    kit.core.lock(binding.id);
    await settle(kit);
    // Resumed while still locked: nothing may go to a locked chat yet.
    kit.core.pause(binding.id, false);
    await settle(kit);
    const told = (kit: Kit) => kit.adapter.texts().filter((text) => text.startsWith("멈춰 둔 동안 예약 1개가 실행되지 않았습니다."));
    expect(told(kit)).toHaveLength(0);
    kit.core.unlock(binding.id);
    await settle(kit);
    expect(told(kit)).toHaveLength(1);
    // Named once: a second pause and resume has nothing left to name.
    kit.core.pause(binding.id, true);
    kit.core.pause(binding.id, false);
    await settle(kit);
    expect(told(kit)).toHaveLength(1);
  });

  it("names at most eight skipped schedules, and says where the rest are", async () => {
    const kit = await startKit();
    const binding = await pair(kit);
    const first = await chatSchedule(kit, "예약 0");
    for (let index = 1; index < 11; index += 1) kit.manager.schedules.create({ sessionId: first.sessionId, text: `예약 ${index}`, when: { kind: "daily", time: "10:00" } }, { channel: "telegram", bindingId: binding.id });
    kit.core.pause(binding.id, true);
    for (const schedule of kit.manager.schedules.all()) schedule.nextAt = Date.now() - 60_000;
    await kit.manager.schedules.tick();
    kit.core.pause(binding.id, false);
    await settle(kit);
    const told = kit.adapter.last()!;
    expect(told.out.text.split("\n")[0]).toBe("멈춰 둔 동안 예약 11개가 실행되지 않았습니다.");
    expect(told.out.text.split("\n").at(-1)).toBe("그 밖 3개는 메뉴의 [예약] → [예약 목록]에서 볼 수 있습니다.");
    expect(told.out.buttons!.flat()).toHaveLength(8);
  });
});
