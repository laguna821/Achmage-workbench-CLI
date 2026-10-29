// Home "흐름" as a calendar: the day, week and month of the real calendar, paged back and forth.
// Plain date math, no React and no imports, so the rules can be tested (also in another time
// zone, calendar.test.tsx). Days are calendar dates counted without any time zone; a date
// becomes a moment only at its local midnight (`startOf`), so daylight saving never shifts a day.

const DAY_MS = 86_400_000;

/** A calendar date, month 1–12. */
export type Day = { y: number; m: number; d: number };

export type FlowView = "day" | "week" | "month";

/** 하루 · 주 · 달: the unit of the period shown (any day, week or month, not a span ending today). */
export const FLOW_VIEWS: { id: FlowView; label: string; unit: string }[] = [
  { id: "day", label: "하루", unit: "날" },
  { id: "week", label: "주", unit: "주" },
  { id: "month", label: "달", unit: "달" },
];

/** By `weekdayOf` (0 = Sunday). */
export const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

/** Weeks start on Monday (as `dateRange("thisweek")` in the views does). */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

export const dayNumber = (day: Day) => Math.round(Date.UTC(day.y, day.m - 1, day.d) / DAY_MS);

export function fromNumber(value: number): Day {
  const date = new Date(value * DAY_MS);
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
}

export const addDays = (day: Day, days: number) => fromNumber(dayNumber(day) + days);
export const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** The same day of another month, on its last day when the month is shorter (1월 31일 + 1 → 2월 28일). */
export function addMonths(day: Day, months: number): Day {
  const index = day.y * 12 + (day.m - 1) + months;
  const y = Math.floor(index / 12);
  const m = (index - y * 12) + 1;
  return { y, m, d: Math.min(day.d, daysInMonth(y, m)) };
}

/** 0 = Sunday. */
export const weekdayOf = (day: Day) => (((dayNumber(day) + 4) % 7) + 7) % 7;
export const mondayOf = (day: Day) => addDays(day, -((weekdayOf(day) + 6) % 7));
export const sameDay = (a: Day, b: Day) => a.y === b.y && a.m === b.m && a.d === b.d;
export const isWeekend = (day: Day) => weekdayOf(day) === 0 || weekdayOf(day) === 6;

const pad = (value: number) => String(value).padStart(2, "0");
export const dayKey = (day: Day) => `${String(day.y).padStart(4, "0")}-${pad(day.m)}-${pad(day.d)}`;

export function parseDayKey(value: unknown): Day | null {
  const found = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (!found) return null;
  const day = { y: Number(found[1]), m: Number(found[2]), d: Number(found[3]) };
  return day.m >= 1 && day.m <= 12 && day.d >= 1 && day.d <= daysInMonth(day.y, day.m) ? day : null;
}

/** The local date of a moment. */
export function localDay(at: number): Day {
  const date = new Date(at);
  return { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() };
}

/** Local midnight of a date (a day may be 23 or 25 hours long). */
export const startOf = (day: Day) => new Date(day.y, day.m - 1, day.d).getTime();

/** Where a moment falls in a day, in wall-clock hours 0–24 (clamped to the day). */
export function hoursIn(at: number, day: Day): number {
  if (at <= startOf(day)) return 0;
  if (at >= startOf(addDays(day, 1))) return 24;
  const date = new Date(at);
  return date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
}

export const dayTitle = (day: Day) => `${day.y}년 ${day.m}월 ${day.d}일 (${WEEKDAYS[weekdayOf(day)]})`;
export const shortDay = (day: Day) => `${day.m}월 ${day.d}일 (${WEEKDAYS[weekdayOf(day)]})`;

/** "10월 26일 – 11월 1일"; with the year when it is not this year or the week crosses one. */
export function weekTitle(first: Day, last: Day, today: Day) {
  if (first.y !== last.y) return `${first.y}년 ${first.m}월 ${first.d}일 – ${last.y}년 ${last.m}월 ${last.d}일`;
  const year = first.y === today.y ? "" : `${first.y}년 `;
  return `${year}${first.m}월 ${first.d}일 – ${last.m}월 ${last.d}일`;
}

export type Period = {
  view: FlowView;
  anchor: Day;
  /** Every day drawn: one, seven, or the month's whole weeks (with days of the months around it). */
  days: Day[];
  first: Day;
  last: Day;
  /** The month the month view is about (its other days are dimmed). */
  month: { y: number; m: number };
  /** Local midnight of the first day and of the day after the last. */
  since: number;
  until: number;
  title: string;
};

/** The day, the week (Monday–Sunday) or the month grid (whole weeks) that holds `anchor`. */
export function periodOf(view: FlowView, anchor: Day, today: Day): Period {
  let first: Day;
  let last: Day;
  let title: string;
  if (view === "day") {
    first = last = anchor;
    title = dayTitle(anchor);
  } else if (view === "week") {
    first = mondayOf(anchor);
    last = addDays(first, 6);
    title = weekTitle(first, last, today);
  } else {
    first = mondayOf({ y: anchor.y, m: anchor.m, d: 1 });
    last = addDays(mondayOf({ y: anchor.y, m: anchor.m, d: daysInMonth(anchor.y, anchor.m) }), 6);
    title = `${anchor.y}년 ${anchor.m}월`;
  }
  const days = Array.from({ length: dayNumber(last) - dayNumber(first) + 1 }, (_, index) => addDays(first, index));
  return { view, anchor, days, first, last, month: { y: anchor.y, m: anchor.m }, since: startOf(first), until: startOf(addDays(last, 1)), title };
}

/** ‹ ›: a day, a week or a month back or on. */
export function shift(view: FlowView, anchor: Day, steps: number): Day {
  if (view === "day") return addDays(anchor, steps);
  if (view === "week") return addDays(anchor, steps * 7);
  return addMonths(anchor, steps);
}

/** ≪ ≫ in the month view. */
export const shiftYear = (anchor: Day, steps: number) => addMonths(anchor, steps * 12);

export const contains = (period: Period, day: Day) => dayNumber(day) >= dayNumber(period.first) && dayNumber(day) <= dayNumber(period.last);

/** The month grid's rows. */
export const weeksOf = (period: Period) => Array.from({ length: Math.ceil(period.days.length / 7) }, (_, row) => period.days.slice(row * 7, row * 7 + 7));

// ── what is remembered ───────────────────────────────────────────────────

export const FLOW_KEY = "workbench.homeFlow.v2";
/** The ranges before the calendar (오늘 · 7일 · 30일), still read once. */
export const LEGACY_FLOW_KEY = "workbench.homeFlow";

const LEGACY: Record<string, FlowView> = { today: "day", week: "week", month: "month" };

/**
 * The last view and the day it was on. The day is kept for the rest of that day (switching modes,
 * reopening the app); the next day "흐름" opens on today again. Anything unreadable gives the week.
 */
export function readFlowState(saved: string | null, legacy: string | null, today: Day): { view: FlowView; anchor: Day } {
  try {
    const value = saved ? (JSON.parse(saved) as { v?: unknown; view?: unknown; anchor?: unknown; on?: unknown }) : null;
    if (value && value.v === 2 && FLOW_VIEWS.some((entry) => entry.id === value.view)) {
      const anchor = parseDayKey(value.anchor);
      const on = parseDayKey(value.on);
      return { view: value.view as FlowView, anchor: anchor && on && sameDay(on, today) ? anchor : today };
    }
  } catch {
    // Not ours or damaged: start over.
  }
  return { view: (legacy && LEGACY[legacy]) || "week", anchor: today };
}

export const writeFlowState = (view: FlowView, anchor: Day, today: Day) => JSON.stringify({ v: 2, view, anchor: dayKey(anchor), on: dayKey(today) });

// ── layout ───────────────────────────────────────────────────────────────

/**
 * Hours the time grid shows: 8–20 at least, widened to every span and to now. Empty hours at the
 * edges fold away so a day is not mostly night; `all` shows 0–24.
 */
export function hourRange(spans: [number, number][], now: number | null, all = false): [number, number] {
  if (all) return [0, 24];
  let from = 8;
  let to = 20;
  for (const [start, end] of spans) {
    from = Math.min(from, Math.floor(start));
    to = Math.max(to, end > start ? Math.ceil(end) : Math.floor(start) + 1);
  }
  if (now !== null) {
    from = Math.min(from, Math.floor(now));
    to = Math.max(to, Math.floor(now) + 1);
  }
  return [Math.max(0, from), Math.min(24, to)];
}

export type Laid<T> = T & { lane: number; lanes: number };

/**
 * Side-by-side lanes for items that overlap (as calendars lay out events): each item takes the
 * first free lane; items that overlap one another share the width of their group.
 */
export function lanes<T extends { top: number; bottom: number }>(items: T[]): Laid<T>[] {
  const sorted = [...items].sort((a, b) => a.top - b.top || b.bottom - a.bottom);
  const out: Laid<T>[] = [];
  let group: Laid<T>[] = [];
  let ends: number[] = [];
  let groupEnd = -Infinity;
  const close = () => {
    for (const item of group) item.lanes = ends.length;
    group = [];
    ends = [];
  };
  for (const item of sorted) {
    if (item.top >= groupEnd) close();
    let lane = ends.findIndex((end) => end <= item.top);
    if (lane < 0) {
      lane = ends.length;
      ends.push(item.bottom);
    } else ends[lane] = item.bottom;
    const laid = { ...item, lane, lanes: 1 };
    group.push(laid);
    out.push(laid);
    groupEnd = Math.max(groupEnd, item.bottom);
  }
  close();
  return out;
}
