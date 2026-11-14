import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchPage } from "@workbench/contracts";
import { parseWhen } from "./menu.ts";
import { cleanKits, openKit, pair, press, restartKit, say, sessionOf, settle, startKit, type Kit } from "./test-kit.ts";

// Review of units 5–6, fix round 1: the gates a chat's schedules and its one-line input pass, and
// the words the menu uses for access modes.

afterEach(() => { vi.restoreAllMocks(); cleanKits(); });

const BOT = "7000000001";
const shownText = (kit: Kit, id: string) => kit.adapter.shown(id)!.text;

async function menu(kit: Kit) {
  await settle(kit);
  const before = kit.adapter.sent.length;
  await say(kit, "메뉴");
  return kit.adapter.sent.slice(before).find((entry) => entry.out.text.startsWith("메뉴 · 지금:"))!.messageId;
}

/** A daily schedule made from the chat in its conversation. */
async function chatSchedule(kit: Kit, text = "매일 아침 요약") {
  await say(kit, "첫 일");
  kit.engine.finish(kit.engine.sent[0]!.sessionId);
  await menu(kit);
  await press(kit, "예약");
  await press(kit, "매일 09:00");
  await say(kit, text);
  const schedule = kit.manager.schedules.all().find((entry) => entry.text === text)!;
  expect(schedule.origin).toBeTruthy();
  return schedule;
}

/** Make a schedule due now and let the schedules tick, as at boot. */
async function due(kit: Pick<Kit, "manager">, id: string, enabled = true) {
  const schedule = kit.manager.schedules.all().find((entry) => entry.id === id)!;
  schedule.enabled = enabled;
  schedule.nextAt = Date.now() - 60_000;
  await kit.manager.schedules.tick();
}

const ran = (kit: Pick<Kit, "engine">, text: string) => kit.engine.sent.filter((turn) => turn.text.includes(text));

describe("a chat's schedules (C1)", () => {
  it("does not run, at boot before the channel starts, an overdue schedule of a chat that was locked", async () => {
    const kit = await startKit();
    const binding = await pair(kit);
    const schedule = await chatSchedule(kit);
    kit.core.lock(binding.id);
    await settle(kit);
    await kit.core.close();
    await kit.manager.shutdown();
    kit.store.close();
    // The gateway opens again: the schedules tick before the channel starts.
    const again = openKit(kit.dir, kit.clock);
    await due(again, schedule.id);
    expect(ran(again, "매일 아침 요약")).toEqual([]);
    expect(again.manager.schedules.journal.list(schedule.id).at(-1)).toMatchObject({ status: "rejected" });
    await again.core.close();
    await again.manager.shutdown();
    again.store.close();
  });

  it("does not run, at boot before the channel starts, an overdue schedule of a chat that is open (its answer would have nowhere to go)", async () => {
    const kit = await startKit();
    await pair(kit);
    const schedule = await chatSchedule(kit);
    await kit.core.close();
    await due(kit, schedule.id);
    expect(ran(kit, "매일 아침 요약")).toEqual([]);
  });

  it("does not run a chat's schedule after the bot was removed (its chats disconnected, the channel closed)", async () => {
    const kit = await startKit();
    const binding = await pair(kit);
    const schedule = await chatSchedule(kit);
    kit.core.revoke(binding.id);
    await kit.core.close();
    await due(kit, schedule.id);
    expect(ran(kit, "매일 아침 요약")).toEqual([]);
  });

  it("refuses a chat's schedule when no channel gate is there at all (fails closed)", async () => {
    const kit = await startKit();
    await pair(kit);
    const schedule = await chatSchedule(kit);
    kit.manager.channelGate = null;
    await due(kit, schedule.id);
    expect(ran(kit, "매일 아침 요약")).toEqual([]);
  });

  it("still runs an ordinary desktop schedule with no bot registered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-channel-inert-"));
    const kit = openKit(dir, { now: Date.now() });
    const work = kit.manager.createWork({ title: "연구" });
    const session = kit.manager.createSession(work.id, { provider: "claude" });
    const schedule = kit.manager.schedules.create({ sessionId: session.id, text: "PC 예약", when: { kind: "daily", time: "09:00" } });
    await due(kit, schedule.id);
    expect(ran(kit, "PC 예약")).toHaveLength(1);
    await kit.manager.shutdown();
    kit.store.close();
  });

  it("stores the chat's schedules off when it is locked, says so, and turns them on again only when the person asks after the unlock", async () => {
    const kit = await startKit();
    const binding = await pair(kit);
    const schedule = await chatSchedule(kit);
    await say(kit, "잠금");
    expect(kit.manager.schedules.all().find((entry) => entry.id === schedule.id)!.enabled).toBe(false);
    expect(kit.adapter.texts().at(-1)).toBe("채널을 잠갔습니다. 이 채팅에서 만든 예약 1개도 껐습니다. 푸는 것은 PC에서만 할 수 있습니다.");
    kit.core.unlock(binding.id);
    await settle(kit);
    // Not on by itself.
    expect(kit.manager.schedules.all().find((entry) => entry.id === schedule.id)!.enabled).toBe(false);
    expect(kit.adapter.last()!.out.text).toBe("잠근 동안 이 채팅에서 만든 예약 1개를 꺼 두었습니다. 다시 켜려면 누르세요.");
    await press(kit, "예약 다시 켜기");
    expect(kit.manager.schedules.all().find((entry) => entry.id === schedule.id)!.enabled).toBe(true);
  });

  it("stores them off on a disconnect (a pause does not: see menu-round2)", async () => {
    const kit = await startKit();
    const binding = await pair(kit);
    const schedule = await chatSchedule(kit);
    kit.core.revoke(binding.id);
    expect(kit.manager.schedules.all().find((entry) => entry.id === schedule.id)).toMatchObject({ enabled: false, offReason: "disconnected" });
    expect(kit.core.auditList().some((row) => row.action === "schedule.disabled" && row.result === "1")).toBe(true);
  });
});

describe("a chat paired again", () => {
  it("is told that the schedules of its earlier connection stay off", async () => {
    const kit = await startKit();
    const binding = await pair(kit);
    await chatSchedule(kit);
    kit.core.revoke(binding.id);
    await pair(kit);
    expect(kit.adapter.texts().at(-1)).toBe("이전 연결에서 만든 예약 1개는 꺼진 채로 두었습니다. 필요하면 메뉴의 [예약]에서 새로 만들어 주세요.");
  });
});

describe("the one-line input (I1)", () => {
  const empty = (): SearchPage => ({ query: "", sessions: [], documents: [], tookMs: 1, scope: "all", total: 0, groupsTotal: 0, counts: { all: 0, project: 0, session: 0, document: 0, decision: 0, vault: 0 }, offset: 0, limit: 4, group: null, terms: [], groups: [] });

  it.each([["멈춰"], ["상태"], ["새 대화"]])("is closed by %s: the next line goes to the AI", async (command) => {
    const asked: string[] = [];
    const kit = await startKit({ search: async (query) => { asked.push(query); return empty(); } });
    await pair(kit);
    await menu(kit);
    await press(kit, "찾기");
    await say(kit, command);
    await say(kit, "보고서 초안 정리해 줘");
    expect(asked).toEqual([]);
    expect(kit.engine.sent.at(-1)!.text).toContain("보고서 초안 정리해 줘");
  });

  it("is closed by a lock and by a pause", async () => {
    const asked: string[] = [];
    const kit = await startKit({ search: async (query) => { asked.push(query); return empty(); } });
    const binding = await pair(kit);
    await menu(kit);
    await press(kit, "찾기");
    kit.core.pause(binding.id, true);
    kit.core.pause(binding.id, false);
    await say(kit, "첫째 줄");
    await menu(kit);
    await press(kit, "찾기");
    kit.core.lock(binding.id);
    kit.core.unlock(binding.id);
    await settle(kit);
    await say(kit, "둘째 줄");
    expect(asked).toEqual([]);
    expect(kit.engine.sent.map((turn) => turn.text).filter((text) => text.includes("째 줄"))).toHaveLength(2);
  });

  it("lasts about three minutes; after that a line goes to the AI and the chat is told the input closed", async () => {
    const asked: string[] = [];
    const kit = await startKit({ search: async (query) => { asked.push(query); return empty(); } });
    await pair(kit);
    await menu(kit);
    await press(kit, "찾기");
    kit.clock.now += 2 * 60_000 + 50_000;
    await say(kit, "아직 찾기");
    expect(asked).toEqual(["아직 찾기"]);
    await menu(kit);
    await press(kit, "찾기");
    kit.clock.now += 3 * 60_000 + 1_000;
    await say(kit, "이건 AI에게");
    expect(asked).toEqual(["아직 찾기"]);
    expect(kit.adapter.texts()).toContain("찾을 말을 적는 칸은 시간이 지나 닫혔습니다. 이 글은 AI에게 보냈습니다.");
    expect(kit.engine.sent.at(-1)!.text).toContain("이건 AI에게");
  });

  it("does not cut what the person typed for the note: over 400 characters it writes nothing, says the limit and keeps the input open", async () => {
    const kit = await startKit({ projects: true });
    const work = kit.manager.createWork({ title: "연구계획서", titleSource: "user" });
    await pair(kit);
    kit.core.setPointer(kit.core.bindings()[0]!.id, kit.manager.createSession(work.id, { provider: "claude", purpose: "노트", access: "full" }).id);
    await menu(kit);
    await press(kit, "프로젝트 노트");
    await press(kit, "결정 추가");
    await say(kit, "나".repeat(401));
    expect(kit.projects!.note(work).decisions).toEqual([]);
    expect(kit.adapter.texts().at(-1)).toBe("노트의 결정·질문은 400자까지입니다(지금 401자). 적지 않았습니다. 줄여서 다시 보내 주세요.");
    await say(kit, "줄인 결정");
    expect(kit.projects!.note(work).decisions).toHaveLength(1);
    // The plain sentence is refused the same way.
    await say(kit, `결정으로 적어 줘: ${"다".repeat(401)}`);
    expect(kit.projects!.note(work).decisions).toHaveLength(1);
    expect(kit.adapter.texts().at(-1)).toBe("노트의 결정·질문은 400자까지입니다(지금 401자). 적지 않았습니다. 줄여서 다시 보내 주세요.");
    expect(kit.engine.sent).toEqual([]);
  });

  it("closes when a line with files comes instead, so the next line is not swallowed", async () => {
    const asked: string[] = [];
    const kit = await startKit({ search: async (query) => { asked.push(query); return empty(); } });
    await pair(kit);
    await menu(kit);
    await press(kit, "찾기");
    await kit.adapter.deliver(kit.adapter.message("사진 봐 줘", { files: [{ fileRef: "nothing", name: "a.jpg", mime: "image/jpeg", size: 10, kind: "photo" }] }));
    await settle(kit);
    if (kit.engine.sent.length) kit.engine.finish(kit.engine.sent.at(-1)!.sessionId);
    await settle(kit);
    await say(kit, "다음 줄");
    expect(asked).toEqual([]);
    expect(kit.engine.sent.at(-1)!.text).toContain("다음 줄");
  });

  it("is taken at most once and never handed to the AI when the gateway stopped while acting on it", async () => {
    const asked: string[] = [];
    let hang: Promise<SearchPage> = new Promise(() => undefined);
    const search = async (query: string) => { asked.push(query); return hang; };
    let kit = await startKit({ search });
    await pair(kit);
    await menu(kit);
    await press(kit, "찾기");
    const event = kit.adapter.message("연구윤리");
    void kit.adapter.deliver(event);
    await new Promise((done) => setTimeout(done, 30));
    expect(asked).toEqual(["연구윤리"]);
    hang = Promise.resolve(empty());
    kit = await restartKit(kit);
    await settle(kit);
    expect(kit.engine.sent).toEqual([]);
    // Not searched a second time either.
    expect(asked).toEqual(["연구윤리"]);
  });
});

describe("access modes and questions (I3)", () => {
  it("names each mode by what it does, the same in the notice and on the engine screen, and says access applies now", async () => {
    const kit = await startKit();
    const work = kit.manager.createWork({ title: "연구계획서" });
    const strict = kit.manager.createSession(work.id, { provider: "claude", purpose: "엄격한 대화", access: "ask" });
    await pair(kit);
    const id = await menu(kit);
    await press(kit, "대화 바꾸기");
    await press(kit, kit.adapter.labelsOf(id).find((label) => label.startsWith("엄격한 대화"))!);
    expect(shownText(kit, id)).toBe("이제 「엄격한 대화」로 보냅니다 (Claude · 묻기).\n이 대화는 '묻기 · 매번 확인' 모드라 중간에 확인 요청이 올 수 있습니다.");
    expect(kit.adapter.labelsOf(id)).toEqual(["전체 접근으로 바꾸기", "← 메뉴"]);
    await press(kit, "← 메뉴");
    await press(kit, "엔진·모델");
    expect(kit.adapter.labelsOf(id).slice(-4)).toEqual(["✓ 묻기 · 매번 확인", "자동 · 명령은 확인", "전체 접근 · 묻지 않음", "← 메뉴"]);
    await press(kit, "전체 접근 · 묻지 않음");
    expect(sessionOf(kit, strict.id).access).toBe("full");
    expect(shownText(kit, id)).toMatch(/^바꿨습니다\. 지금부터 적용합니다\.\n/);
    await press(kit, "✓ 모델: 기본");
    expect(shownText(kit, id)).toMatch(/^바꿨습니다\. 다음 요청부터 적용합니다\.\n/);
  });

  it("sends again, once, a question asked while the chat was paused, when it reopens", async () => {
    const kit = await startKit();
    const work = kit.manager.createWork({ title: "연구계획서" });
    const strict = kit.manager.createSession(work.id, { provider: "claude", purpose: "엄격한 대화", access: "ask" });
    const binding = await pair(kit);
    kit.core.setPointer(binding.id, strict.id);
    await say(kit, "빌드 지워 줘");
    kit.core.pause(binding.id, true);
    kit.engine.ask(strict.id, "명령 실행 허용?", "rm -rf ./build");
    await settle(kit);
    expect(kit.adapter.texts().some((text) => text.includes("명령 실행 허용?"))).toBe(false);
    kit.core.pause(binding.id, false);
    await settle(kit);
    kit.core.pause(binding.id, true);
    kit.core.pause(binding.id, false);
    await settle(kit);
    expect(kit.adapter.texts().filter((text) => text.includes("명령 실행 허용?"))).toHaveLength(1);
    await press(kit, "허용");
    expect(kit.engine.answered).toHaveLength(1);
  });
});

describe("the small ones", () => {
  it("stores search results with their secrets hidden", async () => {
    const token = "7000000001:AAF" + "k".repeat(8) + "-Fake_token-for-loopback-01";
    const page: SearchPage = {
      query: "", sessions: [], documents: [], tookMs: 1, scope: "all", total: 1, groupsTotal: 1, counts: { all: 1, project: 0, session: 0, document: 0, decision: 0, vault: 0 }, offset: 0, limit: 4, group: null, terms: [],
      groups: [{ key: "g", workId: null, title: "", trail: [], total: 1, best: 1, hits: [{ key: "k", kind: "user", scope: "session", workId: null, sessionId: null, itemId: null, artifactId: null, path: null, title: "토큰 대화", titleRanges: [], at: null, provider: null, sessionTitle: null, revision: null, snippet: `토큰은 ${token}`, ranges: [], score: 1, answer: null, detail: null }] }],
    };
    const kit = await startKit({ search: async () => page });
    await pair(kit);
    await menu(kit);
    await press(kit, "찾기");
    await say(kit, "토큰");
    const { token: button } = kit.adapter.buttonOf("토큰 대화 · 요청");
    expect(kit.store.channels.button(button)!.data).not.toContain(token);
  });

  it("says weekly is not available, refuses a date that does not exist, and gives schedule time buttons a short life", async () => {
    const now = new Date(2026, 10, 12, 10, 0).getTime();
    expect(parseWhen("11/31 10:00", now)).toBeNull();
    expect(parseWhen("2/30 9:00", now)).toBeNull();
    const kit = await startKit();
    await pair(kit);
    await menu(kit);
    await press(kit, "예약");
    await press(kit, "직접 적기");
    await say(kit, "매주 월 9:00");
    expect(kit.adapter.texts().at(-1)).toBe("매주 예약은 아직 없습니다. 매일 또는 날짜로 적어 주세요. 예: 매일 9:00 · 11/20 9:00");
    await menu(kit);
    await press(kit, "예약");
    kit.clock.now += 31 * 60_000;
    await press(kit, "매일 09:00");
    expect(kit.adapter.acks.at(-1)!.note).toBe("만료된 버튼입니다");
  });

  it("keeps a schedule's text when it cannot be made", async () => {
    const kit = await startKit();
    await pair(kit);
    await menu(kit);
    await press(kit, "예약");
    await press(kit, "직접 적기");
    await say(kit, "18:30");
    vi.spyOn(kit.manager.schedules, "create").mockImplementation(() => { throw Object.assign(new Error("이미 지난 시각입니다."), { status: 400, code: "schedule_past" }); });
    await say(kit, "메일 정리");
    expect(kit.adapter.texts().at(-1)).toMatch(/^예약하지 못했습니다: .+\n적으려던 내용: “메일 정리”$/);
  });

  it("makes the two buttons of the archived refusal one set: pressing one ends the other", async () => {
    const kit = await startKit();
    await pair(kit);
    await say(kit, "첫 일");
    const old = kit.engine.sent[0]!.sessionId;
    kit.engine.finish(old);
    kit.manager.updateSession(old, { archived: true });
    await settle(kit);
    await say(kit, "보관한 뒤");
    await press(kit, "새 대화에서 하기");
    const other = kit.adapter.buttonOf("대화 바꾸기");
    expect(kit.store.channels.button(other.token)!.usedAt).not.toBeNull();
  });

  it("does not count the stricter-mode notice as said when the message carrying it did not go", async () => {
    const kit = await startKit();
    const work = kit.manager.createWork({ title: "연구계획서" });
    kit.manager.createSession(work.id, { provider: "claude", purpose: "엄격한 대화", access: "ask" });
    await pair(kit);
    const id = await menu(kit);
    await press(kit, "대화 바꾸기");
    kit.adapter.failEdits = true;
    await press(kit, kit.adapter.labelsOf(id).find((label) => label.startsWith("엄격한 대화"))!);
    kit.adapter.failEdits = false;
    await say(kit, "일 하나");
    expect(kit.adapter.texts().some((text) => text.includes("모드라 중간에 확인 요청이 올 수 있습니다"))).toBe(true);
    expect(BOT).toBeTruthy();
  });
});
