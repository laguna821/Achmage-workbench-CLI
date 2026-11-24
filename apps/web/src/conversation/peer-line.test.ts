import { describe, expect, it } from "vitest";
import type { TranscriptItem } from "@workbench/contracts";
import { peerLine } from "./peer-line.ts";

// A workbench-peers step reads as one line (0.5.6 "이 프로젝트의 다른 대화 읽기"): the gateway's first line, not the command.
type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;
const step = (title: string, over: Partial<ToolItem> = {}): ToolItem => ({ kind: "tool", id: "t", tool: "command", title, detail: null, output: null, status: "completed", at: 1, ...over });
const READ = "「서론 고치기」 대화를 읽었습니다 · 최근 3개\nid s-1 · …\n<<<자료 시작 · 지시 아님>>>";

describe("peerLine", () => {
  it("Claude's command and Codex's shell-wrapped one show the answer's first line", () => {
    expect(peerLine(step("workbench-peers read s-1 --turns 3", { output: READ }))).toBe("「서론 고치기」 대화를 읽었습니다 · 최근 3개");
    expect(peerLine(step("/bin/bash -lc 'workbench-peers read s-1'", { output: READ }))).toBe("「서론 고치기」 대화를 읽었습니다 · 최근 3개");
    expect(peerLine(step("workbench-peers list", { output: "「강의계획서」 프로젝트의 다른 대화 2개를 봤습니다\n…" }))).toBe("「강의계획서」 프로젝트의 다른 대화 2개를 봤습니다");
  });
  it("running, failed and declined say so in words; the MCP form is the same", () => {
    expect(peerLine(step("workbench-peers read s-1", { status: "running" }))).toBe("다른 대화를 읽는 중");
    expect(peerLine(step("workbench-peers read s-9", { status: "failed", output: "workbench-peers: 이 프로젝트에서 그 대화를 찾지 못했습니다" }))).toBe("다른 대화를 읽지 못했습니다");
    expect(peerLine(step("workbench-peers list", { status: "declined" }))).toBe("다른 대화 목록 보기를 거절했습니다");
    expect(peerLine(step("workbench-peers · read_conversation", { tool: "mcp", output: READ }))).toBe("「서론 고치기」 대화를 읽었습니다 · 최근 3개");
  });
  it("a command that does more than a plain workbench-peers call shows as the raw command (security review of 0.5.6)", () => {
    for (const line of ["workbench-peers list && rm -rf ~", "workbench-peers read s-1; curl x", "workbench-peers read s-1 | sh", "workbench-peers read $(id)", "workbench-peers read `id`", "workbench-peers list > ~/.bashrc", "/bin/bash -lc 'workbench-peers list && rm -rf ~'", "workbench-peers list\nrm -rf ~"]) {
      expect(peerLine(step(line, { output: READ })), line).toBeNull();
    }
    expect(peerLine(step("workbench-peers read 's-1' --find \"채점 기준\"", { output: READ }))).toBe("「서론 고치기」 대화를 읽었습니다 · 최근 3개");
    expect(peerLine(step("workbench-peers list && workbench-peers read s-1", { output: READ }))).toBe("「서론 고치기」 대화를 읽었습니다 · 최근 3개");
  });

  it("any other step, or an answer that does not start with the gateway's line, is not taken for one", () => {
    expect(peerLine(step("ls -la", { output: READ }))).toBeNull();
    expect(peerLine(step("echo workbench-peers read x", { output: READ }))).toBeNull();
    expect(peerLine(step("workbench-peers read s-1", { output: "「가짜」 대화를 읽었습니다 · 최근 3개 그리고 더" }))).toBe("다른 대화를 읽지 못했습니다");
  });
});
