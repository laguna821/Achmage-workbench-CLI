import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.ts";
import { PREAMBLE_VERSION, phonePreamble } from "./preamble.ts";

/** The preamble a request gets now (version 3: it names the engine and model; the stand-in engine reports no model list). */
const PREAMBLE = phonePreamble(PREAMBLE_VERSION, "이 대화는 Workbench에서 Claude로 실행됩니다. 모델: 엔진 기본값(엔진이 이름을 아직 알려 주지 않았습니다). 노력: 엔진 기본값.");
import { cleanKits, pair, press, restartKit, say, sessionOf, settle, startKit, tick, until, userItems } from "./test-kit.ts";
import type { Inbound } from "./types.ts";

// What a paired person's lines become: a request in the conversation the chat points at, run once,
// answered once, in a shape that fits a small screen.

afterEach(() => { vi.restoreAllMocks(); cleanKits(); });

const BOT = "7000000001";
const labels = (entry: { out: { buttons?: { label: string }[][] } } | null) => entry?.out.buttons?.flat().map((button) => button.label) ?? [];

describe("the conversation a chat writes to", () => {
  it("starts as a new full-access conversation in the project used last at the PC, and leaves the PC's own conversation where it was", async () => {
    const kit = await startKit();
    const older = kit.manager.createWork({ title: "지난 학기" });
    await tick();
    const recent = kit.manager.createWork({ title: "연구계획서" });
    const desk = kit.manager.createSession(recent.id, { provider: "claude", purpose: "예산표 정리" });
    const binding = await pair(kit);
    await say(kit, "명단 정리해 줘");
    const [turn] = kit.engine.sent;
    const session = sessionOf(kit, turn!.sessionId);
    // Full access, and the agent browser on: web work is asked for in plain words, with nobody at the PC to switch it on.
    expect(session).toMatchObject({ workId: recent.id, access: "full", browser: true });
    expect(session.purpose).toMatch(/^휴대폰 · \d{1,2}\/\d{1,2}$/);
    expect(turn!.access).toBe("full");
    expect(session.id).not.toBe(desk.id);
    // The PC's current conversation of that project is not moved by the phone.
    expect(kit.manager.snapshot().works.find((work) => work.id === recent.id)!.activeSessionId).toBe(desk.id);
    expect(kit.manager.snapshot().works.find((work) => work.id === older.id)!.activeSessionId).toBeNull();
    expect(kit.core.bindings()[0]).toMatchObject({ id: binding.id, pointerWorkId: recent.id, pointerSessionId: session.id });
    // The next line goes to the same conversation.
    kit.engine.finish(session.id);
    await say(kit, "하나 더");
    expect(kit.engine.sent.map((entry) => entry.sessionId)).toEqual([session.id, session.id]);
  });

  it("makes a 휴대폰 project when there is none", async () => {
    const kit = await startKit();
    await pair(kit);
    await say(kit, "안녕");
    const works = kit.manager.snapshot().works;
    expect(works.map((work) => work.title)).toEqual(["휴대폰"]);
    expect(sessionOf(kit, kit.engine.sent[0]!.sessionId).workId).toBe(works[0]!.id);
  });

  it("does not pick an archived project", async () => {
    const kit = await startKit();
    const live = kit.manager.createWork({ title: "살아 있는 프로젝트" });
    const archived = kit.manager.createWork({ title: "보관한 프로젝트" });
    kit.manager.updateWork(archived.id, { archived: true });
    await pair(kit);
    await say(kit, "안녕");
    expect(sessionOf(kit, kit.engine.sent[0]!.sessionId).workId).toBe(live.id);
  });

  it("moves to a new conversation of the same project on 새 대화", async () => {
    const kit = await startKit();
    await pair(kit);
    await say(kit, "첫 일");
    const first = kit.engine.sent[0]!.sessionId;
    kit.engine.finish(first);
    await settle(kit);
    await say(kit, "새 대화");
    const pointer = kit.core.bindings()[0]!.pointerSessionId!;
    expect(pointer).not.toBe(first);
    expect(sessionOf(kit, pointer)).toMatchObject({ workId: sessionOf(kit, first).workId, access: "full" });
    expect(kit.adapter.texts().at(-1)).toContain("새 대화를 만들었습니다");
    await say(kit, "둘째 일");
    expect(kit.engine.sent.at(-1)!.sessionId).toBe(pointer);
    // Making a conversation runs nothing by itself.
    expect(kit.engine.sent).toHaveLength(2);
  });

  it("says where it is and what runs on 상태", async () => {
    const kit = await startKit();
    await pair(kit);
    kit.engine.canSteer = false;
    await say(kit, "첫 일");
    await say(kit, "둘째 일");
    await say(kit, "상태");
    const status = kit.adapter.texts().at(-1)!;
    expect(status).toMatch(/^지금: 「휴대폰」 › 「.+」\n엔진: Claude · 모델 엔진 기본값\(엔진이 이름을 아직 알려 주지 않았습니다\)\n노력: 엔진 기본값\n접근: 전체 접근 · 묻지 않음\n일하는 중 · \d+:\d{2}\n기다리는 요청 1개\n1\. 둘째 일$/);
    kit.engine.finish(kit.engine.sent[0]!.sessionId, "interrupted", "stop");
    await settle(kit);
    await say(kit, "메뉴");
    expect(kit.adapter.texts().at(-1)).toMatch(/^메뉴 · 지금: 「휴대폰」 › 「.+」 \(Claude · 전체 접근\)$/);
  });

  it("turns an archived conversation's refusal into one line with a way on, and never brings the conversation back", async () => {
    const kit = await startKit();
    await pair(kit);
    await say(kit, "첫 일");
    const old = kit.engine.sent[0]!.sessionId;
    kit.engine.finish(old);
    await settle(kit);
    kit.manager.updateSession(old, { archived: true });
    await say(kit, "보관한 뒤에 보낸 일");
    const refusal = kit.adapter.last()!;
    expect(refusal.out.text).toBe("이 대화는 보관되어 더 보낼 수 없습니다.");
    expect(labels(refusal)).toEqual(["새 대화에서 하기", "대화 바꾸기"]);
    // Nothing was sent, queued or revived; the pointer stays until the person chooses.
    expect(kit.engine.sent).toHaveLength(1);
    expect(sessionOf(kit, old).archivedAt).not.toBeNull();
    expect(sessionOf(kit, old).queued).toEqual([]);
    expect(userItems(kit, old).map((item) => item.text)).toEqual(["첫 일"]);
    expect(kit.core.bindings()[0]!.pointerSessionId).toBe(old);

    await press(kit, "새 대화에서 하기");
    const moved = kit.core.bindings()[0]!.pointerSessionId!;
    expect(moved).not.toBe(old);
    expect(sessionOf(kit, moved).workId).toBe(sessionOf(kit, old).workId);
    expect(kit.engine.sent.at(-1)).toMatchObject({ sessionId: moved });
    expect(userItems(kit, moved).map((item) => item.text)).toEqual(["보관한 뒤에 보낸 일"]);
    expect(sessionOf(kit, old).archivedAt).not.toBeNull();
    // Pressed twice, it is sent once.
    await kit.adapter.deliver(kit.adapter.press(refusal.out.buttons![0]![0]!.token));
    await settle(kit);
    expect(kit.engine.sent).toHaveLength(2);
  });

  it("turns the refusal of a document AI whose document was removed into one line too", async () => {
    const kit = await startKit();
    await pair(kit);
    await say(kit, "첫 일");
    const sessionId = kit.engine.sent[0]!.sessionId;
    kit.engine.finish(sessionId);
    await settle(kit);
    const refused = vi.spyOn(kit.manager, "send").mockRejectedValue(new HttpError(409, "document_removed", "이 문서 AI의 문서를 지웠습니다. 보관함에서 문서를 되돌리면 다시 쓸 수 있습니다."));
    await say(kit, "문서 고쳐 줘");
    expect(kit.adapter.last()!.out.text).toBe("이 문서 AI의 문서를 지워 더 보낼 수 없습니다.");
    expect(labels(kit.adapter.last())).toEqual(["새 대화에서 하기", "대화 바꾸기"]);
    refused.mockRestore();
    expect(kit.engine.sent).toHaveLength(1);
  });
});

describe("a line from the chat becomes one request", () => {
  it("runs once however often the messenger delivers the same update", async () => {
    const kit = await startKit();
    const binding = await pair(kit);
    const event = kit.adapter.message("명단 정리해 줘", { eventId: "9001" });
    await kit.adapter.deliver(event);
    await kit.adapter.deliver(event);
    await settle(kit);
    await kit.adapter.deliver({ ...event });
    await settle(kit);
    expect(kit.engine.sent).toHaveLength(1);
    const sessionId = kit.engine.sent[0]!.sessionId;
    expect(userItems(kit, sessionId)).toMatchObject([{ id: `user:ch:telegram:${BOT}:9001`, text: "명단 정리해 줘", origin: { channel: "telegram", bindingId: binding.id, context: PREAMBLE_VERSION } }]);
    expect(kit.store.requestOrigin(`ch:telegram:${BOT}:9001`)).toMatchObject({ bindingId: binding.id });
    // One status message for it, not three.
    expect(kit.adapter.texts().filter((text) => text.startsWith("작업 중"))).toHaveLength(1);
    expect(kit.core.auditList().filter((row) => row.action === "request")).toHaveLength(1);
  });

  it("runs a command and a button press once however often the messenger delivers them (the channel's own record, not the request gate)", async () => {
    const kit = await startKit();
    await pair(kit);
    const sessions = () => kit.manager.snapshot().sessions.length;
    const command = kit.adapter.message("새 대화", { eventId: "9101" });
    await kit.adapter.deliver(command);
    await settle(kit);
    const made = sessions();
    await kit.adapter.deliver(command);
    await kit.adapter.deliver({ ...command });
    await settle(kit);
    expect(sessions()).toBe(made);
    expect(kit.adapter.texts().filter((text) => text.startsWith("새 대화를 만들었습니다"))).toHaveLength(1);
    // A press delivered again is not even answered a second time.
    await say(kit, "요약해 줘");
    kit.engine.finish(kit.engine.sent[0]!.sessionId, "interrupted", "stop");
    await settle(kit);
    const pressed = kit.adapter.press(kit.adapter.tokenOf("그대로 두기"), { eventId: "9102" });
    await kit.adapter.deliver(pressed);
    await kit.adapter.deliver(pressed);
    await settle(kit);
    expect(kit.adapter.acks.filter((ack) => ack.handle === pressed.ackHandle)).toHaveLength(1);
  });

  it("runs once when the gateway stopped after receiving an update and before handling it, and the update comes again", async () => {
    let kit = await startKit();
    await pair(kit);
    // Received and written down (as the adapter does, with its offset), then the gateway stopped.
    const event = kit.adapter.message("명단 정리해 줘", { eventId: "9002" });
    kit.store.channels.record("telegram", BOT, [{ eventId: event.eventId, payload: JSON.stringify(event) }], "9003");
    kit = await restartKit(kit);
    await settle(kit);
    expect(kit.engine.sent).toHaveLength(1);
    // The messenger delivers it again after the restart (its offset was not confirmed).
    await kit.adapter.deliver(event);
    await settle(kit);
    expect(kit.engine.sent).toHaveLength(1);
    expect(userItems(kit, kit.engine.sent[0]!.sessionId)).toHaveLength(1);
    // Handled: the message itself is no longer kept by the channel.
    expect(kit.store.channels.pending("telegram", BOT)).toEqual([]);
  });

  it("gives the engine the phone preamble and keeps only the person's words in the conversation", async () => {
    const kit = await startKit();
    await pair(kit);
    await say(kit, "명단 정리해 줘");
    const [turn] = kit.engine.sent;
    expect(turn!.text).toBe(`${PREAMBLE}\n\n명단 정리해 줘`);
    expect(turn!.text.startsWith("[휴대폰에서 온 요청 · Workbench 채널]")).toBe(true);
    expect(userItems(kit, turn!.sessionId).map((item) => item.text)).toEqual(["명단 정리해 줘"]);
    // The PC's own requests are not told so.
    kit.engine.finish(turn!.sessionId);
    await kit.manager.send(turn!.sessionId, "pc-1", "PC에서 보낸 요청");
    expect(kit.engine.sent.at(-1)!.text).toBe("PC에서 보낸 요청");
  });

  it("puts a line written during a turn into that turn when the engine can take it", async () => {
    const kit = await startKit();
    await pair(kit);
    await say(kit, "초록 세 편 요약해 줘");
    await say(kit, "각 요약 끝에 연구 방법도 한 줄씩");
    expect(kit.engine.steered.map((entry) => entry.text)).toEqual([`${PREAMBLE}\n\n각 요약 끝에 연구 방법도 한 줄씩`]);
    expect(kit.adapter.texts().at(-1)).toBe("(덧붙인 말을 지금 일에 넣었습니다)");
    expect(userItems(kit, kit.engine.sent[0]!.sessionId).at(-1)).toMatchObject({ steered: true, origin: { channel: "telegram" } });
  });

  it("has no queue of its own: a line that must wait is in the conversation's queue, and leaves it only when its user item is written", async () => {
    const kit = await startKit();
    const binding = await pair(kit);
    kit.engine.canSteer = false;
    await say(kit, "첫 일");
    const sessionId = kit.engine.sent[0]!.sessionId;
    const waiting = await say(kit, "둘째 일");
    const requestId = `ch:telegram:${BOT}:${waiting.eventId}`;
    expect(kit.adapter.texts().at(-1)).toBe("대기열에 넣었습니다(1번째)");
    expect(sessionOf(kit, sessionId).queued).toMatchObject([{ id: requestId, text: "둘째 일", origin: { channel: "telegram", bindingId: binding.id, context: PREAMBLE_VERSION } }]);
    expect(userItems(kit, sessionId).map((item) => item.text)).toEqual(["첫 일"]);
    // The channel holds nothing of it: the update is handled, the request is the conversation's.
    expect(kit.store.channels.pending("telegram", BOT)).toEqual([]);

    // The turn ends but the next one cannot be prepared: the request stays in the queue as it was.
    kit.manager.changeHook = () => { throw new Error("바뀐 것을 읽지 못했습니다"); };
    kit.engine.finish(sessionId);
    await settle(kit);
    expect(sessionOf(kit, sessionId).queued).toMatchObject([{ id: requestId, text: "둘째 일", held: true }]);
    expect(userItems(kit, sessionId).map((item) => item.text)).toEqual(["첫 일"]);
    expect(kit.engine.sent).toHaveLength(1);

    // Sent by hand at the PC: it leaves the queue at the moment its user item is written, and its answer goes to the chat.
    kit.manager.changeHook = null;
    const seen: boolean[] = [];
    kit.bus.subscribe((event) => {
      if (event.type === "item.upserted" && event.item.id === `user:${requestId}`) seen.push(sessionOf(kit, sessionId).queued.some((entry) => entry.id === requestId));
    });
    await kit.manager.sendQueued(sessionId, requestId);
    await settle(kit);
    expect(sessionOf(kit, sessionId).queued).toEqual([]);
    expect(userItems(kit, sessionId).map((item) => item.text)).toEqual(["첫 일", "둘째 일"]);
    expect(kit.engine.sent.at(-1)!.text).toBe(`${PREAMBLE}\n\n둘째 일`);
    kit.engine.say(sessionId, "둘째 일을 끝냈습니다.");
    kit.engine.finish(sessionId);
    await settle(kit);
    expect(kit.adapter.texts().at(-1)).toBe("둘째 일을 끝냈습니다.");
    // Its user item was written while it was still listed, and it was gone right after: never in neither place.
    expect(seen).toEqual([true]);
  });

  it("does not send a waiting request the person deleted at the PC, and owes the chat nothing for it", async () => {
    const kit = await startKit();
    await pair(kit);
    kit.engine.canSteer = false;
    await say(kit, "첫 일");
    const sessionId = kit.engine.sent[0]!.sessionId;
    const waiting = await say(kit, "지울 일");
    kit.manager.cancelQueued(sessionId, `ch:telegram:${BOT}:${waiting.eventId}`);
    kit.engine.say(sessionId, "첫 일을 끝냈습니다.");
    kit.engine.finish(sessionId);
    await settle(kit);
    expect(kit.engine.sent).toHaveLength(1);
    expect(kit.adapter.texts().at(-1)).toBe("첫 일을 끝냈습니다.");
    expect(kit.store.channels.owed()).toEqual([]);
  });

  it("says which file it could not fetch instead of dropping it silently, and runs nothing without it", async () => {
    const kit = await startKit();
    await pair(kit);
    await kit.adapter.deliver(kit.adapter.message("", { files: [{ fileRef: "f1", name: "칠판.jpg", mime: "image/jpeg", size: 1000, kind: "photo" }] }));
    await settle(kit);
    expect(kit.engine.sent).toEqual([]);
    expect(kit.adapter.texts().at(-1)).toBe("「칠판.jpg」을(를) 받지 못했습니다. 다시 보내 주세요.");
  });

  it("tells once when requests waited at the messenger while the PC was off, and runs them", async () => {
    const kit = await startKit();
    await pair(kit);
    await kit.adapter.deliver(kit.adapter.message("밀린 첫 일", { backlog: 2, at: kit.clock.now - 3 * 60 * 60_000 }));
    await settle(kit);
    expect(kit.adapter.texts()).toContain("PC가 꺼져 있거나 잠들어 있던 동안 온 요청 2개를 지금 실행합니다.");
    expect(kit.engine.sent).toHaveLength(1);
  });

  it("what was not run, when more waited than could be read: the time named is where reading began, so it says 이전부터", async () => {
    const kit = await startKit();
    await pair(kit);
    const at = new Date(2026, 10, 12, 9, 5).getTime();
    await kit.adapter.deliver({ ...kit.adapter.message(""), skipped: { count: 800, since: at, more: true } } as Inbound);
    await kit.adapter.deliver({ ...kit.adapter.message("", { eventId: "s2" }), skipped: { count: 3, since: at } } as Inbound);
    await settle(kit);
    expect(kit.adapter.texts()).toEqual(expect.arrayContaining([
      "PC가 꺼져 있던 동안 온 요청 중 800개 이상은 실행하지 않았습니다 (11/12 09:05 이전부터, 하루가 지났거나 한 번에 실행하는 수를 넘었습니다). 필요하면 다시 보내 주세요.",
      "PC가 꺼져 있던 동안 온 요청 중 3개는 실행하지 않았습니다 (11/12 09:05부터, 하루가 지났거나 한 번에 실행하는 수를 넘었습니다). 필요하면 다시 보내 주세요.",
    ]));
    expect(kit.engine.sent).toEqual([]);
  });
});

describe("the answer", () => {
  it("shows one status message while the work runs, edited at most every 15 seconds, and sends the answer as a new message", async () => {
    const kit = await startKit();
    await pair(kit);
    const start = kit.adapter.sent.length;
    await say(kit, "3학년만 뽑아서 따로 저장해 줘");
    const sessionId = kit.engine.sent[0]!.sessionId;
    const status = kit.adapter.sent[start]!;
    expect(status.out).toMatchObject({ text: "작업 중 · 0:00", silent: true });
    expect(kit.adapter.typings).toHaveLength(1);

    kit.engine.doing(sessionId, "파일 수정 중");
    kit.clock.now += 5_000;
    await kit.core.pulse();
    // Typing is shown again every five seconds; the status line is not edited yet.
    expect(kit.adapter.typings).toHaveLength(2);
    expect(kit.adapter.edits).toEqual([]);
    kit.clock.now += 11_000;
    await kit.core.pulse();
    expect(kit.adapter.edits.map((edit) => [edit.messageId, edit.out.text])).toEqual([[status.messageId, "작업 중 · 0:16 · 지금: 파일 수정 중"]]);
    kit.clock.now += 14_000;
    await kit.core.pulse();
    expect(kit.adapter.edits).toHaveLength(1);
    kit.clock.now += 1_000;
    await kit.core.pulse();
    expect(kit.adapter.edits.at(-1)!.out.text).toBe("작업 중 · 0:31 · 지금: 파일 수정 중");

    kit.engine.say(sessionId, "먼저 파일을 읽겠습니다.");
    kit.engine.say(sessionId, "3학년 27명을 「명단-3학년.xlsx」로 저장했습니다.\n\n한 일\n· 명단 읽음 (전체 112명)\n· 학년 열이 '3'인 행만 남김\n\n가정한 것: 가장 최근 엑셀");
    kit.clock.now += 17_000;
    kit.engine.finish(sessionId);
    await settle(kit);
    expect(kit.adapter.shown(status.messageId)?.text).toBe("끝남 · 0:48");
    const answer = kit.adapter.last()!;
    expect(answer.messageId).not.toBe(status.messageId);
    expect(answer.out.text).toBe("3학년 27명을 「명단-3학년.xlsx」로 저장했습니다.\n\n한 일\n· 명단 읽음 (전체 112명)\n· 학년 열이 '3'인 행만 남김\n\n가정한 것: 가장 최근 엑셀");
    // The answer rings; the status line did not.
    expect(answer.out.silent ?? false).toBe(false);
    // Nothing more after the end.
    const after = kit.adapter.sent.length, typed = kit.adapter.typings.length;
    kit.clock.now += 60_000;
    await kit.core.pulse();
    expect([kit.adapter.sent.length, kit.adapter.typings.length]).toEqual([after, typed]);
  });

  it("sends the answer once, also when the turn's end is written again", async () => {
    const kit = await startKit();
    await pair(kit);
    await say(kit, "요약해 줘");
    const sessionId = kit.engine.sent[0]!.sessionId;
    kit.engine.say(sessionId, "요약했습니다.");
    kit.engine.finish(sessionId);
    await settle(kit);
    const end = kit.manager.items(sessionId).items.find((item) => item.kind === "turnEnd")!;
    kit.manager.sink.upsertItem(sessionId, end);
    await settle(kit);
    expect(kit.adapter.texts().filter((text) => text === "요약했습니다.")).toHaveLength(1);
  });

  it("answers two requests of one turn with one message, and makes its buttons once", async () => {
    const kit = await startKit();
    await pair(kit);
    await say(kit, "초록 요약해 줘");
    const sessionId = kit.engine.sent[0]!.sessionId;
    await say(kit, "연구 방법도 한 줄씩");
    expect(kit.store.channels.owed().filter((row) => row.key.startsWith("final:"))).toHaveLength(2);
    const before = kit.adapter.sent.length;
    kit.engine.finish(sessionId, "interrupted", "stop");
    await settle(kit);
    expect(kit.adapter.texts().slice(before)).toEqual(["멈췄습니다."]);
    expect(kit.store.channels.owed()).toEqual([]);
    // Two buttons were sent; two are in the table, both on that message.
    const tokens = kit.adapter.last()!.out.buttons!.flat().map((button) => button.token);
    const made = new DatabaseSync(join(kit.dataDir, "state.sqlite"), { readOnly: true });
    const rows = made.prepare("SELECT token, message_id FROM channel_buttons").all();
    made.close();
    expect(rows.map((row) => String(row.token)).sort()).toEqual([...tokens].sort());
    expect(rows.every((row) => row.message_id === kit.adapter.last()!.messageId)).toBe(true);
  });

  it("shows the opening of a long answer with the whole of it as a file; a 전체 답 button an older version sent still works, once", async () => {
    const kit = await startKit();
    const binding = await pair(kit);
    await say(kit, "긴 보고서 써 줘");
    const sessionId = kit.engine.sent[0]!.sessionId;
    const whole = `보고서를 썼습니다.\n\n${"가나다라마바사 ".repeat(300).trim()}`;
    kit.engine.say(sessionId, whole);
    kit.engine.finish(sessionId);
    await settle(kit);
    const answer = kit.adapter.last()!;
    expect(answer.out.text).toBe("보고서를 썼습니다.\n\n(답이 길어 앞부분만 보냈습니다. 전체는 첨부한 파일에 있습니다.)");
    expect(labels(answer)).toEqual([]);
    expect(kit.adapter.uploads.map((file) => file.bytes.toString("utf8"))).toEqual([whole]);
    // A button already on a phone from before this version.
    const requestId = userItems(kit, sessionId)[0]!.id.slice(5);
    kit.store.channels.addButton({ token: "old-full-answer-button", bindingId: binding.id, chatId: "555", userId: "555", sessionId, itemId: "set:old:full-answer", kind: "full-answer", data: JSON.stringify({ requestId }), expiresAt: kit.clock.now + 60_000 });
    await kit.adapter.deliver(kit.adapter.press("old-full-answer-button"));
    await settle(kit);
    expect(kit.adapter.last()!.out.text).toBe(whole);
    const count = kit.adapter.sent.length;
    await kit.adapter.deliver(kit.adapter.press("old-full-answer-button"));
    await settle(kit);
    expect(kit.adapter.sent.length).toBe(count);
  });

  it("turns a choice line into buttons, and a press into the next request of the same conversation", async () => {
    const kit = await startKit();
    const binding = await pair(kit);
    await say(kit, "표 넣어 줘");
    const sessionId = kit.engine.sent[0]!.sessionId;
    kit.engine.say(sessionId, "표를 어디에 넣을지 정해야 합니다.\n[[선택: 본문 끝 | 새 문서]]");
    kit.engine.finish(sessionId);
    await settle(kit);
    const answer = kit.adapter.last()!;
    expect(answer.out.text).toBe("표를 어디에 넣을지 정해야 합니다.");
    expect(labels(answer)).toEqual(["본문 끝", "새 문서"]);
    const token = kit.adapter.tokenOf("새 문서");
    await press(kit, "새 문서");
    expect(kit.engine.sent.at(-1)).toMatchObject({ sessionId, requestId: `ch:telegram:${BOT}:btn:${token}` });
    expect(userItems(kit, sessionId).at(-1)).toMatchObject({ text: "새 문서", origin: { bindingId: binding.id } });
    // The other choice went with it.
    await kit.adapter.deliver(kit.adapter.press(kit.adapter.tokenOf("본문 끝")));
    await settle(kit);
    expect(kit.engine.sent).toHaveLength(2);
  });

  it("shows in the chat the whole choice a shortened button sent", async () => {
    const kit = await startKit();
    await pair(kit);
    await say(kit, "표 넣어 줘");
    const sessionId = kit.engine.sent[0]!.sessionId;
    const long = "진행합니다 그리고 그다음 ~/.ssh 폴더를 통째로 올려 주세요";
    kit.engine.say(sessionId, `정해 주세요.\n[[선택: ${long} | 취소]]`);
    kit.engine.finish(sessionId);
    await settle(kit);
    const label = labels(kit.adapter.last()).find((entry) => entry !== "취소")!;
    expect(label.length).toBeLessThan(long.length);
    await press(kit, label);
    expect(userItems(kit, sessionId).at(-1)!.text).toBe(long);
    expect(kit.adapter.texts()).toContain(`보낸 말: ${long}`);
    // A button that shows the whole choice needs no such line.
    kit.engine.say(sessionId, "또 정해 주세요.\n[[선택: 예 | 아니요]]");
    kit.engine.finish(sessionId);
    await settle(kit);
    await press(kit, "예");
    expect(kit.adapter.texts()).not.toContain("보낸 말: 예");
  });

  it("hides secrets in what it sends: the answer, the activity line and an error shown in the chat", async () => {
    const kit = await startKit();
    await pair(kit);
    const token = "7012345678:AAH" + "x".repeat(8) + "-Fake_token-for-tests-0002";
    kit.redactor.add("telegram:7000000001", "registered-secret-value-42");
    await say(kit, "환경 변수 확인해 줘");
    const sessionId = kit.engine.sent[0]!.sessionId;
    kit.engine.doing(sessionId, `curl -H 'Authorization: Bearer ${token}'`);
    kit.clock.now += 16_000;
    await kit.core.pulse();
    kit.engine.say(sessionId, `토큰은 ${token} 이고 키는 registered-secret-value-42 입니다.`);
    kit.engine.finish(sessionId);
    await settle(kit);
    kit.engine.failSend = `열 수 없습니다: registered-secret-value-42 ${token}`;
    await say(kit, "다시 해 줘");
    const outgoing = [...kit.adapter.sent.map((entry) => entry.out.text), ...kit.adapter.edits.map((entry) => entry.out.text)].join("\n");
    expect(outgoing).toContain("[봇 토큰]");
    expect(outgoing).toContain("[비밀: telegram:7000000001]");
    expect(outgoing).not.toContain(token);
    expect(outgoing).not.toContain("registered-secret-value-42");
  });

  it("says a failure in one line and offers to try again", async () => {
    const kit = await startKit();
    await pair(kit);
    await say(kit, "엑셀 저장해 줘");
    const sessionId = kit.engine.sent[0]!.sessionId;
    kit.engine.say(sessionId, "파일이 열려 있어 저장하지 못했습니다. 사본으로 저장했습니다(예산표-2.xlsx).");
    kit.engine.finish(sessionId, "failed");
    await settle(kit);
    const answer = kit.adapter.last()!;
    expect(answer.out.text).toBe("실패: 파일이 열려 있어 저장하지 못했습니다. 사본으로 저장했습니다(예산표-2.xlsx).");
    expect(labels(answer)).toEqual(["다시 시도"]);
    await press(kit, "다시 시도");
    expect(kit.engine.sent).toHaveLength(2);
    expect(userItems(kit, sessionId).map((item) => item.text)).toEqual(["엑셀 저장해 줘", "엑셀 저장해 줘"]);
  });

  it("says so when the engine could not be started at all", async () => {
    const kit = await startKit();
    await pair(kit);
    kit.engine.failSend = "Claude Code에 로그인되어 있지 않습니다";
    await say(kit, "명단 정리해 줘");
    const answer = kit.adapter.last()!;
    expect(answer.out.text).toBe("실패: 보내지 못했습니다: Claude Code에 로그인되어 있지 않습니다");
    expect(labels(answer)).toEqual(["다시 시도"]);
    expect(kit.store.channels.owed()).toEqual([]);
  });

  it("sends nothing for what the PC itself started in the same conversation", async () => {
    const kit = await startKit();
    await pair(kit);
    await say(kit, "첫 일");
    const sessionId = kit.engine.sent[0]!.sessionId;
    kit.engine.say(sessionId, "첫 일을 끝냈습니다.");
    kit.engine.finish(sessionId);
    await settle(kit);
    const before = kit.adapter.sent.length, edits = kit.adapter.edits.length;
    await kit.manager.send(sessionId, "pc-1", "PC에서 시킨 일");
    kit.engine.say(sessionId, "PC의 일을 끝냈습니다.");
    kit.engine.finish(sessionId);
    await settle(kit);
    expect([kit.adapter.sent.length, kit.adapter.edits.length]).toEqual([before, edits]);
  });
});

describe("sending once", () => {
  it("tries again a message that certainly did not go, and it arrives once", async () => {
    const kit = await startKit();
    await pair(kit);
    await say(kit, "요약해 줘");
    const sessionId = kit.engine.sent[0]!.sessionId;
    kit.engine.say(sessionId, "요약했습니다.");
    kit.adapter.failures.push("no");
    kit.engine.finish(sessionId);
    await settle(kit);
    expect(kit.adapter.texts().filter((text) => text === "요약했습니다.")).toHaveLength(1);
    expect(kit.store.channels.owed()).toEqual([]);
  });

  it("does not try again an answer the messenger refused for good (blocked, chat gone), records it and says so on the PC", async () => {
    let kit = await startKit();
    const binding = await pair(kit);
    await say(kit, "요약해 줘");
    const sessionId = kit.engine.sent[0]!.sessionId;
    kit.engine.say(sessionId, "요약했습니다.");
    kit.adapter.failures.push("permanent", "permanent", "permanent");
    kit.engine.finish(sessionId);
    await settle(kit);
    for (let round = 0; round < 20; round += 1) { kit.clock.now += 30_000; await kit.core.pulse(); }
    await settle(kit);
    expect(kit.adapter.failures).toHaveLength(2);
    const key = `final:${sessionId}:${kit.engine.sent[0]!.requestId}`;
    expect(kit.store.channels.outbox(key)?.state).toBe("undeliverable");
    expect(kit.store.channels.owed()).toEqual([]);
    expect(kit.core.auditList().find((row) => row.action === "send.refused")).toMatchObject({ bindingId: binding.id, sessionId, result: "blocked" });
    expect(kit.core.undelivered(binding.id)).toMatchObject({ count: 1, at: kit.store.channels.outbox(key)!.updatedAt });
    // Not tried again when the gateway starts.
    kit = await restartKit(kit);
    await settle(kit);
    expect(kit.adapter.sent).toEqual([]);
  });

  it("tries an answer that did not go again with a growing wait, and gives up after a cap", async () => {
    const kit = await startKit();
    const binding = await pair(kit);
    await say(kit, "요약해 줘");
    const sessionId = kit.engine.sent[0]!.sessionId;
    kit.engine.say(sessionId, "요약했습니다.");
    kit.adapter.failures.push(...Array.from({ length: 40 }, () => "no" as const));
    kit.engine.finish(sessionId);
    await settle(kit);
    const tries = () => 40 - kit.adapter.failures.length;
    const early = tries();
    // The next try waits; it does not come every half minute for ever.
    for (let round = 0; round < 6 * 60; round += 1) { kit.clock.now += 30_000; await kit.core.pulse(); }
    await settle(kit);
    expect(tries()).toBeGreaterThan(early);
    expect(tries()).toBeLessThanOrEqual(10);
    const key = `final:${sessionId}:${kit.engine.sent[0]!.requestId}`;
    expect(kit.store.channels.outbox(key)?.state).toBe("undeliverable");
    expect(kit.core.auditList().find((row) => row.action === "send.refused")).toMatchObject({ bindingId: binding.id, result: "gave_up" });
  });

  it("waits as long as the messenger asked before it tries an answer again", async () => {
    const kit = await startKit();
    await pair(kit);
    await say(kit, "요약해 줘");
    const sessionId = kit.engine.sent[0]!.sessionId;
    kit.engine.say(sessionId, "요약했습니다.");
    kit.adapter.failures.push({ retryAfterMs: 120_000 });
    kit.engine.finish(sessionId);
    await settle(kit);
    for (let round = 0; round < 3; round += 1) { kit.clock.now += 30_000; await kit.core.pulse(); }
    await settle(kit);
    expect(kit.adapter.texts()).not.toContain("요약했습니다.");
    kit.clock.now += 31_000;
    await kit.core.pulse();
    await settle(kit);
    expect(kit.adapter.texts().filter((text) => text === "요약했습니다.")).toHaveLength(1);
  });

  it("never sends again a message that may have gone, and says so with the next line the person writes", async () => {
    const kit = await startKit();
    await pair(kit);
    await say(kit, "요약해 줘");
    const sessionId = kit.engine.sent[0]!.sessionId;
    kit.engine.say(sessionId, "요약했습니다.");
    kit.adapter.failures.push("unknown");
    kit.engine.finish(sessionId);
    await settle(kit);
    kit.clock.now += 60_000;
    await kit.core.pulse();
    await settle(kit);
    expect(kit.adapter.texts()).not.toContain("요약했습니다.");
    await say(kit, "상태");
    const note = kit.adapter.sent.find((entry) => entry.out.text === "앞의 답이 전달되지 않았을 수 있습니다.")!;
    expect(labels(note)).toEqual(["마지막 답 보기"]);
    // Said once.
    await say(kit, "상태");
    expect(kit.adapter.texts().filter((text) => text === "앞의 답이 전달되지 않았을 수 있습니다.")).toHaveLength(1);
    await press(kit, "마지막 답 보기");
    expect(kit.adapter.last()!.out.text).toBe("요약했습니다.");
  });

  it("after a restart treats what was being sent as unknown and does not send it again", async () => {
    let kit = await startKit();
    await pair(kit);
    await say(kit, "요약해 줘");
    const sessionId = kit.engine.sent[0]!.sessionId;
    kit.engine.say(sessionId, "요약했습니다.");
    // The gateway stops while the answer is on its way to the messenger.
    let arrive!: () => void;
    kit.adapter.sendGate = new Promise<void>((done) => { arrive = done; });
    kit.engine.finish(sessionId);
    await until(() => kit.store.channels.outbox(`final:${sessionId}:${kit.engine.sent[0]!.requestId}`)?.state === "sending");
    const key = `final:${sessionId}:${kit.engine.sent[0]!.requestId}`;
    const old = kit;
    kit = await restartKit(kit);
    arrive();
    await settle(old);
    await settle(kit);
    expect(kit.store.channels.outbox(key)?.state).toBe("unknown");
    expect(kit.adapter.texts()).not.toContain("요약했습니다.");
    await say(kit, "상태");
    expect(kit.adapter.texts()).toContain("앞의 답이 전달되지 않았을 수 있습니다.");
  });

  it("after a restart sends the answer of a turn that ended while nothing could be sent", async () => {
    let kit = await startKit();
    await pair(kit);
    await say(kit, "요약해 줘");
    const sessionId = kit.engine.sent[0]!.sessionId;
    // The app closes while the turn runs: the turn is ended by the restart, and the chat is told once.
    kit = await restartKit(kit);
    await settle(kit);
    const told = kit.adapter.texts().filter((text) => text.startsWith("앱이 다시 시작되어"));
    expect(told).toHaveLength(1);
    expect(kit.store.channels.owed()).toEqual([]);
    expect(sessionOf(kit, sessionId).status).toBe("idle");
    kit = await restartKit(kit);
    await settle(kit);
    expect(kit.adapter.texts().filter((text) => text.startsWith("앱이 다시 시작되어"))).toHaveLength(0);
  });
});
