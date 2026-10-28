import { describe, expect, it } from "vitest";
import type { Artifact, Folder, Session, Work } from "@workbench/contracts";
import { initialState, type State } from "./state.ts";
import { EMPTY_OPEN, between, moveFor, nowSessions, nudge, pinnedItems, toggleWork, treeRows, zoneAt, type Row } from "./tree.ts";

const folder = (id: string, parentId: string | null, sort: number, archivedAt: number | null = null): Folder => ({ id, parentId, name: id, sort, archivedAt });
const work = (id: string, folderId: string | null, sort: number, extra: Partial<Work> = {}): Work => ({
  id,
  title: id,
  titleSource: "user",
  folderId,
  cwd: `/w/${id}`,
  cwdManaged: true,
  activeSessionId: null,
  pinned: false,
  sort,
  archivedAt: null,
  createdAt: 0,
  updatedAt: 0,
  ...extra,
});
const session = (id: string, workId: string, sort: number, extra: Partial<Session> = {}): Session =>
  ({
    id,
    workId,
    provider: "claude",
    hostId: "h",
    nativeSessionId: null,
    purpose: id,
    purposeSource: "user",
    model: null,
    effort: null,
    engineModel: null,
    engineEffort: null,
    preview: null,
    previewAt: null,
    status: "idle",
    activity: null,
    lastError: null,
    pinned: false,
    sort,
    archivedAt: null,
    seenAt: null,
    unread: false,
    queued: [],
    access: null,
    context: null,
    createdAt: sort,
    updatedAt: sort,
    ...extra,
  }) as Session;

function stateOf(folders: Folder[], works: Work[], sessions: Session[], artifacts: Partial<Artifact>[] = []): State {
  const byId = <T extends { id: string }>(list: T[]) => Object.fromEntries(list.map((entry) => [entry.id, entry]));
  return { ...initialState, ready: true, folders: byId(folders), works: byId(works), sessions: byId(sessions), artifacts: byId(artifacts as Artifact[]) };
}

const ids = (rows: Row[]) => rows.map((row) => `${"  ".repeat(row.depth)}${row.type}:${row.id}`);

describe("tree rows", () => {
  const state = stateOf(
    [folder("강의", null, 0), folder("2026-2", "강의", 0), folder("보관됨", null, 1, 5)],
    [work("7주차", "2026-2", 2), work("8주차", "2026-2", 1), work("숨은", "보관됨", 0), work("메모", null, 0)],
    [session("s1", "7주차", 1), session("s2", "7주차", 2), session("s3", "7주차", 3, { archivedAt: 9 }), session("solo", "8주차", 1)],
    [{ id: "d1", workId: "7주차", name: "강의안.md", updatedAt: 3 }],
  );

  it("lists folders, works in their order and leaves archived things (and what is inside them) out", () => {
    expect(ids(treeRows(state, EMPTY_OPEN, "manual", null))).toEqual(["folder:강의", "  folder:2026-2", "    work:8주차", "    work:7주차", "section:section:loose", "work:메모"]);
  });

  it("unfolds the work on screen to its sessions and documents; a single-session work stays one row", () => {
    const rows = treeRows(state, EMPTY_OPEN, "manual", "7주차");
    expect(ids(rows)).toContain("      session:s2");
    expect(ids(rows)).toContain("      docs:docs:7주차");
    expect(ids(rows)).not.toContain("      session:s3");
    expect(rows.find((row) => row.id === "8주차")).toMatchObject({ expandable: false });
    const folded = toggleWork(EMPTY_OPEN, "7주차", true);
    expect(ids(treeRows(state, folded, "manual", "7주차"))).not.toContain("      session:s1");
    expect(ids(treeRows(state, toggleWork(folded, "7주차", false), "manual", "7주차"))).toContain("      session:s1");
  });

  it("sorts by name or recent activity when asked", () => {
    const named = ids(treeRows(state, EMPTY_OPEN, "name", null));
    expect(named.indexOf("    work:7주차")).toBeLessThan(named.indexOf("    work:8주차"));
  });

  it("shows what needs the user now, and pinned things", () => {
    const busy = stateOf([], [work("w", null, 0, { pinned: true })], [
      session("ask", "w", 1, { status: "awaitingApproval" }),
      session("run", "w", 2, { status: "running" }),
      session("new", "w", 3, { previewAt: 10, seenAt: 5 }),
      session("read", "w", 4, { previewAt: 10, seenAt: 20, pinned: true }),
    ]);
    const now = nowSessions(busy, null);
    expect([now.attention, now.running, now.unseen].map((list) => list.map((entry) => entry.id))).toEqual([["ask"], ["run"], ["new"]]);
    expect(nowSessions(busy, "new").unseen).toEqual([]);
    expect(pinnedItems(busy)).toMatchObject({ works: [{ id: "w" }], sessions: [{ id: "read" }] });
  });
});

describe("moving rows", () => {
  const state = stateOf(
    [folder("a", null, 0), folder("b", null, 1), folder("a1", "a", 0)],
    [work("w1", "a", 1), work("w2", "a", 2), work("w3", null, 1)],
    [session("s1", "w1", 1), session("s2", "w1", 2), session("s3", "w1", 3), session("x", "w2", 1)],
  );
  const rows = Object.fromEntries(
    treeRows(state, { ...EMPTY_OPEN, openWorks: ["w1"] }, "manual", null).map((row) => [row.id, row]),
  ) as Record<string, Row>;

  it("finds the zone from where the pointer is on the row", () => {
    expect([zoneAt(2, 32, true), zoneAt(16, 32, true), zoneAt(30, 32, true), zoneAt(10, 32, false)]).toEqual(["before", "inside", "after", "before"]);
  });

  it("puts a work into a folder (first) or between two works", () => {
    expect(moveFor(state, rows.w3!, rows.b!, "inside", "manual")).toEqual({ kind: "work", id: "w3", folderId: "b", sort: 0 });
    expect(moveFor(state, rows.w3!, rows.w2!, "before", "manual")).toEqual({ kind: "work", id: "w3", folderId: "a", sort: 1.5 });
    expect(moveFor(state, rows.w1!, rows.w2!, "after", "manual")).toEqual({ kind: "work", id: "w1", folderId: "a", sort: 3 });
  });

  it("never moves a folder into itself or below itself", () => {
    expect(moveFor(state, rows.a!, rows.a1!, "inside", "manual")).toBeNull();
    expect(moveFor(state, rows.b!, rows.a!, "inside", "manual")).toMatchObject({ kind: "folder", parentId: "a" });
    expect(moveFor(state, rows.b!, rows.a!, "before", "manual")).toMatchObject({ kind: "folder", parentId: null, sort: -1 });
  });

  it("reorders sessions only within their own work", () => {
    expect(moveFor(state, rows.s3!, rows.s1!, "before", "manual")).toEqual({ kind: "session", id: "s3", sort: 0 });
    expect(moveFor(state, rows.s1!, rows.s2!, "after", "manual")).toEqual({ kind: "session", id: "s1", sort: 2.5 });
    expect(moveFor(state, rows.s1!, rows.w2!, "before", "manual")).toBeNull();
  });

  it("swaps a row with its neighbour from the keyboard", () => {
    expect(nudge(state, rows.s1!, 1, "manual")).toEqual({ kind: "session", id: "s1", sort: 2.5 });
    expect(nudge(state, rows.s1!, -1, "manual")).toBeNull();
    expect(nudge(state, rows.w2!, -1, "manual")).toEqual({ kind: "work", id: "w2", folderId: "a", sort: 0 });
    expect(between(undefined, undefined)).toBe(0);
  });
});
