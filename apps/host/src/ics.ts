// iCalendar (RFC 5545) for home "흐름": the events of a calendar the user subscribes to by its
// address (Google Calendar's "iCal 형식의 비밀 주소", any .ics). A small reader, no dependency:
// VEVENT with DTSTART/DTEND/DURATION, SUMMARY and LOCATION; all-day dates; UTC, TZID (IANA names,
// Outlook's Windows names, the file's own VTIMEZONE as a fixed offset) and floating times; RRULE
// with FREQ DAILY/WEEKLY/MONTHLY/YEARLY and INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY, BYMONTH,
// BYSETPOS, WKST; EXDATE, RDATE, and single occurrences moved or cancelled (RECURRENCE-ID).
// Occurrences are made only for the window asked for, in the event's own time zone, so a weekly
// 9:00 meeting in New York stays at 9:00 there across daylight saving.

const DAY_MS = 86_400_000;
/** Recurrence periods walked at most per event and request (a daily series over 100 years is ~36k). */
const MAX_PERIODS = 60_000;

/** A calendar date (month 1–12). */
export type Civil = { y: number; m: number; d: number };
export type Wall = Civil & { h: number; mi: number; s: number };

/** Where a wall time is read: a named zone, a fixed offset (minutes east of UTC), or the viewer's zone. */
export type Zone = { kind: "iana"; name: string } | { kind: "fixed"; minutes: number } | { kind: "floating" };

export type IcsTime = { kind: "date"; date: Civil } | { kind: "utc"; at: number } | { kind: "local"; wall: Wall; zone: Zone };

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type Rule = {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  count: number | null;
  until: IcsTime | null;
  /** `n` 0 for every such weekday, else the n-th in the month (negative from its end). */
  byDay: { n: number; day: Weekday }[];
  byMonthDay: number[];
  byMonth: number[];
  bySetPos: number[];
  wkst: Weekday;
};

export type IcsEvent = {
  uid: string;
  summary: string;
  location: string | null;
  start: IcsTime;
  /** Timed events last an exact time; all-day ones a number of days. */
  length: { ms: number } | { days: number };
  rule: Rule | null;
  exdates: IcsTime[];
  rdates: IcsTime[];
  /** Set on a single occurrence of a series that was moved or cancelled. */
  recurrenceId: IcsTime | null;
  cancelled: boolean;
};

export type IcsCalendar = {
  /** X-WR-CALNAME: the calendar's own name. */
  name: string | null;
  /** X-WR-TIMEZONE: the calendar's zone, used for floating times. */
  zone: string | null;
  events: IcsEvent[];
};

export type Occurrence = {
  uid: string;
  summary: string;
  location: string | null;
  start: number;
  end: number;
  /** All-day: its days as `YYYY-MM-DD`, `to` exclusive (start/end are then the viewer's midnights). */
  days: { from: string; to: string } | null;
};

// ── dates ───────────────────────────────────────────────────────────────

/** Days since 1970-01-01 of a calendar date (no time zone involved). */
export const dayNumber = (date: Civil) => Math.round(Date.UTC(date.y, date.m - 1, date.d) / DAY_MS);

export function civilOf(day: number): Civil {
  const date = new Date(day * DAY_MS);
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
}

/** 0 = Sunday. */
export const weekdayOf = (day: number) => ((((day + 4) % 7) + 7) % 7) as Weekday;

export const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

const pad = (value: number, size = 2) => String(value).padStart(size, "0");
export const dateKey = (date: Civil) => `${pad(date.y, 4)}-${pad(date.m)}-${pad(date.d)}`;

// ── zones ───────────────────────────────────────────────────────────────

const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatter(name: string): Intl.DateTimeFormat | null {
  let found = formatters.get(name);
  if (found === undefined) {
    try {
      found = new Intl.DateTimeFormat("en-US", { timeZone: name, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    } catch {
      found = null;
    }
    formatters.set(name, found);
  }
  return found;
}

export const isZoneName = (name: string) => Boolean(name) && formatter(name) !== null;

/** Minutes east of UTC of a named zone at a moment. */
export function zoneOffset(at: number, name: string): number {
  const format = formatter(name);
  if (!format) return 0;
  const parts: Record<string, number> = {};
  for (const part of format.formatToParts(new Date(at))) if (part.type !== "literal") parts[part.type] = Number(part.value);
  const asUtc = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour! % 24, parts.minute!, parts.second!);
  return Math.round((asUtc - (at - (((at % 1000) + 1000) % 1000))) / 60_000);
}

/**
 * The moment a wall time names in a zone, as RFC 5545 §3.3.5 reads it: a time that occurs twice
 * (clocks set back) is the first one; a time skipped (clocks set forward) uses the offset before
 * the gap, so 02:30 on that day is 03:30 after it.
 */
export function wallToEpoch(wall: Wall, zone: Zone, viewer: string): number {
  const naive = Date.UTC(wall.y, wall.m - 1, wall.d, wall.h, wall.mi, wall.s);
  if (zone.kind === "fixed") return naive - zone.minutes * 60_000;
  const name = zone.kind === "iana" ? zone.name : viewer;
  const before = zoneOffset(naive - DAY_MS, name);
  const after = zoneOffset(naive + DAY_MS, name);
  const offsets = before === after ? [before] : [before, after];
  const valid = offsets.map((offset) => naive - offset * 60_000).filter((at, index) => zoneOffset(at, name) === offsets[index]);
  return valid.length ? Math.min(...valid) : naive - before * 60_000;
}

/** The wall time of a moment in a zone. */
export function epochToWall(at: number, zone: Zone, viewer: string): Wall {
  const minutes = zone.kind === "fixed" ? zone.minutes : zoneOffset(at, zone.kind === "iana" ? zone.name : viewer);
  const date = new Date(at + minutes * 60_000);
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate(), h: date.getUTCHours(), mi: date.getUTCMinutes(), s: date.getUTCSeconds() };
}

/** Outlook and Exchange name zones the Windows way. */
const WINDOWS_ZONES: Record<string, string> = {
  "Korea Standard Time": "Asia/Seoul",
  "Tokyo Standard Time": "Asia/Tokyo",
  "China Standard Time": "Asia/Shanghai",
  "Taipei Standard Time": "Asia/Taipei",
  "Singapore Standard Time": "Asia/Singapore",
  "SE Asia Standard Time": "Asia/Bangkok",
  "India Standard Time": "Asia/Kolkata",
  "Arabian Standard Time": "Asia/Dubai",
  "AUS Eastern Standard Time": "Australia/Sydney",
  "New Zealand Standard Time": "Pacific/Auckland",
  "UTC": "UTC",
  "Coordinated Universal Time": "UTC",
  "GMT Standard Time": "Europe/London",
  "Greenwich Standard Time": "Atlantic/Reykjavik",
  "W. Europe Standard Time": "Europe/Berlin",
  "Romance Standard Time": "Europe/Paris",
  "Central Europe Standard Time": "Europe/Budapest",
  "Central European Standard Time": "Europe/Warsaw",
  "E. Europe Standard Time": "Europe/Chisinau",
  "FLE Standard Time": "Europe/Kyiv",
  "GTB Standard Time": "Europe/Bucharest",
  "Russian Standard Time": "Europe/Moscow",
  "Eastern Standard Time": "America/New_York",
  "Central Standard Time": "America/Chicago",
  "Mountain Standard Time": "America/Denver",
  "US Mountain Standard Time": "America/Phoenix",
  "Pacific Standard Time": "America/Los_Angeles",
  "Alaskan Standard Time": "America/Anchorage",
  "Hawaiian Standard Time": "Pacific/Honolulu",
  "Atlantic Standard Time": "America/Halifax",
  "E. South America Standard Time": "America/Sao_Paulo",
  "Canada Central Standard Time": "America/Regina",
};

/** `+0900`, `-05:30` → minutes east of UTC. */
function offsetMinutes(value: string): number | null {
  const found = /^([+-])(\d{2}):?(\d{2})(?::?(\d{2}))?$/.exec(value.trim());
  if (!found) return null;
  const minutes = Number(found[2]) * 60 + Number(found[3]);
  return found[1] === "-" ? -minutes : minutes;
}

/** The zone a TZID names: an IANA name (also inside a longer path), a Windows name, the file's VTIMEZONE, or "UTC+09:00". */
export function resolveZone(tzid: string, fixed: Map<string, number>): Zone {
  const name = tzid.trim().replace(/^"|"$/g, "");
  if (isZoneName(name)) return { kind: "iana", name };
  // "/mozilla.org/20070129_1/Europe/Berlin", "/citadel.org/…/Asia/Seoul"
  const parts = name.split("/").filter(Boolean);
  for (let start = 1; start < parts.length; start += 1) {
    const candidate = parts.slice(start).join("/");
    if (candidate.includes("/") && isZoneName(candidate)) return { kind: "iana", name: candidate };
  }
  const windows = WINDOWS_ZONES[name];
  if (windows && isZoneName(windows)) return { kind: "iana", name: windows };
  const own = fixed.get(name);
  if (own !== undefined) return { kind: "fixed", minutes: own };
  const written = /(?:UTC|GMT)\s*([+-]\d{1,2}(?::?\d{2})?)/i.exec(name);
  if (written) {
    const [hours, minutes = "00"] = written[1]!.replace(/^([+-])(\d)(?!\d)/, "$10$2").split(":");
    const value = offsetMinutes(`${hours}${minutes.padStart(2, "0")}`);
    if (value !== null) return { kind: "fixed", minutes: value };
  }
  return { kind: "floating" };
}

// ── lines ───────────────────────────────────────────────────────────────

/**
 * Content lines with folding undone. Folding is undone on the bytes, before UTF-8 decoding: some
 * writers fold inside a multi-byte character (RFC 5545 §3.1 asks readers to restore it).
 */
export function contentLines(input: string | Uint8Array): string[] {
  let text: string;
  if (typeof input === "string") {
    text = input.replace(/\r?\n[ \t]/g, "");
  } else {
    const out = new Uint8Array(input.length);
    let size = 0;
    for (let index = 0; index < input.length; index += 1) {
      const byte = input[index]!;
      if (byte === 0x0d && input[index + 1] === 0x0a && (input[index + 2] === 0x20 || input[index + 2] === 0x09)) {
        index += 2;
        continue;
      }
      if (byte === 0x0a && (input[index + 1] === 0x20 || input[index + 1] === 0x09)) {
        index += 1;
        continue;
      }
      out[size++] = byte;
    }
    text = new TextDecoder("utf-8").decode(out.subarray(0, size));
  }
  return text.replace(/^﻿/, "").split(/\r?\n|\r/);
}

export type Property = { name: string; params: Record<string, string>; value: string };

/** `NAME;PARAM=value;PARAM="quoted:value":the value` */
export function parseProperty(line: string): Property | null {
  let quoted = false;
  let colon = -1;
  const cuts: number[] = [];
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === ";") cuts.push(index);
    else if (!quoted && char === ":") {
      colon = index;
      break;
    }
  }
  if (colon <= 0) return null;
  const head = [0, ...cuts.map((cut) => cut + 1)].map((from, index) => line.slice(from, index < cuts.length ? cuts[index] : colon));
  const name = head[0]!.trim().toUpperCase();
  if (!name) return null;
  const params: Record<string, string> = {};
  for (const param of head.slice(1)) {
    const equals = param.indexOf("=");
    if (equals <= 0) continue;
    params[param.slice(0, equals).trim().toUpperCase()] = param
      .slice(equals + 1)
      .split(",")
      .map((part) => part.trim().replace(/^"|"$/g, ""))
      .join(",");
  }
  return { name, params, value: line.slice(colon + 1) };
}

/** TEXT values: `\n`, `\,`, `\;`, `\\`. */
export const unescapeText = (value: string) => value.replace(/\\([\\;,nN])/g, (_, char: string) => (char === "n" || char === "N" ? "\n" : char));

// ── values ──────────────────────────────────────────────────────────────

const DATE = /^(\d{4})(\d{2})(\d{2})$/;
const DATE_TIME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(?:\.\d+)?(Z)?$/i;

function validDate(date: Civil) {
  return date.m >= 1 && date.m <= 12 && date.d >= 1 && date.d <= daysInMonth(date.y, date.m);
}

/** One DATE or DATE-TIME value, read with its TZID (or VALUE=DATE). */
export function parseTime(value: string, params: Record<string, string>, fixed: Map<string, number>): IcsTime | null {
  const text = value.trim();
  const date = DATE.exec(text);
  if (date) {
    const civil = { y: Number(date[1]), m: Number(date[2]), d: Number(date[3]) };
    return validDate(civil) ? { kind: "date", date: civil } : null;
  }
  const time = DATE_TIME.exec(text);
  if (!time) return null;
  const wall: Wall = { y: Number(time[1]), m: Number(time[2]), d: Number(time[3]), h: Number(time[4]), mi: Number(time[5]), s: Number(time[6] ?? 0) };
  if (!validDate(wall) || wall.h > 23 || wall.mi > 59 || wall.s > 60) return null;
  if (time[7]) return { kind: "utc", at: Date.UTC(wall.y, wall.m - 1, wall.d, wall.h, wall.mi, Math.min(wall.s, 59)) };
  if (params.VALUE?.toUpperCase() === "DATE") return { kind: "date", date: { y: wall.y, m: wall.m, d: wall.d } };
  return { kind: "local", wall, zone: params.TZID ? resolveZone(params.TZID, fixed) : { kind: "floating" } };
}

/** Several values of one line (EXDATE, RDATE); PERIOD values keep their start. */
function parseTimes(property: Property, fixed: Map<string, number>): IcsTime[] {
  return property.value
    .split(",")
    .map((part) => parseTime(part.split("/")[0]!, property.params, fixed))
    .filter((time): time is IcsTime => time !== null);
}

/** ISO 8601 durations as RFC 5545 writes them: `PT1H30M`, `P1D`, `P2W`, `-PT15M`. */
export function parseDuration(value: string): { ms: number; days: number } | null {
  const found = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(value.trim());
  if (!found || value.trim().length <= 1 + (found[1] ? 1 : 0)) return null;
  const sign = found[1] === "-" ? -1 : 1;
  const days = Number(found[2] ?? 0) * 7 + Number(found[3] ?? 0);
  const ms = (days * 86_400 + Number(found[4] ?? 0) * 3600 + Number(found[5] ?? 0) * 60 + Number(found[6] ?? 0)) * 1000;
  return { ms: sign * ms, days: sign * days };
}

const WEEKDAYS: Record<string, Weekday> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

const numbers = (value: string | undefined, min: number, max: number) =>
  (value ?? "")
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((number) => Number.isInteger(number) && number !== 0 && Math.abs(number) >= min && Math.abs(number) <= max);

export function parseRule(value: string, fixed: Map<string, number>): Rule | null {
  const parts: Record<string, string> = {};
  for (const part of value.split(";")) {
    const equals = part.indexOf("=");
    if (equals > 0) parts[part.slice(0, equals).trim().toUpperCase()] = part.slice(equals + 1).trim();
  }
  const freq = parts.FREQ?.toUpperCase();
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") return null;
  const interval = Math.max(1, Math.min(1000, Math.floor(Number(parts.INTERVAL ?? 1)) || 1));
  const count = parts.COUNT !== undefined && Number(parts.COUNT) > 0 ? Math.floor(Number(parts.COUNT)) : null;
  const byDay = (parts.BYDAY ?? "")
    .split(",")
    .map((part) => /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(part.trim()))
    .filter((found): found is RegExpExecArray => found !== null)
    .map((found) => ({ n: Number(found[1] ?? 0), day: WEEKDAYS[found[2]!.toUpperCase()]! }));
  return {
    freq,
    interval,
    count,
    until: parts.UNTIL ? parseTime(parts.UNTIL, {}, fixed) : null,
    byDay,
    byMonthDay: numbers(parts.BYMONTHDAY, 1, 31),
    byMonth: numbers(parts.BYMONTH, 1, 12).filter((month) => month > 0),
    bySetPos: numbers(parts.BYSETPOS, 1, 366),
    wkst: WEEKDAYS[(parts.WKST ?? "MO").toUpperCase()] ?? 1,
  };
}

// ── the file ────────────────────────────────────────────────────────────

type Draft = { props: Property[] };

function eventOf(draft: Draft, fixed: Map<string, number>, index: number): IcsEvent | null {
  const first = (name: string) => draft.props.find((prop) => prop.name === name);
  const startProp = first("DTSTART");
  if (!startProp) return null;
  const start = parseTime(startProp.value, startProp.params, fixed);
  if (!start) return null;
  const endProp = first("DTEND");
  const end = endProp ? parseTime(endProp.value, endProp.params, fixed) : null;
  const duration = first("DURATION") ? parseDuration(first("DURATION")!.value) : null;
  let length: IcsEvent["length"];
  if (start.kind === "date") {
    const days = end?.kind === "date" ? dayNumber(end.date) - dayNumber(start.date) : duration ? Math.round(duration.ms / DAY_MS) : 1;
    length = { days: Math.max(1, days) };
  } else if (end && end.kind !== "date") {
    // The exact time between the two, each read in its own zone (floating ones in the same zone).
    const viewer = "UTC";
    length = { ms: Math.max(0, timeEpoch(end, viewer) - timeEpoch(start, viewer)) };
  } else {
    length = { ms: Math.max(0, duration?.ms ?? 0) };
  }
  const ruleProp = first("RRULE");
  const recurrence = first("RECURRENCE-ID");
  const summary = first("SUMMARY");
  const location = first("LOCATION");
  return {
    uid: first("UID")?.value.trim() || `event-${index}`,
    summary: summary ? unescapeText(summary.value).trim() : "",
    location: location ? unescapeText(location.value).trim() || null : null,
    start,
    length,
    rule: ruleProp ? parseRule(ruleProp.value, fixed) : null,
    exdates: draft.props.filter((prop) => prop.name === "EXDATE").flatMap((prop) => parseTimes(prop, fixed)),
    rdates: draft.props.filter((prop) => prop.name === "RDATE").flatMap((prop) => parseTimes(prop, fixed)),
    recurrenceId: recurrence ? parseTime(recurrence.value, recurrence.params, fixed) : null,
    cancelled: first("STATUS")?.value.trim().toUpperCase() === "CANCELLED",
  };
}

/** True when the bytes look like an iCalendar file (a web page or an error page does not). */
export const looksLikeIcs = (text: string) => /^\s*BEGIN:VCALENDAR/i.test(text.replace(/^﻿/, "").slice(0, 2048));

/** Read a whole .ics file. Unknown components and properties are skipped. */
export function parseIcs(input: string | Uint8Array): IcsCalendar {
  const lines = contentLines(input);
  const fixed = new Map<string, number>();
  // VTIMEZONE first: events may name a zone defined after them.
  let zoneId: string | null = null;
  let zoneKind: string | null = null;
  let standard: number | null = null;
  let daylight: number | null = null;
  for (const line of lines) {
    const prop = parseProperty(line);
    if (!prop) continue;
    if (prop.name === "BEGIN" && prop.value.trim().toUpperCase() === "VTIMEZONE") {
      zoneId = null;
      standard = daylight = null;
    } else if (prop.name === "BEGIN" && (prop.value.trim().toUpperCase() === "STANDARD" || prop.value.trim().toUpperCase() === "DAYLIGHT")) {
      zoneKind = prop.value.trim().toUpperCase();
    } else if (prop.name === "TZID" && zoneKind === null) {
      zoneId = prop.value.trim();
    } else if (prop.name === "TZOFFSETTO" && zoneKind) {
      const minutes = offsetMinutes(prop.value);
      if (minutes !== null) {
        if (zoneKind === "STANDARD" && standard === null) standard = minutes;
        if (zoneKind === "DAYLIGHT" && daylight === null) daylight = minutes;
      }
    } else if (prop.name === "END" && (prop.value.trim().toUpperCase() === "STANDARD" || prop.value.trim().toUpperCase() === "DAYLIGHT")) {
      zoneKind = null;
    } else if (prop.name === "END" && prop.value.trim().toUpperCase() === "VTIMEZONE") {
      const minutes = standard ?? daylight;
      if (zoneId && minutes !== null) fixed.set(zoneId, minutes);
      zoneId = null;
    }
  }
  const events: IcsEvent[] = [];
  let name: string | null = null;
  let zone: string | null = null;
  const stack: string[] = [];
  let draft: Draft | null = null;
  for (const line of lines) {
    const prop = parseProperty(line);
    if (!prop) continue;
    if (prop.name === "BEGIN") {
      const component = prop.value.trim().toUpperCase();
      stack.push(component);
      if (component === "VEVENT" && stack.length === 2) draft = { props: [] };
      continue;
    }
    if (prop.name === "END") {
      const component = stack.pop();
      if (component === "VEVENT" && draft) {
        const event = eventOf(draft, fixed, events.length);
        if (event) events.push(event);
        draft = null;
      }
      continue;
    }
    const top = stack[stack.length - 1];
    if (top === "VEVENT" && draft && stack.length === 2) draft.props.push(prop);
    else if (top === "VCALENDAR" && stack.length === 1) {
      if (prop.name === "X-WR-CALNAME") name = unescapeText(prop.value).trim() || null;
      if (prop.name === "X-WR-TIMEZONE") zone = prop.value.trim() || null;
    }
  }
  return { name, zone, events };
}

// ── occurrences ─────────────────────────────────────────────────────────

/** The moment of a timed value (floating ones in `viewer`); a date's midnight in `viewer`. */
function timeEpoch(time: IcsTime, viewer: string): number {
  if (time.kind === "utc") return time.at;
  if (time.kind === "local") return wallToEpoch(time.wall, time.zone, viewer);
  return wallToEpoch({ ...time.date, h: 0, mi: 0, s: 0 }, { kind: "floating" }, viewer);
}

/** The day of a moment in a zone. */
const dayIn = (at: number, zone: Zone, viewer: string) => dayNumber(epochToWall(at, zone, viewer));

/** Days of one recurrence period that the rule's BY parts allow, in order (before BYSETPOS). */
function periodDays(rule: Rule, period: { first: number; last: number }, start: Civil): number[] {
  const out: number[] = [];
  const monthsOf = () => {
    const months: { y: number; m: number }[] = [];
    const a = civilOf(period.first);
    const b = civilOf(period.last);
    for (let y = a.y, m = a.m; y < b.y || (y === b.y && m <= b.m); m === 12 ? ((y += 1), (m = 1)) : (m += 1)) months.push({ y, m });
    return months;
  };
  if (rule.freq === "DAILY" || rule.freq === "WEEKLY") {
    for (let day = period.first; day <= period.last; day += 1) {
      const civil = civilOf(day);
      if (rule.byMonth.length && !rule.byMonth.includes(civil.m)) continue;
      if (rule.byMonthDay.length && !rule.byMonthDay.some((value) => (value > 0 ? value : daysInMonth(civil.y, civil.m) + 1 + value) === civil.d)) continue;
      if (rule.byDay.length && !rule.byDay.some((entry) => entry.day === weekdayOf(day))) continue;
      if (!rule.byDay.length && rule.freq === "WEEKLY" && weekdayOf(day) !== weekdayOf(dayNumber(start))) continue;
      out.push(day);
    }
    return out;
  }
  // MONTHLY: one month; YEARLY: the months of BYMONTH (or the start's month) in one year.
  for (const { y, m } of monthsOf()) {
    if (rule.freq === "YEARLY" && !(rule.byMonth.length ? rule.byMonth.includes(m) : m === start.m)) continue;
    if (rule.freq === "MONTHLY" && rule.byMonth.length && !rule.byMonth.includes(m)) continue;
    const length = daysInMonth(y, m);
    const firstDay = dayNumber({ y, m, d: 1 });
    let days: number[];
    const byMonthDay = rule.byMonthDay.map((value) => (value > 0 ? value : length + 1 + value)).filter((value) => value >= 1 && value <= length);
    if (rule.byDay.length) {
      const set = new Set<number>();
      for (const entry of rule.byDay) {
        const matching: number[] = [];
        for (let d = 1; d <= length; d += 1) if (weekdayOf(firstDay + d - 1) === entry.day) matching.push(d);
        if (entry.n === 0) matching.forEach((d) => set.add(d));
        else {
          const pick = entry.n > 0 ? matching[entry.n - 1] : matching[matching.length + entry.n];
          if (pick !== undefined) set.add(pick);
        }
      }
      days = [...set].filter((d) => !rule.byMonthDay.length || byMonthDay.includes(d));
    } else if (rule.byMonthDay.length) {
      days = byMonthDay;
    } else {
      days = start.d <= length ? [start.d] : [];
    }
    for (const d of [...new Set(days)].sort((a, b) => a - b)) out.push(firstDay + d - 1);
  }
  return out;
}

/** The first and last day of the k-th period of a rule (k = 0 holds DTSTART). */
function periodOf(rule: Rule, startDay: number, k: number): { first: number; last: number } {
  const start = civilOf(startDay);
  if (rule.freq === "DAILY") {
    const day = startDay + k * rule.interval;
    return { first: day, last: day };
  }
  if (rule.freq === "WEEKLY") {
    const weekFirst = startDay - ((weekdayOf(startDay) - rule.wkst + 7) % 7) + k * 7 * rule.interval;
    return { first: weekFirst, last: weekFirst + 6 };
  }
  if (rule.freq === "MONTHLY") {
    const index = start.y * 12 + (start.m - 1) + k * rule.interval;
    const y = Math.floor(index / 12);
    const m = (index % 12) + 1;
    return { first: dayNumber({ y, m, d: 1 }), last: dayNumber({ y, m, d: daysInMonth(y, m) }) };
  }
  const y = start.y + k * rule.interval;
  return { first: dayNumber({ y, m: 1, d: 1 }), last: dayNumber({ y, m: 12, d: 31 }) };
}

/** How many whole periods lie between DTSTART and a day (to skip ahead when COUNT does not need them). */
function periodsBefore(rule: Rule, startDay: number, day: number): number {
  if (day <= startDay) return 0;
  const a = civilOf(startDay);
  const b = civilOf(day);
  const span = rule.freq === "DAILY" ? day - startDay : rule.freq === "WEEKLY" ? Math.floor((day - startDay) / 7) : rule.freq === "MONTHLY" ? (b.y - a.y) * 12 + (b.m - a.m) : b.y - a.y;
  return Math.max(0, Math.floor(span / rule.interval) - 1);
}

/** Days on which a series starts, the first `limitDay` included, in order. */
function seriesDays(event: IcsEvent, startDay: number, limitDay: number, fromDay: number, startEpoch: (day: number) => number, untilEpoch: number | null, untilDay: number | null): number[] {
  const rule = event.rule!;
  const out: number[] = [];
  let generated = 0;
  const stop = (day: number) => (untilDay !== null && day > untilDay) || (untilEpoch !== null && startEpoch(day) > untilEpoch);
  // DTSTART is the first occurrence even when the rule would not produce it.
  let k = rule.count === null ? periodsBefore(rule, startDay, fromDay) : 0;
  if (k === 0) {
    if (stop(startDay)) return out;
    out.push(startDay);
    generated = 1;
  }
  for (let walked = 0; walked < MAX_PERIODS; walked += 1, k += 1) {
    const period = periodOf(rule, startDay, k);
    if (period.first > limitDay) break;
    let days = periodDays(rule, period, civilOf(startDay));
    if (rule.bySetPos.length && days.length) {
      const picked = rule.bySetPos.map((position) => (position > 0 ? days[position - 1] : days[days.length + position])).filter((day): day is number => day !== undefined);
      days = [...new Set(picked)].sort((a, b) => a - b);
    }
    for (const day of days) {
      if (day <= startDay) continue;
      if (stop(day)) return out;
      if (rule.count !== null && generated >= rule.count) return out;
      generated += 1;
      if (day > limitDay) return out;
      out.push(day);
    }
    if (rule.count !== null && generated >= rule.count) break;
  }
  return out;
}

/**
 * The occurrences of a calendar's events that overlap `[from, to)`. `viewer` is the zone of the
 * screen (an IANA name): floating times are read there (or in the calendar's X-WR-TIMEZONE), and
 * all-day events are matched against its dates.
 */
export function occurrences(calendar: IcsCalendar, from: number, to: number, viewer: string, limit = 5000): Occurrence[] {
  const floatingZone: Zone = calendar.zone && isZoneName(calendar.zone) ? { kind: "iana", name: calendar.zone } : { kind: "iana", name: viewer };
  const zoneOf = (time: IcsTime): Zone => (time.kind === "local" ? (time.zone.kind === "floating" ? floatingZone : time.zone) : time.kind === "utc" ? { kind: "fixed", minutes: 0 } : floatingZone);
  const viewerZone: Zone = { kind: "iana", name: viewer };
  const firstViewerDay = dayIn(from, viewerZone, viewer);
  const endViewerDay = dayIn(to - 1, viewerZone, viewer) + 1;
  const midnight = (day: number) => wallToEpoch({ ...civilOf(day), h: 0, mi: 0, s: 0 }, viewerZone, viewer);
  // Moved or cancelled single occurrences replace the series' own.
  const moved = new Map<string, Set<string>>();
  for (const event of calendar.events) {
    if (!event.recurrenceId) continue;
    const key = event.recurrenceId.kind === "date" ? dateKey(event.recurrenceId.date) : String(timeEpoch(event.recurrenceId, viewer));
    moved.set(event.uid, (moved.get(event.uid) ?? new Set()).add(key));
  }
  const out: Occurrence[] = [];
  for (const event of calendar.events) {
    if (event.cancelled) continue;
    const summary = event.summary || "(제목 없음)";
    if (event.start.kind === "date") {
      const days = "days" in event.length ? event.length.days : 1;
      const startDay = dayNumber(event.start.date);
      const instances: number[] = [];
      if (event.rule && !event.recurrenceId) {
        const until = event.rule.until;
        const untilDay = until ? (until.kind === "date" ? dayNumber(until.date) : dayIn(timeEpoch(until, viewer), viewerZone, viewer)) : null;
        instances.push(...seriesDays(event, startDay, endViewerDay, firstViewerDay - days - 1, () => 0, null, untilDay));
      } else instances.push(startDay);
      for (const rdate of event.rdates) instances.push(rdate.kind === "date" ? dayNumber(rdate.date) : dayIn(timeEpoch(rdate, viewer), viewerZone, viewer));
      const skipped = new Set([...event.exdates.map((time) => (time.kind === "date" ? dateKey(time.date) : dateKey(civilOf(dayIn(timeEpoch(time, viewer), viewerZone, viewer))))), ...(event.recurrenceId ? [] : (moved.get(event.uid) ?? []))]);
      for (const day of [...new Set(instances)].sort((a, b) => a - b)) {
        if (day >= endViewerDay || day + days <= firstViewerDay || skipped.has(dateKey(civilOf(day)))) continue;
        out.push({ uid: event.uid, summary, location: event.location, start: midnight(day), end: midnight(day + days), days: { from: dateKey(civilOf(day)), to: dateKey(civilOf(day + days)) } });
      }
    } else {
      const zone = zoneOf(event.start);
      const wall = event.start.kind === "local" ? event.start.wall : epochToWall(event.start.at, zone, viewer);
      const ms = "ms" in event.length ? event.length.ms : 0;
      const startOn = (day: number) => wallToEpoch({ ...civilOf(day), h: wall.h, mi: wall.mi, s: wall.s }, zone, viewer);
      const startDay = dayNumber(wall);
      // A one-off event days away from the window needs no zone arithmetic (zones lie within ±14 hours).
      if (!event.rule && !event.rdates.length && (startDay > Math.floor(to / DAY_MS) + 2 || startDay + Math.ceil(ms / DAY_MS) < Math.floor(from / DAY_MS) - 2)) continue;
      const instances: number[] = [];
      if (event.rule && !event.recurrenceId) {
        const until = event.rule.until;
        const untilEpoch = until && until.kind !== "date" ? timeEpoch(until.kind === "local" && until.zone.kind === "floating" ? { ...until, zone } : until, viewer) : null;
        const untilDay = until?.kind === "date" ? dayNumber(until.date) : null;
        const fromDay = dayIn(from - ms, zone, viewer) - 1;
        const limitDay = dayIn(to, zone, viewer) + 1;
        instances.push(...seriesDays(event, startDay, limitDay, fromDay, startOn, untilEpoch, untilDay));
      } else instances.push(startDay);
      const starts = instances.map(startOn);
      for (const rdate of event.rdates) starts.push(rdate.kind === "date" ? startOn(dayNumber(rdate.date)) : timeEpoch(rdate, viewer));
      const skippedAt = new Set(event.exdates.filter((time) => time.kind !== "date").map((time) => timeEpoch(time.kind === "local" && time.zone.kind === "floating" ? { ...time, zone } : time, viewer)));
      const skippedDays = new Set(event.exdates.filter((time) => time.kind === "date").map((time) => dayNumber((time as { date: Civil }).date)));
      const replaced = event.recurrenceId ? null : moved.get(event.uid);
      for (const start of [...new Set(starts)].sort((a, b) => a - b)) {
        const end = start + ms;
        if (start >= to || (end <= from && !(ms === 0 && start >= from))) continue;
        if (skippedAt.has(start) || (skippedDays.size && skippedDays.has(dayIn(start, zone, viewer))) || replaced?.has(String(start))) continue;
        out.push({ uid: event.uid, summary, location: event.location, start, end, days: null });
      }
    }
    if (out.length >= limit) break;
  }
  return out.sort((a, b) => a.start - b.start || a.summary.localeCompare(b.summary, "ko")).slice(0, limit);
}
