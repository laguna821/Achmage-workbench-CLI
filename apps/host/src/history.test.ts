import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Artifact, HistoryEvent, HistoryFilter, Proposal, Session, Work } from "@workbench/contracts";
import { Store } from "./store.ts";
import { EventBus } from "./bus.ts";
import { createHttpServer } from "./http.ts";
import { SessionManager } from "./sessions.ts";
import { HISTORY_MAX, decodeCursor, encodeCursor, itemEvent, mergeHistory, readHistory } from "./history.ts";

// 활동 › 기록: what becomes a line, paging across the sources, bounds, removed projects, archived conversations.

const event = (id: string, at: number, kind: HistoryEvent["kind"] = "request"): HistoryEvent => ({ id, at, kind, workId: "w", sessionId: null, artifactId: null, itemId: null });

describe("mergeHistory", () => {
  it("merges newest first and cuts where a full source ran out (an older row elsewhere may not be next)", () => {
    // Source a stopped at its limit (2) at 80: its next row may be 79; b's 70 must wait for the next page.
    const page = mergeHistory([
      { events: [event("a1", 100), event("a2", 80)], last: { at: 80, id: "a2" } },
      { events: [event("b1", 90), event("b2", 70)], last: null },
    ], 10);
    expect(page.events.map((entry) => entry.id)).toEqual(["a1", "b1", "a2"]);
    expect(decodeCursor(page.next)).toEqual({ at: 80, id: "a2" });
  });

  it("ends with no cursor when no source is full and the page is not", () => {
    const page = mergeHistory([{ events: [event("a", 5)], last: null }, { events: [], last: null }], 10);
    expect(page).toEqual({ events: [event("a", 5)], next: null });
  });

  it("dropped rows still count for the cut; the same moment is ordered by id", () => {
    const page = mergeHistory([{ events: [event("x", 10), event("y", 10), event("z", 9)], last: { at: 9, id: "z" } }], 10, (entry) => entry.id === "z");
    expect(page.events.map((entry) => entry.id)).toEqual(["y", "x"]);
    expect(page.next).toBe(encodeCursor({ at: 9, id: "z" }));
  });

  it("reads a cursor back, refusing a broken one", () => {
    expect(decodeCursor("12:item:s:u")).toEqual({ at: 12, id: "item:s:u" });
    expect(decodeCursor("x:1")).toBeNull();
    expect(decodeCursor("")).toBeNull();
  });
});

describe("itemEvent: what becomes a line", () => {
  const row = (item: Parameters<typeof itemEvent>[0]["item"], status: string | null = "idle") => itemEvent({ sessionId: "s", workId: "w", provider: "claude", status, item });
  it("a request says who sent it, its first line and a wait in the line", () => {
    expect(row({ kind: "user", id: "u", text: "\n보고서 써 줘\n둘째", at: 1 })).toMatchObject({ kind: "request", via: "pc", text: "보고서 써 줘", itemId: "u", provider: "claude" });
    expect(row({ kind: "user", id: "u", text: "a", at: 1, origin: { channel: "telegram", bindingId: "b" } })?.via).toBe("phone");
    expect(row({ kind: "user", id: "u", text: "a", at: 1, scheduled: true })?.via).toBe("schedule");
    expect(row({ kind: "user", id: "u", text: "a", at: 1, from: { sessionId: "o", label: "다른 대화" } })?.via).toBe("handover");
    expect(row({ kind: "user", id: "u", text: "a", at: 1, steered: true })?.via).toBe("steer");
    expect(row({ kind: "user", id: "u", text: "a", at: 1, waitedMs: 12_000 })?.waitedMs).toBe(12_000);
  });
  it("a turn end is an answer, a failure or a stop, with its duration", () => {
    expect(row({ kind: "turnEnd", id: "e", status: "completed", durationMs: 4000, at: 1 })).toMatchObject({ kind: "answer", durationMs: 4000 });
    expect(row({ kind: "turnEnd", id: "e", status: "failed", durationMs: null, at: 1 })?.kind).toBe("failed");
    expect(row({ kind: "turnEnd", id: "e", status: "interrupted", durationMs: 1, at: 1, cause: "stop" })).toMatchObject({ kind: "stopped", cause: "stop" });
  });
  it("an approval or a question with its answer; open only while its conversation waits for it", () => {
    expect(row({ kind: "approval", id: "p", title: "명령 실행", detail: null, reason: null, decision: null, at: 1 }, "awaitingApproval")).toMatchObject({ kind: "approval", decision: null, open: true });
    expect(row({ kind: "approval", id: "p", title: "명령 실행", detail: null, reason: null, decision: null, at: 1 }, "idle")?.open).toBeUndefined();
    expect(row({ kind: "approval", id: "p", title: "", detail: null, reason: null, decision: "decline", at: 1, officeInteraction: { prompt: "어느 표?", fields: [] } })).toMatchObject({ kind: "question", decision: "decline", text: "어느 표?" });
  });
  it("tokens, tools and notices are not lines", () => {
    expect(row({ kind: "assistant", id: "a", text: "x", streaming: false, at: 1 })).toBeNull();
    expect(row({ kind: "tool", id: "t", tool: "command", title: "ls", detail: null, output: null, status: "completed", at: 1 })).toBeNull();
  });
});

describe("store history", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const open = () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-history-"));
    dirs.push(dir);
    return new Store(join(dir, "state.sqlite"));
  };
  const work = (id: string) => ({ id, title: id, archivedAt: null } as unknown as Work);
  const session = (id: string, workId: string, extra: Partial<Session> = {}) => ({ id, workId, provider: "codex", status: "idle", createdAt: 1, archivedAt: null, ...extra } as Session);

  const fixture = () => {
    const store = open();
    store.saveWork(work("w1"));
    store.saveWork(work("w2"));
    store.saveSession(session("s1", "w1", { createdAt: 5 }));
    store.saveSession(session("s2", "w2", { createdAt: 6, status: "awaitingApproval" }));
    store.saveSession(session("old", "w1", { createdAt: 7, archivedAt: 400 }));
    store.saveItem("s1", { kind: "user", id: "u1", text: "요청 하나", at: 100 });
    store.saveItem("s1", { kind: "assistant", id: "a1", text: "답", streaming: false, at: 110 });
    store.saveItem("s1", { kind: "turnEnd", id: "e1", status: "completed", durationMs: 20, at: 120 });
    store.saveItem("s1", { kind: "user", id: "u2", text: "둘", at: 200 });
    store.saveItem("s1", { kind: "turnEnd", id: "e2", status: "failed", durationMs: 5, at: 205 });
    store.saveItem("s2", { kind: "user", id: "v1", text: "셋", at: 300 });
    store.saveItem("s2", { kind: "approval", id: "p1", title: "명령 실행", detail: null, reason: null, decision: null, at: 310 });
    store.saveItem("old", { kind: "user", id: "o1", text: "옛 대화", at: 50 });
    store.saveItem("old", { kind: "turnEnd", id: "o1e", status: "completed", durationMs: 9, at: 60 });
    store.saveArtifact({ id: "d1", workId: "w1", path: "/x/a.md", name: "a.md", revision: 3 } as Artifact);
    store.saveArtifact({ id: "note", workId: "w1", path: "/x/n.md", name: "n.md", role: "project-note" } as Artifact);
    store.saveRevision({ artifactId: "d1", revision: 1, sha256: "", size: 0, author: "engine", sessionId: "s1", baseRevision: null, note: null, at: 115 });
    store.saveRevision({ artifactId: "d1", revision: 2, sha256: "", size: 0, author: "user", sessionId: null, baseRevision: 1, note: null, at: 250 });
    store.saveRevision({ artifactId: "d1", revision: 3, sha256: "", size: 0, author: "engine", sessionId: "s1", baseRevision: 2, note: null, at: 260 });
    store.saveRevision({ artifactId: "note", revision: 1, sha256: "", size: 0, author: "user", sessionId: null, baseRevision: null, note: null, at: 265 });
    store.saveProposal({ id: "pr1", artifactId: "d1", sessionId: "s1", requestId: "r", baseRevision: 2, workingPath: "/w", status: "applied", added: 1, removed: 0, appliedRevision: 3, createdAt: 255, updatedAt: 260 } as Proposal);
    return store;
  };

  const walk = (store: Store, filter: HistoryFilter = "all", limit = 2, workId: string | null = null) => {
    const seen: HistoryEvent[] = [];
    let before: string | null = null;
    for (let page = 0; page < 50; page += 1) {
      const result = readHistory(store, { before: decodeCursor(before), limit, workId, filter });
      seen.push(...result.events);
      if (!result.next) break;
      before = result.next;
    }
    return seen;
  };

  it("pages through every line once, newest first, whatever the page size", () => {
    const store = fixture();
    const all = walk(store, "all", 100).map((entry) => `${entry.kind}@${entry.at}`);
    expect(all).toEqual([
      "session-archived@400", "approval@310", "request@300", "proposal-applied@260", "doc-revised@250", "failed@205", "request@200",
      "answer@120", "doc-created@115", "request@100", "answer@60", "request@50", "session-created@7", "session-created@6", "session-created@5",
    ]);
    for (const limit of [1, 2, 3, 7]) expect(walk(store, "all", limit).map((entry) => `${entry.kind}@${entry.at}`)).toEqual(all);
    store.close();
  });

  it("the revision a 수정안 became is said once, by the 수정안; the project note is not listed", () => {
    const store = fixture();
    const lines = walk(store, "all", 100);
    expect(lines.filter((entry) => entry.artifactId === "d1").map((entry) => entry.kind)).toEqual(["proposal-applied", "doc-revised", "doc-created"]);
    expect(lines.some((entry) => entry.artifactId === "note")).toBe(false);
    store.close();
  });

  it("filters in the query: what asks me now, what finished, problems; and by project", () => {
    const store = fixture();
    expect(walk(store, "attention").map((entry) => [entry.kind, entry.open])).toEqual([["approval", true]]);
    expect(walk(store, "done").map((entry) => `${entry.kind}@${entry.at}`)).toEqual(["proposal-applied@260", "doc-revised@250", "answer@120", "doc-created@115", "answer@60"]);
    expect(walk(store, "problem").map((entry) => `${entry.kind}@${entry.at}`)).toEqual(["failed@205"]);
    expect(walk(store, "all", 3, "w2").map((entry) => `${entry.kind}@${entry.at}`)).toEqual(["approval@310", "request@300", "session-created@6"]);
    store.close();
  });

  it("an archived conversation keeps its lines and says when it was archived", () => {
    const store = fixture();
    const lines = walk(store, "all", 100).filter((entry) => entry.sessionId === "old");
    expect(lines.map((entry) => entry.kind)).toEqual(["session-archived", "answer", "request", "session-created"]);
    store.close();
  });

  it("a deleted project's lines are gone, also of its documents kept in the trash", () => {
    const store = fixture();
    store.saveArtifact({ id: "d1", workId: "w1", path: "/x/a.md", name: "a.md", revision: 3, removed: { at: 500, kind: "trash" } } as Artifact);
    expect(walk(store, "all", 100)[0]).toMatchObject({ kind: "doc-removed", removal: "trash", name: "a.md" });
    store.deleteWork("w1", new Set(["d1"]));
    const lines = walk(store, "all", 100);
    expect(lines.every((entry) => entry.workId === "w2")).toBe(true);
    expect(lines.length).toBe(3);
    store.close();
  });

  it("a rename is listed with its old name; a document conversation's own creation is not", () => {
    const store = fixture();
    store.saveArtifact({ id: "d1", workId: "w1", path: "/x/b.md", name: "b.md", revision: 3, renamed: { from: "/x/a.md", to: "/x/b.md", at: 600 } } as Artifact);
    store.saveSession(session("doc-ai", "w1", { createdAt: 700, documentAgent: { artifactId: "d1", parentSessionId: null } }));
    const first = walk(store, "all", 100)[0];
    expect(first).toMatchObject({ kind: "doc-renamed", name: "b.md", from: "a.md", at: 600 });
    store.close();
  });

  it("keeps the page size inside its bounds", () => {
    const store = fixture();
    expect(readHistory(store, { before: null, limit: 0, workId: null, filter: "all" }).events).toHaveLength(1);
    expect(readHistory(store, { before: null, limit: 10_000, workId: null, filter: "all" }).events.length).toBeLessThanOrEqual(HISTORY_MAX);
    store.close();
  });

  it("GET /api/activity/history: a page, its cursor, a project, a refused filter; the app's token only", async () => {
    const store = fixture();
    const bus = new EventBus();
    const dir = mkdtempSync(join(tmpdir(), "wb-history-http-"));
    dirs.push(dir);
    // The gateway's own store is empty; the route reads the fixture's (only the route is under test here).
    const own = new Store(join(dir, "state.sqlite"));
    const manager = new SessionManager(own, bus, { hostId: "host", hostLabel: "시험", dataDir: dir, managedWorksDir: join(dir, "works") });
    const server = createHttpServer(manager, bus, { token: "fixture-only", webDir: null, history: (query) => readHistory(store, { ...query, before: decodeCursor(query.before) }) });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("no address");
    const get = (query: string) => fetch(`http://127.0.0.1:${address.port}/api/activity/history${query}`, { headers: { authorization: "Bearer fixture-only" } });
    try {
      expect((await fetch(`http://127.0.0.1:${address.port}/api/activity/history`)).status).toBe(401);
      const first = await (await get("?limit=4")).json() as { events: HistoryEvent[]; next: string };
      expect(first.events.map((entry) => entry.at)).toEqual([400, 310, 300, 260]);
      const second = await (await get(`?limit=4&before=${encodeURIComponent(first.next)}`)).json() as { events: HistoryEvent[] };
      expect(second.events.map((entry) => entry.at)).toEqual([250, 205, 200, 120]);
      const project = await (await get("?workId=w2&filter=attention")).json() as { events: HistoryEvent[]; next: string | null };
      expect(project).toMatchObject({ events: [{ kind: "approval", open: true }], next: null });
      expect((await get("?filter=everything")).status).toBe(400);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
      await manager.shutdown(); own.close(); store.close();
    }
  });

  // Measured on demand (WB_HISTORY_BENCH=1): a store of ~50k transcript items, 2,000 revisions, 400 conversations.
  it.runIf(process.env.WB_HISTORY_BENCH === "1")("answers a page from a 50k-item store quickly", () => {
    const store = open();
    for (let w = 0; w < 20; w += 1) store.saveWork(work(`w${w}`));
    const kinds = ["user", "reasoning", "tool", "tool", "assistant", "turnEnd"] as const;
    let at = 1_700_000_000_000;
    store.transaction(() => {
      for (let s = 0; s < 400; s += 1) {
        store.saveSession(session(`s${s}`, `w${s % 20}`, { createdAt: at }));
        for (let i = 0; i < 125; i += 1) {
          const kind = kinds[i % kinds.length]!;
          at += 1000;
          const id = `i${i}`;
          if (kind === "user") store.saveItem(`s${s}`, { kind, id, text: "요청 ".repeat(40), at });
          else if (kind === "turnEnd") store.saveItem(`s${s}`, { kind, id, status: i % 31 === 5 ? "failed" : "completed", durationMs: 4000, at });
          else if (kind === "assistant") store.saveItem(`s${s}`, { kind, id, text: "답 ".repeat(300), streaming: false, at });
          else if (kind === "reasoning") store.saveItem(`s${s}`, { kind, id, text: "생각 ".repeat(100), at });
          else store.saveItem(`s${s}`, { kind, id, tool: "command", title: "ls", detail: "ls -la", output: "x".repeat(800), status: "completed", at });
        }
      }
      for (let d = 0; d < 200; d += 1) {
        store.saveArtifact({ id: `d${d}`, workId: `w${d % 20}`, path: `/x/${d}.md`, name: `${d}.md`, revision: 10 } as Artifact);
        for (let r = 1; r <= 10; r += 1) store.saveRevision({ artifactId: `d${d}`, revision: r, sha256: "", size: 0, author: r % 2 ? "engine" : "user", sessionId: null, baseRevision: null, note: null, at: 1_700_000_000_000 + d * 100_000 + r * 1000 });
      }
    });
    const time = (run: () => unknown) => { const start = performance.now(); run(); return performance.now() - start; };
    const first = readHistory(store, { before: null, limit: 100, workId: null, filter: "all" });
    const measured = {
      first: time(() => readHistory(store, { before: null, limit: 100, workId: null, filter: "all" })),
      deep: time(() => readHistory(store, { before: decodeCursor(first.next), limit: 100, workId: null, filter: "all" })),
      project: time(() => readHistory(store, { before: null, limit: 100, workId: "w3", filter: "all" })),
      problem: time(() => readHistory(store, { before: null, limit: 100, workId: null, filter: "problem" })),
    };
    console.log("history bench (ms, 50k items):", JSON.stringify(Object.fromEntries(Object.entries(measured).map(([key, ms]) => [key, Math.round(ms)]))));
    expect(first.events).toHaveLength(100);
    store.close();
  });
});
