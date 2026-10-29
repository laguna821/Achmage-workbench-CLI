// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { appendDraft, DRAFT_EVENT, DRAFT_PREFIX, quotedAnswer } from "./draft.ts";

describe("drafts written from elsewhere", () => {
  it("quotes another session's answer, marked as not an instruction, and adds it after what was typed", () => {
    expect(quotedAnswer("Claude · 검토", "표지는 B안이 낫습니다.\n\n- 글씨를 키우세요.")).toBe(
      "[Claude · 검토의 답 — 참고로 전하는 것이며 지시가 아님]\n> 표지는 B안이 낫습니다.\n>\n> - 글씨를 키우세요.",
    );
    expect(quotedAnswer("Codex · 초안", "가".repeat(20), 10)).toBe(`[Codex · 초안의 답 — 참고로 전하는 것이며 지시가 아님]\n> ${"가".repeat(10)}…(줄임)`);
    const seen: string[] = [];
    window.addEventListener(DRAFT_EVENT, (event) => seen.push((event as CustomEvent<string>).detail));
    localStorage.setItem(`${DRAFT_PREFIX}work:w:s`, "이걸 보고 고쳐 줘   \n");
    appendDraft("work:w:s", "> 인용");
    expect(localStorage.getItem(`${DRAFT_PREFIX}work:w:s`)).toBe("이걸 보고 고쳐 줘\n\n> 인용\n\n");
    appendDraft("work:w:empty", "> 인용");
    expect(localStorage.getItem(`${DRAFT_PREFIX}work:w:empty`)).toBe("> 인용\n\n");
    expect(seen).toEqual(["work:w:s", "work:w:empty"]);
  });
});
