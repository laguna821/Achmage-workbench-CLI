import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  addMonths,
  dayKey,
  hourRange,
  hoursIn,
  lanes,
  mondayOf,
  periodOf,
  readFlowState,
  shift,
  shiftYear,
  startOf,
  writeFlowState,
  type Day,
} from "./calendar.ts";

// Home "흐름" as a calendar: the real day, week (Monday–Sunday) and month grid, paging, what is
// remembered, and the hour range of the time grids. Days are calendar dates; a date becomes a
// moment only at its local midnight, so daylight saving never moves a day.

const day = (y: number, m: number, d: number): Day => ({ y, m, d });
const TODAY = day(2026, 10, 29);
const keys = (days: Day[]) => days.map(dayKey);

describe("periods", () => {
  it("starts weeks on Monday", () => {
    expect(dayKey(mondayOf(day(2026, 10, 29)))).toBe("2026-10-26");
    expect(dayKey(mondayOf(day(2026, 11, 1)))).toBe("2026-10-26");
    expect(dayKey(mondayOf(day(2026, 10, 26)))).toBe("2026-10-26");
    expect(dayKey(mondayOf(day(2027, 1, 2)))).toBe("2026-12-28");
  });

  it("is a day with its title, from local midnight to the next", () => {
    const period = periodOf("day", TODAY, TODAY);
    expect(period.title).toBe("2026년 10월 29일 (목)");
    expect(period.since).toBe(new Date(2026, 9, 29).getTime());
    expect(period.until).toBe(new Date(2026, 9, 30).getTime());
    expect(keys(period.days)).toEqual(["2026-10-29"]);
  });

  it("is a week Monday to Sunday, with the year only when it is not this year or crosses one", () => {
    const week = periodOf("week", TODAY, TODAY);
    expect(keys(week.days)).toEqual(["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]);
    expect(week.title).toBe("10월 26일 – 11월 1일");
    expect(periodOf("week", day(2025, 10, 29), TODAY).title).toBe("2025년 10월 27일 – 11월 2일");
    expect(periodOf("week", day(2026, 12, 30), TODAY).title).toBe("2026년 12월 28일 – 2027년 1월 3일");
  });

  it("is a month of whole weeks, with the days of the months around it", () => {
    const october = periodOf("month", TODAY, TODAY);
    expect(october.title).toBe("2026년 10월");
    expect(october.days).toHaveLength(35);
    expect(dayKey(october.first)).toBe("2026-09-28");
    expect(dayKey(october.last)).toBe("2026-11-01");
    expect(october.days.filter((entry) => entry.m !== 10).map(dayKey)).toEqual(["2026-09-28", "2026-09-29", "2026-09-30", "2026-11-01"]);
    // August 2026 starts on a Saturday and needs six rows; February 2027 fits four exactly.
    const august = periodOf("month", day(2026, 8, 15), TODAY);
    expect([august.days.length, dayKey(august.first), dayKey(august.last)]).toEqual([42, "2026-07-27", "2026-09-06"]);
    const february = periodOf("month", day(2027, 2, 10), TODAY);
    expect([february.days.length, dayKey(february.first), dayKey(february.last)]).toEqual([28, "2027-02-01", "2027-02-28"]);
  });

  it("pages by a day, a week, a month and a year, keeping the day of the month where it can", () => {
    expect(dayKey(shift("day", day(2026, 10, 31), 1))).toBe("2026-11-01");
    expect(dayKey(shift("week", TODAY, -1))).toBe("2026-10-22");
    expect(dayKey(shift("month", day(2027, 1, 31), 1))).toBe("2027-02-28");
    expect(dayKey(shift("month", day(2028, 1, 31), 1))).toBe("2028-02-29");
    expect(dayKey(shift("month", day(2026, 1, 15), -1))).toBe("2025-12-15");
    expect(dayKey(shiftYear(day(2028, 2, 29), 1))).toBe("2029-02-28");
    expect(dayKey(addMonths(day(2026, 10, 29), -22))).toBe("2024-12-29");
  });

  it("places moments in a day by the wall clock", () => {
    expect(hoursIn(new Date(2026, 9, 29, 14, 30).getTime(), TODAY)).toBe(14.5);
    expect(hoursIn(new Date(2026, 9, 28, 23).getTime(), TODAY)).toBe(0);
    expect(hoursIn(new Date(2026, 9, 30, 1).getTime(), TODAY)).toBe(24);
  });
});

describe("what is remembered", () => {
  it("keeps the view and, for the rest of the day, the day it was on", () => {
    const saved = writeFlowState("month", day(2025, 3, 2), TODAY);
    expect(readFlowState(saved, null, TODAY)).toEqual({ view: "month", anchor: day(2025, 3, 2) });
    // The next day "흐름" opens on today again, in the same view.
    expect(readFlowState(saved, null, day(2026, 10, 30))).toEqual({ view: "month", anchor: day(2026, 10, 30) });
  });

  it("reads the ranges from before the calendar, and anything else as the week of today", () => {
    expect(readFlowState(null, "today", TODAY)).toEqual({ view: "day", anchor: TODAY });
    expect(readFlowState(null, "month", TODAY).view).toBe("month");
    expect(readFlowState("{not json", "week", TODAY)).toEqual({ view: "week", anchor: TODAY });
    expect(readFlowState(JSON.stringify({ v: 3, view: "day" }), null, TODAY)).toEqual({ view: "week", anchor: TODAY });
    expect(readFlowState(JSON.stringify({ v: 2, view: "day", anchor: "2026-02-31", on: dayKey(TODAY) }), null, TODAY)).toEqual({ view: "day", anchor: TODAY });
    expect(readFlowState(null, null, TODAY)).toEqual({ view: "week", anchor: TODAY });
  });
});

describe("layout", () => {
  it("shows 8–20 at least, widened to what happened and to now, or the whole day", () => {
    expect(hourRange([], null)).toEqual([8, 20]);
    expect(hourRange([[6.5, 7]], null)).toEqual([6, 20]);
    expect(hourRange([[21.2, 23.5]], null)).toEqual([8, 24]);
    expect(hourRange([[22, 22]], null)).toEqual([8, 23]);
    expect(hourRange([], 2.3)).toEqual([2, 20]);
    expect(hourRange([[9, 10]], null, true)).toEqual([0, 24]);
  });

  it("puts overlapping items side by side, each group sharing its width", () => {
    const laid = lanes([
      { id: "a", top: 9, bottom: 11 },
      { id: "b", top: 10, bottom: 12 },
      { id: "c", top: 11, bottom: 13 },
      { id: "d", top: 14, bottom: 15 },
    ]);
    expect(laid.map((item) => [item.id, item.lane, item.lanes])).toEqual([
      ["a", 0, 2],
      ["b", 1, 2],
      ["c", 0, 2],
      ["d", 0, 1],
    ]);
  });
});

describe("daylight saving", () => {
  // In New York the week of 26 October 2026 ends on the day clocks go back (25 hours), and the
  // week of 2 March ends on the day they go forward (8 March, 23 hours). Run where that happens.
  it("keeps every day at local midnight and the wall clock in the day", () => {
    const script = `
      const { periodOf, startOf, hoursIn, addDays } = await import(${JSON.stringify(new URL("./calendar.ts", import.meta.url).href)});
      const fall = periodOf("week", { y: 2026, m: 10, d: 29 }, { y: 2026, m: 10, d: 29 });
      const spring = periodOf("week", { y: 2026, m: 3, d: 5 }, { y: 2026, m: 3, d: 5 });
      const sunday = fall.days[6];
      console.log(JSON.stringify({
        zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        fallHours: (fall.until - fall.since) / 3600000,
        springHours: (spring.until - spring.since) / 3600000,
        midnights: [...fall.days, ...spring.days].every((day) => new Date(startOf(day)).getHours() === 0),
        sundayLength: (startOf(addDays(sunday, 1)) - startOf(sunday)) / 3600000,
        threeAm: hoursIn(new Date(2026, 10, 1, 3, 0).getTime(), sunday),
      }));
    `;
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, TZ: "America/New_York" }, encoding: "utf8" });
    expect(run.stderr.replace(/\(node:\d+\) ExperimentalWarning.*\n?/g, "").replace(/\(Use `node --trace-warnings.*\n?/g, "")).toBe("");
    expect(JSON.parse(run.stdout)).toEqual({ zone: "America/New_York", fallHours: 169, springHours: 167, midnights: true, sundayLength: 25, threeAm: 3 });
  });

  it("does the same here, whatever this zone is", () => {
    const week = periodOf("week", TODAY, TODAY);
    expect(week.days.every((entry) => new Date(startOf(entry)).getHours() === 0)).toBe(true);
  });
});
