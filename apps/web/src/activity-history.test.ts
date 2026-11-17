import { describe, expect, it } from "vitest";
import type { HistoryEvent } from "@workbench/contracts";
import { foldHistory, historyDays, historyText, mergePages, took, type HistoryContext } from "./activity-history.ts";

// 활동 › 기록: what a line says, the folding of one conversation's run, the day groups, pages joined.

const at = (hour: number, minute = 0, day = 17) => new Date(2026, 10, day, hour, minute).getTime();
const ev = (id: string, when: number, kind: HistoryEvent["kind"], extra: Partial<HistoryEvent> = {}): HistoryEvent => ({ id, at: when, kind, workId: "w", sessionId: "s", artifactId: null, itemId: id, provider: "claude", ...extra });
const ctx: HistoryContext = {
  work: (id) => (id === "w" ? { title: "강의 준비" } : null),
  session: (id) => (id === "s" ? { purpose: "3주차 슬라이드", provider: "claude" } : id === "t" ? { purpose: "회의록", provider: "codex" } : id === "doc-ai" ? { purpose: "문서 AI", provider: "claude", artifactId: "d" } : null),
  artifact: (id) => (id === "d" ? { name: "보고서.md" } : null),
};

describe("historyText: one plain Korean line", () => {
  it("requests say who sent them, what, and a wait in the line", () => {
    expect(historyText(ev("a", 1, "request", { via: "pc", text: "표 고쳐 줘" }))).toBe("요청 「표 고쳐 줘」");
    expect(historyText(ev("a", 1, "request", { via: "phone", text: "요약" }))).toBe("휴대폰에서 요청 「요약」");
    expect(historyText(ev("a", 1, "request", { via: "schedule", text: "아침 정리" }))).toBe("예약으로 요청 「아침 정리」");
    expect(historyText(ev("a", 1, "request", { via: "handover", text: "이어서" }))).toBe("넘겨받은 요청 「이어서」");
    expect(historyText(ev("a", 1, "request", { via: "pc", text: "길게", waitedMs: 72_000 }))).toBe("요청 「길게」 · 차례를 1분 12초 기다림");
    expect(historyText(ev("a", 1, "request", { via: "pc", text: "짧게", waitedMs: 2_000 }))).toBe("요청 「짧게」");
  });
  it("turn ends: answered with its duration, failed, stopped and why", () => {
    expect(historyText(ev("a", 1, "answer", { durationMs: 192_000 }))).toBe("답을 마침 · 3분 12초");
    expect(historyText(ev("a", 1, "answer", { durationMs: 8_000 }))).toBe("답을 마침 · 8초");
    expect(historyText(ev("a", 1, "failed", { durationMs: 5_000 }))).toBe("답하지 못함 (실패)");
    expect(historyText(ev("a", 1, "stopped", { cause: "stop" }))).toBe("멈춤 (직접 멈춤)");
    expect(historyText(ev("a", 1, "stopped", { cause: "restart" }))).toBe("멈춤 (앱이 다시 시작됨)");
  });
  it("approvals and questions with how they were answered", () => {
    expect(historyText(ev("a", 1, "approval", { text: "명령 실행", decision: null, open: true }))).toBe("승인 요청 「명령 실행」 · 기다리는 중");
    expect(historyText(ev("a", 1, "approval", { text: "명령 실행", decision: "accept" }))).toBe("승인 요청 「명령 실행」 · 허용함");
    expect(historyText(ev("a", 1, "approval", { plan: true, decision: "accept" }))).toBe("계획 확인 요청 · 진행함");
    expect(historyText(ev("a", 1, "approval", { text: "파일 지우기", decision: "decline" }))).toBe("승인 요청 「파일 지우기」 · 거절함");
    expect(historyText(ev("a", 1, "question", { text: "어느 표?", decision: "accept" }))).toBe("질문 「어느 표?」 · 답함");
    expect(historyText(ev("a", 1, "question", { text: "어느 표?", decision: null }))).toBe("질문 「어느 표?」 · 답하지 않음");
  });
  it("documents and conversations", () => {
    expect(historyText(ev("a", 1, "doc-created", { author: "engine", name: "a.md" }))).toBe("AI가 문서를 만듦");
    expect(historyText(ev("a", 1, "doc-revised", { author: "user", revision: 3 }))).toBe("문서를 고침 (3판)");
    expect(historyText(ev("a", 1, "doc-revised", { author: "external", revision: 4 }))).toBe("다른 프로그램에서 고침 (4판)");
    expect(historyText(ev("a", 1, "proposal-applied"))).toBe("수정안 적용");
    expect(historyText(ev("a", 1, "proposal-discarded"))).toBe("수정안 버림");
    expect(historyText(ev("a", 1, "doc-renamed", { from: "a.md", name: "b.md" }))).toBe("이름 바꿈 「a.md」 → 「b.md」");
    expect(historyText(ev("a", 1, "doc-removed", { removal: "trash" }))).toBe("휴지통으로 옮김");
    expect(historyText(ev("a", 1, "doc-removed", { removal: "unlisted" }))).toBe("목록에서 뺌");
    expect(historyText(ev("a", 1, "session-created"))).toBe("대화를 만듦");
    expect(historyText(ev("a", 1, "session-archived"))).toBe("대화를 보관함");
  });
  it("took: seconds under a minute, then minutes and hours", () => {
    expect(took(0)).toBe("1초 미만");
    expect(took(59_400)).toBe("59초");
    expect(took(3_600_000 + 120_000)).toBe("1시간 2분");
  });
});

describe("foldHistory: one conversation's run is one expandable line", () => {
  it("folds a conversation's lines within a short time, even between other conversations' lines", () => {
    const lines = [
      ev("e3", at(10, 30), "answer", { durationMs: 1000 }),
      ev("x", at(10, 29), "request", { sessionId: "t", via: "pc", text: "다른 일" }),
      ev("u3", at(10, 28), "request", { via: "pc", text: "셋" }),
      ev("e2", at(10, 20), "answer"),
      ev("u2", at(10, 18), "request", { via: "pc" }),
      ev("e1", at(10, 10), "answer"),
      ev("u1", at(10, 5), "request", { via: "pc" }),
    ];
    const folded = foldHistory(lines, ctx);
    expect(folded.map((entry) => entry.kind === "one" ? entry.event.id : `fold:${entry.events.length}`)).toEqual(["fold:6", "x"]);
    const first = folded[0]!;
    expect(first.kind === "fold" && first.summary).toBe("대화 「3주차 슬라이드」 · 요청 3건, 답 3건");
  });
  it("a long pause starts a new line; a failure, a stop and what still asks are never folded away", () => {
    const lines = [
      ev("a", at(15), "answer"),
      ev("b", at(14, 58), "request", { via: "pc" }),
      ev("f", at(14, 50), "failed"),
      ev("o", at(14, 45), "approval", { decision: null, open: true }),
      ev("c", at(11), "answer"),
      ev("d", at(10, 55), "request", { via: "pc" }),
    ];
    expect(foldHistory(lines, ctx).map((entry) => entry.kind === "one" ? entry.event.id : entry.events.map((event) => event.id).join("+"))).toEqual(["a+b", "f", "o", "c+d"]);
  });
  it("a document's own lines fold by the document; a day boundary is never crossed", () => {
    const lines = [
      ev("r3", at(0, 5, 17), "doc-revised", { sessionId: null, artifactId: "d", author: "user", revision: 3 }),
      ev("r2", at(23, 55, 16), "doc-revised", { sessionId: null, artifactId: "d", author: "user", revision: 2 }),
      ev("r1", at(23, 50, 16), "doc-revised", { sessionId: null, artifactId: "d", author: "user", revision: 1 }),
    ];
    const folded = foldHistory(lines, ctx);
    expect(folded.map((entry) => entry.kind)).toEqual(["one", "fold"]);
    const second = folded[1]!;
    expect(second.kind === "fold" && second.summary).toBe("문서 「보고서.md」 · 고침 2건");
  });
});

describe("historyDays: 오늘 / 어제 / the date", () => {
  it("groups newest first by day", () => {
    const now = at(12);
    const groups = historyDays([ev("a", at(9), "answer"), ev("b", at(22, 0, 16), "answer"), ev("c", at(8, 0, 14), "answer"), ev("d", at(8, 0, 14) - 1, "answer")].map((event) => ({ kind: "one" as const, key: event.id, at: event.at, event })), now);
    expect(groups.map((group) => [group.label, group.entries.length])).toEqual([["오늘", 1], ["어제", 1], ["11월 14일 (토)", 2]]);
  });
});

describe("mergePages: a fresh first page joins the pages already read", () => {
  it("keeps the older lines once, the new ones first", () => {
    const old = [ev("b", 20, "answer"), ev("c", 10, "answer")];
    expect(mergePages([ev("a", 30, "request"), ev("b", 20, "answer")], old).map((event) => event.id)).toEqual(["a", "b", "c"]);
  });
});
