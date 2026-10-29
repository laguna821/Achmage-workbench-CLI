import type { Artifact, CalendarEvent, Provider, Session, Timeline, TimelineTurn, Work } from "@workbench/contracts";
import type { State } from "./state.ts";
import { isWorking } from "./overview.ts";
import { sessionHidden, workHidden } from "./tree.ts";
import { addDays, dayKey, dayNumber, hoursIn, localDay, parseDayKey, startOf, type Day } from "./calendar.ts";

// Home "흐름": what the timeline holds (turns and revisions) and the subscribed calendars' events,
// arranged for the three calendar views — a day's columns per work, a week's hour cells, a
// month's days. Plain data (no React), so the grouping can be tested.

/** A turn of a visible session, with an end even while it runs (now) or when it was never recorded. */
export type Turn = {
  session: Session;
  work: Work;
  start: number;
  end: number;
  status: TimelineTurn["status"];
  running: boolean;
  itemId?: string;
  text?: string;
};

export type Revision = { work: Work; artifact: Artifact; revision: number; at: number; author: "user" | "engine" | "external" };

export type Activity = { turns: Turn[]; revisions: Revision[] };

/** A turn whose end was never recorded (the app stopped) is drawn a minute long. */
const UNKNOWN_END_MS = 60_000;

/**
 * The timeline's turns and revisions, for visible sessions and works only. The latest open turn
 * of a session that is working (or waiting for an approval) runs until now.
 */
export function activityOf(state: State, timeline: Timeline | null, now: number): Activity {
  const latestOpen = new Map<string, number>();
  for (const turn of timeline?.turns ?? []) if (turn.end === null) latestOpen.set(turn.sessionId, Math.max(latestOpen.get(turn.sessionId) ?? -Infinity, turn.start));
  const turns: Turn[] = [];
  for (const turn of timeline?.turns ?? []) {
    const session = state.sessions[turn.sessionId];
    const work = state.works[turn.workId];
    if (!session || !work || sessionHidden(state, session)) continue;
    const busy = isWorking(session) || session.status === "awaitingApproval";
    const running = turn.end === null && busy && latestOpen.get(turn.sessionId) === turn.start;
    const end = turn.end ?? (running ? Math.max(now, turn.start) : turn.start + UNKNOWN_END_MS);
    turns.push({ session, work, start: turn.start, end, status: turn.status, running, ...(turn.itemId ? { itemId: turn.itemId } : {}), ...(turn.text ? { text: turn.text } : {}) });
  }
  const revisions: Revision[] = [];
  for (const revision of timeline?.revisions ?? []) {
    const artifact = state.artifacts[revision.artifactId];
    const work = state.works[revision.workId];
    // A project's own note is its page, not a document of the work (프로젝트 노트 설계 §4).
    if (!artifact || !work || workHidden(state, work) || artifact.role === "project-note") continue;
    revisions.push({ work, artifact, revision: revision.revision, at: revision.at, author: revision.author });
  }
  return { turns, revisions };
}

/** The engine most of these turns ran on. */
export function mainProvider(turns: { session: Session }[]): Provider {
  let claude = 0;
  let codex = 0;
  for (const turn of turns) {
    if (turn.session.provider === "claude") claude += 1;
    else codex += 1;
  }
  return claude > codex ? "claude" : "codex";
}

const overlaps = (start: number, end: number, from: number, to: number) => start < to && (end > from || (end === start && start >= from));

// ── 하루 ─────────────────────────────────────────────────────────────────

/** Turns of one work close together, as one block (a turn alone when it stands apart). */
export type DayBlock = { turns: Turn[]; start: number; end: number; top: number; bottom: number; running: boolean; failed: boolean; provider: Provider };
export type DayMark = { revisions: Revision[]; top: number };
export type DayColumn = { work: Work; blocks: DayBlock[]; marks: DayMark[]; requests: number; revisions: number; providers: Provider[]; first: number };

/**
 * "하루": a column per work active that day, in the order the day reached them. A turn that
 * starts before the last block's drawn end (`minHours`, so a label fits) joins that block.
 */
export function dayColumns(day: Day, activity: Activity, minHours = 0.4, markHours = 0.2): DayColumn[] {
  const since = startOf(day);
  const until = startOf(addDays(day, 1));
  const columns = new Map<string, DayColumn>();
  const column = (work: Work) => {
    let entry = columns.get(work.id);
    if (!entry) columns.set(work.id, (entry = { work, blocks: [], marks: [], requests: 0, revisions: 0, providers: [], first: Infinity }));
    return entry;
  };
  for (const turn of [...activity.turns].sort((a, b) => a.start - b.start)) {
    if (!overlaps(turn.start, turn.end, since, until)) continue;
    const entry = column(turn.work);
    const top = hoursIn(turn.start, day);
    const bottom = Math.max(hoursIn(turn.end, day), top);
    if (turn.start >= since) entry.requests += 1;
    if (!entry.providers.includes(turn.session.provider)) entry.providers.push(turn.session.provider);
    entry.first = Math.min(entry.first, turn.start);
    const last = entry.blocks[entry.blocks.length - 1];
    if (last && top < Math.max(last.bottom, last.top + minHours)) {
      last.turns.push(turn);
      last.end = Math.max(last.end, turn.end);
      last.bottom = Math.max(last.bottom, bottom);
      last.running ||= turn.running;
      last.failed ||= turn.status === "failed";
      last.provider = mainProvider(last.turns);
    } else {
      entry.blocks.push({ turns: [turn], start: turn.start, end: turn.end, top, bottom, running: turn.running, failed: turn.status === "failed", provider: turn.session.provider });
    }
  }
  for (const revision of [...activity.revisions].sort((a, b) => a.at - b.at)) {
    if (revision.at < since || revision.at >= until) continue;
    const entry = column(revision.work);
    entry.revisions += 1;
    entry.first = Math.min(entry.first, revision.at);
    const top = hoursIn(revision.at, day);
    const last = entry.marks[entry.marks.length - 1];
    if (last && top - last.top < markHours) last.revisions.push(revision);
    else entry.marks.push({ revisions: [revision], top });
  }
  return [...columns.values()].sort((a, b) => a.first - b.first);
}

// ── 주 ───────────────────────────────────────────────────────────────────

export type CellWork = { work: Work; provider: Provider; requests: number; revisions: number };

/** One hour of one day: who worked then, the requests made in it, and when turns ran (0–1 of the hour). */
export type WeekCell = {
  key: string;
  day: Day;
  hour: number;
  works: CellWork[];
  requests: number;
  revisions: number;
  /** Turns that started in this hour (what a click opens), and revisions made in it. */
  turns: Turn[];
  revisionList: Revision[];
  /** When turns ran inside the hour, as fractions, with their engine. */
  runs: { from: number; to: number; provider: Provider; running: boolean }[];
};

export const cellKey = (day: Day, hour: number) => `${dayKey(day)}@${hour}`;

/** "주": the hour cells of the given days that saw any activity. */
export function weekCells(days: Day[], activity: Activity): Map<string, WeekCell> {
  const cells = new Map<string, WeekCell>();
  const counts = new Map<string, Map<string, { work: Work; claude: number; codex: number; requests: number; revisions: number }>>();
  const cell = (day: Day, hour: number) => {
    const key = cellKey(day, hour);
    let entry = cells.get(key);
    if (!entry) cells.set(key, (entry = { key, day, hour, works: [], requests: 0, revisions: 0, turns: [], revisionList: [], runs: [] }));
    return entry;
  };
  const tally = (key: string, work: Work) => {
    let byWork = counts.get(key);
    if (!byWork) counts.set(key, (byWork = new Map()));
    let entry = byWork.get(work.id);
    if (!entry) byWork.set(work.id, (entry = { work, claude: 0, codex: 0, requests: 0, revisions: 0 }));
    return entry;
  };
  const first = days[0];
  const last = days[days.length - 1];
  if (!first || !last) return cells;
  const since = startOf(first);
  const until = startOf(addDays(last, 1));
  for (const turn of activity.turns) {
    if (!overlaps(turn.start, turn.end, since, until)) continue;
    const startDay = localDay(Math.max(turn.start, since));
    for (let index = dayNumber(startDay) - dayNumber(first); index < days.length; index += 1) {
      const day = days[index]!;
      if (startOf(day) >= turn.end && !(turn.end === turn.start && index === dayNumber(startDay) - dayNumber(first))) break;
      const from = hoursIn(turn.start, day);
      const to = Math.max(hoursIn(turn.end, day), from);
      const lastHour = to > from ? Math.ceil(to) - 1 : Math.floor(from);
      for (let hour = Math.floor(from); hour <= Math.min(23, lastHour); hour += 1) {
        const entry = cell(day, hour);
        entry.runs.push({ from: Math.max(from, hour) - hour, to: Math.min(to, hour + 1) - hour, provider: turn.session.provider, running: turn.running });
        const counted = tally(entry.key, turn.work);
        if (turn.session.provider === "claude") counted.claude += 1;
        else counted.codex += 1;
        if (turn.start >= startOf(day) && Math.floor(hoursIn(turn.start, day)) === hour && turn.start >= since) {
          entry.requests += 1;
          entry.turns.push(turn);
          counted.requests += 1;
        }
      }
    }
  }
  for (const revision of activity.revisions) {
    if (revision.at < since || revision.at >= until) continue;
    const day = localDay(revision.at);
    const entry = cell(day, Math.min(23, Math.floor(hoursIn(revision.at, day))));
    entry.revisions += 1;
    entry.revisionList.push(revision);
    tally(entry.key, revision.work).revisions += 1;
  }
  for (const entry of cells.values()) {
    entry.works = [...(counts.get(entry.key)?.values() ?? [])]
      .map((count) => ({ work: count.work, provider: (count.claude > count.codex ? "claude" : "codex") as Provider, requests: count.requests, revisions: count.revisions }))
      .sort((a, b) => b.requests + b.revisions - (a.requests + a.revisions) || a.work.title.localeCompare(b.work.title, "ko"));
    entry.turns.sort((a, b) => a.start - b.start);
    entry.revisionList.sort((a, b) => a.at - b.at);
  }
  return cells;
}

// ── 달 ───────────────────────────────────────────────────────────────────

export type MonthWork = { work: Work; provider: Provider; requests: number; revisions: number };
export type MonthDay = { key: string; works: MonthWork[]; requests: number; revisions: number; events: CalendarEvent[] };

/** "달": per day, the works active that day (requests begun, revisions made) and the events on it. */
export function monthDays(days: Day[], activity: Activity, events: CalendarEvent[]): Map<string, MonthDay> {
  const out = new Map<string, MonthDay>(days.map((day) => [dayKey(day), { key: dayKey(day), works: [], requests: 0, revisions: 0, events: [] }]));
  const counts = new Map<string, Map<string, { work: Work; claude: number; codex: number; requests: number; revisions: number }>>();
  const tally = (key: string, work: Work) => {
    let byWork = counts.get(key);
    if (!byWork) counts.set(key, (byWork = new Map()));
    let entry = byWork.get(work.id);
    if (!entry) byWork.set(work.id, (entry = { work, claude: 0, codex: 0, requests: 0, revisions: 0 }));
    return entry;
  };
  for (const turn of activity.turns) {
    const key = dayKey(localDay(turn.start));
    const entry = out.get(key);
    if (!entry) continue;
    entry.requests += 1;
    const counted = tally(key, turn.work);
    counted.requests += 1;
    if (turn.session.provider === "claude") counted.claude += 1;
    else counted.codex += 1;
  }
  for (const revision of activity.revisions) {
    const key = dayKey(localDay(revision.at));
    const entry = out.get(key);
    if (!entry) continue;
    entry.revisions += 1;
    tally(key, revision.work).revisions += 1;
  }
  for (const [key, entry] of out) {
    entry.works = [...(counts.get(key)?.values() ?? [])]
      .map((count) => ({ work: count.work, provider: (count.claude > count.codex ? "claude" : "codex") as Provider, requests: count.requests, revisions: count.revisions }))
      .sort((a, b) => b.requests + b.revisions - (a.requests + a.revisions) || a.work.title.localeCompare(b.work.title, "ko"));
  }
  for (const event of events) for (const day of eventDays(event, days)) out.get(dayKey(day))?.events.push(event);
  for (const entry of out.values()) entry.events.sort(byEventStart);
  return out;
}

/** All-day events first, then by start. */
export const byEventStart = (a: CalendarEvent, b: CalendarEvent) => Number(Boolean(b.days)) - Number(Boolean(a.days)) || a.start - b.start || a.title.localeCompare(b.title, "ko");

/** The days among `days` an event is on (all-day: its dates; timed: every day it overlaps). */
export function eventDays(event: CalendarEvent, days: Day[]): Day[] {
  if (event.days) {
    const from = parseDayKey(event.days.from);
    const to = parseDayKey(event.days.to);
    if (!from || !to) return [];
    return days.filter((day) => dayNumber(day) >= dayNumber(from) && dayNumber(day) < dayNumber(to));
  }
  return days.filter((day) => overlaps(event.start, event.end, startOf(day), startOf(addDays(day, 1))));
}

/** A month day's lines: two events first, then works, then the other events; the rest as "외 N". */
export function dayLines(entry: MonthDay, max: number): { lines: ({ kind: "event"; event: CalendarEvent } | { kind: "work"; work: MonthWork })[]; more: number } {
  const ordered = [
    ...entry.events.slice(0, 2).map((event) => ({ kind: "event" as const, event })),
    ...entry.works.map((work) => ({ kind: "work" as const, work })),
    ...entry.events.slice(2).map((event) => ({ kind: "event" as const, event })),
  ];
  if (ordered.length <= max) return { lines: ordered, more: 0 };
  return { lines: ordered.slice(0, max - 1), more: ordered.length - (max - 1) };
}

/** Timed events of a day as hour spans (0–24), and its all-day events. */
export function dayEvents(day: Day, events: CalendarEvent[]) {
  const since = startOf(day);
  const until = startOf(addDays(day, 1));
  const allDay = events.filter((event) => event.days && eventDays(event, [day]).length);
  const timed = events
    .filter((event) => !event.days && overlaps(event.start, event.end, since, until))
    .map((event) => ({ event, top: hoursIn(event.start, day), bottom: Math.max(hoursIn(event.end, day), hoursIn(event.start, day)) }));
  return { allDay, timed };
}

/** Totals of a period for the line under the title. */
export function periodTotals(activity: Activity, since: number, until: number) {
  const works = new Set<string>();
  let requests = 0;
  let revisions = 0;
  for (const turn of activity.turns) {
    if (turn.start < since || turn.start >= until) continue;
    requests += 1;
    works.add(turn.work.id);
  }
  for (const revision of activity.revisions) {
    if (revision.at < since || revision.at >= until) continue;
    revisions += 1;
    works.add(revision.work.id);
  }
  return { requests, revisions, works: works.size };
}
