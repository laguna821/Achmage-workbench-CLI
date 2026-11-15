import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchPage } from "@workbench/contracts";
import { parseWhen } from "./menu.ts";
import { cleanKits, pair, press, say, sessionOf, settle, startKit, userItems, type Kit } from "./test-kit.ts";

// "메뉴" and what it reaches: one message with buttons, edited in place, from which the person
// reaches nearly everything the desktop conversation does — each through the function the desktop
// calls, behind the same gates as a line.

afterEach(() => { vi.restoreAllMocks(); cleanKits(); });

const labelsOf = (kit: Kit, messageId: string) => kit.adapter.labelsOf(messageId);
const shownText = (kit: Kit, messageId: string) => kit.adapter.shown(messageId)!.text;

/** Open the menu and return its message id. */
async function menu(kit: Kit) {
  await settle(kit);
  const before = kit.adapter.sent.length;
  await say(kit, "메뉴");
  const sent = kit.adapter.sent.slice(before);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.out.text).toMatch(/^메뉴 · 지금: /);
  return sent[0]!.messageId;
}

describe("the menu", () => {
  it("is one message with buttons, and moving through it edits that message instead of sending new ones", async () => {
    const kit = await startKit();
    await pair(kit);
    await say(kit, "첫 일");
    const id = await menu(kit);
    expect(shownText(kit, id)).toMatch(/^메뉴 · 지금: 「휴대폰」 › 「휴대폰 · \d+\/\d+」/);
    expect(labelsOf(kit, id)).toEqual(["새 대화", "대화 바꾸기", "프로젝트 바꾸기", "엔진·모델", "최근 파일", "프로젝트 노트", "찾기", "예약", "사용량", "알림", "상태·대기열", "채널 잠금"]);
    const count = kit.adapter.sent.length;
    await press(kit, "엔진·모델");
    await press(kit, "← 메뉴");
    await press(kit, "사용량");
    expect(kit.adapter.sent.length).toBe(count);
    expect(shownText(kit, id)).toMatch(/Claude/);
    expect(labelsOf(kit, id)).toEqual(["← 메뉴"]);
  });

  it("binds each button to the chat, the person and the one message it sits on, and a pressed or replaced button does nothing", async () => {
    const kit = await startKit();
    await pair(kit);
    const id = await menu(kit);
    const old = kit.adapter.buttonOf("새 대화");
    await press(kit, "엔진·모델");
    // The screen was replaced: the button it showed before is over.
    const sessions = kit.manager.snapshot().sessions.length;
    await kit.adapter.deliver(kit.adapter.press(old.token, { messageId: id }));
    await settle(kit);
    expect(kit.manager.snapshot().sessions).toHaveLength(sessions);
    expect(kit.adapter.acks.at(-1)!.note).toBe("이미 처리됨");
    // A live button pressed on another message (a forwarded or copied keyboard) does nothing.
    const live = kit.adapter.buttonOf("← 메뉴");
    await kit.adapter.deliver(kit.adapter.press(live.token, { messageId: "m999" }));
    await settle(kit);
    expect(kit.adapter.acks.at(-1)!.note).toBe("쓸 수 없는 버튼입니다");
    expect(labelsOf(kit, id)).toContain("← 메뉴");
    // Another person in the owner's chat gets nothing either.
    await kit.adapter.deliver(kit.adapter.press(live.token, { messageId: id, userId: "666", chat: kit.adapter.dm("555") }));
    await settle(kit);
    expect(kit.adapter.acks.at(-1)!.note).toBe("쓸 수 없는 버튼입니다");
    expect(labelsOf(kit, id)).toContain("← 메뉴");
    // A screen replaced without a press (the line a prompt asked for came): its old 취소 is over too.
    await press(kit, "← 메뉴");
    await press(kit, "새 대화");
    await press(kit, "← 메뉴");
    await press(kit, "프로젝트 바꾸기");
    await press(kit, "새 프로젝트");
    const cancel = kit.adapter.buttonOf("취소");
    await say(kit, "가을 특강");
    expect(shownText(kit, id)).toBe("받았습니다.");
    await kit.adapter.deliver(kit.adapter.press(cancel.token, { messageId: id }));
    await settle(kit);
    expect(kit.adapter.acks.at(-1)!.note).toBe("이미 처리됨");
    expect(shownText(kit, id)).toBe("받았습니다.");
  });

  it("refuses its buttons in a paused or locked chat, and is not shown there", async () => {
    const kit = await startKit();
    const binding = await pair(kit);
    await menu(kit);
    kit.core.pause(binding.id, true);
    await press(kit, "새 대화");
    expect(kit.adapter.acks.at(-1)!.note).toBe("채널이 멈춰 있습니다");
    expect(kit.manager.snapshot().sessions).toHaveLength(0);
    const before = kit.adapter.sent.length;
    await say(kit, "메뉴");
    expect(kit.adapter.sent.slice(before).map((entry) => entry.out.text)).toEqual(["지금은 PC에서 채널을 멈춰 두었습니다."]);
  });

  it("locks the channel from 채널 잠금, as 잠금 does", async () => {
    const kit = await startKit();
    await pair(kit);
    await menu(kit);
    await press(kit, "채널 잠금");
    expect(kit.core.bindings()[0]!.lockedAt).not.toBeNull();
    expect(kit.adapter.texts().at(-1)).toBe("채널을 잠갔습니다. 푸는 것은 PC에서만 할 수 있습니다.");
  });
});

describe("switching conversation and project", () => {
  it("lists the project's conversations and moves the chat to the one picked, without moving the PC's current one", async () => {
    const kit = await startKit();
    const work = kit.manager.createWork({ title: "연구계획서" });
    const desk = kit.manager.createSession(work.id, { provider: "claude", purpose: "문헌 목록", access: "full" });
    await pair(kit);
    await say(kit, "첫 일");
    const phone = kit.engine.sent[0]!.sessionId;
    kit.engine.finish(phone);
    const other = kit.manager.createSession(work.id, { provider: "claude", purpose: "예산표 정리", access: "full" }, false);
    const archived = kit.manager.createSession(work.id, { provider: "claude", purpose: "보관한 대화" }, false);
    kit.manager.updateSession(archived.id, { archived: true });
    const id = await menu(kit);
    await press(kit, "대화 바꾸기");
    expect(shownText(kit, id)).toBe("「연구계획서」의 최근 대화");
    const labels = labelsOf(kit, id);
    expect(labels.some((label) => label.startsWith("✓ 휴대폰 ·"))).toBe(true);
    expect(labels.some((label) => label.startsWith("예산표 정리 ·"))).toBe(true);
    expect(labels.some((label) => label.startsWith("보관한 대화"))).toBe(false);
    await press(kit, labels.find((label) => label.startsWith("문헌 목록"))!);
    expect(shownText(kit, id)).toBe("이제 「문헌 목록」로 보냅니다 (Claude · 전체 접근).");
    expect(kit.core.bindings()[0]!.pointerSessionId).toBe(desk.id);
    expect(kit.manager.snapshot().works.find((entry) => entry.id === work.id)!.activeSessionId).toBe(desk.id);
    await say(kit, "여기서 이어 줘");
    expect(kit.engine.sent.at(-1)!.sessionId).toBe(desk.id);
    expect(other.id).not.toBe(desk.id);
  });

  it("says once, in the same message, that a conversation in a stricter mode may ask, with a way to switch it", async () => {
    const kit = await startKit();
    const work = kit.manager.createWork({ title: "연구계획서" });
    const strict = kit.manager.createSession(work.id, { provider: "claude", purpose: "엄격한 대화", access: "ask" });
    await pair(kit);
    const id = await menu(kit);
    await press(kit, "대화 바꾸기");
    await press(kit, labelsOf(kit, id).find((label) => label.startsWith("엄격한 대화"))!);
    expect(shownText(kit, id)).toBe("이제 「엄격한 대화」로 보냅니다 (Claude · 묻기).\n이 대화는 '묻기 · 매번 확인' 모드라 중간에 확인 요청이 올 수 있습니다.");
    // Not said a second time when the first line goes there.
    const before = kit.adapter.sent.length;
    await say(kit, "일 하나");
    expect(kit.adapter.sent.slice(before).some((entry) => entry.out.text.includes("모드라"))).toBe(false);
    await press(kit, "전체 접근으로 바꾸기");
    expect(sessionOf(kit, strict.id).access).toBe("full");
  });

  it("goes to another project, and makes a new conversation there or a new project", async () => {
    const kit = await startKit();
    const first = kit.manager.createWork({ title: "지난 학기" });
    kit.manager.createSession(first.id, { provider: "claude", purpose: "강의 준비" });
    const second = kit.manager.createWork({ title: "연구계획서" });
    await pair(kit);
    const id = await menu(kit);
    await press(kit, "프로젝트 바꾸기");
    const shown = labelsOf(kit, id);
    expect(shown.map((label) => label.replace("✓ ", "")).sort()).toEqual(["← 메뉴", "새 프로젝트", "연구계획서", "지난 학기"].sort());
    expect(shown.filter((label) => label.startsWith("✓ "))).toHaveLength(1);
    await press(kit, shown.find((label) => label.endsWith("지난 학기"))!);
    expect(shownText(kit, id)).toBe("「지난 학기」의 최근 대화");
    await press(kit, "이 프로젝트에 새 대화");
    const pointer = kit.core.bindings()[0]!.pointerSessionId!;
    expect(sessionOf(kit, pointer)).toMatchObject({ workId: first.id, access: "full" });
    expect(shownText(kit, id)).toMatch(/^「지난 학기」에 새 대화를 만들었습니다: /);

    await press(kit, "← 메뉴");
    await press(kit, "프로젝트 바꾸기");
    await press(kit, "새 프로젝트");
    expect(shownText(kit, id)).toBe("새 프로젝트 이름을 적어 보내 주세요.");
    await say(kit, "가을 특강");
    // The name is the project's, not a request: the AI got nothing.
    expect(kit.engine.sent).toEqual([]);
    const made = kit.manager.snapshot().works.find((work) => work.title === "가을 특강")!;
    expect(made).toMatchObject({ titleSource: "user" });
    expect(sessionOf(kit, kit.core.bindings()[0]!.pointerSessionId!).workId).toBe(made.id);
    expect(kit.adapter.texts().at(-1)).toMatch(/^「가을 특강」 프로젝트를 만들고 새 대화로 옮겼습니다: /);
    expect(second.id).not.toBe(made.id);
  });

  it("offers 대화 바꾸기 beside 새 대화에서 하기 when the conversation was archived, and sends the line to the one picked", async () => {
    const kit = await startKit();
    await pair(kit);
    await say(kit, "첫 일");
    const old = kit.engine.sent[0]!.sessionId;
    kit.engine.finish(old);
    const work = sessionOf(kit, old).workId;
    const other = kit.manager.createSession(work, { provider: "claude", purpose: "살아 있는 대화", access: "full" }, false);
    kit.manager.updateSession(old, { archived: true });
    await settle(kit);
    await say(kit, "보관한 뒤에 보낸 일");
    const refusal = kit.adapter.last()!;
    expect(refusal.out.buttons!.flat().map((button) => button.label)).toEqual(["새 대화에서 하기", "대화 바꾸기"]);
    await press(kit, "대화 바꾸기");
    expect(shownText(kit, refusal.messageId)).toBe("「휴대폰」의 최근 대화\n보낼 대화를 고르세요.");
    await press(kit, labelsOf(kit, refusal.messageId).find((label) => label.startsWith("살아 있는 대화"))!);
    expect(kit.core.bindings()[0]!.pointerSessionId).toBe(other.id);
    expect(userItems(kit, other.id).map((item) => item.text)).toEqual(["보관한 뒤에 보낸 일"]);
    expect(sessionOf(kit, old).archivedAt).not.toBeNull();
    // Nothing goes twice: 새 대화에서 하기 on the same refusal finds nothing left to send.
    await kit.adapter.deliver(kit.adapter.press(refusal.out.buttons![0]![0]!.token, { messageId: refusal.messageId }));
    await settle(kit);
    expect(kit.engine.sent.filter((turn) => turn.text.includes("보관한 뒤에 보낸 일"))).toHaveLength(1);
  });
});

describe("engine, model, effort, access", () => {
  it("changes the model, the effort and the access mode of the chat's conversation through the desktop's own setting", async () => {
    const kit = await startKit();
    kit.engine.report = { models: [{ id: "opus", label: "Opus", description: null, efforts: ["low", "medium", "high"], defaultEffort: "medium", isDefault: true }, { id: "sonnet", label: "Sonnet", description: null, efforts: ["low", "high"], defaultEffort: "low", isDefault: false }] };
    await pair(kit);
    await say(kit, "첫 일");
    const session = kit.engine.sent[0]!.sessionId;
    kit.engine.finish(session);
    const id = await menu(kit);
    await press(kit, "엔진·모델");
    expect(labelsOf(kit, id)).toEqual(["✓ Claude", "Codex", "✓ 모델: 기본", "모델: Opus", "모델: Sonnet", "✓ 노력: 기본", "노력: 낮음", "노력: 중간", "노력: 높음", "묻기 · 매번 확인", "자동 · 명령은 확인", "✓ 전체 접근 · 묻지 않음", "← 메뉴"]);
    await press(kit, "모델: Sonnet");
    await press(kit, "노력: 높음");
    expect(shownText(kit, id)).toMatch(/^바꿨습니다\. 다음 요청부터 적용합니다\.\n\n지금: Claude · sonnet · 노력 높음 · 전체 접근/);
    await press(kit, "자동 · 명령은 확인");
    expect(sessionOf(kit, session)).toMatchObject({ model: "sonnet", effort: "high", access: "auto" });
    expect(shownText(kit, id)).toMatch(/^바꿨습니다\. 지금부터 적용합니다\.\n\n지금: Claude · sonnet · 노력 높음 · 자동/);
  });

  it("makes a new conversation with the other engine (an engine is fixed per conversation, as at the PC)", async () => {
    const kit = await startKit({ codex: true });
    await pair(kit);
    await say(kit, "첫 일");
    const first = kit.engine.sent[0]!.sessionId;
    kit.engine.finish(first);
    const id = await menu(kit);
    await press(kit, "엔진·모델");
    await press(kit, "Codex");
    const pointer = kit.core.bindings()[0]!.pointerSessionId!;
    expect(pointer).not.toBe(first);
    expect(sessionOf(kit, pointer)).toMatchObject({ provider: "codex", access: "full", workId: sessionOf(kit, first).workId });
    expect(shownText(kit, id)).toMatch(/^이 대화를 Codex로 바꿀 수 없어 Codex로 새 대화를 만들었습니다: 「휴대폰 · /);
    await say(kit, "코덱스로 해 줘");
    expect(kit.codex!.sent.map((turn) => turn.sessionId)).toEqual([pointer]);
  });

  it("says plainly when the other engine is not on this PC", async () => {
    const kit = await startKit();
    await pair(kit);
    await say(kit, "첫 일");
    kit.engine.finish(kit.engine.sent[0]!.sessionId);
    const id = await menu(kit);
    await press(kit, "엔진·모델");
    await press(kit, "Codex");
    expect(shownText(kit, id)).toMatch(/^Codex가 이 PC에 설치되어 있지 않습니다\./);
  });
});

describe("plan first", () => {
  it("asks for a plan on '계획 먼저: …', offers one 진행, and the go-ahead's answer comes back to the chat", async () => {
    const kit = await startKit();
    await pair(kit);
    await say(kit, "계획 먼저: 학회 발표 자료 만들어 줘");
    const [turn] = kit.engine.sent;
    const item = userItems(kit, turn!.sessionId)[0]!;
    expect(item).toMatchObject({ text: "학회 발표 자료 만들어 줘", plan: true });
    kit.engine.say(turn!.sessionId, "계획: 1. 개요 2. 그림");
    kit.engine.finish(turn!.sessionId);
    await settle(kit);
    // The plan is the answer, and its one button goes with it (no second message asks the same).
    expect(kit.adapter.texts().filter((text) => text.includes("이 계획대로 진행할까요?"))).toEqual([]);
    expect(kit.adapter.sent.filter((entry) => entry.out.buttons?.flat().some((button) => button.label === "진행"))).toHaveLength(1);
    expect(kit.adapter.last()!.out.text).toBe("계획: 1. 개요 2. 그림");
    expect(kit.adapter.last()!.out.buttons!.flat().map((button) => button.label)).toEqual(["진행"]);
    const planMessage = kit.adapter.last()!.messageId;
    await press(kit, "진행");
    expect(kit.adapter.shown(planMessage)!.text).toMatch(/^계획: 1\. 개요 2\. 그림\n진행함 · \d+:\d{2} · 휴대폰$/);
    const go = kit.engine.sent.at(-1)!;
    expect(go.text).toContain("계획대로 진행해 주세요.");
    // The go-ahead is the chat's request too: its answer comes here.
    expect(userItems(kit, turn!.sessionId).at(-1)!.origin).toMatchObject({ bindingId: kit.core.bindings()[0]!.id });
    kit.engine.say(turn!.sessionId, "발표 자료를 만들었습니다.");
    kit.engine.finish(turn!.sessionId);
    await settle(kit);
    expect(kit.adapter.texts()).toContain("발표 자료를 만들었습니다.");
  });
});

describe("the queue", () => {
  it("shows what waits on 상태, and 빼기 and 지금 보내기 go through the desktop's own guarded functions", async () => {
    const kit = await startKit();
    await pair(kit);
    kit.engine.canSteer = false;
    await say(kit, "첫 일");
    await say(kit, "둘째 일");
    await say(kit, "셋째 일");
    const session = kit.engine.sent[0]!.sessionId;
    const before = kit.adapter.sent.length;
    await say(kit, "상태");
    const status = kit.adapter.sent[before]!;
    expect(status.out.text).toMatch(/\n기다리는 요청 2개\n1\. 둘째 일\n2\. 셋째 일$/);
    expect(labelsOf(kit, status.messageId)).toEqual(["1 지금 보내기", "1 빼기", "2 지금 보내기", "2 빼기", "이름 바꾸기", "맥락 줄이기", "← 메뉴"]);
    await press(kit, "1 빼기");
    expect(sessionOf(kit, session).queued.map((entry) => entry.text)).toEqual(["셋째 일"]);
    expect(shownText(kit, status.messageId)).toMatch(/^대기열에서 뺐습니다\./);
    // Deleted: never sent, also not when the turn ends.
    kit.engine.finish(session);
    await settle(kit);
    expect(kit.engine.sent.map((turn) => turn.text).some((text) => text.includes("둘째 일"))).toBe(false);
    expect(kit.engine.sent.at(-1)!.text).toContain("셋째 일");
    // A request that waits again is sent now from the chat (it leaves the queue when its user item is written).
    await say(kit, "넷째 일");
    await say(kit, "상태");
    kit.engine.canSteer = true;
    await press(kit, "1 지금 보내기");
    expect(sessionOf(kit, session).queued).toEqual([]);
    expect(userItems(kit, session).at(-1)).toMatchObject({ text: "넷째 일", steered: true });
    expect(kit.adapter.history.at(-1)!.out.text).toMatch(/^보냈습니다\./);
  });

  it("does not send a waiting request from the chat while the gateway prepares an update", async () => {
    const kit = await startKit();
    await pair(kit);
    kit.engine.canSteer = false;
    await say(kit, "첫 일");
    await say(kit, "둘째 일");
    const session = kit.engine.sent[0]!.sessionId;
    await say(kit, "상태");
    kit.manager.tasks.admitNewWork = () => { throw new Error("draining"); };
    await press(kit, "1 지금 보내기");
    expect(sessionOf(kit, session).queued.map((entry) => entry.text)).toEqual(["둘째 일"]);
    expect(kit.adapter.history.at(-1)!.out.text).toMatch(/^PC가 업데이트를 준비하고 있어/);
  });
});

describe("a document's own AI", () => {
  it("lists the project's recent files, and moves the chat to the document's AI (its own child conversation)", async () => {
    const kit = await startKit();
    await pair(kit);
    await say(kit, "첫 일");
    const main = kit.engine.sent[0]!.sessionId;
    kit.engine.finish(main);
    const work = kit.manager.snapshot().works[0]!;
    writeFileSync(join(work.cwd, "심사 의견서.md"), "# 의견\n");
    const artifact = kit.manager.openFile(work.id, "심사 의견서.md");
    const id = await menu(kit);
    await press(kit, "최근 파일");
    expect(labelsOf(kit, id)).toEqual(["심사 의견서.md", "← 메뉴"]);
    await press(kit, "심사 의견서.md");
    expect(shownText(kit, id)).toMatch(/^「심사 의견서\.md」 · .+ 수정$/);
    await press(kit, "이 문서의 AI에게");
    const child = kit.core.bindings()[0]!.pointerSessionId!;
    expect(sessionOf(kit, child).documentAgent).toMatchObject({ artifactId: artifact.id, parentSessionId: main });
    expect(shownText(kit, id)).toMatch(/^이제 「심사 의견서」의 AI에게 보냅니다 \(Claude · 전체 접근\)\.$/);
    await say(kit, "2번 의견 답변을 공손하게");
    expect(kit.engine.sent.at(-1)!.sessionId).toBe(child);
    // The main conversation is not locked by it.
    await kit.core.setPointer(kit.core.bindings()[0]!.id, main);
    await say(kit, "본 대화에도 하나");
    expect(kit.engine.sent.at(-1)!.sessionId).toBe(main);
  });
});

describe("the project note", () => {
  async function noteKit() {
    const kit = await startKit({ projects: true });
    const work = kit.manager.createWork({ title: "연구계획서" });
    await pair(kit);
    await say(kit, "첫 일");
    kit.engine.finish(kit.engine.sent[0]!.sessionId);
    await settle(kit);
    return { kit, work };
  }

  it("reads the note, and adds a decision through the note's guarded write with the revision shown", async () => {
    const { kit, work } = await noteKit();
    kit.projects!.addEntry(work.id, { section: "decision", text: "표지는 B안", sessionId: null, itemId: null });
    const id = await menu(kit);
    await press(kit, "프로젝트 노트");
    expect(shownText(kit, id)).toMatch(/^「연구계획서」 노트\n결정\n· \d{4}-\d{2}-\d{2} 표지는 B안$/);
    const write = vi.spyOn(kit.projects!, "addEntry");
    await press(kit, "결정 추가");
    expect(shownText(kit, id)).toBe("'결정'에 남길 말을 적어 보내 주세요.");
    await say(kit, "2차 심사는 12월 첫 주로");
    expect(kit.engine.sent).toHaveLength(1);
    expect(write).toHaveBeenCalledWith(work.id, expect.objectContaining({ section: "decision", text: "2차 심사는 12월 첫 주로", baseRevision: 1 }));
    expect(kit.adapter.texts().at(-1)).toBe("「연구계획서」 노트 '결정'에 추가했습니다.");
    expect(kit.projects!.note(work).decisions.map((entry) => entry.text.replace(/^\S+ /, "").replace(/ — .*$/, ""))).toEqual(["표지는 B안", "2차 심사는 12월 첫 주로"]);
  });

  it("refuses a stale write once, keeps the words, and writes them on the person's choice against the note as it is now", async () => {
    const { kit, work } = await noteKit();
    kit.projects!.addEntry(work.id, { section: "decision", text: "표지는 B안", sessionId: null, itemId: null });
    const id = await menu(kit);
    await press(kit, "프로젝트 노트");
    await press(kit, "질문 추가");
    // Someone edits the note at the PC (or in Obsidian) meanwhile.
    const path = kit.projects!.note(work).path;
    writeFileSync(path, `${readFileSync(path, "utf8")}\n밖에서 고친 줄\n`);
    await say(kit, "IRB 승인번호는?");
    const conflict = kit.adapter.last()!;
    expect(conflict.out.text).toBe("노트가 그사이 바뀌어 적지 않았습니다.\n적으려던 말: “IRB 승인번호는?”");
    expect(conflict.out.buttons!.flat().map((button) => button.label)).toEqual(["지금 노트에 적기", "그만두기"]);
    expect(kit.projects!.note(work).questions).toEqual([]);
    expect(readFileSync(path, "utf8")).toContain("밖에서 고친 줄");
    await press(kit, "지금 노트에 적기");
    expect(kit.projects!.note(work).questions.map((entry) => entry.text)).toEqual([expect.stringMatching(/^\S+ IRB 승인번호는\? — Claude · 휴대폰 · /)]);
    // The outside edit is still there: nothing was re-applied over it.
    expect(readFileSync(path, "utf8")).toContain("밖에서 고친 줄");
    expect(shownText(kit, conflict.messageId)).toBe("「연구계획서」 노트 '열린 질문'에 추가했습니다.");
    expect(id).not.toBe(conflict.messageId);
  });

  it("writes '결정으로 적어 줘: …' to the note of the chat's project, and runs nothing", async () => {
    const { kit, work } = await noteKit();
    kit.core.setPointer(kit.core.bindings()[0]!.id, kit.manager.createSession(work.id, { provider: "claude", purpose: "노트 대화", access: "full" }).id);
    await say(kit, "결정으로 적어 줘: 2차 심사는 12월 첫 주로");
    expect(kit.engine.sent).toHaveLength(1);
    expect(kit.adapter.texts().at(-1)).toBe("「연구계획서」 노트 '결정'에 추가했습니다.");
    expect(kit.projects!.note(work).decisions.map((entry) => entry.text)).toEqual([expect.stringMatching(/^\S+ 2차 심사는 12월 첫 주로 — Claude · 노트 대화 /)]);
    // Inside a sentence the same words are for the AI.
    await say(kit, "어제 결정으로 적어 줘: 라고 했던 거 찾아 줘");
    expect(kit.engine.sent).toHaveLength(2);
  });

  it("changes a property of the note with the revision shown", async () => {
    const { kit, work } = await noteKit();
    kit.projects!.setProperty(work.id, "마감", ["2026-12-01"], "date");
    const id = await menu(kit);
    await press(kit, "프로젝트 노트");
    await press(kit, "속성 바꾸기");
    await press(kit, labelsOf(kit, id).find((label) => label.startsWith("마감:"))!);
    expect(shownText(kit, id)).toBe("「마감」에 새 값을 적어 보내 주세요. 지금: 2026-12-01");
    await say(kit, "2026-12-15");
    expect(kit.adapter.texts().at(-1)).toBe("노트를 고쳤습니다: 마감: 2026-12-01 → 2026-12-15");
    expect(kit.projects!.note(work).properties).toContainEqual(["마감", ["2026-12-15"]]);
  });
});

describe("search", () => {
  const page = (hits: { title: string; kind: string; snippet: string; sessionId?: string | null }[]): SearchPage => ({
    query: "", sessions: [], documents: [], tookMs: 1, scope: "all", total: hits.length, groupsTotal: 1, counts: { all: hits.length, project: 0, session: 0, document: 0, decision: 0, vault: 0 }, offset: 0, limit: 4, group: null, terms: [],
    groups: [{ key: "g", workId: null, title: "", trail: [], total: hits.length, best: 1, hits: hits.map((hit, index) => ({ key: `k${index}`, kind: hit.kind as never, scope: "session", workId: null, sessionId: hit.sessionId ?? null, itemId: null, artifactId: null, path: null, title: hit.title, titleRanges: [], at: null, provider: null, sessionTitle: null, revision: null, snippet: hit.snippet, ranges: [], score: 1, answer: null, detail: null })) }],
  });

  it("asks for one line, searches it (not sent to the AI), and opens what was found", async () => {
    const asked: string[] = [];
    let sessionId = "";
    const kit = await startKit({ search: async (query) => { asked.push(query); return page([{ title: "IRB 서류 대화", kind: "user", snippet: "IRB 승인번호 2026-1102-03", sessionId }, { title: "프로젝트 노트", kind: "decision", snippet: "IRB 승인번호 2026-1102-03 (10/2 확정)" }]); } });
    await pair(kit);
    await say(kit, "첫 일");
    kit.engine.finish(kit.engine.sent[0]!.sessionId);
    sessionId = kit.manager.createSession(kit.manager.snapshot().works[0]!.id, { provider: "claude", purpose: "IRB 서류", access: "full" }, false).id;
    const id = await menu(kit);
    await press(kit, "찾기");
    expect(shownText(kit, id)).toBe("무엇을 찾을까요? (한 줄로 적어 주세요)");
    await say(kit, "연구윤리 심의 번호");
    expect(asked).toEqual(["연구윤리 심의 번호"]);
    expect(kit.engine.sent).toHaveLength(1);
    const results = kit.adapter.last()!;
    expect(results.out.text).toBe("2건 · “연구윤리 심의 번호”");
    expect(labelsOf(kit, results.messageId)).toEqual(["IRB 서류 대화 · 요청", "프로젝트 노트 · 결정", "다시 찾기", "← 메뉴"]);
    await press(kit, "프로젝트 노트 · 결정");
    expect(shownText(kit, results.messageId)).toBe("프로젝트 노트 · 결정\n“IRB 승인번호 2026-1102-03 (10/2 확정)”");
    await press(kit, "← 찾은 목록");
    await press(kit, "IRB 서류 대화 · 요청");
    await press(kit, "이 대화로 보내기");
    expect(kit.core.bindings()[0]!.pointerSessionId).toBe(sessionId);
  });

  it("lets the next line go to the AI again after the input was cancelled or ran out", async () => {
    const kit = await startKit({ search: async () => page([]) });
    await pair(kit);
    await menu(kit);
    await press(kit, "찾기");
    await press(kit, "취소");
    await say(kit, "이건 AI에게");
    expect(kit.engine.sent).toHaveLength(1);
    kit.engine.finish(kit.engine.sent[0]!.sessionId);
    await menu(kit);
    await press(kit, "찾기");
    kit.clock.now += 11 * 60_000;
    await say(kit, "이것도 AI에게");
    expect(kit.engine.sent).toHaveLength(2);
  });
});

describe("schedules", () => {
  it("makes a schedule in the chat's conversation through the desktop's schedules, and its result comes back to the chat", async () => {
    const kit = await startKit();
    await pair(kit);
    await say(kit, "첫 일");
    const session = kit.engine.sent[0]!.sessionId;
    kit.engine.finish(session);
    const id = await menu(kit);
    await press(kit, "예약");
    expect(labelsOf(kit, id)).toEqual([expect.stringMatching(/^(오늘|내일) 18:00$/), "내일 08:00", "매일 09:00", "직접 적기", "예약 목록", "← 메뉴"]);
    await press(kit, "매일 09:00");
    expect(shownText(kit, id)).toBe("무엇을 할까요? (매일 09:00 예약)");
    await say(kit, "메일함 정리하고 오늘 일정 요약 보내 줘");
    expect(kit.engine.sent).toHaveLength(1);
    expect(kit.adapter.texts().at(-1)).toMatch(/^예약했습니다: 매일 09:00 「휴대폰 · /);
    const [schedule] = kit.manager.schedules.all();
    expect(schedule).toMatchObject({ sessionId: session, text: "메일함 정리하고 오늘 일정 요약 보내 줘", when: { kind: "daily", time: "09:00" }, origin: { channel: "telegram", bindingId: kit.core.bindings()[0]!.id } });
    // It comes due: the request is the chat's (the preamble goes with it), and so is its answer.
    schedule!.nextAt = Date.now() - 1000;
    await kit.manager.schedules.tick();
    await settle(kit);
    const run = kit.engine.sent.at(-1)!;
    expect(run.text).toContain("메일함 정리하고 오늘 일정 요약 보내 줘");
    expect(run.text).toContain("휴대폰에서 온 요청");
    kit.engine.say(session, "메일함을 정리했습니다.");
    kit.engine.finish(session);
    await settle(kit);
    expect(kit.adapter.texts()).toContain("메일함을 정리했습니다.");
  });

  it("does not run a schedule of a chat that is locked or disconnected", async () => {
    const kit = await startKit();
    const binding = await pair(kit);
    await say(kit, "첫 일");
    const session = kit.engine.sent[0]!.sessionId;
    kit.engine.finish(session);
    await menu(kit);
    await press(kit, "예약");
    await press(kit, "매일 09:00");
    await say(kit, "아침 요약");
    kit.core.lock(binding.id);
    await settle(kit);
    const [schedule] = kit.manager.schedules.all();
    expect(schedule!.enabled).toBe(false);
    schedule!.nextAt = Date.now() - 1000;
    await kit.manager.schedules.tick();
    await settle(kit);
    expect(kit.engine.sent).toHaveLength(1);
    // Stored off at the lock: it does not even come due.
    expect(schedule!.enabled).toBe(false);
  });

  it("reads a typed time", () => {
    const now = new Date(2026, 10, 12, 10, 0).getTime();
    expect(parseWhen("18:30", now)).toEqual({ when: { kind: "once", at: new Date(2026, 10, 12, 18, 30).getTime() }, label: "오늘 18:30" });
    expect(parseWhen("9:00", now)).toEqual({ when: { kind: "once", at: new Date(2026, 10, 13, 9, 0).getTime() }, label: "내일 09:00" });
    expect(parseWhen("내일 9시", now)!.label).toBe("내일 09:00");
    expect(parseWhen("11/20 14:00", now)!.when).toEqual({ kind: "once", at: new Date(2026, 10, 20, 14, 0).getTime() });
    expect(parseWhen("매일 7:30", now)).toEqual({ when: { kind: "daily", time: "07:30" }, label: "매일 07:30" });
    expect(parseWhen("다음 주쯤", now)).toBeNull();
    expect(parseWhen("25:00", now)).toBeNull();
  });
});

describe("usage and notifications", () => {
  it("shows the engines' usage and limits", async () => {
    const kit = await startKit();
    kit.engine.report = { plan: "Max", usage: [{ label: "5시간", usedPercent: 42, resetsAt: null }, { label: "주간", usedPercent: 10.4, resetsAt: null }], usageObservedAt: null };
    await kit.manager.refreshProviders();
    await pair(kit);
    const id = await menu(kit);
    await press(kit, "사용량");
    expect(shownText(kit, id)).toBe("Claude · Max\n· 5시간: 42% 사용\n· 주간: 10% 사용");
  });

  it("tells the chat when desktop work ends in a project it turned on, and nothing for the others", async () => {
    const kit = await startKit();
    const watched = kit.manager.createWork({ title: "연구계획서", titleSource: "user" });
    const quiet = kit.manager.createWork({ title: "다른 일", titleSource: "user" });
    await pair(kit);
    const id = await menu(kit);
    await press(kit, "알림");
    expect(new Set(labelsOf(kit, id))).toEqual(new Set(["꺼짐 · 다른 일", "꺼짐 · 연구계획서", "꺼짐 · 답 아래 꼬리말(모델·시간·맥락)", "← 메뉴"]));
    await press(kit, "꺼짐 · 연구계획서");
    // What is on comes first.
    expect(labelsOf(kit, id)).toEqual(["켜짐 · 연구계획서", "꺼짐 · 다른 일", "꺼짐 · 답 아래 꼬리말(모델·시간·맥락)", "← 메뉴"]);
    const a = kit.manager.createSession(watched.id, { provider: "claude", purpose: "예산표 정리", access: "full" });
    const b = kit.manager.createSession(quiet.id, { provider: "claude", purpose: "다른 대화", access: "full" });
    await kit.manager.send(a.id, "pc-1", "PC에서 시킨 일");
    await kit.manager.send(b.id, "pc-2", "다른 PC 일");
    kit.engine.finish(a.id);
    kit.engine.finish(b.id);
    await settle(kit);
    const notices = kit.adapter.texts().filter((text) => text.startsWith("PC에서 시킨 일이"));
    expect(notices).toEqual(["PC에서 시킨 일이 끝났습니다 · 「연구계획서」 › 「예산표 정리」"]);
    // A conversation muted at the PC is not told.
    kit.manager.updateSession(a.id, { muted: true });
    await kit.manager.send(a.id, "pc-3", "조용히");
    kit.engine.finish(a.id);
    await settle(kit);
    expect(kit.adapter.texts().filter((text) => text.startsWith("PC에서 시킨 일이"))).toHaveLength(1);
  });

  it("does not tell a chat's own request as a notice (its answer is the message)", async () => {
    const kit = await startKit();
    await pair(kit);
    await say(kit, "첫 일");
    const session = kit.engine.sent[0]!.sessionId;
    const id = await menu(kit);
    await press(kit, "알림");
    await press(kit, labelsOf(kit, id).find((label) => label.endsWith("휴대폰"))!);
    kit.engine.say(session, "끝냈습니다.");
    kit.engine.finish(session);
    await settle(kit);
    expect(kit.adapter.texts().filter((text) => text.startsWith("PC에서 시킨 일이"))).toEqual([]);
    expect(kit.adapter.texts()).toContain("끝냈습니다.");
  });

  it("sends a desktop question in a project the chat turned on, with buttons bound to it", async () => {
    const kit = await startKit();
    const work = kit.manager.createWork({ title: "연구계획서" });
    await pair(kit);
    const id = await menu(kit);
    await press(kit, "알림");
    await press(kit, "꺼짐 · 연구계획서");
    const desk = kit.manager.createSession(work.id, { provider: "claude", purpose: "예산표 정리", access: "ask" });
    await kit.manager.send(desk.id, "pc-1", "빌드 지워 줘");
    kit.engine.ask(desk.id, "명령 실행 허용?", "rm -rf ./build");
    await settle(kit);
    expect(kit.adapter.last()!.out.text).toBe("「예산표 정리」 · 명령 실행 허용?\nrm -rf ./build");
    await press(kit, "허용");
    expect(kit.engine.answered).toEqual([{ sessionId: desk.id, itemId: expect.any(String), decision: "accept" }]);
    // Not the questions of a conversation muted at the PC.
    kit.manager.updateSession(desk.id, { muted: true });
    const before = kit.adapter.sent.length;
    kit.engine.ask(desk.id, "또 허용?", "rm -rf ./dist");
    await settle(kit);
    expect(kit.adapter.sent.slice(before)).toEqual([]);
    expect(id).toBeTruthy();
  });
});

describe("what the menu sends", () => {
  it("hides secrets in what a menu screen shows", async () => {
    const kit = await startKit();
    const token = "7000000001:AAF" + "k".repeat(8) + "-Fake_token-for-loopback-01";
    const work = kit.manager.createWork({ title: `토큰 ${token}`, titleSource: "user" });
    const binding = await pair(kit);
    kit.core.setPointer(binding.id, kit.manager.createSession(work.id, { provider: "claude", purpose: "대화", access: "full" }).id);
    const id = await menu(kit);
    await press(kit, "대화 바꾸기");
    expect(shownText(kit, id)).toMatch(/^「토큰 .+」의 최근 대화$/);
    expect(JSON.stringify(kit.adapter.history)).not.toContain(token);
  });
});
