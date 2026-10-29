import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CalendarEventsView, CalendarFeedView, Session, Timeline } from "@workbench/contracts";
import { EventBus } from "./bus.ts";
import { CalendarFeeds, describeFeedUrl, normalizeFeedUrl, REFRESH_MS } from "./calendar-feeds.ts";
import { HttpError } from "./errors.ts";
import { createHttpServer } from "./http.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";
import { buildTimeline } from "./timeline.ts";

// Calendar feeds: the secret address stays in a 0600 file and never comes back; copies are
// fetched at most every 10 minutes (and when asked); a failed fetch keeps the last copy and says why.

const SECRET = "private-0123456789abcdef0123456789abcdef";
const SEOUL = "Asia/Seoul";
const seoul = (y: number, m: number, d: number, h = 0) => Date.UTC(y, m - 1, d, h) - 9 * 3600_000;

const ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "X-WR-CALNAME:학과 일정",
  "BEGIN:VEVENT",
  "UID:meeting",
  "DTSTART;TZID=Asia/Seoul:20261029T100000",
  "DTEND;TZID=Asia/Seoul:20261029T110000",
  "SUMMARY:학과 회의",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:class",
  "DTSTART;TZID=Asia/Seoul:20261026T140000",
  "DURATION:PT1H30M",
  "RRULE:FREQ=WEEKLY;BYDAY=MO,TH",
  "SUMMARY:미디어와 사회",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

type Stand = { url: (path: string) => string; hits: () => number; mode: { value: "ok" | "missing" | "html" | "down" } };

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function standIn(): Promise<Stand> {
  let hits = 0;
  const mode: Stand["mode"] = { value: "ok" };
  const server = createServer((req, res) => {
    hits += 1;
    if (mode.value === "missing" || !req.url?.includes(SECRET)) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("not found");
    }
    if (mode.value === "html") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<!doctype html><title>로그인</title>");
    }
    if (mode.value === "down") {
      res.writeHead(503);
      return res.end();
    }
    res.writeHead(200, { "content-type": "text/calendar; charset=utf-8" });
    res.end(ICS);
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  return { url: (path) => `http://127.0.0.1:${port}${path}`, hits: () => hits, mode };
}

const feedPath = `/calendar/ical/laguna%40example.com/${SECRET}/basic.ics`;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wb-calendar-"));
  let now = seoul(2026, 10, 29, 9);
  const feeds = new CalendarFeeds({ dataDir: dir, now: () => now });
  return { dir, feeds, advance: (ms: number) => (now += ms) };
}

const failure = async (run: Promise<unknown>) => {
  try {
    await run;
  } catch (error) {
    return error as HttpError;
  }
  throw new Error("expected a failure");
};

describe("addresses", () => {
  it("takes http(s) and webcal addresses only", () => {
    expect(normalizeFeedUrl(" webcal://example.com/a.ics ")).toBe("https://example.com/a.ics");
    expect(() => normalizeFeedUrl("ftp://example.com/a.ics")).toThrow(/https/);
    expect(() => normalizeFeedUrl("캘린더")).toThrow(/형식/);
    expect(() => normalizeFeedUrl("")).toThrow(/비어/);
  });

  it("shows only the host and a file name that is not a token", () => {
    expect(describeFeedUrl(`https://calendar.google.com${feedPath}`)).toEqual({ host: "calendar.google.com", hint: "…/basic.ics" });
    expect(describeFeedUrl("https://p53-caldav.icloud.com/published/2/MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkw")).toEqual({ host: "p53-caldav.icloud.com", hint: "" });
    expect(describeFeedUrl("https://example.com/feeds/a8f3c2d1e9b74f60aa.ics").hint).toBe("");
  });
});

describe("feeds", () => {
  it("keeps the address in a 0600 file and never returns it", async () => {
    const stand = await standIn();
    const { dir, feeds } = setup();
    const view = await feeds.add({ url: stand.url(feedPath), color: "#C2453D" });
    expect(view).toMatchObject({ name: "학과 일정", color: "#C2453D", host: "127.0.0.1", hint: "…/basic.ics", error: null, events: 2 });
    const file = join(dir, "calendar-feeds.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toContain(SECRET);
    const cache = join(dir, "calendar-cache", `${view.id}.ics`);
    expect(statSync(cache).mode & 0o777).toBe(0o600);
    const answers = [view, feeds.list(), await feeds.events(seoul(2026, 10, 26), seoul(2026, 11, 2), SEOUL), await feeds.update(view.id, { name: "학과" }), await feeds.refresh(view.id)];
    for (const answer of answers) expect(JSON.stringify(answer)).not.toContain(SECRET);
    // Nothing else in the data folder holds it.
    const others = readdirSync(dir).filter((name) => name !== "calendar-feeds.json" && name !== "calendar-cache");
    for (const name of others) expect(readFileSync(join(dir, name), "utf8")).not.toContain(SECRET);
  });

  it("refuses an address that holds no calendar, saying why, and saves nothing", async () => {
    const stand = await standIn();
    const { dir, feeds } = setup();
    expect((await failure(feeds.add({ url: stand.url("/calendar/ical/x/public/basic.ics") }))).message).toMatch(/HTTP 404/);
    stand.mode.value = "html";
    expect((await failure(feeds.add({ url: stand.url(feedPath) }))).message).toMatch(/iCal\(\.ics\) 형식이 아닙니다/);
    expect((await failure(feeds.add({ url: "http://127.0.0.1:9/none.ics" }))).message).toMatch(/연결하지 못했습니다/);
    expect(feeds.list()).toEqual([]);
    expect(readdirSync(dir)).not.toContain("calendar-feeds.json");
  });

  it("refuses the same address twice", async () => {
    const stand = await standIn();
    const { feeds } = setup();
    await feeds.add({ url: stand.url(feedPath) });
    expect((await failure(feeds.add({ url: stand.url(feedPath) }))).status).toBe(409);
  });

  it("gives the events of a window, fetching again only after 10 minutes or when asked", async () => {
    const stand = await standIn();
    const { feeds, advance } = setup();
    const view = await feeds.add({ url: stand.url(feedPath), name: "학과" });
    const week = await feeds.events(seoul(2026, 10, 26), seoul(2026, 11, 2), SEOUL);
    expect(week.events.map((event) => [event.title, event.start])).toEqual([
      ["미디어와 사회", seoul(2026, 10, 26, 14)],
      ["미디어와 사회", seoul(2026, 10, 29, 14)],
      ["학과 회의", seoul(2026, 10, 29, 10)],
    ].sort((a, b) => (a[1] as number) - (b[1] as number)));
    expect(week.events.every((event) => event.feedId === view.id)).toBe(true);
    const fetched = stand.hits();
    advance(60_000);
    await feeds.events(seoul(2026, 10, 26), seoul(2026, 11, 2), SEOUL);
    expect(stand.hits()).toBe(fetched);
    advance(REFRESH_MS);
    await feeds.events(seoul(2026, 10, 26), seoul(2026, 11, 2), SEOUL);
    expect(stand.hits()).toBe(fetched + 1);
    // "다시 받기" right after a fetch waits; 15 seconds later it fetches.
    await feeds.refresh(view.id);
    expect(stand.hits()).toBe(fetched + 1);
    advance(15_000);
    await feeds.refresh(view.id);
    expect(stand.hits()).toBe(fetched + 2);
  });

  it("keeps the last copy when a fetch fails, says why, and reads it from disk after a restart", async () => {
    const stand = await standIn();
    const { dir, feeds, advance } = setup();
    const view = await feeds.add({ url: stand.url(feedPath) });
    stand.mode.value = "down";
    advance(REFRESH_MS);
    const failed: CalendarEventsView = await feeds.events(seoul(2026, 10, 26), seoul(2026, 11, 2), SEOUL);
    expect(failed.feeds[0]!.error).toMatch(/HTTP 503/);
    expect(failed.events.length).toBe(3);
    const again = new CalendarFeeds({ dataDir: dir, now: () => seoul(2026, 10, 29, 9) });
    expect(again.list()[0]).toMatchObject({ id: view.id, events: 2, error: null });
    expect((await again.events(seoul(2026, 10, 26), seoul(2026, 11, 2), SEOUL)).events.length).toBe(3);
  });

  it("renames, recolours and removes a feed with its copy", async () => {
    const stand = await standIn();
    const { dir, feeds } = setup();
    const view = await feeds.add({ url: stand.url(feedPath) });
    expect(await feeds.update(view.id, { name: "  수업  ", color: "#4F7A3A" })).toMatchObject({ name: "수업", color: "#4F7A3A" });
    expect(await feeds.update(view.id, { color: "red" })).toMatchObject({ color: "#4F7A3A" });
    expect(feeds.remove(view.id)).toEqual([]);
    expect(readdirSync(join(dir, "calendar-cache"))).toEqual([]);
    expect((await failure(feeds.refresh(view.id))).status).toBe(404);
  });
});

describe("routes", () => {
  it("answer with views only, and give the timeline of a window (the old call still works)", async () => {
    const stand = await standIn();
    const dir = mkdtempSync(join(tmpdir(), "wb-calendar-routes-"));
    const store = new Store(join(dir, "state.sqlite"));
    const manager = new SessionManager(store, new EventBus(), { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works"), dataDir: dir });
    store.saveSession({ id: "s", workId: "w", provider: "codex" } as Session);
    store.saveItem("s", { kind: "user", id: "u1", text: "어제 요청", at: 1000 });
    store.saveItem("s", { kind: "turnEnd", id: "e1", status: "completed", durationMs: 100, at: 1100 });
    store.saveItem("s", { kind: "user", id: "u2", text: "오늘 요청", at: 5000 });
    store.saveItem("s", { kind: "turnEnd", id: "e2", status: "completed", durationMs: 100, at: 5100 });
    const server = createHttpServer(manager, new EventBus(), {
      token: "app-token",
      webDir: null,
      calendar: new CalendarFeeds({ dataDir: dir }),
      timeline: (since, until) => buildTimeline(store.turnMarks(since, until), store.revisionMarks(since, until), since, until),
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const bodies: string[] = [];
    const call = async <T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> => {
      const response = await fetch(`${base}${path}`, { method, headers: { authorization: "Bearer app-token", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text();
      bodies.push(text);
      return { status: response.status, json: JSON.parse(text) as T };
    };
    const added = await call<CalendarFeedView>("POST", "/api/calendar/feeds", { url: stand.url(feedPath), name: "학과" });
    expect(added.status).toBe(201);
    expect((await call<{ feeds: CalendarFeedView[] }>("GET", "/api/calendar/feeds")).json.feeds.map((feed) => feed.name)).toEqual(["학과"]);
    const events = await call<CalendarEventsView>("GET", `/api/calendar/events?since=${seoul(2026, 10, 29)}&until=${seoul(2026, 10, 30)}&tz=${SEOUL}`);
    expect(events.json.events.map((event) => event.title)).toEqual(["학과 회의", "미디어와 사회"]);
    expect((await call("GET", `/api/calendar/events?since=10&until=5`)).status).toBe(400);
    expect((await call<CalendarFeedView>("POST", `/api/calendar/feeds/${added.json.id}/refresh`)).status).toBe(200);
    expect((await call<CalendarFeedView>("PATCH", `/api/calendar/feeds/${added.json.id}`, { color: "#2F6FD0" })).json.color).toBe("#2F6FD0");
    const wrong = await call<{ message: string }>("POST", "/api/calendar/feeds", { url: stand.url("/nothing.ics") });
    expect([wrong.status, wrong.json.message]).toEqual([400, expect.stringMatching(/HTTP 404/)]);
    for (const body of bodies) expect(body).not.toContain(SECRET);
    expect((await call<{ feeds: CalendarFeedView[] }>("DELETE", `/api/calendar/feeds/${added.json.id}`)).json.feeds).toEqual([]);
    const unauthorized = await fetch(`${base}/api/calendar/feeds`);
    expect(unauthorized.status).toBe(401);

    const window = await call<Timeline>("GET", "/api/views/timeline?since=0&until=3000");
    expect(window.json.turns.map((turn) => turn.text)).toEqual(["어제 요청"]);
    expect(window.json.until).toBe(3000);
    const old = await call<Timeline>("GET", "/api/views/timeline?since=0");
    expect(old.json.turns.map((turn) => turn.text)).toEqual(["어제 요청", "오늘 요청"]);
    expect(old.json.until).toBeUndefined();
    store.close();
  });
});
