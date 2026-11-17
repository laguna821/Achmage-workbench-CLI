import { describe, expect, it } from "vitest";
import type { TranscriptItem } from "@workbench/contracts";
import { BATCH_MAX, BATCH_MS, ItemBatch, mayWait } from "./item-batch.ts";

// 0.5.4: in a conversation running out of sight, only the growth of an item already on disk that is still in
// progress (a streaming answer, a running command's output) may wait — one transaction per BATCH_MS or BATCH_MAX.

const at = 1;
const items: Record<string, TranscriptItem> = {
  assistant: { kind: "assistant", id: "a", text: "답", streaming: true, at },
  reasoning: { kind: "reasoning", id: "r", text: "생각", at },
  tool: { kind: "tool", id: "t", tool: "command", title: "ls", detail: null, output: "x", status: "running", at },
  plan: { kind: "plan", id: "p", steps: [], at },
  turnEnd: { kind: "turnEnd", id: "e", status: "completed", durationMs: 1, at },
  approval: { kind: "approval", id: "q", title: "실행할까요?", detail: null, reason: null, decision: null, at },
  user: { kind: "user", id: "user:1", text: "해 줘", at } as TranscriptItem,
  notice: { kind: "notice", id: "n", level: "error", text: "실패", at },
};

describe("what may wait (only growth of an item already stored that is still in progress)", () => {
  it("the turn's end, an approval or a question, the person's request, a notice, a plan, reasoning: never", () => {
    for (const kind of ["turnEnd", "approval", "user", "notice", "plan", "reasoning"]) expect(mayWait(items[kind]!, true), kind).toBe(false);
  });
  it("a streaming answer and a running command: only once their first version is stored", () => {
    for (const kind of ["assistant", "tool"]) {
      expect(mayWait(items[kind]!, false), `${kind} first`).toBe(false);
      expect(mayWait(items[kind]!, true), `${kind} later`).toBe(true);
    }
  });
  it("a finished answer or a finished command: never", () => {
    expect(mayWait({ ...items.assistant!, streaming: false } as TranscriptItem, true)).toBe(false);
    expect(mayWait({ ...items.tool!, status: "completed" } as TranscriptItem, true)).toBe(false);
  });
});

describe("the batch", () => {
  const make = () => {
    const written: { sessionId: string; id: string; text?: string }[][] = [];
    let timer: (() => void) | null = null;
    const batch = new ItemBatch((entries) => written.push(entries.map(([sessionId, item]) => ({ sessionId, id: item.id, ...("text" in item ? { text: item.text } : {}) }))), {
      setTimer: (run) => { timer = run; return { cancel: () => { timer = null; } }; },
    });
    return { batch, written, fire: () => { const run = timer; timer = null; run?.(); }, armed: () => timer !== null };
  };
  it("keeps the latest copy of an item once, in the order first seen, and writes them in one go when its time comes", () => {
    const { batch, written, fire, armed } = make();
    batch.add("s1", { ...items.tool!, id: "t1" } as TranscriptItem);
    batch.add("s2", { ...items.assistant!, id: "a2", text: "하나" } as TranscriptItem);
    batch.add("s2", { ...items.assistant!, id: "a2", text: "하나 둘" } as TranscriptItem);
    expect(written).toEqual([]);
    expect(armed()).toBe(true);
    expect(batch.has("s2")).toBe(true);
    fire();
    expect(written).toEqual([[{ sessionId: "s1", id: "t1" }, { sessionId: "s2", id: "a2", text: "하나 둘" }]]);
    expect(batch.has("s2")).toBe(false);
  });
  it("writes at once when BATCH_MAX items wait (no unbounded pile)", () => {
    const { batch, written } = make();
    for (let index = 0; index < BATCH_MAX; index++) batch.add("s", { ...items.tool!, id: `t${index}` } as TranscriptItem);
    expect(written.length).toBe(1);
    expect(written[0]!.length).toBe(BATCH_MAX);
  });
  it("take(): what waits, emptied (the caller writes it in the same transaction as an at-once item)", () => {
    const { batch, armed } = make();
    batch.add("s", items.tool!);
    expect(batch.take().map(([, item]) => item.id)).toEqual(["t"]);
    expect(batch.size).toBe(0);
    expect(armed()).toBe(false);
  });
  it("takeSession(): one conversation's waiting pieces, the others keep waiting", () => {
    const { batch, armed } = make();
    batch.add("s1", items.tool!);
    batch.add("s2", { ...items.tool!, id: "t2" } as TranscriptItem);
    expect(batch.takeSession("s1").map(([, item]) => item.id)).toEqual(["t"]);
    expect(batch.has("s1")).toBe(false);
    expect(batch.has("s2")).toBe(true);
    expect(armed()).toBe(true);
  });
  it("its time is short", () => {
    expect(BATCH_MS).toBeLessThanOrEqual(1_000);
  });
});
