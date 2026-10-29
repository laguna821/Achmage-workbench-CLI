/// <reference lib="dom" />
// Browser check of home "흐름" as a calendar, for Codex and Claude alike, against a real gateway
// driving stand-in engines (no model), in Asia/Seoul:
// - 하루: hours down the side; today's live request of each engine appears as a block in its
//   work's column and opens that session at that request; ← → T page by day (not while typing);
//   yesterday's seeded requests sit at their hours and open at their request; revision marks;
// - 주: Monday–Sunday with the real dates, today marked, ‹ › by week; a cell opens its request, a
//   busy cell offers a menu;
// - 달: the month's whole weeks (other months dimmed, today marked), ‹ › by month, ≪ ≫ by year,
//   the year/month picker, a day opens its 하루;
// - "캘린더 연결": a local HTTP server's .ics (timed, weekly with BYDAY, all-day, UTC, TZID) shows in
//   하루 · 주 · 달; a failed fetch says why and the activity stays; the address is in no answer of
//   the gateway, in no other file of its data folder and in none of its output.
// Usage: node scripts/flow-check.ts [outDir] [codex|claude]

process.env.TZ = "Asia/Seoul";

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Page } from "playwright-core";
import type { Provider, Session, TranscriptItem } from "@workbench/contracts";
import { seedFlow } from "./seed-flow.ts";

const outDir = process.argv[2] ?? join(tmpdir(), "wb-flow");
const providers: Provider[] = process.argv[3] === "codex" || process.argv[3] === "claude" ? [process.argv[3]] : ["codex", "claude"];
mkdirSync(outDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "workbench-flow-"));
const worksDir = mkdtempSync(join(tmpdir(), "workbench-flow-works-"));
const results: { step: string; ok: boolean; detail: string }[] = [];
const check = (step: string, ok: boolean, detail = "") => {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`);
};

// ── dates, written out here independently of the app's calendar.ts ──────────────────────────
const WD = ["일", "월", "화", "수", "목", "금", "토"];
type D = { y: number; m: number; d: number };
const dOf = (date: Date): D => ({ y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() });
const plus = (day: D, days: number) => dOf(new Date(day.y, day.m - 1, day.d + days));
const key = (day: D) => `${day.y}-${String(day.m).padStart(2, "0")}-${String(day.d).padStart(2, "0")}`;
const weekday = (day: D) => new Date(day.y, day.m - 1, day.d).getDay();
const monday = (day: D) => plus(day, -((weekday(day) + 6) % 7));
const dayTitle = (day: D) => `${day.y}년 ${day.m}월 ${day.d}일 (${WD[weekday(day)]})`;
const weekTitle = (first: D, today: D) => {
  const last = plus(first, 6);
  if (first.y !== last.y) return `${first.y}년 ${first.m}월 ${first.d}일 – ${last.y}년 ${last.m}월 ${last.d}일`;
  return `${first.y === today.y ? "" : `${first.y}년 `}${first.m}월 ${first.d}일 – ${last.m}월 ${last.d}일`;
};
const monthGrid = (y: number, m: number) => {
  const first = monday({ y, m, d: 1 });
  const lastOfMonth = dOf(new Date(y, m, 0));
  const last = plus(monday(lastOfMonth), 6);
  const days = Math.round((new Date(last.y, last.m - 1, last.d).getTime() - new Date(first.y, first.m - 1, first.d).getTime()) / 86_400_000) + 1;
  return { first, last, days };
};
const today = dOf(new Date());
const yesterday = plus(today, -1);

const SECRET = `private-${"0123456789abcdef".repeat(2)}`;
const seeded = seedFlow(dataDir, worksDir);
const request = (key: string) => seeded.requests.find((entry) => entry.id === `user-${key}`)!;

// ── a calendar to subscribe to (a local stand-in for Google Calendar's secret address) ─────────
const ics = () => {
  const stamp = (day: D, h: number, mi = 0) => `${key(day).replace(/-/g, "")}T${String(h).padStart(2, "0")}${String(mi).padStart(2, "0")}00`;
  const mon = monday(today);
  const utcSix = new Date(Date.UTC(today.y, today.m - 1, today.d, 6, 0));
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//flow-check//KO",
    "X-WR-CALNAME:학과 일정",
    "X-WR-TIMEZONE:Asia/Seoul",
    "BEGIN:VEVENT",
    "UID:meeting@flow-check",
    `DTSTART;TZID=Asia/Seoul:${stamp(today, 10)}`,
    `DTEND;TZID=Asia/Seoul:${stamp(today, 11)}`,
    "SUMMARY:학과 회의",
    "LOCATION:본관 301호",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:class@flow-check",
    `DTSTART;TZID=Asia/Seoul:${stamp(plus(mon, -7), 16)}`,
    "DURATION:PT1H30M",
    "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=12",
    "SUMMARY:미디어와 사회",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:trip@flow-check",
    `DTSTART;VALUE=DATE:${key(today).replace(/-/g, "")}`,
    `DTEND;VALUE=DATE:${key(plus(today, 2)).replace(/-/g, "")}`,
    "SUMMARY:학회",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:utc@flow-check",
    `DTSTART:${utcSix.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`,
    `DTEND:${new Date(utcSix.getTime() + 1800_000).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`,
    "SUMMARY:세계 표준시 통화",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:ny@flow-check",
    `DTSTART;TZID=America/New_York:${stamp(yesterday, 21)}`,
    `DTEND;TZID=America/New_York:${stamp(yesterday, 22)}`,
    "SUMMARY:뉴욕 세미나",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
};
const calendarMode = { value: "ok" as "ok" | "down" };
const calendarServer = createServer((req, res) => {
  if (!req.url?.includes(SECRET)) {
    res.writeHead(404);
    return res.end("not found");
  }
  if (calendarMode.value === "down") {
    res.writeHead(500);
    return res.end();
  }
  res.writeHead(200, { "content-type": "text/calendar; charset=utf-8" });
  res.end(ics());
});
await new Promise<void>((done) => calendarServer.listen(0, "127.0.0.1", done));
const feedUrl = `http://127.0.0.1:${(calendarServer.address() as AddressInfo).port}/calendar/ical/flowcheck%40example.com/${SECRET}/basic.ics`;
/** The NY seminar (yesterday 21:00 there) in Seoul time, worked out here with Intl. */
const nySeoul = (() => {
  const guess = Date.UTC(yesterday.y, yesterday.m - 1, yesterday.d, 21, 0);
  for (const hours of [4, 5]) {
    const candidate = guess + hours * 3600_000;
    const ny = new Date(candidate).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" });
    if (ny === "21:00") return new Date(candidate).toLocaleString("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit" });
  }
  return "?";
})();

// ── the gateway ─────────────────────────────────────────────────────────────────────────────
const output: string[] = [];
const child = spawn(process.execPath, ["apps/host/src/main.ts"], {
  env: {
    ...process.env,
    TZ: "Asia/Seoul",
    WORKBENCH_DATA_DIR: dataDir,
    WORKBENCH_WEB_DIR: "apps/web/dist",
    WORKBENCH_HOST_LABEL: "노트북",
    WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"),
    WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stderr!.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
const ready = await new Promise<{ url: string; token: string }>((done) => {
  createInterface({ input: child.stdout! }).on("line", (line) => {
    output.push(line);
    if (line.startsWith("WORKBENCH_READY ")) done(JSON.parse(line.slice(16)));
  });
});
const bodies: string[] = [];
const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${ready.url}${path}`, { method, headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  bodies.push(text);
  return JSON.parse(text) as T;
};
const session = async (id: string) => (await api<{ sessions: Session[] }>("GET", "/api/snapshot")).sessions.find((entry) => entry.id === id)!;
const items = async (id: string) => (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${id}/items`)).items;
const until = async (what: () => Promise<boolean>, timeout = 15_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await what()) return true;
    await new Promise((done) => setTimeout(done, 100));
  }
  return false;
};

const browser = await chromium.launch();
const logs: string[] = [];
const watch = (page: Page, label: string) => {
  page.on("console", (message) => message.type() === "error" && logs.push(`[${label} error] ${message.text().slice(0, 200)}`));
  page.on("pageerror", (error) => logs.push(`[${label} pageerror] ${error.message.slice(0, 200)}`));
  // Every answer of the gateway the page reads, to look for the calendar address in it.
  page.on("response", (response) => {
    if (!response.url().includes("/api/") || response.url().includes("/api/events")) return;
    void response.text().then(
      (text) => bodies.push(text),
      () => undefined,
    );
  });
};

const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, timezoneId: "Asia/Seoul", locale: "ko-KR" });
// The range chosen before the calendar ("오늘") opens 하루 the first time.
await context.addInitScript(() => {
  if (!localStorage.getItem("workbench.homeFlow.v2")) localStorage.setItem("workbench.homeFlow", "today");
});
const page = await context.newPage();
watch(page, "flow");
const shot = (name: string) => page.screenshot({ path: join(outDir, name), fullPage: false });
const blur = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
const title = () => page.locator(".flow-title > span").innerText();
const view = () => page.locator(".flow-cal").getAttribute("data-view");
const home = async () => {
  await page.locator(".topbar .brand").click();
  await page.waitForSelector(".home-modes.mode-flow .flow-cal");
};
/** A key for the page: focus first leaves the home input (it takes focus when home opens). */
const press = async (keyName: string) => {
  await page.locator(".flow-sum").click();
  await blur();
  await page.keyboard.press(keyName);
};
const scrollTo = (selector: string) => page.locator(selector).first().scrollIntoViewIfNeeded();
/** Open the transcript the mark leads to and see that request marked (`focusItem`). */
const opensAt = async (itemId: string) => {
  const flashed = await page.waitForSelector(`.turn-request.flash[data-item-id="${itemId}"]`, { timeout: 8000 }).then(
    () => true,
    () => false,
  );
  return flashed;
};

async function liveTurn(provider: Provider) {
  const label = provider === "codex" ? "Codex" : "Claude";
  const pass = (step: string, ok: boolean, detail = "") => check(`[${label}] ${step}`, ok, detail);
  const workId = provider === "codex" ? "w-codex" : "w-claude";
  const live = await api<Session>("POST", `/api/works/${workId}/sessions`, { provider, purpose: "오늘 요청" });
  // "길게": both stand-ins answer for about 8 seconds, time to see the turn running.
  await api("POST", `/api/sessions/${live.id}/messages`, { requestId: crypto.randomUUID(), text: `길게 오늘 ${label} 요청` });
  const running = await until(async () => (await page.locator(`.flow-col[data-work="${workId}"] .flow-block.running`).count()) > 0, 10_000);
  await until(async () => (await session(live.id)).status === "idle", 30_000);
  const itemId = (await items(live.id)).filter((item) => item.kind === "user").at(-1)!.id;
  const block = page.locator(`.flow-col[data-work="${workId}"] .flow-block[data-item="${itemId}"]`);
  await until(async () => (await block.count()) === 1 && (await page.locator(`.flow-col[data-work="${workId}"] .flow-block.running`).count()) === 0, 10_000);
  const text = await block.innerText().catch(() => "");
  await block.scrollIntoViewIfNeeded();
  await shot(`01-day-today-${provider}.png`);
  pass("하루(오늘): 이 엔진의 요청이 일하는 동안 진행 중 블록, 끝나면 그 작업 열에 블록으로", running && text.includes(`길게 오늘 ${label} 요청`), JSON.stringify(text));
  await block.click();
  const opened = await opensAt(itemId);
  const active = await page.locator(".work-view").count();
  pass("하루: 블록을 누르면 그 세션이 그 요청에서 열림", opened && active === 1, itemId);
  await home();
  pass("홈으로 돌아오면 흐름은 그대로 하루 · 오늘", (await view()) === "day" && (await title()) === dayTitle(today), await title());
}

async function seededDay(provider: Provider) {
  const label = provider === "codex" ? "Codex" : "Claude";
  const pass = (step: string, ok: boolean, detail = "") => check(`[${label}] ${step}`, ok, detail);
  const known = request(provider === "codex" ? "morning" : "afternoon");
  const workId = provider === "codex" ? "w-codex" : "w-claude";
  if ((await title()) !== dayTitle(yesterday)) await press("ArrowLeft");
  await page.waitForSelector(`.flow-block[data-item="${known.id}"]`, { timeout: 8000 });
  const block = page.locator(`.flow-block[data-item="${known.id}"]`);
  const firstHour = Number((await page.locator(".flow-day .flow-hour").first().innerText()).replace("시", ""));
  const top = await block.evaluate((element) => Number.parseFloat((element as HTMLElement).style.top));
  const start = new Date(known.start);
  const expected = (start.getHours() + start.getMinutes() / 60 - firstHour) * 44;
  const marks = provider === "claude" ? await page.locator(`.flow-col[data-work="${workId}"] .flow-mark`).count() : 0;
  await block.scrollIntoViewIfNeeded();
  await shot(`02-day-yesterday-${provider}.png`);
  pass(
    `하루(어제): 심어 둔 ${start.getHours()}:${String(start.getMinutes()).padStart(2, "0")} 요청이 그 시각에${provider === "claude" ? ", 문서 판 표시 둘" : ""}`,
    Math.abs(top - expected) < 1 && (provider === "codex" || marks === 2),
    `top ${top} / ${expected.toFixed(1)}${provider === "claude" ? ` · 판 ${marks}` : ""}`,
  );
  await block.click();
  pass("하루(어제): 블록을 누르면 심어 둔 세션이 그 요청에서 열림", await opensAt(known.id), known.id);
  await home();
  pass("홈으로 돌아와도 어제에 머묾(같은 날 동안 기억)", (await title()) === dayTitle(yesterday), await title());
}

try {
  check("심어 둔 요청 5개, 판 2개", seeded.requests.length === 5 && seeded.revisions.length === 2);
  await page.goto(`${ready.url}/?token=${ready.token}`);
  await page.waitForSelector(".topbar .brand");
  await home();
  const hours = await page.locator(".flow-day .flow-hour").allInnerTexts();
  check("예전 '오늘'을 고른 사람은 하루로 시작, 제목은 실제 날짜", (await view()) === "day" && (await title()) === dayTitle(today), `${await title()} · 시간 ${hours[0]}–${hours.at(-1)}`);

  // ── 하루: live turns of both engines, then yesterday's seeded ones ───────────────────────
  for (const provider of providers) await liveTurn(provider);
  for (const provider of providers) await seededDay(provider);

  // ← → T by day; not while typing.
  await press("ArrowRight");
  const backToday = await title();
  await press("ArrowRight");
  const tomorrow = await title();
  await press("t");
  const pressedT = await title();
  check("← → 는 하루씩, T는 오늘", backToday === dayTitle(today) && tomorrow === dayTitle(plus(today, 1)) && pressedT === dayTitle(today), `${backToday} → ${tomorrow} → ${pressedT}`);
  const input = page.locator(".start-view .composer-input");
  await input.focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.type("t");
  const typed = await input.inputValue();
  await input.fill("");
  check("입력창에서는 ← 와 T가 글쓰기에 쓰임(흐름은 그대로)", typed === "t" && (await title()) === dayTitle(today), JSON.stringify(typed));

  // ── 주 ─────────────────────────────────────────────────────────────────────────────────
  await page.locator(".flow-views button", { hasText: "주" }).click();
  await page.waitForSelector('.flow-cal[data-view="week"] .flow-week-day');
  const week = monday(today);
  const heads = await page.locator(".flow-week-day").evaluateAll((elements) => elements.map((element) => `${element.querySelector(".flow-wd")!.textContent}${element.querySelector(".flow-date")!.textContent}`));
  const expectedHeads = Array.from({ length: 7 }, (_, index) => plus(week, index)).map((day) => `${WD[weekday(day)]}${day.d === 1 ? `${day.m}/1` : day.d}`);
  const todayHead = await page.locator(".flow-week-day.today .flow-date").innerText();
  await shot("03-week.png");
  check("주: 월요일부터 일요일까지 실제 날짜, 제목, 오늘 표시", (await title()) === weekTitle(week, today) && JSON.stringify(heads) === JSON.stringify(expectedHeads) && todayHead === String(today.d === 1 ? `${today.m}/1` : today.d), `${await title()} · ${heads.join(" ")}`);
  await press("ArrowLeft");
  const previousWeek = await title();
  await page.locator('.flow-nav button[aria-label="다음 주"]').click();
  check("주: ← / 다음 주 단추로 한 주씩", previousWeek === weekTitle(plus(week, -7), today) && (await title()) === weekTitle(week, today), `${previousWeek} → ${await title()}`);
  if (monday(yesterday).d !== week.d || monday(yesterday).m !== week.m) await press("ArrowLeft");
  for (const provider of providers) {
    const label = provider === "codex" ? "Codex" : "Claude";
    const known = request(provider === "codex" ? "morning" : "afternoon");
    const hour = new Date(known.start).getHours();
    const cell = page.locator(`.flow-col[data-day="${key(yesterday)}"] .flow-cell[data-hour="${hour}"]`);
    await cell.scrollIntoViewIfNeeded();
    const lines = await cell.innerText();
    const runs = await cell.locator(".flow-run").count();
    if (provider === "codex") {
      await cell.click();
      check(`[${label}] 주: 어제 ${hour}시 칸(작업 이름·요청 수·턴이 돈 때)을 누르면 그 요청에서 열림`, lines.includes("Codex 달력") && runs >= 1 && (await opensAt(known.id)), JSON.stringify(lines));
    } else {
      // Its request and two revisions: a menu to choose from.
      await cell.click();
      await page.waitForSelector(".context-menu", { timeout: 5000 });
      const entries = await page.locator(".context-menu .context-menu-item").allInnerTexts();
      await page.waitForTimeout(300);
      await shot("04-week-menu.png");
      await page.locator(".context-menu .context-menu-item", { hasText: "어제 오후 Claude 요청" }).click();
      check(`[${label}] 주: 요청과 판이 함께 있는 ${hour}시 칸은 메뉴로 고르고, 요청을 고르면 그 요청에서 열림`, entries.length === 3 && entries.some((entry) => entry.includes("강의안.md r1")) && (await opensAt(known.id)), entries.join(" | "));
    }
    await home();
  }
  check("홈으로 돌아와도 주 보기와 그 주가 그대로", (await view()) === "week" && (await title()) === weekTitle(monday(yesterday), today), await title());

  // ── 달 ─────────────────────────────────────────────────────────────────────────────────
  await press("t");
  await page.locator(".flow-views button", { hasText: "달" }).click();
  await page.waitForSelector('.flow-cal[data-view="month"] .flow-month-day');
  const grid = monthGrid(today.y, today.m);
  const cells = await page.locator(".flow-month-day").evaluateAll((elements) => elements.map((element) => ({ day: element.getAttribute("data-day"), other: element.classList.contains("other"), today: element.classList.contains("today") })));
  const heads2 = await page.locator(".flow-month-head span").allInnerTexts();
  // The grid is there at once; the month's timeline arrives a moment later.
  const linesOf = (dayKey: string) => page.locator(`.flow-month-day[data-day="${dayKey}"] .flow-line.work`);
  await until(async () => (await linesOf(key(yesterday)).count()) >= 2, 8000);
  const yesterdayLines = await linesOf(key(yesterday)).allInnerTexts();
  await shot("05-month.png");
  const others = cells.filter((cell) => cell.other).map((cell) => cell.day!);
  const expectedOthers = Array.from({ length: grid.days }, (_, index) => plus(grid.first, index)).filter((day) => day.m !== today.m).map(key);
  check(
    "달: 월요일 시작 달력(앞뒤 달의 날은 흐리게), 오늘 표시, 요일 이름",
    (await title()) === `${today.y}년 ${today.m}월` && cells.length === grid.days && cells[0]!.day === key(grid.first) && JSON.stringify(others) === JSON.stringify(expectedOthers) && cells.filter((cell) => cell.today).map((cell) => cell.day).join() === key(today) && heads2.join("") === "월화수목금토일",
    `${await title()} · ${cells.length}칸 · 흐린 날 ${others.length}`,
  );
  check("달: 어제 칸에 두 작업이 요청 수와 함께", yesterdayLines.some((line) => line.includes("Codex 달력")) && yesterdayLines.some((line) => line.includes("Claude 달력")), yesterdayLines.join(" | "));
  await page.locator('.flow-nav button[aria-label="이전 해"]').click();
  const lastYearTitle = await title();
  const lastYearKey = key({ y: today.y - 1, m: today.m, d: 14 });
  await until(async () => (await linesOf(lastYearKey).count()) >= 1, 8000);
  const lastYearLine = await linesOf(lastYearKey).allInnerTexts();
  await shot("06-month-last-year.png");
  await page.locator('.flow-nav button[aria-label="다음 해"]').click();
  const thisYear = await title();
  check("[Claude] 달: ≪ 는 한 해 전(작년 14일의 Claude 요청), ≫ 로 돌아옴", lastYearTitle === `${today.y - 1}년 ${today.m}월` && lastYearLine.some((line) => line.includes("Claude 달력")) && thisYear === `${today.y}년 ${today.m}월`, `${lastYearTitle} · ${lastYearLine.join(",")} → ${thisYear}`);
  await press("ArrowLeft");
  const lastMonth = dOf(new Date(today.y, today.m - 2, 15));
  const lastMonthTitle = await title();
  const fifteenth = page.locator(`.flow-month-day[data-day="${key(lastMonth)}"]`);
  await until(async () => (await linesOf(key(lastMonth)).count()) >= 1, 8000);
  const fifteenthLines = await linesOf(key(lastMonth)).allInnerTexts();
  check("[Codex] 달: ← 는 한 달 전(15일의 Codex 요청)", lastMonthTitle === `${lastMonth.y}년 ${lastMonth.m}월` && fifteenthLines.some((line) => line.includes("Codex 달력")), `${lastMonthTitle} · ${fifteenthLines.join(",")}`);
  await fifteenth.click();
  await page.waitForSelector('.flow-cal[data-view="day"]');
  const opened = await page.waitForSelector(`.flow-block[data-item="${request("last-month").id}"]`, { timeout: 8000 }).then(
    () => 1,
    () => 0,
  );
  check("달: 날을 누르면 그날의 하루, 그 요청 블록과 함께", (await title()) === dayTitle(lastMonth) && opened === 1, await title());
  // The picker: a year and its months.
  await page.locator(".flow-views button", { hasText: "달" }).click();
  await page.locator(".flow-title").click();
  await page.waitForSelector(".flow-picker-months");
  await page.waitForTimeout(300);
  await shot("07-picker.png");
  await page.locator('.flow-picker-head button[aria-label="이전 해"]').click();
  await page.locator(".flow-picker-months button", { hasText: /^3월$/ }).click();
  const picked = await title();
  await press("T");
  check("달 제목의 고르기: 해를 넘기고 달을 고르면 그 달, T는 이번 달", picked === `${lastMonth.y - 1}년 3월` && (await title()) === `${today.y}년 ${today.m}월`, `${picked} → ${await title()}`);

  // ── 캘린더 연결 ──────────────────────────────────────────────────────────────────────────
  await page.locator(".flow-feeds-button").click();
  await page.waitForSelector(".calendar-sheet");
  await page.locator('.calendar-sheet input[name="calendar-ical-address"]').fill(feedUrl);
  await page.locator(".calendar-sheet .calendar-field input").nth(1).fill("학과 일정");
  await page.locator('.calendar-sheet .calendar-swatches button[aria-label="청록"]').last().click();
  await page.locator(".calendar-sheet .button.primary", { hasText: "연결" }).click();
  await page.waitForSelector(".calendar-feed .calendar-feed-name");
  const addedAt = Date.now();
  const source = await page.locator(".calendar-feed-source").innerText();
  const fieldAfter = await page.locator('.calendar-sheet input[name="calendar-ical-address"]').inputValue();
  await shot("08-feeds-sheet.png");
  check("캘린더 연결: 붙여 넣은 주소로 연결, 목록에는 호스트와 파일 이름만, 입력칸은 비움", source.includes("127.0.0.1") && source.includes("basic.ics") && !source.includes(SECRET) && fieldAfter === "", source);
  await page.locator('.calendar-sheet button[aria-label="닫기"]').click();
  await page.locator(".flow-views button", { hasText: "주" }).click();
  await page.waitForSelector(".flow-event");
  const weekEvents = await page.locator(".flow-week .flow-event").evaluateAll((elements) => elements.map((element) => element.textContent ?? ""));
  const chips = await page.locator(".flow-week .flow-chip").allInnerTexts();
  const meeting = weekEvents.find((text) => text.includes("학과 회의")) ?? "";
  const utcCall = weekEvents.find((text) => text.includes("세계 표준시 통화")) ?? "";
  await scrollTo(".flow-week .flow-event");
  await shot("09-week-events.png");
  check(
    "주: .ics 일정 — 오늘 10:00 회의, 매주 월·수 수업(BYDAY), 종일 학회, UTC 06:00 → 15:00",
    meeting.includes("10:00") && weekEvents.filter((text) => text.includes("미디어와 사회")).length >= 1 && chips.filter((chip) => chip === "학회").length >= 1 && utcCall.includes("15:00"),
    `${weekEvents.length}개 · ${weekEvents.slice(0, 4).join(" | ")} · 종일 ${chips.join(",")}`,
  );
  const classDays = await page.locator(".flow-week .flow-col").evaluateAll((columns) => columns.filter((column) => column.textContent?.includes("미디어와 사회")).map((column) => column.getAttribute("data-day")));
  check("주: 매주 수업은 월요일과 수요일 칸에만", JSON.stringify(classDays) === JSON.stringify([key(monday(today)), key(plus(monday(today), 2))]), classDays.join(","));
  // Yesterday 21:00 in New York is this morning in Seoul (10:00 in summer time, 11:00 after it).
  const ny = await page.locator(`.flow-col[data-day="${key(today)}"] .flow-event`, { hasText: "뉴욕 세미나" }).allInnerTexts();
  check("TZID 일정: 뉴욕 21:00이 서울 시각으로 오늘 칸에", ny.join("").includes(nySeoul), `${ny.join(" ")} (기대 ${nySeoul})`);
  await page.locator(".flow-views button", { hasText: "달" }).click();
  await page.waitForSelector(".flow-month .flow-line.event");
  const todayCell = page.locator(`.flow-month-day[data-day="${key(today)}"]`);
  const monthEvents = await todayCell.locator(".flow-line.event").allInnerTexts();
  const more = await todayCell.locator(".flow-line.more").allInnerTexts();
  const todayLabel = (await todayCell.getAttribute("aria-label")) ?? "";
  await shot("10-month-events.png");
  // Four lines a day: two events, then the works, the rest as "외 N" (all of them in the day's label).
  check(
    "달: 오늘 칸에 종일 학회와 10:00 일정, 넘치는 것은 '외 N'(날의 설명에는 모두)",
    monthEvents[0] === "학회" && monthEvents.some((line) => line.startsWith("10:00")) && more.length === 1 && ["학과 회의", "뉴욕 세미나", "세계 표준시 통화", "학회"].every((name) => todayLabel.includes(name)),
    `${monthEvents.join(" | ")} · ${more.join("")}`,
  );
  await page.locator(".flow-views button", { hasText: "하루" }).click();
  await press("t");
  await page.waitForSelector(".flow-day .flow-col.events .flow-event");
  const dayEvents = await page.locator(".flow-day .flow-col.events .flow-event").allInnerTexts();
  const dayChip = await page.locator(".flow-day .flow-chip").allInnerTexts();
  await scrollTo(".flow-day .flow-col.events .flow-event");
  await shot("11-day-events.png");
  check("하루: '일정' 열에 회의·통화, 종일 줄에 학회, 작업 열 옆에", dayEvents.some((text) => text.includes("학과 회의")) && dayChip.includes("학회") && (await page.locator(".flow-day .flow-col[data-work]").count()) >= 1, `${dayEvents.join(" | ")} · ${dayChip.join(",")}`);

  // A fetch that fails: said in Korean, the last copy and the activity stay.
  calendarMode.value = "down";
  await page.waitForTimeout(Math.max(0, 15_500 - (Date.now() - addedAt)));
  await page.locator(".flow-views button", { hasText: "주" }).click();
  await page.locator(".flow-feeds-button").click();
  await page.waitForSelector(".calendar-sheet .calendar-feed");
  await page.locator('.calendar-sheet button[aria-label="다시 받기"]').click();
  await page.waitForSelector(".calendar-feed-state.failed", { timeout: 25_000 });
  const reason = await page.locator(".calendar-feed-state.failed").innerText();
  await page.locator('.calendar-sheet button[aria-label="닫기"]').click();
  await page.waitForSelector(".flow-feed-error", { timeout: 8000 });
  const notice = await page.locator(".flow-feed-error").innerText();
  const stillEvents = await page.locator(".flow-week .flow-event").count();
  const stillCells = await page.locator(".flow-week .flow-cell").count();
  await shot("12-feed-error.png");
  check("받지 못하면 까닭을 한국어로(HTTP 500), 마지막으로 받은 일정과 작업 기록은 그대로", reason.includes("HTTP 500") && notice.includes("받지 못했습니다") && notice.includes("받은 일정을 보여 줍니다") && stillEvents > 0 && stillCells > 0, `${notice.replace(/\s+/g, " ").slice(0, 120)} · 일정 ${stillEvents} · 칸 ${stillCells}`);
  calendarMode.value = "ok";

  // Dark look of the week and the month.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(300);
  await scrollTo(".flow-week .flow-cell");
  await shot("13-week-dark.png");
  await page.locator(".flow-views button", { hasText: "달" }).click();
  await page.waitForSelector(".flow-month .flow-line.event", { timeout: 8000 }).catch(() => undefined);
  await shot("14-month-dark.png");
  await page.emulateMedia({ colorScheme: "light" });

  // Reduced motion: switching views moves nothing.
  await page.emulateMedia({ reducedMotion: "reduce" });
  // Colour transitions from leaving the dark look began before; let them end.
  await page.waitForTimeout(600);
  await page.locator(".flow-views button", { hasText: "주" }).click();
  const moving = await page.evaluate(async () => {
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    const root = document.querySelector(".flow-cal");
    return document.getAnimations().filter((animation) => animation.playState === "running" && root?.contains(((animation.effect as KeyframeEffect | null)?.target ?? null) as Node | null)).length;
  });
  check("움직임 줄이기: 보기를 바꿔도 흐름 안에서 움직이는 것 없음", moving === 0, `animations=${moving}`);

  // ── the address is a secret ────────────────────────────────────────────────────────────
  for (const path of ["/api/calendar/feeds", "/api/snapshot", `/api/calendar/events?since=${new Date(today.y, today.m - 1, 1).getTime()}&until=${new Date(today.y, today.m, 1).getTime()}&tz=Asia%2FSeoul`]) await api("GET", path);
  // The event stream from the start, read for a moment.
  let stream = "";
  const reading = new AbortController();
  const stop = setTimeout(() => reading.abort(), 1500);
  try {
    const response = await fetch(`${ready.url}/api/events?since=0&token=${encodeURIComponent(ready.token)}`, { signal: reading.signal });
    const reader = response.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      stream += new TextDecoder().decode(value);
    }
  } catch {
    // Aborted after the moment: what was read is enough.
  } finally {
    clearTimeout(stop);
  }
  await page.waitForTimeout(300);
  const leaked = bodies.filter((body) => body.includes(SECRET) || body.includes("flowcheck%40example.com"));
  const feedsFile = join(dataDir, "calendar-feeds.json");
  const files = readdirSync(dataDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => file !== feedsFile);
  const inFiles = files.filter((file) => readFileSync(file).includes(SECRET));
  const inOutput = output.join("").includes(SECRET);
  check(
    "주소는 비밀: 게이트웨이의 어떤 응답(API·이벤트 흐름)에도, 다른 파일·출력에도 없고, 0600 파일에만",
    leaked.length === 0 && !stream.includes(SECRET) && inFiles.length === 0 && !inOutput && (statSync(feedsFile).mode & 0o777) === 0o600 && readFileSync(feedsFile, "utf8").includes(SECRET),
    `응답 ${bodies.length}개 중 ${leaked.length} · 다른 파일 ${files.length}개 중 ${inFiles.length} · 0${(statSync(feedsFile).mode & 0o777).toString(8)}`,
  );
} catch (error) {
  check("실행", false, error instanceof Error ? error.message.split("\n")[0]! : String(error));
  await shot("failure.png").catch(() => undefined);
} finally {
  writeFileSync(join(outDir, "console.log"), logs.join("\n"));
  writeFileSync(join(outDir, "results.json"), JSON.stringify({ results }, null, 2));
  await browser.close();
  calendarServer.close();
  child.kill();
  await new Promise((done) => (child.exitCode === null && child.signalCode === null ? child.once("exit", done) : done(null)));
  for (const dir of [dataDir, worksDir]) rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((result) => !result.ok).length;
  console.log(`${results.length - failed}/${results.length} passed · console: ${logs.length ? logs.slice(0, 6).join(" | ") : "clean"}`);
  process.exitCode = failed ? 1 : 0;
}

