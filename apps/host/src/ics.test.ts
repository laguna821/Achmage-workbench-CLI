import { describe, expect, it } from "vitest";
import { contentLines, looksLikeIcs, occurrences, parseDuration, parseIcs, parseProperty, resolveZone, wallToEpoch, zoneOffset } from "./ics.ts";

// iCalendar feeds for home "흐름": the reader and the occurrences of a window. Times are checked as
// moments (UTC), so the result does not depend on the zone the tests run in.

const SEOUL = "Asia/Seoul";
const utc = (y: number, m: number, d: number, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h, mi);
/** A Seoul wall time as a moment (UTC+9 all year). */
const seoul = (y: number, m: number, d: number, h = 0, mi = 0) => utc(y, m, d, h, mi) - 9 * 3600_000;
const OCTOBER = [seoul(2026, 10, 1), seoul(2026, 11, 1)] as const;

const calendar = (...events: string[]) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//test//KO", "X-WR-CALNAME:학과 일정", "X-WR-TIMEZONE:Asia/Seoul", ...events, "END:VCALENDAR"].join("\r\n");
const event = (...lines: string[]) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n");
const starts = (text: string, from: number, to: number, viewer = SEOUL) => occurrences(parseIcs(text), from, to, viewer).map((entry) => entry.start);

describe("reading the file", () => {
  it("undoes folding on the bytes, also inside a multi-byte character", () => {
    const head = Buffer.from("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:20261029T010000Z\r\nSUMMARY:학과 ", "utf8");
    const word = Buffer.from("회의", "utf8");
    const tail = Buffer.from("\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n", "utf8");
    // The fold falls between the first and second byte of "회".
    const folded = Buffer.concat([head, word.subarray(0, 1), Buffer.from("\r\n ", "utf8"), word.subarray(1), tail]);
    expect(parseIcs(folded).events[0]!.summary).toBe("학과 회의");
    expect(contentLines("A:1\r\n 2\nB:3")).toEqual(["A:12", "B:3"]);
  });

  it("reads parameters, quoted ones with : and ; inside, and escaped text", () => {
    expect(parseProperty('DTSTART;TZID="(UTC+09:00) Seoul; Tokyo":20261029T090000')).toEqual({ name: "DTSTART", params: { TZID: "(UTC+09:00) Seoul; Tokyo" }, value: "20261029T090000" });
    expect(parseProperty("url:https://example.com/a?b=c")).toEqual({ name: "URL", params: {}, value: "https://example.com/a?b=c" });
    const parsed = parseIcs(calendar(event("UID:x", "DTSTART:20261029T010000Z", "SUMMARY:회의\\, 준비\\; 정리\\n둘째 줄", "LOCATION:본관 301호")));
    expect(parsed.name).toBe("학과 일정");
    expect(parsed.zone).toBe(SEOUL);
    expect(parsed.events[0]).toMatchObject({ summary: "회의, 준비; 정리\n둘째 줄", location: "본관 301호" });
  });

  it("tells an iCalendar file from a web page", () => {
    expect(looksLikeIcs("﻿BEGIN:VCALENDAR\r\nVERSION:2.0")).toBe(true);
    expect(looksLikeIcs("<!doctype html><html>")).toBe(false);
  });

  it("reads durations", () => {
    expect(parseDuration("PT1H30M")).toEqual({ ms: 5400_000, days: 0 });
    expect(parseDuration("P1D")).toEqual({ ms: 86_400_000, days: 1 });
    expect(parseDuration("P2W")).toMatchObject({ days: 14 });
    expect(parseDuration("-PT15M")).toMatchObject({ ms: -900_000 });
    expect(parseDuration("P")).toBeNull();
  });
});

describe("time zones", () => {
  it("reads IANA names, Windows names, longer paths, the file's VTIMEZONE and written offsets", () => {
    const fixed = new Map([["My Zone", 330]]);
    expect(resolveZone("Asia/Seoul", fixed)).toEqual({ kind: "iana", name: SEOUL });
    expect(resolveZone("Korea Standard Time", fixed)).toEqual({ kind: "iana", name: SEOUL });
    expect(resolveZone("/mozilla.org/20070129_1/Europe/Berlin", fixed)).toEqual({ kind: "iana", name: "Europe/Berlin" });
    expect(resolveZone("My Zone", fixed)).toEqual({ kind: "fixed", minutes: 330 });
    expect(resolveZone("(UTC+09:00) Osaka, Sapporo", fixed)).toEqual({ kind: "fixed", minutes: 540 });
    expect(resolveZone("Nowhere/Unknown", fixed)).toEqual({ kind: "floating" });
  });

  it("turns wall times into moments across daylight saving", () => {
    expect(zoneOffset(utc(2026, 10, 29, 12), "America/New_York")).toBe(-240);
    expect(zoneOffset(utc(2026, 11, 2, 12), "America/New_York")).toBe(-300);
    const ny = { kind: "iana" as const, name: "America/New_York" };
    expect(wallToEpoch({ y: 2026, m: 10, d: 30, h: 9, mi: 0, s: 0 }, ny, SEOUL)).toBe(utc(2026, 10, 30, 13));
    expect(wallToEpoch({ y: 2026, m: 11, d: 2, h: 9, mi: 0, s: 0 }, ny, SEOUL)).toBe(utc(2026, 11, 2, 14));
    // The hour that does not exist (spring forward) uses the offset before it: 02:30 EST = 03:30 EDT.
    expect(wallToEpoch({ y: 2026, m: 3, d: 8, h: 2, mi: 30, s: 0 }, ny, SEOUL)).toBe(utc(2026, 3, 8, 7, 30));
    // The hour that occurs twice (fall back) is the first one: 01:30 EDT.
    expect(wallToEpoch({ y: 2026, m: 11, d: 1, h: 1, mi: 30, s: 0 }, ny, SEOUL)).toBe(utc(2026, 11, 1, 5, 30));
  });
});

describe("single events", () => {
  it("places UTC, TZID, Windows-named and floating times", () => {
    const text = calendar(
      event("UID:utc", "DTSTART:20261029T010000Z", "DTEND:20261029T020000Z", "SUMMARY:UTC"),
      event("UID:ny", "DTSTART;TZID=America/New_York:20261029T090000", "DTEND;TZID=America/New_York:20261029T100000", "SUMMARY:뉴욕"),
      event("UID:win", "DTSTART;TZID=Korea Standard Time:20261029T150000", "DURATION:PT30M", "SUMMARY:윈도"),
      event("UID:float", "DTSTART:20261029T180000", "DTEND:20261029T190000", "SUMMARY:떠 있는 시각"),
    );
    const found = occurrences(parseIcs(text), ...OCTOBER, SEOUL);
    const byUid = Object.fromEntries(found.map((entry) => [entry.uid, entry]));
    expect([byUid.utc!.start, byUid.utc!.end]).toEqual([utc(2026, 10, 29, 1), utc(2026, 10, 29, 2)]);
    expect([byUid.ny!.start, byUid.ny!.end]).toEqual([utc(2026, 10, 29, 13), utc(2026, 10, 29, 14)]);
    expect([byUid.win!.start, byUid.win!.end]).toEqual([seoul(2026, 10, 29, 15), seoul(2026, 10, 29, 15, 30)]);
    // Floating: the calendar's X-WR-TIMEZONE.
    expect(byUid.float!.start).toBe(seoul(2026, 10, 29, 18));
    expect(found.every((entry) => entry.days === null)).toBe(true);
  });

  it("keeps all-day events on their dates, the last one exclusive", () => {
    const text = calendar(event("UID:trip", "DTSTART;VALUE=DATE:20261029", "DTEND;VALUE=DATE:20261031", "SUMMARY:학회"), event("UID:one", "DTSTART;VALUE=DATE:20261101", "SUMMARY:하루"));
    const found = occurrences(parseIcs(text), seoul(2026, 10, 26), seoul(2026, 11, 2), SEOUL);
    expect(found.map((entry) => [entry.uid, entry.days, entry.start, entry.end])).toEqual([
      ["trip", { from: "2026-10-29", to: "2026-10-31" }, seoul(2026, 10, 29), seoul(2026, 10, 31)],
      ["one", { from: "2026-11-01", to: "2026-11-02" }, seoul(2026, 11, 1), seoul(2026, 11, 2)],
    ]);
    // Seen from New York, the same days (all-day events have no zone).
    const ny = occurrences(parseIcs(text), utc(2026, 10, 26, 4), utc(2026, 11, 2, 5), "America/New_York");
    expect(ny.map((entry) => entry.days?.from)).toEqual(["2026-10-29", "2026-11-01"]);
  });

  it("includes an event that began before the window and skips cancelled ones", () => {
    const text = calendar(
      event("UID:late", "DTSTART;TZID=Asia/Seoul:20260930T230000", "DTEND;TZID=Asia/Seoul:20261001T010000", "SUMMARY:자정 넘어"),
      event("UID:gone", "DTSTART:20261005T010000Z", "STATUS:CANCELLED", "SUMMARY:취소"),
    );
    expect(occurrences(parseIcs(text), ...OCTOBER, SEOUL).map((entry) => entry.uid)).toEqual(["late"]);
  });
});

describe("recurring events", () => {
  it("repeats weekly on the BYDAY days, COUNT counting from the first", () => {
    const text = calendar(event("UID:class", "DTSTART;TZID=Asia/Seoul:20261005T100000", "DTEND;TZID=Asia/Seoul:20261005T113000", "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=5", "SUMMARY:미디어와 사회"));
    expect(starts(text, ...OCTOBER)).toEqual([seoul(2026, 10, 5, 10), seoul(2026, 10, 7, 10), seoul(2026, 10, 12, 10), seoul(2026, 10, 14, 10), seoul(2026, 10, 19, 10)]);
    // Only the part in the window, COUNT still counted from DTSTART.
    expect(starts(text, seoul(2026, 10, 13), seoul(2026, 10, 31))).toEqual([seoul(2026, 10, 14, 10), seoul(2026, 10, 19, 10)]);
  });

  it("keeps the wall time of its own zone across daylight saving", () => {
    const text = calendar(event("UID:ny", "DTSTART;TZID=America/New_York:20261019T090000", "DURATION:PT1H", "RRULE:FREQ=WEEKLY", "SUMMARY:뉴욕 회의"));
    expect(starts(text, utc(2026, 10, 25), utc(2026, 11, 10))).toEqual([utc(2026, 10, 26, 13), utc(2026, 11, 2, 14), utc(2026, 11, 9, 14)]);
  });

  it("repeats daily with INTERVAL and UNTIL, and drops EXDATE", () => {
    const text = calendar(
      event("UID:d", "DTSTART;TZID=Asia/Seoul:20261001T080000", "RRULE:FREQ=DAILY;INTERVAL=2;UNTIL=20261009T000000Z", "EXDATE;TZID=Asia/Seoul:20261005T080000", "SUMMARY:운동"),
    );
    // 1, 3, (5 excluded), 7, 9 (08:00 Seoul is 23:00Z on the 8th, before UNTIL).
    expect(starts(text, ...OCTOBER)).toEqual([seoul(2026, 10, 1, 8), seoul(2026, 10, 3, 8), seoul(2026, 10, 7, 8), seoul(2026, 10, 9, 8)]);
  });

  it("repeats daily on chosen weekdays only", () => {
    const text = calendar(event("UID:w", "DTSTART;TZID=Asia/Seoul:20261026T090000", "RRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;COUNT=6", "SUMMARY:출근"));
    expect(starts(text, ...OCTOBER).map((at) => new Date(at + 9 * 3600_000).getUTCDate())).toEqual([26, 27, 28, 29, 30]);
  });

  it("repeats monthly on the last Friday, on the 31st only where there is one, and on the last weekday", () => {
    const last = calendar(event("UID:f", "DTSTART;TZID=Asia/Seoul:20260925T170000", "RRULE:FREQ=MONTHLY;BYDAY=-1FR", "SUMMARY:마감"));
    expect(starts(last, seoul(2026, 10, 1), seoul(2026, 12, 1))).toEqual([seoul(2026, 10, 30, 17), seoul(2026, 11, 27, 17)]);
    const thirtyFirst = calendar(event("UID:m", "DTSTART;VALUE=DATE:20260831", "RRULE:FREQ=MONTHLY;BYMONTHDAY=31", "SUMMARY:정산"));
    expect(occurrences(parseIcs(thirtyFirst), seoul(2026, 9, 1), seoul(2027, 1, 1), SEOUL).map((entry) => entry.days!.from)).toEqual(["2026-10-31", "2026-12-31"]);
    const weekday = calendar(event("UID:p", "DTSTART;TZID=Asia/Seoul:20260930T090000", "RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1", "SUMMARY:월말"));
    expect(starts(weekday, seoul(2026, 10, 1), seoul(2027, 1, 1)).map((at) => new Date(at + 9 * 3600_000).toISOString().slice(0, 10))).toEqual(["2026-10-30", "2026-11-30", "2026-12-31"]);
  });

  it("repeats yearly (a birthday from long ago) and daily from years back without walking every day", () => {
    const text = calendar(
      event("UID:b", "DTSTART;VALUE=DATE:19901029", "DTEND;VALUE=DATE:19901030", "RRULE:FREQ=YEARLY", "SUMMARY:생일"),
      event("UID:d", "DTSTART;TZID=Asia/Seoul:20000101T070000", "RRULE:FREQ=DAILY", "SUMMARY:아침"),
    );
    const started = performance.now();
    const found = occurrences(parseIcs(text), seoul(2026, 10, 29), seoul(2026, 10, 30), SEOUL);
    expect(performance.now() - started).toBeLessThan(200);
    expect(found.map((entry) => [entry.uid, entry.days?.from ?? entry.start])).toEqual([
      ["b", "2026-10-29"],
      ["d", seoul(2026, 10, 29, 7)],
    ]);
  });

  it("reads a calendar of years quickly: one-off events far from the window are skipped early", () => {
    const events: string[] = [];
    for (let index = 0; index < 20_000; index += 1) {
      const day = new Date(Date.UTC(2016, 0, 1) + index * 4 * 3600_000);
      const stamp = `${day.getUTCFullYear()}${String(day.getUTCMonth() + 1).padStart(2, "0")}${String(day.getUTCDate()).padStart(2, "0")}T${String(day.getUTCHours()).padStart(2, "0")}0000`;
      events.push(event(`UID:e${index}`, `DTSTART;TZID=Asia/Seoul:${stamp}`, "DURATION:PT1H", `SUMMARY:일정 ${index}`));
    }
    const parsed = parseIcs(calendar(...events));
    const started = performance.now();
    const found = occurrences(parsed, seoul(2018, 3, 5), seoul(2018, 3, 12), SEOUL);
    expect(performance.now() - started).toBeLessThan(300);
    // Every 4 hours over the week: 42 of them.
    expect(found).toHaveLength(42);
    expect(found[0]!.start).toBe(seoul(2018, 3, 5));
  });

  it("moves or cancels single occurrences (RECURRENCE-ID) and adds RDATE", () => {
    const text = calendar(
      event("UID:s", "DTSTART;TZID=Asia/Seoul:20261005T140000", "DURATION:PT1H", "RRULE:FREQ=WEEKLY;COUNT=4", "RDATE;TZID=Asia/Seoul:20261031T100000", "SUMMARY:세미나"),
      event("UID:s", "RECURRENCE-ID;TZID=Asia/Seoul:20261012T140000", "DTSTART;TZID=Asia/Seoul:20261013T160000", "DURATION:PT1H", "SUMMARY:세미나(옮김)"),
      event("UID:s", "RECURRENCE-ID;TZID=Asia/Seoul:20261019T140000", "DTSTART;TZID=Asia/Seoul:20261019T140000", "STATUS:CANCELLED", "SUMMARY:세미나"),
    );
    const found = occurrences(parseIcs(text), ...OCTOBER, SEOUL);
    expect(found.map((entry) => [entry.summary, entry.start])).toEqual([
      ["세미나", seoul(2026, 10, 5, 14)],
      ["세미나(옮김)", seoul(2026, 10, 13, 16)],
      ["세미나", seoul(2026, 10, 26, 14)],
      ["세미나", seoul(2026, 10, 31, 10)],
    ]);
  });
});
