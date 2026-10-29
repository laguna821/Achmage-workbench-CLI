import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Artifact, Session } from "@workbench/contracts";
import { Store } from "./store.ts";
import { buildTimeline, firstLine, type TurnMark } from "./timeline.ts";

// Home "흐름": turns paired from stored requests and turn ends, and revision ticks.

const mark = (sessionId: string, kind: TurnMark["kind"], at: number, extra: Partial<TurnMark> = {}): TurnMark => ({
  sessionId,
  workId: "w",
  kind,
  at,
  status: kind === "turnEnd" ? "completed" : null,
  durationMs: null,
  steered: false,
  ...extra,
});

describe("buildTimeline", () => {
  it("pairs each request with the end of its turn, per session", () => {
    const { turns } = buildTimeline([mark("a", "user", 10), mark("a", "turnEnd", 50), mark("a", "user", 60), mark("a", "turnEnd", 90, { status: "interrupted" }), mark("b", "user", 20), mark("b", "turnEnd", 30, { status: "failed" })], [], 0);
    expect(turns).toEqual([
      { sessionId: "a", workId: "w", start: 10, end: 50, status: "completed" },
      { sessionId: "b", workId: "w", start: 20, end: 30, status: "failed" },
      { sessionId: "a", workId: "w", start: 60, end: 90, status: "interrupted" },
    ]);
  });

  it("keeps a steered request inside its turn and closes a turn that never recorded its end", () => {
    const { turns } = buildTimeline([mark("a", "user", 10), mark("a", "user", 20, { steered: true }), mark("a", "turnEnd", 40), mark("a", "user", 50), mark("a", "user", 80), mark("a", "turnEnd", 95)], [], 0);
    expect(turns.map((turn) => [turn.start, turn.end, turn.status])).toEqual([
      [10, 40, "completed"],
      [50, 80, "interrupted"],
      [80, 95, "completed"],
    ]);
  });

  it("leaves the running turn open and starts an end without its request by its duration", () => {
    const { turns } = buildTimeline([mark("a", "turnEnd", 100, { durationMs: 30 }), mark("b", "user", 70)], [], 60);
    expect(turns).toEqual([
      { sessionId: "a", workId: "w", start: 70, end: 100, status: "completed" },
      { sessionId: "b", workId: "w", start: 70, end: null, status: "open" },
    ]);
  });
});

describe("store marks", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("reads requests, turn ends and revisions since a time, with their work", () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-timeline-"));
    dirs.push(dir);
    const store = new Store(join(dir, "state.sqlite"));
    store.saveSession({ id: "s1", workId: "w1", provider: "codex" } as Session);
    store.saveItem("s1", { kind: "user", id: "u0", text: "옛 요청", at: 5 });
    store.saveItem("s1", { kind: "turnEnd", id: "e0", status: "completed", durationMs: 2, at: 7 });
    store.saveItem("s1", { kind: "user", id: "u1", text: "요청", at: 100 });
    store.saveItem("s1", { kind: "assistant", id: "a1", text: "답", streaming: false, at: 120 });
    store.saveItem("s1", { kind: "user", id: "u2", text: "끼어들기", at: 130, steered: true });
    store.saveItem("s1", { kind: "turnEnd", id: "e1", status: "completed", durationMs: 50, at: 150 });
    store.saveArtifact({ id: "d1", workId: "w1", path: "/x/a.md", name: "a.md" } as Artifact);
    store.saveRevision({ artifactId: "d1", revision: 1, sha256: "", size: 0, author: "user", sessionId: null, baseRevision: null, note: null, at: 6 });
    store.saveRevision({ artifactId: "d1", revision: 2, sha256: "", size: 0, author: "engine", sessionId: "s1", baseRevision: 1, note: null, at: 140 });
    const marks = store.turnMarks(50);
    expect(marks.map((entry) => [entry.kind, entry.at, entry.steered, entry.workId])).toEqual([
      ["user", 100, false, "w1"],
      ["user", 130, true, "w1"],
      ["turnEnd", 150, false, "w1"],
    ]);
    const timeline = buildTimeline(marks, store.revisionMarks(50), 50);
    expect(timeline.turns).toEqual([{ sessionId: "s1", workId: "w1", start: 100, end: 150, status: "completed", itemId: "u1", text: "요청" }]);
    expect(timeline.revisions).toEqual([{ artifactId: "d1", workId: "w1", revision: 2, at: 140, author: "engine" }]);
    expect(timeline.until).toBeUndefined();
    store.close();
  });

  it("reads a window with the turns that cross its edges, at their real start and end", () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-timeline-"));
    dirs.push(dir);
    const store = new Store(join(dir, "state.sqlite"));
    store.saveSession({ id: "a", workId: "w1", provider: "codex" } as Session);
    store.saveSession({ id: "b", workId: "w2", provider: "claude" } as Session);
    store.saveSession({ id: "c", workId: "w2", provider: "claude" } as Session);
    store.saveSession({ id: "old", workId: "w1", provider: "codex" } as Session);
    // a: begins before the window and ends inside it; then one inside; then one that runs past it; then one after it.
    store.saveItem("a", { kind: "user", id: "a1", text: "\n\n  밤새 정리해 줘  \n둘째 줄", at: 90 });
    store.saveItem("a", { kind: "turnEnd", id: "a1e", status: "completed", durationMs: 30, at: 120 });
    store.saveItem("a", { kind: "user", id: "a2", text: "가운데", at: 130 });
    store.saveItem("a", { kind: "turnEnd", id: "a2e", status: "failed", durationMs: 10, at: 140 });
    store.saveItem("a", { kind: "user", id: "a3", text: "늦게", at: 190 });
    store.saveItem("a", { kind: "turnEnd", id: "a3e", status: "completed", durationMs: 40, at: 230 });
    store.saveItem("a", { kind: "user", id: "a4", text: "다음 날", at: 300 });
    store.saveItem("a", { kind: "turnEnd", id: "a4e", status: "completed", durationMs: 5, at: 305 });
    // b: a request still running across the whole window (no end yet).
    store.saveItem("b", { kind: "user", id: "b1", text: "길게", at: 50 });
    // c: a turn that ended just before the window, and a request after it.
    store.saveItem("c", { kind: "user", id: "c1", text: "전에", at: 60 });
    store.saveItem("c", { kind: "turnEnd", id: "c1e", status: "completed", durationMs: 30, at: 99 });
    store.saveItem("c", { kind: "user", id: "c2", text: "뒤에", at: 250 });
    store.saveItem("c", { kind: "turnEnd", id: "c2e", status: "completed", durationMs: 30, at: 260 });
    // old: finished long ago.
    store.saveItem("old", { kind: "user", id: "o1", text: "옛날", at: 1 });
    store.saveItem("old", { kind: "turnEnd", id: "o1e", status: "completed", durationMs: 1, at: 2 });
    store.saveArtifact({ id: "d1", workId: "w1", path: "/x/a.md", name: "a.md" } as Artifact);
    for (const [revision, at] of [[1, 99], [2, 100], [3, 199], [4, 200]] as const) {
      store.saveRevision({ artifactId: "d1", revision, sha256: "", size: 0, author: "engine", sessionId: "a", baseRevision: null, note: null, at });
    }
    const timeline = buildTimeline(store.turnMarks(100, 200), store.revisionMarks(100, 200), 100, 200);
    expect(timeline.until).toBe(200);
    expect(timeline.turns.map((turn) => [turn.sessionId, turn.start, turn.end, turn.status, turn.itemId, turn.text])).toEqual([
      ["b", 50, null, "open", "b1", "길게"],
      ["a", 90, 120, "completed", "a1", "밤새 정리해 줘"],
      ["a", 130, 140, "failed", "a2", "가운데"],
      ["a", 190, 230, "completed", "a3", "늦게"],
    ]);
    expect(timeline.revisions.map((revision) => revision.revision)).toEqual([2, 3]);
    store.close();
  });
});

describe("firstLine", () => {
  it("takes the first written line, shortened for a label", () => {
    expect(firstLine("\n   \n  강의안을   고쳐 줘 \n두 번째")).toBe("강의안을 고쳐 줘");
    expect(firstLine("")).toBeUndefined();
    expect(firstLine(null)).toBeUndefined();
    expect(firstLine("가".repeat(100), 10)).toBe(`${"가".repeat(9)}…`);
  });
});
