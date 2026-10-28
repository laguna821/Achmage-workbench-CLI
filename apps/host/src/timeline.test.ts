import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Artifact, Session } from "@workbench/contracts";
import { Store } from "./store.ts";
import { buildTimeline, type TurnMark } from "./timeline.ts";

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
    expect(timeline.turns).toEqual([{ sessionId: "s1", workId: "w1", start: 100, end: 150, status: "completed" }]);
    expect(timeline.revisions).toEqual([{ artifactId: "d1", workId: "w1", revision: 2, at: 140, author: "engine" }]);
    store.close();
  });
});
