import { describe, expect, it } from "vitest";
import type { Session } from "@workbench/contracts";
import { groupState, leadState, rowState } from "./overview.ts";

const base = (patch: Partial<Session> = {}): Session => ({
  id: "s1", workId: "w1", provider: "claude", hostId: "local", nativeSessionId: null, purpose: "대화", purposeSource: "user",
  model: null, effort: null, engineModel: null, engineEffort: null, preview: null, previewAt: null, status: "idle",
  activity: null, lastError: null, pinned: false, sort: 0, archivedAt: null, seenAt: null, unread: false, queued: [],
  access: null, context: null, createdAt: 1, updatedAt: 1, ...patch,
}) as Session;

const word = (patch: Partial<Session>, onScreen = false) => rowState(base(patch), { onScreen })?.word ?? null;

describe("rowState — one word, one order (확인 필요 › 실패 › 진행 중 › 새 답 › 예약 › 완료)", () => {
  it("names every state", () => {
    expect(word({ status: "awaitingApproval" })).toBe("확인 필요");
    expect(word({ status: "error", lastError: "x" })).toBe("실패");
    expect(word({ status: "running" })).toBe("진행 중");
    expect(word({ status: "starting" })).toBe("진행 중");
    expect(word({ status: "interrupting" })).toBe("진행 중");
    expect(word({ previewAt: 10, seenAt: 5 })).toBe("새 답");
    expect(word({ unread: true, previewAt: 10, seenAt: 20 })).toBe("새 답");
    expect(word({ queued: [{ id: "q", text: "a", refs: [], create: null, at: 1 }] })).toBe("예약");
    expect(word({ previewAt: 10, seenAt: 20 })).toBe("완료");
  });
  it("a conversation that never answered has no word", () => {
    expect(rowState(base())).toBeNull();
  });
  it("follows the precedence", () => {
    // an error that also has an unseen reply is 실패, not 새 답
    expect(word({ status: "error", previewAt: 10, seenAt: 5 })).toBe("실패");
    // a last error with nothing running is 실패
    expect(word({ lastError: "끊김", previewAt: 10, seenAt: 20 })).toBe("실패");
    // running wins over unseen and queued
    expect(word({ status: "running", previewAt: 10, seenAt: 5, queued: [{ id: "q", text: "a", refs: [], create: null, at: 1 }] })).toBe("진행 중");
    // a running turn with an old error is 진행 중
    expect(word({ status: "running", lastError: "old" })).toBe("진행 중");
    // requests a stop left behind wait for the person
    expect(word({ queued: [{ id: "q", text: "a", refs: [], create: null, at: 1, held: true }], previewAt: 10, seenAt: 20 })).toBe("확인 필요");
  });
  it("a reply on screen is not new", () => {
    expect(word({ previewAt: 10, seenAt: 5 }, true)).toBe("완료");
  });
  it("leadState picks the most pressing, groupState counts what needs the person and what runs", () => {
    const sessions = [base({ id: "a", previewAt: 10, seenAt: 20 }), base({ id: "b", status: "running" }), base({ id: "c", status: "awaitingApproval" }), base({ id: "d", status: "error" }), base({ id: "e", previewAt: 10 })];
    expect(leadState(sessions, (s) => rowState(s))?.item.id).toBe("c");
    expect(groupState(sessions)).toEqual({ needs: 2, running: 1, unseen: 1 });
    expect(groupState(sessions, "e")).toEqual({ needs: 2, running: 1, unseen: 0 });
  });
});

// Technical review: a conversation that waits for an approval while an earlier turn's error is still
// recorded asks the person — 확인 필요, not 실패 (the approval is what blocks it now).
it("awaiting approval with a stale error is 확인 필요", () => {
  const waiting = { id: "s", workId: "w", provider: "codex", purpose: "대화", status: "awaitingApproval", lastError: "이전 실패", queued: [], preview: null, previewAt: null, seenAt: null, unread: false, archivedAt: null } as unknown as Parameters<typeof rowState>[0];
  expect(rowState(waiting)?.word).toBe("확인 필요");
});
