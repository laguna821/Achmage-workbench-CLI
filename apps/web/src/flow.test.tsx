import { describe, expect, it } from "vitest";
import type { Artifact, CalendarEvent, Session, Timeline, TimelineTurn, Work } from "@workbench/contracts";
import { initialState, type State } from "./state.ts";
import { periodOf, type Day } from "./calendar.ts";
import { activityOf, cellKey, dayColumns, dayEvents, dayLines, monthDays, periodTotals, weekCells } from "./flow.ts";

// Home "흐름": the timeline arranged for the day (a column per work), the week (hour cells) and
// the month (works and events per day). Local times throughout, as the screen shows them.

const day = (y: number, m: number, d: number): Day => ({ y, m, d });
const at = (d: number, h: number, mi = 0) => new Date(2026, 9, d, h, mi).getTime();
const NOW = at(29, 15);

const work = (id: string, extra: Partial<Work> = {}): Work => ({
  id,
  title: id,
  titleSource: "user",
  folderId: null,
  cwd: `/w/${id}`,
  cwdManaged: false,
  activeSessionId: null,
  pinned: false,
  sort: 0,
  archivedAt: null,
  createdAt: 0,
  updatedAt: 0,
  ...extra,
});
const session = (id: string, workId: string, provider: Session["provider"], extra: Partial<Session> = {}): Session => ({
  id,
  workId,
  provider,
  hostId: "h",
  nativeSessionId: null,
  purpose: `${id} 목적`,
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
  sort: 0,
  archivedAt: null,
  seenAt: 0,
  unread: false,
  queued: [],
  access: null,
  context: null,
  createdAt: 0,
  updatedAt: 0,
  ...extra,
});
const artifact = (id: string, workId: string, extra: Partial<Artifact> = {}): Artifact => ({
  id,
  workId,
  path: `/w/${workId}/${id}.md`,
  name: `${id}.md`,
  format: "markdown",
  revision: 1,
  sha256: "",
  size: 1,
  diskState: "same",
  readBy: {},
  createdAt: 0,
  updatedAt: 0,
  ...extra,
});
const byId = <T extends { id: string }>(list: T[]) => Object.fromEntries(list.map((entry) => [entry.id, entry]));
const stateOf = (works: Work[], sessions: Session[], artifacts: Artifact[] = []): State => ({ ...initialState, ready: true, works: byId(works), sessions: byId(sessions), artifacts: byId(artifacts) });
const turn = (sessionId: string, workId: string, start: number, end: number | null, extra: Partial<TimelineTurn> = {}): TimelineTurn => ({ sessionId, workId, start, end, status: end === null ? "open" : "completed", itemId: `u-${start}`, ...extra });

const STATE = stateOf(
  [work("강의안"), work("보고서"), work("보관함", { archivedAt: 1 })],
  [session("c", "강의안", "claude"), session("x", "보고서", "codex", { status: "running" }), session("old", "보관함", "codex")],
  [artifact("d", "강의안"), artifact("note", "강의안", { role: "project-note" })],
);

const TIMELINE: Timeline = {
  since: at(26, 0),
  until: at(27 + 6, 0),
  turns: [
    turn("c", "강의안", at(29, 9, 10), at(29, 9, 25), { text: "도입부 고쳐 줘" }),
    turn("c", "강의안", at(29, 9, 30), at(29, 9, 32)),
    turn("c", "강의안", at(29, 14, 0), at(29, 14, 40), { status: "failed" }),
    turn("x", "보고서", at(29, 13, 50), at(29, 14, 10)),
    // An old turn that never recorded its end, and the one running now.
    turn("x", "보고서", at(28, 20, 0), null),
    turn("x", "보고서", at(29, 14, 50), null),
    turn("old", "보관함", at(29, 10, 0), at(29, 10, 5)),
  ],
  revisions: [
    { artifactId: "d", workId: "강의안", revision: 2, at: at(29, 9, 20), author: "engine" },
    { artifactId: "d", workId: "강의안", revision: 3, at: at(29, 9, 24), author: "user" },
    { artifactId: "note", workId: "강의안", revision: 4, at: at(29, 9, 40), author: "user" },
  ],
};

describe("activity", () => {
  it("keeps visible sessions; the running turn lasts until now, an unended old one a minute", () => {
    const activity = activityOf(STATE, TIMELINE, NOW);
    expect(activity.turns.map((entry) => entry.work.id)).not.toContain("보관함");
    const open = activity.turns.filter((entry) => entry.status === "open");
    expect(open.map((entry) => [entry.start, entry.end, entry.running])).toEqual([
      [at(28, 20), at(28, 20) + 60_000, false],
      [at(29, 14, 50), NOW, true],
    ]);
    // A project's own note is not a document of the work.
    expect(activity.revisions.map((entry) => entry.revision)).toEqual([2, 3]);
    expect(periodTotals(activity, at(29, 0), at(30, 0))).toEqual({ requests: 5, revisions: 2, works: 2 });
  });
});

describe("하루", () => {
  it("has a column per work in the order the day reached them; close turns share a block", () => {
    const columns = dayColumns(day(2026, 10, 29), activityOf(STATE, TIMELINE, NOW), 0.4, 0.2);
    expect(columns.map((column) => [column.work.id, column.requests, column.revisions, column.providers])).toEqual([
      ["강의안", 3, 2, ["claude"]],
      ["보고서", 2, 0, ["codex"]],
    ]);
    const [lesson, report] = columns;
    // 9:10–9:25 and 9:30–9:32 are one block (9:30 starts before 9:25 + 0.4 h); 14:00 stands apart.
    expect(lesson!.blocks.map((block) => [block.turns.length, block.top, Number(block.bottom.toFixed(2)), block.failed])).toEqual([
      [2, 9 + 10 / 60, 9.53, false],
      [1, 14, 14.67, true],
    ]);
    // Revisions 4 minutes apart are one mark.
    expect(lesson!.marks.map((mark) => mark.revisions.length)).toEqual([2]);
    expect(report!.blocks.map((block) => [block.turns.length, block.running])).toEqual([
      [1, false],
      [1, true],
    ]);
    expect(report!.blocks[1]!.bottom).toBe(15);
  });
});

describe("주", () => {
  it("gives each hour the works in it, the requests begun in it and when turns ran", () => {
    const week = periodOf("week", day(2026, 10, 29), day(2026, 10, 29));
    const cells = weekCells(week.days, activityOf(STATE, TIMELINE, NOW));
    const nine = cells.get(cellKey(day(2026, 10, 29), 9))!;
    expect([nine.requests, nine.revisions, nine.works.map((entry) => [entry.work.id, entry.provider, entry.requests, entry.revisions])]).toEqual([2, 2, [["강의안", "claude", 2, 2]]]);
    expect(nine.runs.map((run) => [Number(run.from.toFixed(3)), Number(run.to.toFixed(3))])).toEqual([
      [0.167, 0.417],
      [0.5, 0.533],
    ]);
    // 13:50–14:10 runs in two hours but is one request, made at 13.
    const thirteen = cells.get(cellKey(day(2026, 10, 29), 13))!;
    const fourteen = cells.get(cellKey(day(2026, 10, 29), 14))!;
    expect([thirteen.requests, fourteen.requests]).toEqual([1, 2]);
    expect(fourteen.works.map((entry) => entry.work.id).sort()).toEqual(["강의안", "보고서"]);
    expect(fourteen.turns.map((entry) => entry.itemId)).toEqual([`u-${at(29, 14)}`, `u-${at(29, 14, 50)}`]);
    expect(cells.get(cellKey(day(2026, 10, 28), 20))!.requests).toBe(1);
  });
});

describe("달", () => {
  const events: CalendarEvent[] = [
    { id: "trip", feedId: "f", title: "학회", location: null, start: at(28, 0), end: at(30, 0), days: { from: "2026-10-28", to: "2026-10-30" } },
    { id: "late", feedId: "f", title: "밤 행사", location: "본관", start: at(29, 23), end: at(30, 1), days: null },
    { id: "lunch", feedId: "f", title: "점심", location: null, start: at(29, 12), end: at(29, 13), days: null },
  ];

  it("counts per day the works active and lists the events on it, also across midnight", () => {
    const month = periodOf("month", day(2026, 10, 29), day(2026, 10, 29));
    const days = monthDays(month.days, activityOf(STATE, TIMELINE, NOW), events);
    const thursday = days.get("2026-10-29")!;
    expect([thursday.requests, thursday.revisions, thursday.works.map((entry) => [entry.work.id, entry.requests, entry.revisions])]).toEqual([
      5,
      2,
      [
        ["강의안", 3, 2],
        ["보고서", 2, 0],
      ],
    ]);
    expect(thursday.events.map((event) => event.id)).toEqual(["trip", "lunch", "late"]);
    expect(days.get("2026-10-28")!.events.map((event) => event.id)).toEqual(["trip"]);
    expect(days.get("2026-10-30")!.events.map((event) => event.id)).toEqual(["late"]);
    // Two events first, then works, then the rest; what does not fit is "외 N".
    expect(dayLines(thursday, 4)).toMatchObject({ lines: [{ kind: "event" }, { kind: "event" }, { kind: "work" }], more: 2 });
    expect(dayLines(thursday, 9).more).toBe(0);
  });

  it("splits a day's events into all-day ones and timed spans in hours", () => {
    const { allDay, timed } = dayEvents(day(2026, 10, 29), events);
    expect(allDay.map((event) => event.id)).toEqual(["trip"]);
    expect(timed.map((entry) => [entry.event.id, entry.top, entry.bottom])).toEqual([
      ["late", 23, 24],
      ["lunch", 12, 13],
    ]);
  });
});
