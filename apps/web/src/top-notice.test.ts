import { expect, it, vi } from "vitest";
import { EMPTY_NOTICES, asSlot, failure, lifetime, noticeReducer, type Notices, type NoticeSlot } from "./top-notice.ts";

const done = (id: string, text = `${id} · 답변 완료`): NoticeSlot => ({ kind: "completion", completion: { id, provider: "codex", text, others: [] } });
const info = (text: string): NoticeSlot => ({ kind: "info", text });
const error = (text: string): NoticeSlot => ({ kind: "error", text });
const run = (...actions: Parameters<typeof noticeReducer>[1][]) => actions.reduce<Notices>(noticeReducer, EMPTY_NOTICES);

it("shows the newest notice in the one slot", () => {
  const state = run({ type: "show", slot: info("복사했습니다.") }, { type: "show", slot: done("s1") });
  expect(state.current).toEqual(done("s1"));
  expect(run({ type: "show", slot: done("s1") }, { type: "show", slot: info("저장했습니다.") }).current).toEqual(info("저장했습니다."));
});

it("counts other sessions, not repeats of the same one", () => {
  const state = run({ type: "show", slot: done("s1") }, { type: "show", slot: done("s2") }, { type: "show", slot: done("s1") });
  expect(state.current?.kind === "completion" && state.current.completion).toMatchObject({ id: "s1", others: ["s2"] });
  const same = run({ type: "show", slot: done("s1") }, { type: "show", slot: done("s1") });
  expect(same.current?.kind === "completion" && same.current.completion.others).toEqual([]);
});

it("never replaces an error silently: later notices wait until it leaves", () => {
  let state = run({ type: "show", slot: error("저장하지 못했습니다.") }, { type: "show", slot: done("s1") }, { type: "show", slot: done("s2") });
  expect(state.current).toEqual(error("저장하지 못했습니다."));
  state = noticeReducer(state, { type: "close" });
  expect(state.current?.kind === "completion" && state.current.completion).toMatchObject({ id: "s2", others: ["s1"] });
  state = noticeReducer(state, { type: "close" });
  expect(state.current).toBeNull();
});

it("a newer error waits behind the one showing", () => {
  let state = run({ type: "show", slot: error("하나") }, { type: "show", slot: error("둘") }, { type: "show", slot: info("셋") });
  expect(state.current).toEqual(error("하나"));
  state = noticeReducer(state, { type: "close" });
  expect(state.current).toEqual(error("둘"));
});

it("a completion leaves at once when its conversation comes on screen, waiting or showing", () => {
  expect(noticeReducer(run({ type: "show", slot: done("s1") }), { type: "seen", onScreen: new Set(["s1"]) }).current).toBeNull();
  const behind = run({ type: "show", slot: error("오류") }, { type: "show", slot: done("s1") });
  const seen = noticeReducer(behind, { type: "seen", onScreen: new Set(["s1"]) });
  expect(noticeReducer(seen, { type: "close" }).current).toBeNull();
  expect(noticeReducer(run({ type: "show", slot: done("s1") }), { type: "seen", onScreen: new Set(["s2"]) }).current).toEqual(done("s1"));
});

it("keeps the existing lifetimes", () => {
  expect(lifetime(done("s1"))).toBe(6000);
  expect(lifetime(info("복사했습니다."))).toBe(6000);
  expect(lifetime(error("실패"))).toBe(6000);
  expect(lifetime({ kind: "info", text: "만들었습니다", action: { label: "열기", run: () => {} } })).toBe(9000);
});

it("a document save failure stays until it leaves; a completion arriving meanwhile shows after it", () => {
  // As DocumentView reports it: decided where the failure happens, not by its text.
  const saveFailed = asSlot(failure(new Error("디스크가 가득 찼습니다."), "저장하지 못했습니다: "));
  expect(saveFailed).toEqual({ kind: "error", text: "저장하지 못했습니다: 디스크가 가득 찼습니다.", action: undefined });
  let state = run({ type: "show", slot: saveFailed }, { type: "show", slot: done("s1") });
  expect(state.current).toEqual(saveFailed);
  state = noticeReducer(state, { type: "close" });
  expect(state.current).toEqual(done("s1"));
  // Plain strings stay results of the user's own actions.
  expect(asSlot("복사했습니다.")).toEqual({ kind: "info", text: "복사했습니다." });
});

it("an undo notice is not replaced by a completion: the completion waits until it leaves", () => {
  const undo = vi.fn();
  const undoable: NoticeSlot = { kind: "info", text: "프로젝트 2개를 보관함으로 옮겼습니다.", action: { label: "되돌리기", run: undo } };
  let state = run({ type: "show", slot: undoable }, { type: "show", slot: done("s1") });
  expect(state.current).toBe(undoable);
  if (state.current?.kind === "info") state.current.action!.run();
  expect(undo).toHaveBeenCalledTimes(1);
  state = noticeReducer(state, { type: "close" });
  expect(state.current).toEqual(done("s1"));
  // Without an action, a plain result can still be replaced.
  expect(run({ type: "show", slot: info("복사했습니다.") }, { type: "show", slot: done("s1") }).current).toEqual(done("s1"));
});
