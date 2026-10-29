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

  it("says which files a command read, as Codex parsed it, made absolute", () => {
    const mapped = mapThreadItem(
      item({
        type: "commandExecution",
        id: "c2",
        command: "sed -n '1,40p' notes/a.md && cat /v/b.md && ls",
        cwd: "/w",
        status: "completed",
        exitCode: 0,
        aggregatedOutput: "",
        commandActions: [
          { type: "read", command: "sed -n '1,40p' notes/a.md", name: "a.md", path: "notes/a.md" },
          { type: "read", command: "cat /v/b.md", name: "b.md", path: "/v/b.md" },
          { type: "listFiles", command: "ls", path: null },
        ],
      }),
      1,
      false,
    );
    expect(mapped).toMatchObject({ kind: "tool", tool: "command", reads: ["/w/notes/a.md", "/v/b.md"] });
    expect(mapThreadItem(item({ type: "commandExecution", id: "c3", command: "ls", cwd: "/w", status: "completed", exitCode: 0, aggregatedOutput: "", commandActions: [] }), 1, false)).not.toHaveProperty("reads");
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
