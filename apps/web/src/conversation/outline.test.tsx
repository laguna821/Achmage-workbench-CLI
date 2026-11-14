// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TranscriptItem } from "@workbench/contracts";
import { headingsOf, jumpInNote, outlineOf, registerNoteTarget } from "./outline.ts";

const user = (id: string, text: string): TranscriptItem => ({ kind: "user", id, text, at: 1 });
const answer = (id: string): TranscriptItem => ({ kind: "assistant", id, text: "답", streaming: false, at: 2 });
const end = (id: string): TranscriptItem => ({ kind: "turnEnd", id, status: "completed", durationMs: 1000, at: 3 } as unknown as TranscriptItem);
const asks = (id: string): TranscriptItem => ({ kind: "approval", id, title: "명령 실행", detail: null, reason: null, decision: null, at: 2 });

afterEach(() => { document.body.innerHTML = ""; });

describe("a conversation's outline", () => {
  it("numbers the requests as the note does and keeps the first line of each", () => {
    const rows = outlineOf([answer("a0"), user("u1", "## 슬라이드 구성을\n다시 짜 줘"), answer("a1"), end("e1"), user("u2", ""), end("e2")], false);
    expect(rows.map((row) => [row.index, row.text])).toEqual([[1, "슬라이드 구성을"], [2, "첨부한 파일"]]);
  });

  it("marks the request waiting for an answer and the one still running", () => {
    const rows = outlineOf([user("u1", "하나"), asks("p1"), user("u2", "둘"), answer("a2")], true);
    expect(rows.map((row) => [row.id, row.attention, row.running])).toEqual([["u1", true, false], ["u2", false, true]]);
    expect(outlineOf([user("u1", "하나"), end("e1")], true)[0]!.running).toBe(false);
  });
});

describe("a Markdown document's outline", () => {
  it("lists headings with their level and line, outside front matter and code", () => {
    const text = ["---", "title: # 아님", "---", "# 강의안", "본문", "```", "# 코드 속", "```", "## 1주차 ##", "### 과제"].join("\n");
    expect(headingsOf(text)).toEqual([
      { line: 3, level: 1, text: "강의안" },
      { line: 8, level: 2, text: "1주차" },
      { line: 9, level: 3, text: "과제" },
    ]);
  });
});

describe("jumping into a note", () => {
  it("goes to the copy in the focused pane when the note is open twice", () => {
    document.body.innerHTML = `<div class="pane" data-pane-active="false"><div id="left"></div></div><div class="pane" data-pane-active="true"><div id="right"></div></div>`;
    const left = vi.fn(), right = vi.fn();
    const offLeft = registerNoteTarget("chat:s", { element: () => document.getElementById("left"), jump: left });
    const offRight = registerNoteTarget("chat:s", { element: () => document.getElementById("right"), jump: right });
    expect(jumpInNote("chat:s", "u2")).toBe(true);
    expect(right).toHaveBeenCalledWith("u2", undefined);
    expect(left).not.toHaveBeenCalled();
    offRight();
    jumpInNote("chat:s", "u1");
    expect(left).toHaveBeenCalledWith("u1", undefined);
    offLeft();
    expect(jumpInNote("chat:s", "u1")).toBe(false);
  });

  it("skips a copy in a hidden tab", () => {
    document.body.innerHTML = `<div class="pane" hidden><div id="hidden"></div></div><div class="pane"><div id="shown"></div></div>`;
    const hidden = vi.fn(), shown = vi.fn();
    const off = [registerNoteTarget("chat:t", { element: () => document.getElementById("hidden"), jump: hidden }), registerNoteTarget("chat:t", { element: () => document.getElementById("shown"), jump: shown })];
    jumpInNote("chat:t", "u1");
    expect(shown).toHaveBeenCalled();
    expect(hidden).not.toHaveBeenCalled();
    off.forEach((stop) => stop());
  });
});
