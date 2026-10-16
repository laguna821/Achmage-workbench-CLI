import { describe, expect, it } from "vitest";
import { mapThreadItem } from "./map.ts";
import type { ThreadItem } from "./generated/v2/ThreadItem.ts";

const item = (value: unknown) => value as ThreadItem;

describe("mapThreadItem", () => {
  it("marks a completed command with a non-zero exit code as failed", () => {
    const mapped = mapThreadItem(
      item({ type: "commandExecution", id: "c1", command: "false", cwd: "/w", status: "completed", exitCode: 1, aggregatedOutput: "x", commandActions: [] }),
      1,
      false,
    );
    expect(mapped).toMatchObject({ kind: "tool", tool: "command", title: "false", status: "failed", output: "x" });
  });

  it("summarizes multi-file changes", () => {
    const mapped = mapThreadItem(
      item({ type: "fileChange", id: "f1", status: "inProgress", changes: [{ path: "a.md", kind: "add", diff: "+a" }, { path: "b.md", kind: "update", diff: "+b" }] }),
      1,
      true,
    );
    expect(mapped).toMatchObject({ kind: "tool", tool: "fileChange", title: "파일 2개 변경", status: "running" });
  });

  it("streams agent messages and skips user messages", () => {
    expect(mapThreadItem(item({ type: "agentMessage", id: "a1", text: "hi" }), 1, true)).toMatchObject({ kind: "assistant", streaming: true });
    expect(mapThreadItem(item({ type: "userMessage", id: "u1", content: [] }), 1, false)).toBeNull();
  });
});
