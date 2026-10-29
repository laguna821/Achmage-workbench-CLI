/// <reference lib="dom" />
// Browser check of home's views (프로젝트-내비게이터-그룹보기-설계 §3) against a real gateway on a
// temporary data folder with stand-in engines (no model), sessions of both engines. Projects get
// 단계, 마감일, 중요도, 종류 and the vault's "DIKM_단계:" through /api/projects/:id/property. It checks:
// view tabs (add, rename, duplicate, delete, back to default, kept after a reload); grouping and
// subgrouping on a board, a table, cards and a list; the Bases Look (group colours, borders, tint,
// emphasized headings) drawn and saved; a folded group remembered; dragging on a board to change
// the stage (undo), the folder and a property, and a refused drag on a date period (and why);
// DIKM values in order and in their emoji's colours; "지금" regrouped by project and engine with
// each engine's waiting session; "문서" regrouped; "흐름" filtered and coloured by stage; the graph;
// 300 projects on a board (render and drag frame times); dark. Screenshots go to the out dir.
// Usage: node scripts/groups-check.ts [outDir]

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Locator, type Page } from "playwright-core";
import type { Folder, HomeViews, ProjectSummary, Provider, Session, UiPrefs, Work } from "@workbench/contracts";

const outDir = process.argv[2] ?? join(tmpdir(), "wb-groups");
mkdirSync(outDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "workbench-groups-"));
const worksDir = mkdtempSync(join(tmpdir(), "workbench-groups-works-"));
const results: { step: string; ok: boolean; detail: string }[] = [];
const check = (step: string, ok: boolean, detail = "") => {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`);
};
const numbers: string[] = [];

const child = spawn(process.execPath, ["apps/host/src/main.ts"], {
  env: {
    ...process.env,
    WORKBENCH_DATA_DIR: dataDir,
    WORKBENCH_WEB_DIR: "apps/web/dist",
    WORKBENCH_HOST_LABEL: "노트북",
    WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"),
    WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"),
  },
  stdio: ["ignore", "pipe", "inherit"],
});
const ready = await new Promise<{ url: string; token: string }>((done) => {
  createInterface({ input: child.stdout! }).on("line", (line) => {
    if (line.startsWith("WORKBENCH_READY ")) done(JSON.parse(line.slice(16)));
  });
});
const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${ready.url}${path}`, { method, headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
};
const until = async (what: () => Promise<boolean> | boolean, timeout = 15_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await what()) return true;
    await new Promise((done) => setTimeout(done, 100));
  }
  return false;
};
type Snapshot = { works: Work[]; sessions: Session[]; prefs: UiPrefs };
const snapshot = () => api<Snapshot>("GET", "/api/snapshot");
const summaries = () => api<ProjectSummary[]>("GET", "/api/projects/");
const prop = async (workId: string, key: string) => (await summaries()).find((entry) => entry.workId === workId)?.properties.find((entry) => entry.key === key)?.values ?? [];
const stageOf = async (workId: string) => (await summaries()).find((entry) => entry.workId === workId)?.stage ?? null;
const savedViews = async () => (await snapshot()).prefs.homeViews as HomeViews | undefined;
await api("PUT", "/api/prefs", { prefs: { onboarding: "done", startScreen: "last", homeMode: "projects" } });

// ── seed: folders, projects with notes, sessions of both engines, documents ──────────────────
const pad = (value: number) => String(value).padStart(2, "0");
const ymd = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const dayAfter = (days: number) => {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return ymd(date);
};
const mondayOffset = (() => {
  const day = new Date().getDay();
  return -((day + 6) % 7);
})();
const DATES = { overdue: dayAfter(-1), today: dayAfter(0), tomorrow: dayAfter(1), nextWeek: dayAfter(mondayOffset + 9), later: dayAfter(120) };

const folder = (name: string, parentId: string | null = null) => api<Folder>("POST", "/api/folders", { name, parentId });
const lecture = await folder("강의");
const term = await folder("2026-2", lecture.id);
const research = await folder("연구");
const admin = await folder("행정");

type Seed = { title: string; folder: Folder | null; stage?: string; due?: string; importance?: string; kinds?: string[]; dikm?: string; tags?: string[]; engines?: Provider[] };
async function project(seed: Seed) {
  const cwd = join(worksDir, seed.title.replace(/\s+/g, "-"));
  mkdirSync(cwd, { recursive: true });
  const work = await api<Work>("POST", "/api/works", { title: seed.title, cwd, folderId: seed.folder?.id ?? null });
  await api("PATCH", `/api/works/${work.id}`, { title: seed.title, folderId: seed.folder?.id ?? null });
  if (seed.stage) await api("PUT", `/api/projects/${work.id}/stage`, { stage: seed.stage });
  if (seed.due) await api("PUT", `/api/projects/${work.id}/property`, { key: "마감일", values: [seed.due], type: "date" });
  if (seed.importance) await api("PUT", `/api/projects/${work.id}/property`, { key: "중요도", values: [seed.importance], type: "text" });
  if (seed.kinds) await api("PUT", `/api/projects/${work.id}/property`, { key: "종류", values: seed.kinds, type: "list" });
  if (seed.dikm) await api("PUT", `/api/projects/${work.id}/property`, { key: "DIKM_단계:", values: [seed.dikm], type: "list" });
  if (seed.tags) await api("PUT", `/api/projects/${work.id}/property`, { key: "tags", values: seed.tags, type: "tags" });
  for (const provider of seed.engines ?? []) await api("POST", `/api/works/${work.id}/sessions`, { provider, purpose: "준비", access: "auto" });
  return work;
}
const works = {
  autumn: await project({ title: "가을 특강", folder: term, stage: "진행중", due: DATES.tomorrow, importance: "높음", kinds: ["강의"], dikm: "🟢 D", tags: ["강의"], engines: ["codex", "claude"] }),
  draft: await project({ title: "논문 초고", folder: research, stage: "할일", due: DATES.overdue, importance: "높음", kinds: ["연구"], dikm: "🔵 I", tags: ["연구"], engines: ["claude"] }),
  talk: await project({ title: "학회 발표", folder: research, stage: "진행중", due: DATES.today, importance: "보통", kinds: ["연구"], dikm: "🟣 K", tags: ["연구"], engines: ["codex"] }),
  budget: await project({ title: "예산 보고", folder: admin, stage: "보류", due: DATES.nextWeek, importance: "낮음", kinds: ["행정"], dikm: "🟠 M", engines: ["codex"] }),
  minutes: await project({ title: "회의록 정리", folder: admin, due: DATES.later, importance: "보통", kinds: ["행정"], dikm: "⬜ 보류", engines: ["claude"] }),
  app: await project({ title: "워크벤치 앱", folder: null, stage: "완료", tags: ["코딩"], engines: ["codex", "claude"] }),
  week7: await project({ title: "강의안 7주차", folder: lecture, stage: "진행중", due: DATES.tomorrow, importance: "높음", kinds: ["강의", "글쓰기"], engines: ["claude"] }),
  alone: await project({ title: "혼자 쓰는 노트", folder: null }),
};
// Documents: two in the lecture, one in the draft.
for (const [work, name] of [
  [works.autumn, "강의안.md"],
  [works.autumn, "자료.md"],
  [works.draft, "초고.md"],
] as const) {
  writeFileSync(join(work.cwd, name), `# ${name}\n\n${work.title}의 문서입니다.\n`);
  await api("POST", `/api/works/${work.id}/artifacts`, { path: name });
}

const browser = await chromium.launch();
const logs: string[] = [];
const watch = (page: Page, label: string) => {
  page.on("console", (message) => message.type() === "error" && logs.push(`[${label} error] ${message.text().slice(0, 200)}`));
  page.on("pageerror", (error) => logs.push(`[${label} pageerror] ${error.message.slice(0, 200)}`));
};
const blur = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

async function home(page: Page, mode: "지금" | "프로젝트" | "흐름" | "문서") {
  if (!(await page.locator(".home-modes").count())) await page.locator(".topbar .brand").click();
  await page.waitForSelector(".home-modes");
  const wanted = { 지금: "now", 프로젝트: "projects", 흐름: "flow", 문서: "docs" }[mode];
  if (!(await page.locator(`.home-modes.mode-${wanted}`).count())) await page.locator(".home-mode-bar button", { hasText: mode }).click();
  await page.waitForSelector(`.home-modes.mode-${wanted}`);
}
const tab = (page: Page, name: string) => page.locator(".home-modes .view-tab", { hasText: new RegExp(`^${name.replace(/[×()]/g, "\\$&")}$`) });
async function view(page: Page, name: string) {
  await tab(page, name).click();
  await page.waitForSelector(`.home-modes .view-tab.on:text-is("${name}")`);
}
/** Open a toolbar popover ("묶기", "하위 묶기", "정렬", "속성", "모양", "색 기준"). */
async function tool(page: Page, label: string) {
  const button = page.locator(".home-modes .view-tool", { hasText: new RegExp(`^${label}`) }).first();
  if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
  await page.waitForSelector(".view-pop");
}
const closePop = (page: Page) => page.keyboard.press("Escape");
const pick = (page: Page, label: string) => page.locator(".view-pop .menu-item", { hasText: new RegExp(`^${label}$`) }).first().click();
const toggle = (page: Page, label: string) => page.locator(".view-pop .view-switch", { hasText: label }).locator("input").click();
const texts = (page: Page, selector: string) => page.locator(selector).allInnerTexts();
const label = (text: string) => text.replace(/\s+\d+$/, "").trim();

/** Drag with the mouse from a card to a place, through a few steps (a press, a 5px threshold, the move). */
async function drag(page: Page, from: Locator, to: Locator) {
  // Both ends on screen: the source scrolled in, then the page moved so the target shows too.
  await from.scrollIntoViewIfNeeded();
  let a = (await from.boundingBox())!;
  let b = (await to.boundingBox())!;
  const height = page.viewportSize()!.height;
  if (b.y < 60 || b.y + 50 > height) {
    const shift = Math.round(b.y + 25 - (b.y < a.y ? 120 : height - 120));
    await page.evaluate((by) => document.querySelector(".start-view")?.scrollBy(0, by), shift);
    a = (await from.boundingBox())!;
    b = (await to.boundingBox())!;
  }
  await page.mouse.move(a.x + 20, a.y + 12);
  await page.mouse.down();
  await page.mouse.move(a.x + 40, a.y + 26, { steps: 3 });
  await page.mouse.move(b.x + b.width / 2, b.y + Math.min(40, b.height / 2), { steps: 8 });
  await page.waitForTimeout(80);
  const hovered = await page.evaluate(() => ({ over: document.querySelectorAll(".group-board .over").length, refuse: document.querySelectorAll(".group-board .refuse").length, hint: document.querySelector(".kanban-ghost-hint")?.textContent ?? "" }));
  await page.mouse.up();
  return hovered;
}

const toastText = (page: Page) => page.locator(".toast").last().innerText().catch(() => "");

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
  watch(page, "main");
  const shot = (name: string, target: Page = page) => target.screenshot({ path: join(outDir, name) });
  await page.goto(`${ready.url}/?token=${ready.token}`);
  await page.waitForSelector(".topbar .brand, .home-modes", { timeout: 20_000 });
  await home(page, "프로젝트");

  // ── view tabs: today's views first, then the two new ones ────────────────────────────────
  await page.waitForSelector(".projects-layouts .view-tab.on");
  const tabs = await texts(page, ".projects-layouts .view-tab");
  await page.waitForSelector(".map-section");
  const sections = (await texts(page, ".map-section > .group-head .group-label")).map(label);
  await shot("01-projects-cards.png");
  check(
    "프로젝트 보기 탭: 카드 · 표 · 단계 · 그래프 · 마감 × 중요도 · 폴더별, 카드는 폴더별(트리 순서, 폴더 밖 마지막)",
    tabs.join("|") === "카드|표|단계|그래프|마감 × 중요도|폴더별" && sections.join("|") === "강의|강의 / 2026-2|연구|행정|폴더 밖",
    `${tabs.join(" · ")} / ${sections.join(" · ")}`,
  );

  // Add, rename, duplicate, delete, back to default; all kept in the preferences.
  await page.locator(".projects-layouts .view-add").click();
  await page.locator(".view-add-pop .menu-item", { hasText: /^보드$/ }).click();
  await page.waitForSelector('.projects-layouts .view-tab.on:text-is("보드")');
  await page.locator('.projects-layouts .view-tab.on:text-is("보드")').dblclick();
  await page.locator(".view-tab-input").fill("내 보드");
  await page.locator(".view-tab-input").press("Enter");
  await page.waitForSelector('.projects-layouts .view-tab.on:text-is("내 보드")');
  await tab(page, "내 보드").click({ button: "right" });
  await page.locator(".context-menu .context-menu-item", { hasText: "복제" }).click();
  await page.waitForSelector('.projects-layouts .view-tab.on:text-is("내 보드 사본")');
  await tab(page, "내 보드 사본").click({ button: "right" });
  await page.locator(".context-menu .context-menu-item", { hasText: "지우기" }).click();
  const afterDelete = await texts(page, ".projects-layouts .view-tab");
  const kept = await until(async () => (await savedViews())?.modes.projects.views.some((entry) => entry.name === "내 보드") === true && !(await savedViews())?.modes.projects.views.some((entry) => entry.name === "내 보드 사본"), 4000);
  check("보기 더하기(보드) · 이름 바꾸기 · 복제 · 지우기, 화면 설정에 바로 저장", afterDelete.join("|") === "카드|표|단계|그래프|마감 × 중요도|폴더별|내 보드" && kept, afterDelete.join(" · "));

  // ── a board grouped by 중요도 with 단계 rows (swimlanes) ───────────────────────────────────
  await view(page, "내 보드");
  await tool(page, "묶기");
  await pick(page, "중요도");
  await closePop(page);
  await tool(page, "하위 묶기");
  await pick(page, "단계");
  await closePop(page);
  await page.waitForSelector(".group-board.lanes .kanban-lane");
  const columns = (await texts(page, ".group-board.lanes .kanban-column-head .group-label")).map(label);
  const lanes = (await texts(page, ".group-board.lanes .kanban-lane-head .group-label")).map(label);
  const cellOf = (column: string, lane: string) => page.locator(`.group-board.lanes .kanban-cell[data-col="${column}"][data-lane="${lane}"]`);
  const autumnCell = await cellOf("높음", "진행중").locator(`.kanban-card[data-work="${works.autumn.id}"]`).count();
  await shot("02-board-lanes.png");
  check(
    "보드: 열 = 중요도(템플릿 안내의 높음·보통·낮음 순서, 값 없음 끝), 가로줄 = 단계, 칸마다 그 카드",
    columns.join("|") === "높음|보통|낮음|값 없음" && lanes.slice(0, 2).join("|") === "할일|진행중" && lanes.at(-1) === "값 없음" && autumnCell === 1,
    `열 ${columns.join(" · ")} / 줄 ${lanes.join(" · ")} / 가을 특강 ${autumnCell}`,
  );

  // ── the look: a colour, border, emphasized headings, a tint; kept after a reload ────────────
  await tool(page, "모양");
  await toggle(page, "테두리");
  await toggle(page, "머리 강조");
  await page.locator('.view-pop input[type="range"]').fill("12");
  await page.locator(".view-pop .view-color-row", { hasText: "보통" }).first().locator(".view-color-dot").click();
  await page.locator('.view-pop .view-color-row .color-swatch[aria-label="#12a594"]').first().click();
  await closePop(page);
  const look = await page.evaluate(() => {
    const head = document.querySelector<HTMLElement>('.group-board.lanes .kanban-column-head[style*="12a594"]');
    const cell = document.querySelector<HTMLElement>('.group-board.lanes .kanban-cell[data-col="보통"]');
    const labelEl = head?.querySelector<HTMLElement>(".group-label");
    return {
      head: head ? getComputedStyle(head).boxShadow : "",
      cell: cell ? getComputedStyle(cell).backgroundColor : "",
      size: labelEl ? getComputedStyle(labelEl).fontSize : "",
      weight: labelEl ? getComputedStyle(labelEl).fontWeight : "",
      color: labelEl ? getComputedStyle(labelEl).color : "",
    };
  });
  await shot("03-board-look.png");
  const lookOk = look.head.includes("rgb(18, 165, 148)") && /0px 3px 0px/.test(look.head) && look.cell !== "" && look.cell !== "rgba(0, 0, 0, 0)" && look.weight === "700";
  // Saved a moment after the last change (the screen preferences are written together).
  await until(async () => (await savedViews())?.modes.projects.views.find((entry) => entry.name === "내 보드")?.look.colors["prop:중요도=보통"] === "#12a594", 5000);
  await page.reload();
  await page.waitForSelector(".group-board.lanes .kanban-lane");
  const reloaded = await page.evaluate(() => Boolean(document.querySelector('.group-board.lanes .kanban-column-head[style*="12a594"]')) && document.querySelector(".group-board.lanes")!.classList.contains("look-tint"));
  const savedLook = (await savedViews())?.modes.projects.views.find((entry) => entry.name === "내 보드")?.look;
  check(
    "모양: 묶음 색(#12a594)이 열의 위 띠와 테두리, 옅은 바탕, 굵은 머리 — 다시 열어도 그대로(보기에 저장)",
    lookOk && reloaded && savedLook?.border === true && savedLook.heading === true && savedLook.tint === 12 && savedLook.colors["prop:중요도=보통"] === "#12a594",
    JSON.stringify({ ...look, reloaded, savedLook }),
  );

  // Folding a row (swimlane) is remembered.
  await page.locator('.group-board.lanes .kanban-lane[data-lane="진행중"] .kanban-lane-head .group-toggle').click();
  await page.waitForSelector('.group-board.lanes .kanban-lane[data-lane="진행중"].folded');
  await until(async () => (await savedViews())?.modes.projects.views.find((entry) => entry.name === "내 보드")?.collapsed.includes("stage=진행중") === true, 5000);
  await page.reload();
  await page.waitForSelector(".group-board.lanes .kanban-lane");
  const folded = await page.locator('.group-board.lanes .kanban-lane[data-lane="진행중"].folded').count();
  const foldedCards = await page.locator('.group-board.lanes .kanban-lane[data-lane="진행중"] .kanban-card').count();
  check("접은 묶음은 보기에 남아 다시 열어도 접힘", folded === 1 && foldedCards === 0, `접힘 ${folded} · 카드 ${foldedCards}`);
  await page.locator('.group-board.lanes .kanban-lane[data-lane="진행중"] .kanban-lane-head .group-toggle').click();

  // ── drag on the board: a property (중요도), then the stage (rows) ───────────────────────────
  await page.waitForSelector(`.group-board.lanes .kanban-cell[data-col="낮음"][data-lane="보류"] .kanban-card[data-work="${works.budget.id}"]`);
  const toHigh = await drag(page, cellOf("낮음", "보류").locator(`.kanban-card[data-work="${works.budget.id}"]`), cellOf("높음", "보류"));
  const importance = await until(async () => (await prop(works.budget.id, "중요도")).join() === "높음", 8000);
  const movedCard = await until(async () => (await cellOf("높음", "보류").locator(`.kanban-card[data-work="${works.budget.id}"]`).count()) === 1, 5000);
  check("보드 끌기: '예산 보고'를 낮음 → 높음 열로 끌면 노트의 중요도: 높음, 카드도 그 칸으로", importance && movedCard && toHigh.over === 1, JSON.stringify(toHigh));
  const toDone = await drag(page, cellOf("높음", "보류").locator(`.kanban-card[data-work="${works.budget.id}"]`), cellOf("높음", "완료"));
  const staged = await until(async () => (await stageOf(works.budget.id)) === "완료", 8000);
  await page.locator(".toast button", { hasText: "되돌리기" }).click();
  const undone = await until(async () => (await stageOf(works.budget.id)) === "보류", 8000);
  check("가로줄 끌기: 보류 → 완료 줄로 끌면 단계가 바뀌고 '되돌리기'로 보류로", staged && undone && toDone.over === 1, JSON.stringify(toDone));

  // ── table, cards and list of the same view, grouped ───────────────────────────────────────
  await tool(page, "모양");
  await page.locator('.view-pop .view-segments button:text-is("표")').click();
  await closePop(page);
  await page.waitForSelector(".projects-table .group-row");
  const tableGroups = (await texts(page, ".projects-table .group-row:not(.sub) .group-label")).map(label);
  const tableSubs = await page.locator(".projects-table .group-row.sub").count();
  await shot("04-table-grouped.png");
  await tool(page, "모양");
  await page.locator('.view-pop .view-segments button:text-is("카드")').click();
  await closePop(page);
  await page.waitForSelector(".map-section .group-subs .work-card");
  const cardGroups = await page.locator(".map-section:not(.sub)").count();
  await shot("05-cards-grouped.png");
  await tool(page, "모양");
  await page.locator('.view-pop .view-segments button:text-is("목록")').click();
  await closePop(page);
  await page.waitForSelector(".list-section .project-line");
  const listLines = await page.locator(".list-section .project-line").count();
  await shot("06-list-grouped.png");
  check(
    "같은 보기를 표 · 카드 · 목록으로: 묶음 머리 안에 하위 묶음 머리",
    tableGroups.slice(0, 3).join("|") === "높음|보통|낮음" && tableSubs >= 4 && cardGroups >= 3 && listLines >= 7,
    `표 ${tableGroups.join(" · ")} (하위 ${tableSubs}) · 카드 묶음 ${cardGroups} · 목록 줄 ${listLines}`,
  );

  // ── the stage view: today's kanban, a card dragged to a stage, undone ─────────────────────
  await view(page, "단계");
  await page.waitForSelector('.kanban-column[data-stage-column="할일"] .kanban-card');
  const stageColumns = (await texts(page, ".group-board .kanban-column .kanban-head .group-label")).map(label);
  const band = await page.evaluate(() => getComputedStyle(document.querySelector('.kanban-column[data-stage-column="진행중"]')!).boxShadow);
  await drag(page, page.locator(`.kanban-column[data-stage-column="할일"] .kanban-card[data-work="${works.draft.id}"]`), page.locator('.kanban-column[data-stage-column="완료"]'));
  const toDoneStage = await until(async () => (await stageOf(works.draft.id)) === "완료", 8000);
  const inDone = await until(async () => (await page.locator(`.kanban-column[data-stage-column="완료"] .kanban-card[data-work="${works.draft.id}"]`).count()) === 1, 5000);
  await shot("07-stage-board.png");
  await page.locator(".toast button", { hasText: "되돌리기" }).click();
  const backToDo = await until(async () => (await stageOf(works.draft.id)) === "할일", 8000);
  check(
    "'단계' 보기(전의 칸반): 열은 단계 순서 · 아카이브 · 값 없음, 단계 색 띠, 끌면 노트에 단계 → 되돌리기",
    stageColumns.join("|") === "할일|진행중|완료|보류|아카이브|값 없음" && /rgb\(62, 99, 221\) 0px 3px 0px/.test(band) && toDoneStage && inDone && backToDo,
    `${stageColumns.join(" · ")} · ${band.slice(0, 60)}`,
  );

  // ── a board wider than the centre (the navigator's two panes beside it): carried to the edge,
  //    the board scrolls on, so a column out of sight still takes the card ─────────────────────
  {
    const board = page.locator(".group-board");
    await board.evaluate((element) => (element.scrollLeft = 0));
    const overflows = await board.evaluate((element) => element.scrollWidth > element.clientWidth + 4);
    const last = page.locator('.kanban-column[data-stage-column=""]');
    const inSight = () => last.evaluate((column) => {
      const own = column.getBoundingClientRect();
      const frame = column.closest(".group-board")!.getBoundingClientRect();
      return own.left + own.width / 2 < frame.right - 8;
    });
    const hiddenBefore = !(await inSight());
    const source = page.locator(`.kanban-column[data-stage-column="할일"] .kanban-card[data-work="${works.draft.id}"]`);
    await source.scrollIntoViewIfNeeded();
    const a = (await source.boundingBox())!;
    const frame = (await board.boundingBox())!;
    await page.mouse.move(a.x + 20, a.y + 12);
    await page.mouse.down();
    await page.mouse.move(a.x + 40, a.y + 26, { steps: 3 });
    await page.mouse.move(frame.x + frame.width - 12, a.y + 26, { steps: 10 });
    const reached = await until(inSight, 6000);
    const target = (await last.boundingBox())!;
    await page.mouse.move(target.x + target.width / 2, a.y + 26, { steps: 6 });
    await page.waitForTimeout(80);
    await page.mouse.up();
    const cleared = await until(async () => (await stageOf(works.draft.id)) === null, 8000);
    await shot("07b-board-edge-scroll.png");
    await page.locator(".toast button", { hasText: "되돌리기" }).click();
    const restored = await until(async () => (await stageOf(works.draft.id)) === "할일", 8000);
    check(
      "가운데보다 넓은 보드(두 칸 내비게이터 옆): 카드를 가장자리로 가져가면 보드가 넘어가 화면 밖 열('값 없음')에 놓임 → 되돌리기",
      overflows && hiddenBefore && Boolean(reached) && cleared && restored,
      `넘침 ${overflows} · 처음엔 안 보임 ${hiddenBefore} · 닿음 ${Boolean(reached)}`,
    );
  }

  // ── 마감 × 중요도: periods × importance; a date period refuses a drag and says why ─────────
  await view(page, "마감 × 중요도");
  await page.waitForSelector(".group-board.lanes .kanban-lane");
  const dueColumns = (await texts(page, ".group-board.lanes .kanban-column-head .group-label")).map(label);
  const overdueCard = page.locator(`.kanban-cell[data-col="overdue"] .kanban-card[data-work="${works.draft.id}"]`);
  const placed = {
    overdue: await overdueCard.count(),
    today: await page.locator(`.kanban-cell[data-col="today"] .kanban-card[data-work="${works.talk.id}"]`).count(),
    tomorrow: await page.locator(`.kanban-cell[data-col="tomorrow"] .kanban-card[data-work="${works.autumn.id}"]`).count(),
    later: await page.locator(`.kanban-cell[data-col="later"] .kanban-card[data-work="${works.minutes.id}"]`).count(),
  };
  await shot("08-due-importance.png");
  const refused = await drag(page, overdueCard, page.locator('.kanban-cell[data-col="today"][data-lane="높음"]'));
  const why = await until(async () => (await toastText(page)).includes("끌어서 정할 수 없습니다"), 4000);
  const dueAfter = await prop(works.draft.id, "마감일");
  check(
    "'마감 × 중요도': 열은 마감이 있는 기간만(지남·오늘·내일·다음 주·나중) · 값 없음, 날짜 기간으로는 끌 수 없고 까닭을 알림(값 그대로)",
    dueColumns.join("|") === "지남|오늘|내일|다음 주|나중|값 없음" && Object.values(placed).every((count) => count === 1) && refused.refuse === 1 && refused.hint === "옮길 수 없음" && why && dueAfter.join() === DATES.overdue,
    `${dueColumns.join(" · ")} · ${JSON.stringify(placed)} · ${JSON.stringify(refused)} · ${await toastText(page)}`,
  );

  // ── 폴더별 (table by folder), then a board by folder: dragging moves the work ───────────────
  await view(page, "폴더별");
  await page.waitForSelector(".projects-table .group-row");
  const folderGroups = (await texts(page, ".projects-table .group-row .group-label")).map(label);
  const folderHeads = await texts(page, ".projects-table thead th");
  await shot("09-folders-table.png");
  check("'폴더별' 표: 폴더마다 머리(빈 폴더 숨김), 열에 단계·중요도·마감일", folderGroups.join("|") === "강의|강의 / 2026-2|연구|행정|폴더 밖" && folderHeads.slice(0, 4).join("|") === "이름|단계|중요도|마감일", `${folderGroups.join(" · ")} / ${folderHeads.join(" · ")}`);
  await tool(page, "모양");
  await page.locator('.view-pop .view-segments button:text-is("보드")').click();
  await closePop(page);
  await tool(page, "묶기");
  await page.locator(".view-pop .view-switch", { hasText: "빈 묶음 숨기기" }).locator("input").uncheck();
  await closePop(page);
  await page.waitForSelector(`.kanban-column[data-col="${admin.id}"]`);
  await shot("09b-folders-board.png");
  await drag(page, page.locator(`.kanban-column[data-col="${research.id}"] .kanban-card[data-work="${works.talk.id}"]`), page.locator(`.kanban-column[data-col="${admin.id}"]`));
  const movedFolder = await until(async () => (await snapshot()).works.find((work) => work.id === works.talk.id)?.folderId === admin.id, 8000);
  await until(async () => (await toastText(page)).includes("연구 → 행정"), 4000);
  const folderNotice = await toastText(page);
  await page.locator(".toast button", { hasText: "되돌리기" }).click();
  const folderBack = await until(async () => (await snapshot()).works.find((work) => work.id === works.talk.id)?.folderId === research.id, 8000);
  check("폴더로 묶은 보드: 카드를 '행정' 열로 끌면 프로젝트가 그 폴더로(PATCH folderId), 되돌리기로 제자리", movedFolder && folderBack && folderNotice.includes("연구 → 행정"), folderNotice);
  // This view goes back to how it shipped.
  await tab(page, "폴더별").click({ button: "right" });
  await page.locator(".context-menu .context-menu-item", { hasText: "기본값으로" }).click();
  await page.waitForSelector(".projects-table .group-row");
  check("탭 오른쪽 클릭 '기본값으로': 폴더별 표로 돌아옴", (await page.locator(".projects-table .group-row").count()) >= 4);

  // ── the vault's DIKM values: their order and their emoji's colours ─────────────────────────
  await view(page, "내 보드");
  await tool(page, "모양");
  await page.locator('.view-pop .view-segments button:text-is("보드")').click();
  await closePop(page);
  await tool(page, "하위 묶기");
  await pick(page, "없음");
  await closePop(page);
  await tool(page, "묶기");
  await pick(page, "DIKM_단계");
  await closePop(page);
  await page.waitForSelector('.group-board .kanban-column[data-col="🟢 D"]');
  const dikm = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>(".group-board .kanban-column")).map((column) => [column.dataset.col, getComputedStyle(column).getPropertyValue("--group").trim()]),
  );
  await shot("10-dikm.png");
  check(
    "지식체계(DIKM_단계:): 🟢 D · 🔵 I · 🟣 K · 🟠 M · ⬜ 보류 순서, 이모지 색으로 묶임",
    JSON.stringify(dikm) === JSON.stringify([["🟢 D", "#30a46c"], ["🔵 I", "#3e63dd"], ["🟣 K", "#8e4ec6"], ["🟠 M", "#f76b15"], ["⬜ 보류", "#8b8d98"], ["", ""]]),
    JSON.stringify(dikm),
  );
  // A list key with several values (종류: 강의, 글쓰기) is in each group, and is not dragged.
  await tool(page, "묶기");
  await pick(page, "종류");
  await closePop(page);
  await page.waitForSelector('.group-board .kanban-column[data-col="글쓰기"]');
  const both = (await page.locator(`.group-board .kanban-card[data-work="${works.week7.id}"]`).count()) === 2;
  await drag(page, page.locator(`.kanban-column[data-col="글쓰기"] .kanban-card[data-work="${works.week7.id}"]`), page.locator('.kanban-column[data-col="연구"]'));
  const manyWhy = await until(async () => (await toastText(page)).includes("값이 여럿"), 4000);
  const kindsAfter = await prop(works.week7.id, "종류");
  check("여러 값(종류: 강의·글쓰기)은 묶음마다 보이고, 끌면 까닭을 알리고 그대로", both && manyWhy && kindsAfter.join() === "강의,글쓰기", `${await toastText(page)} · ${kindsAfter.join()}`);

  // ── the graph still works (coloured by the view's group when it has one) ───────────────────
  await view(page, "그래프");
  await page.waitForSelector(".graph-node.project");
  const points = await page.locator(".graph-node.project").count();
  await shot("11-graph.png");
  check("그래프 보기: 프로젝트마다 점", points === Object.keys(works).length, `${points}점`);

  // ── the project page: values to pick for a text and a list property (Notion's select) ───────
  await view(page, "표");
  await page.locator(".projects-table .projects-name", { hasText: "혼자 쓰는 노트" }).click();
  await page.waitForSelector('.properties-panel .prop-row[data-key="중요도"]');
  await page.locator('.properties-panel .prop-row[data-key="중요도"] .prop-value').click();
  await page.waitForSelector('.prop-row[data-key="중요도"] .prop-choice');
  const importanceChoices = await texts(page, '.prop-row[data-key="중요도"] .prop-choice');
  await shot("11b-property-choices.png");
  await page.locator('.prop-row[data-key="중요도"] .prop-choice', { hasText: "보통" }).click();
  const picked = await until(async () => (await prop(works.alone.id, "중요도")).join() === "보통", 8000);
  await page.locator('.properties-panel .prop-row[data-key="종류"] .prop-add-value').click();
  await page.waitForSelector('.prop-row[data-key="종류"] .prop-choice');
  const kindChoices = await texts(page, '.prop-row[data-key="종류"] .prop-choice');
  await page.locator('.prop-row[data-key="종류"] .prop-choice', { hasText: "연구" }).click();
  const kindPicked = await until(async () => (await prop(works.alone.id, "종류")).join() === "연구", 8000);
  check(
    "프로젝트 페이지 속성: 중요도는 템플릿의 높음·보통·낮음, 종류는 다른 프로젝트가 쓴 값을 골라 씀",
    importanceChoices.slice(0, 3).join("|") === "높음|보통|낮음" && picked && ["강의", "연구", "행정", "글쓰기"].every((value) => kindChoices.includes(value)) && kindPicked,
    `중요도 ${importanceChoices.join(",")} · 종류 ${kindChoices.join(",")}`,
  );
  await page.locator(".topbar .brand").click();

  // ── 문서: grouped by project, by format, by when ───────────────────────────────────────────
  await home(page, "문서");
  await page.waitForSelector(".docs .doc-tile");
  const tiles = await page.locator(".docs .doc-tile").count();
  await tool(page, "묶기");
  await pick(page, "프로젝트");
  await closePop(page);
  await page.waitForSelector(".docs-section .group-label");
  const docGroups = (await texts(page, ".docs-section .group-label")).map(label);
  await shot("12-docs-by-project.png");
  await tool(page, "묶기");
  await pick(page, "고친 때");
  await closePop(page);
  const docPeriods = (await texts(page, ".docs-section .group-label")).map(label);
  check("문서: 처음은 지금 화면(첫 쪽 썸네일), 프로젝트별 · 고친 때(오늘)로 다시 묶기", tiles === 3 && docGroups.join("|") === "가을 특강|논문 초고" && docPeriods.join("|") === "오늘", `${tiles}장 · ${docGroups.join(" · ")} · ${docPeriods.join(" · ")}`);

  // ── per engine: a waiting session in 지금 (by state, project and engine) and a turn in 흐름 ──
  // Each engine in its own project (turns of one project close in time share a block in 하루).
  const lanesOf = { codex: { work: works.autumn, keep: "#강의", drop: "#연구" }, claude: { work: works.talk, keep: "#연구", drop: "#강의" } } as const;
  for (const provider of ["codex", "claude"] as const) {
    const name = provider === "codex" ? "Codex" : "Claude";
    const pass = (step: string, ok: boolean, detail = "") => check(`[${name}] ${step}`, ok, detail);
    const { work: target, keep, drop } = lanesOf[provider];
    const asking = await api<Session>("POST", `/api/works/${target.id}/sessions`, { provider, purpose: `${name} 확인`, access: "ask" });
    await api("POST", `/api/sessions/${asking.id}/messages`, { requestId: crypto.randomUUID(), text: "명령 실행해 줘" });
    await until(async () => (await snapshot()).sessions.find((session) => session.id === asking.id)?.status === "awaitingApproval");
    await home(page, "지금");
    await view(page, "상태");
    await page.waitForSelector(".home-modes.mode-now .bucket-attention");
    const waiting = await page.locator(".bucket-attention .home-session", { hasText: `${name} 확인` }).count();
    await shot(`13-${provider}-now.png`);
    await tool(page, "묶기");
    await pick(page, "프로젝트");
    await closePop(page);
    await page.waitForSelector(".now-mode .home-section[data-group]");
    const byProject = await page.locator(`.now-mode .home-section[data-group="${target.id}"] .home-session`, { hasText: `${name} 확인` }).count();
    await tool(page, "묶기");
    await pick(page, "엔진");
    await closePop(page);
    await page.waitForSelector(`.now-mode .home-section[data-group="${provider}"]`);
    const byEngine = await page.locator(`.now-mode .home-section[data-group="${provider}"] .home-session`, { hasText: `${name} 확인` }).count();
    const engineGroups = (await texts(page, ".now-mode .home-section > .group-head .group-label")).map(label);
    await shot(`13b-${provider}-now-by-engine.png`);
    // Back to today's 지금 for the next engine.
    await tool(page, "묶기");
    await pick(page, "상태");
    await closePop(page);
    pass("지금: 확인 필요에 이 엔진의 세션, 프로젝트별·엔진별로 다시 묶어도 그 묶음에", waiting === 1 && byProject === 1 && byEngine === 1 && engineGroups.includes(name), `${engineGroups.join(" · ")}`);
    await api("POST", `/api/sessions/${asking.id}/approvals/${encodeURIComponent((await api<{ items: { id: string; kind: string }[] }>("GET", `/api/sessions/${asking.id}/items`)).items.find((item) => item.kind === "approval")!.id)}`, { decision: "accept" });
    await until(async () => (await snapshot()).sessions.find((session) => session.id === asking.id)?.status === "idle", 20_000);

    // 흐름: today's turn of this engine, coloured by the project's stage, and gone when filtered out.
    await home(page, "흐름");
    await page.locator(".flow-views button", { hasText: "하루" }).click();
    await page.locator(".flow-today").click();
    await until(async () => (await page.locator(`.flow-col[data-work="${target.id}"] .flow-block[data-session="${asking.id}"]`).count()) > 0, 8000);
    const engineInk = await page.evaluate((id) => getComputedStyle(document.querySelector(`.flow-block[data-session="${id}"]`)!).getPropertyValue("--accent").trim(), asking.id);
    await tool(page, "색 기준");
    await pick(page, "단계");
    await closePop(page);
    await until(async () => (await page.evaluate((id) => getComputedStyle(document.querySelector(`.flow-block[data-session="${id}"]`)!).getPropertyValue("--accent").trim(), asking.id)) === "#3e63dd", 5000);
    const stageInk = await page.evaluate((id) => getComputedStyle(document.querySelector(`.flow-block[data-session="${id}"]`)!).getPropertyValue("--accent").trim(), asking.id);
    await shot(`14-${provider}-flow-by-stage.png`);
    await page.locator(".home-modes .view-tool", { hasText: "거르기" }).click();
    await page.locator(".view-filter").fill(drop);
    await until(async () => (await page.locator(`.flow-col[data-work="${target.id}"]`).count()) === 0, 5000);
    const filteredOut = await page.locator(`.flow-col[data-work="${target.id}"]`).count();
    await page.locator(".view-filter").fill(keep);
    await until(async () => (await page.locator(`.flow-col[data-work="${target.id}"]`).count()) === 1, 5000);
    const filteredIn = await page.locator(`.flow-col[data-work="${target.id}"]`).count();
    await page.locator(".view-filter").fill("");
    await tool(page, "색 기준");
    await pick(page, "엔진");
    await closePop(page);
    pass(`흐름: 오늘 이 엔진의 턴 — 색 기준 '단계'면 진행중의 파랑, 거르기 ${drop}면 빠지고 ${keep}면 남음`, stageInk === "#3e63dd" && engineInk !== stageInk && filteredOut === 0 && filteredIn === 1, `엔진 ${engineInk} → 단계 ${stageInk} · ${drop} ${filteredOut} · ${keep} ${filteredIn}`);
  }

  // ── keys 1–4 still switch modes; the flow and docs views do not take them ────────────────
  await blur(page);
  await page.keyboard.press("2");
  await page.waitForSelector(".home-modes.mode-projects");
  await page.keyboard.press("4");
  const keysOk = await page.waitForSelector(".home-modes.mode-docs", { timeout: 3000 }).then(() => true, () => false);
  check("숫자 키 2 → 프로젝트, 4 → 문서(입력창 밖)", keysOk);
  await page.close();

  // ── dark: the colours of groups stay readable ─────────────────────────────────────────────
  const dark = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: "dark" });
  watch(dark, "dark");
  await dark.goto(`${ready.url}/?token=${ready.token}`);
  await dark.waitForSelector(".topbar .brand, .home-modes", { timeout: 20_000 });
  await home(dark, "프로젝트");
  await view(dark, "마감 × 중요도");
  await dark.waitForSelector(".group-board.lanes .kanban-lane");
  await dark.waitForTimeout(300);
  await dark.screenshot({ path: join(outDir, "15-dark-due.png") });
  const darkLook = await dark.evaluate(() => {
    // Any CSS colour (rgb(), color(srgb …), oklab(…) from color-mix) as drawn, then its brightness.
    const canvas = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    const luminance = (color: string) => {
      canvas.clearRect(0, 0, 1, 1);
      canvas.fillStyle = color;
      canvas.fillRect(0, 0, 1, 1);
      const [r, g, b] = canvas.getImageData(0, 0, 1, 1).data;
      return (0.2126 * r! + 0.7152 * g! + 0.0722 * b!) / 255;
    };
    const card = document.querySelector(".group-board .kanban-card")!;
    const heading = document.querySelector('.group-board .kanban-column-head.has-color .group-label')!;
    return { card: luminance(getComputedStyle(card).backgroundColor), title: luminance(getComputedStyle(card.querySelector(".kanban-card-title")!).color), heading: luminance(getComputedStyle(heading).color) };
  });
  check("다크: 카드는 어두운 면, 제목과 강조한 묶음 머리는 밝게", darkLook.card < 0.25 && darkLook.title > 0.6 && darkLook.heading > 0.35, JSON.stringify(darkLook));
  await dark.close();

  // ── 300 projects on a board: render and drag frame times ──────────────────────────────────
  const created = Date.now();
  const many: Work[] = [];
  const IMPORTANCE = ["높음", "보통", "낮음"];
  const STAGES = ["할일", "진행중", "완료", "보류"];
  for (let batch = 0; batch < 30; batch += 1) {
    many.push(
      ...(await Promise.all(
        Array.from({ length: 10 }, async (_, at) => {
          const n = batch * 10 + at;
          const cwd = join(worksDir, `many-${n}`);
          mkdirSync(cwd, { recursive: true });
          const work = await api<Work>("POST", "/api/works", { title: `과제 ${String(n).padStart(3, "0")}`, cwd });
          await api("PUT", `/api/projects/${work.id}/stage`, { stage: STAGES[n % 4] });
          await api("PUT", `/api/projects/${work.id}/property`, { key: "중요도", values: [IMPORTANCE[n % 3]], type: "text" });
          await api("PUT", `/api/projects/${work.id}/property`, { key: "마감일", values: [dayAfter((n % 60) - 10)], type: "date" });
          return work;
        }),
      )),
    );
  }
  numbers.push(`프로젝트 300개 만들기 ${Math.round((Date.now() - created) / 1000)}초`);
  const big = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  watch(big, "300");
  await big.goto(`${ready.url}/?token=${ready.token}`);
  await big.waitForSelector(".topbar .brand, .home-modes", { timeout: 20_000 });
  await home(big, "프로젝트");
  await view(big, "단계");
  const shown = await big.waitForFunction(() => document.querySelectorAll(".group-board .kanban-card").length >= 300, undefined, { timeout: 20_000 }).then(() => true, () => false);
  // Switching views back and forth: until the next painted frame.
  const switches: number[] = [];
  for (const name of ["마감 × 중요도", "단계", "마감 × 중요도", "단계"]) {
    switches.push(
      await big.evaluate(async (name) => {
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>(".home-modes .view-tab")).find((entry) => entry.textContent === name)!;
        const start = performance.now();
        button.click();
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        return Math.round(performance.now() - start);
      }, name),
    );
  }
  await big.waitForTimeout(400);
  const cards = await big.locator(".group-board .kanban-card").count();
  await big.screenshot({ path: join(outDir, "16-300-board.png") });
  // A card dragged across the board with a pointer event each frame.
  const frames = await big.evaluate(async () => {
    const card = document.querySelector<HTMLElement>('.kanban-column[data-stage-column="할일"] .kanban-card')!;
    const box = card.getBoundingClientRect();
    const fire = (type: string, x: number, y: number, target: EventTarget) =>
      target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: "mouse", button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: y }));
    fire("pointerdown", box.left + 20, box.top + 10, card);
    const times: number[] = [];
    await new Promise<void>((done) => {
      let last = 0;
      let step = 0;
      const tick = (now: number) => {
        if (last) times.push(now - last);
        last = now;
        step += 1;
        fire("pointermove", box.left + 20 + step * 6, box.top + 10 + Math.sin(step / 9) * 60, window);
        if (step < 150) requestAnimationFrame(tick);
        else done();
      };
      requestAnimationFrame(tick);
    });
    fire("pointercancel", box.left, box.top, window);
    return times;
  });
  const sorted = [...frames].sort((a, b) => a - b);
  const stats = { frames: sorted.length, mean: Math.round((sorted.reduce((sum, value) => sum + value, 0) / sorted.length) * 10) / 10, p95: Math.round(sorted[Math.floor(sorted.length * 0.95)]! * 10) / 10, max: Math.round(sorted.at(-1)! * 10) / 10 };
  numbers.push(`300개 보드: 보기 바꾸기 ${switches.join("·")}ms(다음 그린 프레임까지), 끄는 동안 프레임 평균 ${stats.mean}ms · p95 ${stats.p95}ms · 최대 ${stats.max}ms`);
  check("프로젝트 300개: 단계 보드에 모두, 보기 바꾸기 400ms 안, 끄는 동안 p95 25ms 미만", shown && cards >= 300 && Math.max(...switches) < 400 && stats.p95 < 25, `${cards}장 · 바꾸기 ${switches.join(",")}ms · ${JSON.stringify(stats)}`);
  await big.close();
} catch (error) {
  check("실행", false, error instanceof Error ? error.message.split("\n")[0]! : String(error));
} finally {
  await browser.close();
  child.kill();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(worksDir, { recursive: true, force: true });
  writeFileSync(join(outDir, "results.json"), JSON.stringify({ results, numbers, logs }, null, 2));
  for (const line of numbers) console.log(`· ${line}`);
  const failed = results.filter((result) => !result.ok).length;
  console.log(`${results.length - failed}/${results.length} passed · console: ${logs.length ? logs.slice(0, 6).join(" | ") : "clean"}`);
  process.exit(failed ? 1 : 0);
}
