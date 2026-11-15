import { describe, expect, it } from "vitest";
import type { Session } from "@workbench/contracts";
import { statusText, statusTone } from "./format.ts";
import { ROW_STATES, rowState } from "./row-state.ts";

// Skin 2 fix 1, design review finding 6: ONE state vocabulary. statusText still said 대기 중 / 응답 중 /
// 승인 필요 / 오류 beside rowState's 확인 필요 › 실패 › 진행 중 › 새 답 › 예약 › 완료 (the document head's way
// back read "← 대화 승인 필요"). Every word it says now comes from rowState; while a conversation
// works, the engine's own account of what it does (activity) may stand in for 진행 중.
const base = { id: "s", workId: "w", provider: "codex", purpose: "대화", status: "idle", queued: [], lastError: null, preview: null, previewAt: null, seenAt: null, unread: false, archivedAt: null } as unknown as Session;
const s = (patch: Partial<Session>) => ({ ...base, ...patch }) as Session;
const WORDS = new Set(Object.values(ROW_STATES).map((entry) => entry.word));

describe("statusText speaks the one vocabulary (rowState)", () => {
  const cases: [string, Session][] = [
    ["never answered", s({})],
    ["idle with a reply", s({ preview: "답", previewAt: 2, seenAt: 3 })],
    ["new answer", s({ preview: "답", previewAt: 5, seenAt: 1 })],
    ["starting", s({ status: "starting" })],
    ["running", s({ status: "running" })],
    ["stopping", s({ status: "interrupting" })],
    ["awaiting approval", s({ status: "awaitingApproval" })],
    ["error", s({ status: "error" })],
  ];
  it.each(cases)("%s", (_, session) => {
    const text = statusText(session);
    const word = rowState(session)?.word ?? "";
    expect(text).toBe(word);
    expect(text === "" || WORDS.has(text)).toBe(true);
  });

  it("while it works, the engine's account of what it does stands in for 진행 중", () => {
    expect(statusText(s({ status: "running", activity: "명령 실행 중" } as Partial<Session>))).toBe("명령 실행 중");
    expect(statusText(s({ status: "awaitingApproval", activity: "명령 실행 중" } as Partial<Session>))).toBe("확인 필요");
  });

  it("its tone follows the same state", () => {
    expect(statusTone(s({ status: "awaitingApproval" }))).toBe("attention");
    expect(statusTone(s({ status: "error" }))).toBe("error");
    expect(statusTone(s({ status: "running" }))).toBe("active");
    expect(statusTone(s({ queued: [{ id: "q", text: "x", held: true }] } as unknown as Partial<Session>))).toBe("attention");
    expect(statusTone(s({}))).toBe("idle");
  });
});
