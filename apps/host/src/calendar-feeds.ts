import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { CALENDAR_COLORS, type CalendarEvent, type CalendarEventsView, type CalendarFeedInput, type CalendarFeedView } from "@workbench/contracts";
import { HttpError } from "./errors.ts";
import { readBody, sendJson } from "./http.ts";
import { isZoneName, looksLikeIcs, occurrences, parseIcs, type IcsCalendar } from "./ics.ts";

// Calendar feeds on home "흐름": calendars the user subscribes to by their iCal address, shown
// read-only next to the work activity. No OAuth: Google Calendar's "iCal 형식의 비밀 주소" (or any
// .ics address) is enough. That address is a secret: it is kept in a 0600 file in the gateway's
// data folder, never sent back whole (the screen gets its host and a harmless hint), and never
// logged — errors are said in the user's words without it. A copy of each calendar is fetched at
// most every 10 minutes (and when asked, at most every 15 seconds), kept in memory and on disk
// (0600), so the last copy still shows when a fetch fails or the computer is offline.

const FEEDS_FILE = "calendar-feeds.json";
const CACHE_DIR = "calendar-cache";
/** Fetched again after this long when a view asks. */
export const REFRESH_MS = 10 * 60_000;
/** "다시 받기" waits this long after the last attempt. */
const AGAIN_MS = 15_000;
const TIMEOUT_MS = 20_000;
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_FEEDS = 20;
const MAX_EVENTS = 4000;
const DAY_MS = 86_400_000;

type Saved = { id: string; name: string; color: string; url: string; addedAt: number };
type SavedFile = { version: 1; feeds: Saved[] };

type Live = { calendar: IcsCalendar | null; fetchedAt: number | null; error: string | null; attemptAt: number; running: Promise<void> | null };

/** A failure to read a calendar, already in the user's words (and without its address). */
export class CalendarError extends Error {}

const ADDRESS_HELP = "Google 캘린더 › 설정 › 캘린더 이름 › 캘린더 통합의 'iCal 형식의 비밀 주소'(https://로 시작)를 붙여 넣어 주세요.";

/** The address as it is fetched: `webcal://` is https, only http(s) is accepted. */
export function normalizeFeedUrl(value: unknown): string {
  let text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new HttpError(400, "calendar_url", `iCal 주소가 비어 있습니다. ${ADDRESS_HELP}`);
  if (text.length > 4096) throw new HttpError(400, "calendar_url", "주소가 너무 깁니다.");
  text = text.replace(/^webcals?:\/\//i, "https://");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new HttpError(400, "calendar_url", `iCal 주소의 형식이 아닙니다. ${ADDRESS_HELP}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new HttpError(400, "calendar_url", `iCal 주소는 https://로 시작합니다. ${ADDRESS_HELP}`);
  return url.toString();
}

/** What the screen may know of an address: its host, and its file name when that is no token. */
export function describeFeedUrl(address: string): { host: string; hint: string } {
  try {
    const url = new URL(address);
    const last = url.pathname.split("/").filter(Boolean).pop() ?? "";
    const stem = last.replace(/\.ics$/i, "");
    const harmless = /^[\w.-]{1,40}\.ics$/i.test(last) && !/[0-9a-f]{12,}|[A-Za-z0-9_-]{20,}/i.test(stem);
    return { host: url.hostname, hint: harmless ? `…/${last}` : "" };
  } catch {
    return { host: "", hint: "" };
  }
}

function statusMessage(status: number) {
  if (status === 401 || status === 403) return `이 주소로는 캘린더를 읽을 수 없습니다(HTTP ${status}). 공개 주소가 아니라 'iCal 형식의 비밀 주소'인지 확인해 주세요.`;
  if (status === 404 || status === 410) return `이 주소에 캘린더가 없습니다(HTTP ${status}). 비밀 주소를 다시 만들었다면 새 주소를 붙여 넣어 주세요.`;
  if (status === 429) return "캘린더 서버가 요청이 잦다며 잠시 거절했습니다(HTTP 429). 조금 뒤 다시 받습니다.";
  if (status >= 500) return `캘린더 서버에 문제가 있어 받지 못했습니다(HTTP ${status}).`;
  return `캘린더 서버가 거절했습니다(HTTP ${status}).`;
}

function networkMessage(error: unknown) {
  const cause = (error as { cause?: { code?: string } })?.cause?.code ?? (error as { code?: string })?.code ?? "";
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return `캘린더 서버가 ${TIMEOUT_MS / 1000}초 동안 응답하지 않았습니다.`;
  if (cause === "ENOTFOUND" || cause === "EAI_AGAIN") return "캘린더 주소의 서버를 찾지 못했습니다. 주소와 인터넷 연결을 확인해 주세요.";
  if (cause === "ECONNREFUSED") return "캘린더 서버에 연결하지 못했습니다(연결 거부).";
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(cause)) return "캘린더 서버의 인증서를 확인하지 못했습니다.";
  return "캘린더 서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.";
}

/** One .ics file, read to its end within the size limit. */
async function download(address: string, fetcher: typeof fetch): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetcher(address, {
      headers: { accept: "text/calendar, text/plain;q=0.9, */*;q=0.5", "user-agent": "AchmageWorkbench (calendar feed)" },
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new CalendarError(networkMessage(error));
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new CalendarError(statusMessage(response.status));
  }
  const tooBig = `캘린더 파일이 너무 큽니다(${MAX_BYTES / 1024 / 1024}MB 넘음).`;
  if (Number(response.headers.get("content-length") ?? 0) > MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new CalendarError(tooBig);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    const reader = response.body?.getReader();
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new CalendarError(tooBig);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof CalendarError) throw error;
    throw new CalendarError(networkMessage(error));
  }
  return Buffer.concat(chunks);
}

/** The calendar in some bytes, or why they are not one. */
function readCalendar(bytes: Uint8Array): IcsCalendar {
  if (!looksLikeIcs(new TextDecoder("utf-8").decode(bytes.subarray(0, 4096)))) {
    throw new CalendarError("받은 내용이 iCal(.ics) 형식이 아닙니다. 웹 페이지 주소가 아니라 'iCal 형식의 비밀 주소'를 붙여 넣어 주세요.");
  }
  return parseIcs(bytes);
}

const HEX = /^#[0-9a-f]{6}$/i;

export type CalendarFeedsOptions = {
  dataDir: string;
  /** Another fetch (unit tests). */
  fetch?: typeof fetch;
  now?: () => number;
};

export class CalendarFeeds {
  private readonly options: CalendarFeedsOptions;
  private readonly lives = new Map<string, Live>();
  constructor(options: CalendarFeedsOptions) {
    this.options = options;
  }

  private get file() {
    return join(this.options.dataDir, FEEDS_FILE);
  }

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  private cacheFile(id: string) {
    return join(this.options.dataDir, CACHE_DIR, `${id}.ics`);
  }

  private read(): Saved[] {
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8")) as Partial<SavedFile>;
      if (saved.version !== 1 || !Array.isArray(saved.feeds)) return [];
      return saved.feeds.filter((feed): feed is Saved => Boolean(feed && typeof feed.id === "string" && /^[\w-]{1,64}$/.test(feed.id) && typeof feed.url === "string")).map((feed) => ({
        id: feed.id,
        name: String(feed.name ?? ""),
        color: HEX.test(String(feed.color)) ? String(feed.color) : CALENDAR_COLORS[0],
        url: feed.url,
        addedAt: Number(feed.addedAt ?? 0),
      }));
    } catch {
      return [];
    }
  }

  /** Readable only by this user, written whole or not at all (like the R2 keys, doc-images.ts). */
  private write(feeds: Saved[]) {
    mkdirSync(this.options.dataDir, { recursive: true });
    const temporary = `${this.file}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ version: 1, feeds } satisfies SavedFile, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.file);
  }

  private writeCache(id: string, bytes: Uint8Array) {
    const dir = join(this.options.dataDir, CACHE_DIR);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temporary = `${this.cacheFile(id)}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(temporary, bytes, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.cacheFile(id));
  }

  /** What is known of a feed now; the copy on disk is read the first time. */
  private live(id: string): Live {
    let live = this.lives.get(id);
    if (!live) {
      live = { calendar: null, fetchedAt: null, error: null, attemptAt: 0, running: null };
      try {
        const file = this.cacheFile(id);
        if (existsSync(file)) {
          live.calendar = readCalendar(readFileSync(file));
          live.fetchedAt = statSync(file).mtimeMs;
        }
      } catch {
        // A damaged copy is fetched again.
      }
      this.lives.set(id, live);
    }
    return live;
  }

  private view(feed: Saved): CalendarFeedView {
    const live = this.live(feed.id);
    const series = new Set(live.calendar?.events.map((event) => event.uid) ?? []);
    return {
      id: feed.id,
      name: feed.name,
      color: feed.color,
      ...describeFeedUrl(feed.url),
      addedAt: feed.addedAt,
      fetchedAt: live.fetchedAt,
      error: live.error,
      events: series.size,
    };
  }

  /** The feeds, never with their addresses. */
  list(): CalendarFeedView[] {
    return this.read().map((feed) => this.view(feed));
  }

  private async fetchInto(feed: Saved, live: Live) {
    live.attemptAt = this.now();
    try {
      const bytes = await download(feed.url, this.options.fetch ?? fetch);
      const calendar = readCalendar(bytes);
      // Removed while it was being fetched: nothing to keep.
      if (!this.read().some((entry) => entry.id === feed.id)) return;
      live.calendar = calendar;
      live.fetchedAt = this.now();
      live.error = null;
      this.writeCache(feed.id, bytes);
    } catch (error) {
      live.error = error instanceof CalendarError ? error.message : "캘린더를 받지 못했습니다.";
    }
  }

  /** Fetch when the copy is older than 10 minutes, or when asked (at most every 15 seconds). */
  private ensure(feed: Saved, force: boolean): Promise<void> {
    const live = this.live(feed.id);
    if (live.running) return live.running;
    const now = this.now();
    const due = force ? now - live.attemptAt >= AGAIN_MS : now - Math.max(live.attemptAt, live.fetchedAt ?? 0) >= REFRESH_MS;
    if (!due) return Promise.resolve();
    live.running = this.fetchInto(feed, live).finally(() => {
      live.running = null;
    });
    return live.running;
  }

  private checkName(value: unknown) {
    return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 60) : "";
  }

  /** A new feed: its address is fetched first and kept only when it holds a calendar. */
  async add(input: CalendarFeedInput): Promise<CalendarFeedView> {
    const url = normalizeFeedUrl(input.url);
    const feeds = this.read();
    if (feeds.length >= MAX_FEEDS) throw new HttpError(400, "calendar_limit", `캘린더는 ${MAX_FEEDS}개까지 연결합니다.`);
    if (feeds.some((feed) => feed.url === url)) throw new HttpError(409, "calendar_exists", "이미 연결한 캘린더입니다.");
    let bytes: Uint8Array;
    let calendar: IcsCalendar;
    try {
      bytes = await download(url, this.options.fetch ?? fetch);
      calendar = readCalendar(bytes);
    } catch (error) {
      throw new HttpError(400, "calendar_fetch", error instanceof CalendarError ? error.message : "캘린더를 받지 못했습니다.");
    }
    const used = new Set(feeds.map((feed) => feed.color.toUpperCase()));
    const color = typeof input.color === "string" && HEX.test(input.color) ? input.color : (CALENDAR_COLORS.find((entry) => !used.has(entry)) ?? CALENDAR_COLORS[feeds.length % CALENDAR_COLORS.length]!);
    const feed: Saved = { id: randomUUID(), name: this.checkName(input.name) || calendar.name?.slice(0, 60) || describeFeedUrl(url).host || "캘린더", color, url, addedAt: this.now() };
    this.write([...feeds, feed]);
    this.writeCache(feed.id, bytes);
    this.lives.set(feed.id, { calendar, fetchedAt: this.now(), error: null, attemptAt: this.now(), running: null });
    return this.view(feed);
  }

  /** A new name or colour; a new address is fetched first, like a new feed. */
  async update(id: string, input: CalendarFeedInput): Promise<CalendarFeedView> {
    const feeds = this.read();
    const feed = feeds.find((entry) => entry.id === id);
    if (!feed) throw new HttpError(404, "calendar_missing", "연결한 캘린더가 없습니다.");
    if (typeof input.url === "string" && input.url.trim()) {
      const url = normalizeFeedUrl(input.url);
      if (feeds.some((entry) => entry.id !== id && entry.url === url)) throw new HttpError(409, "calendar_exists", "이미 연결한 캘린더입니다.");
      try {
        const bytes = await download(url, this.options.fetch ?? fetch);
        const calendar = readCalendar(bytes);
        feed.url = url;
        this.writeCache(id, bytes);
        this.lives.set(id, { calendar, fetchedAt: this.now(), error: null, attemptAt: this.now(), running: null });
      } catch (error) {
        throw new HttpError(400, "calendar_fetch", error instanceof CalendarError ? error.message : "캘린더를 받지 못했습니다.");
      }
    }
    const name = this.checkName(input.name);
    if (name) feed.name = name;
    if (typeof input.color === "string" && HEX.test(input.color)) feed.color = input.color;
    this.write(feeds);
    return this.view(feed);
  }

  remove(id: string): CalendarFeedView[] {
    const feeds = this.read();
    if (!feeds.some((feed) => feed.id === id)) throw new HttpError(404, "calendar_missing", "연결한 캘린더가 없습니다.");
    this.write(feeds.filter((feed) => feed.id !== id));
    rmSync(this.cacheFile(id), { force: true });
    this.lives.delete(id);
    return this.list();
  }

  /** "다시 받기": fetch one feed now (at most every 15 seconds). */
  async refresh(id: string): Promise<CalendarFeedView> {
    const feed = this.read().find((entry) => entry.id === id);
    if (!feed) throw new HttpError(404, "calendar_missing", "연결한 캘린더가 없습니다.");
    await this.ensure(feed, true);
    return this.view(feed);
  }

  /**
   * The events of every feed that overlap `[from, to)`, read for the screen's zone. A feed whose
   * copy is older than 10 minutes is fetched first; when that fails its last copy is used and its
   * view says why.
   */
  async events(from: number, to: number, zone: string, force = false): Promise<CalendarEventsView> {
    const feeds = this.read();
    await Promise.all(feeds.map((feed) => this.ensure(feed, force)));
    const viewer = isZoneName(zone) ? zone : Intl.DateTimeFormat().resolvedOptions().timeZone;
    const events: CalendarEvent[] = [];
    for (const feed of feeds) {
      const calendar = this.live(feed.id).calendar;
      if (!calendar) continue;
      for (const entry of occurrences(calendar, from, to, viewer, MAX_EVENTS)) {
        events.push({ id: `${feed.id}:${entry.uid}:${entry.start}`, feedId: feed.id, title: entry.summary, location: entry.location, start: entry.start, end: entry.end, days: entry.days });
      }
    }
    events.sort((a, b) => a.start - b.start || a.title.localeCompare(b.title, "ko"));
    return { feeds: feeds.map((feed) => this.view(feed)), events: events.slice(0, MAX_EVENTS) };
  }
}

async function readInput(req: IncomingMessage): Promise<CalendarFeedInput> {
  const body = await readBody(req, 64_000);
  try {
    const parsed = body.length ? (JSON.parse(body.toString("utf8")) as unknown) : {};
    return parsed && typeof parsed === "object" ? (parsed as CalendarFeedInput) : {};
  } catch {
    throw new HttpError(400, "invalid_json", "JSON 형식이 아닙니다.");
  }
}

/**
 * The gateway's calendar routes (after its token check): the feeds (`GET`, `POST` a new one,
 * `PATCH`/`DELETE` one, `POST …/refresh`) and the events of a window. False for any other request.
 */
export async function routeCalendar(feeds: CalendarFeeds, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith("/api/calendar/")) return false;
  const method = req.method ?? "GET";
  const parts = path.split("/").filter(Boolean);
  if (path === "/api/calendar/events" && method === "GET") {
    const since = Number(url.searchParams.get("since"));
    const until = Number(url.searchParams.get("until"));
    if (!Number.isFinite(since) || !Number.isFinite(until) || until <= since) throw new HttpError(400, "calendar_window", "기간이 올바르지 않습니다.");
    if (until - since > 62 * DAY_MS) throw new HttpError(400, "calendar_window", "한 번에 두 달까지 읽습니다.");
    sendJson(res, 200, await feeds.events(since, until, url.searchParams.get("tz") ?? "", url.searchParams.get("refresh") === "1"));
    return true;
  }
  if (path === "/api/calendar/feeds") {
    if (method === "GET") {
      sendJson(res, 200, { feeds: feeds.list() });
      return true;
    }
    if (method === "POST") {
      sendJson(res, 201, await feeds.add(await readInput(req)));
      return true;
    }
    return false;
  }
  if (parts[2] !== "feeds" || !parts[3]) return false;
  let id: string;
  try {
    id = decodeURIComponent(parts[3]);
  } catch {
    throw new HttpError(404, "calendar_missing", "연결한 캘린더가 없습니다.");
  }
  if (parts.length === 4 && method === "PATCH") {
    sendJson(res, 200, await feeds.update(id, await readInput(req)));
    return true;
  }
  if (parts.length === 4 && method === "DELETE") {
    sendJson(res, 200, { feeds: feeds.remove(id) });
    return true;
  }
  if (parts.length === 5 && parts[4] === "refresh" && method === "POST") {
    sendJson(res, 200, await feeds.refresh(id));
    return true;
  }
  return false;
}
