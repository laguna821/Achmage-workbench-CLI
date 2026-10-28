import { describe, expect, it } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeTranscriptMapper, usageFromRateLimit } from "./map.ts";

const msg = (value: unknown) => value as SDKMessage;
const streamEvent = (event: unknown) => msg({ type: "stream_event", event, parent_tool_use_id: null, uuid: "u", session_id: "s" });

describe("ClaudeTranscriptMapper", () => {
  it("reports how full the context is after a turn, and compaction as a notice", () => {
    const mapper = new ClaudeTranscriptMapper(() => 1);
    mapper.handle(
      msg({
        type: "assistant",
        message: { id: "m9", content: [], usage: { input_tokens: 12, cache_creation_input_tokens: 500, cache_read_input_tokens: 41_000, output_tokens: 488 } },
        parent_tool_use_id: null,
        uuid: "a9",
        session_id: "s",
      }),
      "t1",
    );
    const ended = mapper.handle(
      msg({ type: "result", subtype: "success", is_error: false, result: "", duration_ms: 5, modelUsage: { "claude-x": { contextWindow: 200_000 } }, uuid: "r", session_id: "s" }),
      "t1",
    );
    expect(ended).toContainEqual({ type: "context", used: 42_000, window: 200_000 });

    expect(mapper.handle(msg({ type: "system", subtype: "status", status: "compacting", uuid: "c0", session_id: "s" }), "t2")).toEqual([{ type: "activity", text: "대화를 압축하는 중" }]);
    const compacted = mapper.handle(
      msg({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 156_400, post_tokens: 23_100 }, uuid: "c1", session_id: "s" }),
      "t2",
    );
    expect(compacted).toContainEqual({ type: "context", used: 23_100, window: null });
    expect(compacted.find((entry) => entry.type === "upsert")).toMatchObject({
      item: { kind: "notice", text: "대화가 길어 앞부분을 요약해 압축했습니다 (156k → 23k 토큰)." },
    });
  });

  it("streams text into one assistant item and finalizes it", () => {
    const mapper = new ClaudeTranscriptMapper(() => 1);
    const out = [
      ...mapper.handle(streamEvent({ type: "message_start", message: { id: "m1" } }), "t1"),
      ...mapper.handle(streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }), "t1"),
      ...mapper.handle(streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "안녕" } }), "t1"),
      ...mapper.handle(streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "하세요" } }), "t1"),
      ...mapper.handle(streamEvent({ type: "content_block_stop", index: 0 }), "t1"),
    ];
    expect(out.filter((o) => o.type === "delta").map((o) => (o.type === "delta" ? o.text : ""))).toEqual(["안녕", "하세요"]);
    const final = out.filter((o) => o.type === "upsert").at(-1);
    expect(final).toMatchObject({ item: { kind: "assistant", id: "m1:0", text: "안녕하세요", streaming: false } });
  });

  it("does not duplicate streamed text when the full assistant message arrives", () => {
    const mapper = new ClaudeTranscriptMapper(() => 1);
    mapper.handle(streamEvent({ type: "message_start", message: { id: "m1" } }), "t1");
    mapper.handle(streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }), "t1");
    const out = mapper.handle(
      msg({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "hi" }] }, parent_tool_use_id: null, uuid: "a1", session_id: "s" }),
      "t1",
    );
    expect(out.some((o) => o.type === "upsert" && o.item.kind === "assistant")).toBe(false);
  });

  it("maps tool use and its result, and TodoWrite to a plan", () => {
    const mapper = new ClaudeTranscriptMapper(() => 1);
    const started = mapper.handle(
      msg({
        type: "assistant",
        message: {
          id: "m2",
          content: [
            { type: "tool_use", id: "tool1", name: "Bash", input: { command: "ls -la", description: "list" } },
            { type: "tool_use", id: "tool2", name: "TodoWrite", input: { todos: [{ content: "읽기", status: "completed" }, { content: "쓰기", status: "in_progress" }] } },
          ],
        },
        parent_tool_use_id: null,
        uuid: "a2",
        session_id: "s",
      }),
      "turn-9",
    );
    expect(started).toContainEqual(expect.objectContaining({ type: "upsert", item: expect.objectContaining({ kind: "tool", tool: "command", title: "ls -la", status: "running" }) }));
    expect(started).toContainEqual(
      expect.objectContaining({
        type: "upsert",
        item: expect.objectContaining({ kind: "plan", id: "plan:turn-9", steps: [{ text: "읽기", status: "completed" }, { text: "쓰기", status: "inProgress" }] }),
      }),
    );
    const finished = mapper.handle(
      msg({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool1", content: "total 0", is_error: false }] }, parent_tool_use_id: null }),
      "turn-9",
    );
    expect(finished[0]).toMatchObject({ type: "upsert", item: { id: "tool1", status: "completed", output: "total 0" } });
  });

  it("keeps a declined tool declined when its error result arrives", () => {
    const mapper = new ClaudeTranscriptMapper(() => 1);
    mapper.handle(
      msg({ type: "assistant", message: { id: "m3", content: [{ type: "tool_use", id: "t", name: "Write", input: { file_path: "/a" } }] }, parent_tool_use_id: null, uuid: "x", session_id: "s" }),
      "k",
    );
    mapper.markDeclined("t");
    const out = mapper.handle(msg({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "denied", is_error: true }] }, parent_tool_use_id: null }), "k");
    expect(out[0]).toMatchObject({ item: { status: "declined" } });
  });

  it("ends the turn on result messages", () => {
    const mapper = new ClaudeTranscriptMapper(() => 1);
    const out = mapper.handle(msg({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom"], duration_ms: 5 }), "k");
    expect(out[0]).toEqual({ type: "turnEnd", status: "failed", durationMs: 5, error: "boom", queued: 0 });
  });

  it("shows a message another Claude Code session sent as a request from that session", () => {
    const mapper = new ClaudeTranscriptMapper(() => 7);
    // The harness gives the decoded body and the sender's display name.
    const decoded = mapper.handle(
      msg({
        type: "user",
        message: { role: "user", content: '<cross-session-message from="local_1" from-name="리서치">\n표 2를 다시 봐 주세요\n</cross-session-message>' },
        parent_tool_use_id: null,
        origin: { kind: "peer", from: "local_1", name: "리서치", body: "표 2를 다시 봐 주세요" },
        uuid: "p1",
        session_id: "s",
      }),
      "k",
    );
    expect(decoded).toEqual([
      { type: "peer", item: { kind: "user", id: "peer:p1", text: "표 2를 다시 봐 주세요", at: 7, peer: { name: "리서치", from: "local_1" } }, starts: true },
    ]);
    // Older senders: only the envelope, which is taken apart here.
    const wrapped = mapper.handle(
      msg({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: '<cross-session-message from="local_2" from-name="초안">\n끝났어요\n</cross-session-message>' }] },
        parent_tool_use_id: null,
        origin: { kind: "peer", from: "local_2" },
        session_id: "s",
      }),
      "k",
    );
    expect(wrapped[0]).toMatchObject({ type: "peer", item: { text: "끝났어요", peer: { name: "초안", from: "local_2" } } });
    // Relayed between sessions of a coordinator; a message only appended (no turn) does not start one.
    const relayed = mapper.handle(
      msg({ type: "user", message: { role: "user", content: "검토 부탁" }, parent_tool_use_id: null, origin: { kind: "task-notification", subkind: "peer-send-message" }, shouldQuery: false, uuid: "p3", session_id: "s" }),
      "k",
    );
    expect(relayed).toEqual([{ type: "peer", item: { kind: "user", id: "peer:p3", text: "검토 부탁", at: 7, peer: { name: null, from: null } }, starts: false }]);
  });

  it("keeps ignoring other user messages: the user's own (not echoed), tool results, other notifications", () => {
    const mapper = new ClaudeTranscriptMapper(() => 1);
    expect(mapper.handle(msg({ type: "user", message: { role: "user", content: "hi" }, parent_tool_use_id: null, origin: { kind: "human" } }), "k")).toEqual([]);
    expect(mapper.handle(msg({ type: "user", message: { role: "user", content: "hi" }, parent_tool_use_id: null }), "k")).toEqual([]);
    expect(mapper.handle(msg({ type: "user", message: { role: "user", content: "done" }, parent_tool_use_id: null, origin: { kind: "task-notification" } }), "k")).toEqual([]);
    // A subagent's peer traffic stays inside the subagent.
    expect(mapper.handle(msg({ type: "user", message: { role: "user", content: "x" }, parent_tool_use_id: "t1", origin: { kind: "peer", from: "a", body: "x" } }), "k")).toEqual([]);
  });
});

describe("usageFromRateLimit", () => {
  it("converts fractional utilization and second timestamps", () => {
    expect(usageFromRateLimit({ status: "allowed", rateLimitType: "five_hour", utilization: 0.42, resetsAt: 1_800_000_000 })).toEqual({
      label: "5시간",
      usedPercent: 42,
      resetsAt: 1_800_000_000_000,
    });
    expect(usageFromRateLimit({ status: "allowed" })).toBeNull();
  });
});
