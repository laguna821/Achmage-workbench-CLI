import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ApprovalDecision, ProviderStatus, Session, TranscriptItem } from "@workbench/contracts";
import { EventBus } from "./bus.ts";
import { claudeHistory, codexHistory, type ClaudeRecord, type CodexTurn } from "./imports.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";
import { emptyStatus, type NativeConversation, type ProviderAdapter } from "./providers/types.ts";

// "가져오기": an engine's record of a conversation made elsewhere, continued here.

const assistant = (id: string, content: unknown[]) => ({ id, type: "message", role: "assistant", model: "m", content, stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });

describe("a Claude Code record as a transcript", () => {
  const records: ClaudeRecord[] = [
    { type: "user", uuid: "u1", parent_tool_use_id: null, message: { role: "user", content: "폴더를 정리해 줘" } },
    { type: "assistant", uuid: "a1", parent_tool_use_id: null, message: assistant("m1", [{ type: "text", text: "살펴보겠습니다." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]) },
    { type: "user", uuid: "r1", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }] } },
    { type: "assistant", uuid: "a2", parent_tool_use_id: null, message: assistant("m2", [{ type: "text", text: "a.txt 하나뿐입니다." }]) },
    { type: "user", uuid: "c1", parent_tool_use_id: null, message: { role: "user", content: "<command-name>/cost</command-name>" } },
    { type: "user", uuid: "u2", parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text: "고마워" }] } },
    { type: "assistant", uuid: "a3", parent_tool_use_id: null, message: assistant("m3", [{ type: "text", text: "천만에요." }]) },
  ];

  it("keeps requests, replies and steps in order, with a turn end before each next request", () => {
    const items = claudeHistory(records, 1_000, 7_000);
    expect(items.map((item) => (item.kind === "user" || item.kind === "assistant" ? `${item.kind}:${item.text}` : item.kind))).toEqual([
      "user:폴더를 정리해 줘",
      "assistant:살펴보겠습니다.",
      "tool",
      "assistant:a.txt 하나뿐입니다.",
      "turnEnd",
      "user:고마워",
      "assistant:천만에요.",
      "turnEnd",
    ]);
    const tool = items.find((item) => item.kind === "tool");
    expect(tool).toMatchObject({ status: "completed", output: "a.txt" });
    const times = items.map((item) => item.at);
    expect(times[0]).toBe(1_000);
    expect(Math.max(...times)).toBeLessThanOrEqual(7_000);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("finishes a step the record left running", () => {
    const items = claudeHistory(records.slice(0, 2), 0, 10);
    expect(items.find((item) => item.kind === "tool")).toMatchObject({ status: "completed" });
  });
});

describe("Codex turns as a transcript", () => {
  it("maps each turn's request, work and end", () => {
    const turns: CodexTurn[] = [
      {
        id: "turn1",
        status: "completed",
        startedAt: 100,
        completedAt: 104,
        items: [
          { type: "userMessage", id: "um1", content: [{ type: "text", text: "테스트 돌려 줘", text_elements: [] }] },
          { type: "commandExecution", id: "c1", command: "npm test", cwd: "/w", status: "completed", aggregatedOutput: "ok", exitCode: 0, commandActions: [], processId: null, source: "agent", durationMs: 10 },
          { type: "agentMessage", id: "am1", text: "모두 통과했습니다.", phase: null, memoryCitation: null },
        ],
      },
      { id: "turn2", status: "interrupted", startedAt: 200, completedAt: 201, items: [{ type: "userMessage", id: "um2", content: [{ type: "text", text: "멈춰", text_elements: [] }] }] },
    ];
    const items = codexHistory(turns);
    expect(items.map((item) => item.kind)).toEqual(["user", "tool", "assistant", "turnEnd", "user", "turnEnd"]);
    expect(items[0]).toMatchObject({ text: "테스트 돌려 줘", at: 100_000 });
    expect(items[3]).toMatchObject({ status: "completed", durationMs: 4_000 });
    expect(items[5]).toMatchObject({ status: "interrupted" });
  });
});

class RecordEngine implements ProviderAdapter {
  readonly provider = "codex" as const;
  private readonly cwd: string;
  constructor(cwd: string) {
    this.cwd = cwd;
  }
  async init() {}
  status(): ProviderStatus {
    return emptyStatus("codex");
  }
  async refreshStatus() {
    return this.status();
  }
  async login() {
    return { url: null, message: "" };
  }
  async send() {}
  async interrupt() {}
  async answerApproval(_session: Session, _itemId: string, _decision: ApprovalDecision) {
    return false;
  }
  async shutdown() {}
  conversations(): NativeConversation[] {
    return [
      { nativeSessionId: "thr_term", title: "터미널 대화", cwd: this.cwd, updatedAt: 5_000 },
      { nativeSessionId: "thr_gone", title: "사라진 폴더", cwd: join(this.cwd, "없음"), updatedAt: 4_000 },
    ];
  }
  async listNative() {
    return this.conversations();
  }
  async nativeHistory(id: string) {
    const entry = this.conversations().find((conversation) => conversation.nativeSessionId === id)!;
    const items: TranscriptItem[] = [
      { kind: "user", id: "user:x", text: "안녕", at: 1_000 },
      { kind: "assistant", id: "a:x", text: "안녕하세요. 무엇을 도와드릴까요?", streaming: false, at: 2_000 },
      { kind: "turnEnd", id: "end:x", status: "completed", durationMs: 1_000, at: 2_000 },
    ];
    return { ...entry, items };
  }
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wb-import-"));
  dirs.push(dir);
  const manager = new SessionManager(new Store(join(dir, "state.sqlite")), new EventBus(), { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works"), dataDir: dir });
  manager.registerAdapter(new RecordEngine(dir));
  return { manager, dir };
}

describe("importing a conversation", () => {
  it("binds a session to it in the work of its folder, with its record and the note where it came from", async () => {
    const { manager, dir } = setup();
    const before = manager.createWork({ title: "같은 폴더", cwd: dir });
    const session = await manager.importSession({ provider: "codex", nativeSessionId: "thr_term" });
    expect(session).toMatchObject({ workId: before.id, nativeSessionId: "thr_term", purpose: "터미널 대화", preview: "안녕하세요. 무엇을 도와드릴까요?" });
    const items = manager.items(session.id).items;
    expect(items.map((item) => item.kind)).toEqual(["notice", "user", "assistant", "turnEnd"]);
    expect(items[0]).toMatchObject({ text: expect.stringContaining("Codex에서 가져온 대화입니다") });
  });

  it("does it once, says which ones are here already, and offers none whose folder is gone", async () => {
    const { manager } = setup();
    const first = await manager.importSession({ provider: "codex", nativeSessionId: "thr_term" });
    const again = await manager.importSession({ provider: "codex", nativeSessionId: "thr_term" });
    expect(again.id).toBe(first.id);
    const candidates = await manager.importCandidates("codex", "");
    expect(candidates.map((entry) => [entry.nativeSessionId, entry.sessionId])).toEqual([["thr_term", first.id]]);
  });

  it("refuses a conversation whose folder is gone (the engine resumes there)", async () => {
    const { manager } = setup();
    await expect(manager.importSession({ provider: "codex", nativeSessionId: "thr_gone" })).rejects.toThrow(/작업 폴더가 없습니다/);
    expect(manager.snapshot().sessions).toHaveLength(0);
  });
});
