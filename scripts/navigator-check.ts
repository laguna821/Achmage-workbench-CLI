/// <reference lib="dom" />
// Browser check of the sidebar as a two-pane navigator (design: 프로젝트-내비게이터-그룹보기-설계 §2),
// against a real gateway driving the stand-in engines (no model) with a fixture vault in a temporary
// folder. For Codex and for Claude: the app opens ready for a new session with the navigator in two
// panes; project folders are made, nested, renamed (F2, double-click), coloured and given an icon;
// "+" in a folder's list starts a project there with that engine; projects outside folders, "하위
// 포함"; one and several projects dragged into folders and out again; shortcuts seeded from pinned
// works, added by dragging and from menus, renamed, reordered and removed; sorting, a folder's own
// sort, group heads by date and by folder; the filter box; keyboard (↑↓ Enter ←→ F2 Delete) and
// Ctrl+Shift+E; a project unfolded to its sessions; pin, stage and tags from menus; folders deleted
// both ways. Then once: the three layouts, widths and heights remembered, sections folded across a
// reload, 300 projects, the dark theme.
// Usage: node scripts/navigator-check.ts [outDir] [codex|claude]

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Locator, type Page } from "playwright-core";
import type { Folder, NavShortcut, Provider, Session, UiPrefs, Work } from "@workbench/contracts";
import { makePkmVault } from "./fixtures/pkm-vault.ts";

const outDir = process.argv[2] ?? join(tmpdir(), "wb-navigator");
// A third argument runs one engine's steps ("codex", "claude") or only the shared ones ("layout").
const providers: Provider[] = process.argv[3] === "codex" || process.argv[3] === "claude" ? [process.argv[3]] : process.argv[3] === "layout" ? [] : ["codex", "claude"];
mkdirSync(outDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "workbench-navigator-"));
const worksDir = mkdtempSync(join(tmpdir(), "workbench-navigator-works-"));
const vaultDir = mkdtempSync(join(tmpdir(), "workbench-navigator-vault-"));
makePkmVault(vaultDir);
const results: { step: string; ok: boolean; detail: string }[] = [];
const check = (step: string, ok: boolean, detail = "") => {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`);
};

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
  return (await response.json()) as T;
};
const snapshot = () => api<{ works: Work[]; sessions: Session[]; folders: Folder[]; prefs: UiPrefs }>("GET", "/api/snapshot");
const workOf = async (id: string) => (await snapshot()).works.find((entry) => entry.id === id);
const folderOf = async (id: string) => (await snapshot()).folders.find((entry) => entry.id === id);
const prefsNow = async () => (await snapshot()).prefs;
const navPrefs = async () => ((await prefsNow()).navigator ?? {}) as Record<string, unknown>;
const until = async (what: () => Promise<boolean>, timeout = 10_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await what()) return true;
    await new Promise((done) => setTimeout(done, 100));
  }
  return false;
};
const BASE_PREFS = { onboarding: "done", startScreen: "last" };
let workSeq = 0;
const makeWork = async (title: string, folderId: string | null = null) => {
  const cwd = join(worksDir, `w${(workSeq += 1)}`);
  mkdirSync(cwd, { recursive: true });
  const made = await api<Work>("POST", "/api/works", { title, folderId, cwd });
  // Named by hand, so automatic titles leave it alone.
  return api<Work>("PATCH", `/api/works/${made.id}`, { title });
};
await api("PUT", "/api/prefs", { prefs: BASE_PREFS });
await api("PUT", "/api/pkm/vault", { path: vaultDir });

const browser = await chromium.launch();
const logs: string[] = [];
const watch = (page: Page, label: string) => {
  page.on("console", (message) => message.type() === "error" && logs.push(`[${label} error] ${message.text().slice(0, 200)}`));
  page.on("pageerror", (error) => logs.push(`[${label} pageerror] ${error.message.slice(0, 200)}`));
};

// Rows and places of the navigator.
const navRow = (page: Page, id: string) => page.locator(`.nav-folder-tree [data-row-id="${id}"]`);
const listRow = (page: Page, id: string) => page.locator(`.list-rows [data-row-id="${id}"]`);
const listTitles = (page: Page) => page.locator(".list-rows .nav-project .nav-project-title").allInnerTexts();
const groupHeads = (page: Page) => page.locator(".list-rows .list-group > span:first-of-type").allInnerTexts();

/** A pointer drag as a person makes it: press, a small move, then over to the target. */
async function drag(page: Page, from: Locator, to: Locator, at: "middle" | "top" | "bottom" = "middle", before?: () => Promise<void>) {
  await from.scrollIntoViewIfNeeded();
  const source = (await from.boundingBox())!;
  await page.mouse.move(source.x + Math.min(40, source.width / 2), source.y + Math.min(14, source.height / 2));
  await page.mouse.down();
  await page.mouse.move(source.x + 50, source.y + 22, { steps: 4 });
  await to.scrollIntoViewIfNeeded().catch(() => undefined);
  const target = (await to.boundingBox())!;
  const y = at === "top" ? target.y + 3 : at === "bottom" ? target.y + target.height - 3 : target.y + target.height / 2;
  await page.mouse.move(target.x + Math.min(60, target.width / 2), y, { steps: 10 });
  await page.waitForTimeout(80);
  await before?.();
  await page.mouse.up();
  await page.waitForTimeout(300);
}

async function menuItem(page: Page, label: string | RegExp) {
  await page.locator(".context-menu [role=menuitem]", { hasText: label }).first().click();
}

async function flow(provider: Provider) {
  const label = provider === "codex" ? "Codex" : "Claude";
  const pass = (step: string, ok: boolean, detail = "") => check(`[${label}] ${step}`, ok, detail);
  // Each engine starts from the screen preferences of a first launch (no shortcuts yet).
  await api("PUT", "/api/prefs", { prefs: BASE_PREFS });
  const pinned = await makeWork(`${label} 고정해 둔 작업`);
  await api("PATCH", `/api/works/${pinned.id}`, { pinned: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  watch(page, label);
  const shot = (name: string) => page.screenshot({ path: join(outDir, `${provider}-${name}`) });
  try {
    await page.goto(`${ready.url}/?token=${ready.token}`);
    await page.waitForSelector(".start-view .composer-input");
    await page.waitForSelector(".sidebar .list-pane");
    await page.waitForTimeout(600);

    // ── opens ready for a new session, the navigator in two panes, pins seeded as shortcuts ──
    const navBox = (await page.locator(".nav-pane").boundingBox())!;
    const listBox = (await page.locator(".list-pane").boundingBox())!;
    const focused = await page.evaluate(() => document.activeElement?.classList.contains("composer-input") ?? false);
    const seededRow = await page.locator(".nav-shortcuts [data-shortcut-kind='work']", { hasText: pinned.title }).count();
    const seeded = ((await prefsNow()).navShortcuts as NavShortcut[] | undefined) ?? [];
    await shot("01-open.png");
    pass(
      "앱은 새 세션을 바로 쓸 수 있게 열리고(입력창에 초점), 사이드바는 두 칸(탐색 | 목록), 고정했던 작업이 바로가기에 한 번 옮겨짐",
      focused && (await page.locator(".sidebar.nav-dual").count()) === 1 && navBox.x + navBox.width <= listBox.x + 1 && seededRow === 1 && seeded.some((entry) => entry.kind === "work" && entry.id === pinned.id) && (await workOf(pinned.id))?.pinned === true,
      `nav ${Math.round(navBox.width)}px | list ${Math.round(listBox.width)}px · 바로가기 ${seeded.length}`,
    );

    // ── project folders: make, nest, rename, colour and icon ─────────────────────────────────
    const folderName = `${label} 강의`;
    await page.locator(".nav-projects .nav-section-head").hover();
    await page.locator('.nav-projects .side-tools button[title="새 폴더"]').click();
    await page.locator(".nav-folder-tree .creating input").fill(folderName);
    await page.locator(".nav-folder-tree .creating input").press("Enter");
    await until(async () => (await snapshot()).folders.some((folder) => folder.name === folderName));
    const top = (await snapshot()).folders.find((folder) => folder.name === folderName)!;
    await navRow(page, top.id).click({ button: "right" });
    await menuItem(page, "하위 폴더 만들기");
    await page.locator(".nav-folder-tree .creating input").fill("2026-1");
    await page.locator(".nav-folder-tree .creating input").press("Enter");
    await until(async () => (await snapshot()).folders.some((folder) => folder.parentId === top.id));
    const sub = (await snapshot()).folders.find((folder) => folder.parentId === top.id)!;
    await navRow(page, sub.id).waitFor();
    const level = await navRow(page, sub.id).getAttribute("aria-level");
    // F2, then a double-click.
    await navRow(page, sub.id).focus();
    await page.keyboard.press("F2");
    await page.locator(".nav-folder-tree .side-rename").fill("2026-2");
    await page.keyboard.press("Enter");
    const renamedF2 = await until(async () => (await folderOf(sub.id))?.name === "2026-2");
    await navRow(page, top.id).dblclick();
    await page.locator(".nav-folder-tree .side-rename").fill(`${label} 강의실`);
    await page.keyboard.press("Enter");
    const renamedTwice = await until(async () => (await folderOf(top.id))?.name === `${label} 강의실`);
    pass("폴더 만들기(섹션 +)·하위 폴더(오른쪽 클릭)·이름 바꾸기(F2, 두 번 누르기)", level === "3" && renamedF2 && renamedTwice, `aria-level ${level}`);

    await navRow(page, top.id).click({ button: "right" });
    await menuItem(page, "색·아이콘…");
    await page.waitForSelector(".folder-style");
    await page.locator(".folder-style .folder-swatch:not(.none)").nth(1).click();
    await page.locator('.folder-style [aria-label="아이콘 book"]').click();
    const styled = await until(async () => {
      const folder = await folderOf(top.id);
      return Boolean(folder?.color && folder.icon === "book");
    });
    await page.waitForTimeout(200);
    await page.locator(".folder-style").screenshot({ path: join(outDir, `${provider}-02-folder-style.png`) });
    await page.keyboard.press("Escape");
    const colored = await navRow(page, top.id).evaluate((element) => element.classList.contains("colored") && getComputedStyle(element.querySelector(".nav-folder-icon")!).color);
    pass("우클릭 '색·아이콘…': 단계 색 팔레트에서 색, 앱 아이콘에서 아이콘(폴더 줄에 바로 보임)", styled && Boolean(colored), `${(await folderOf(top.id))?.color} · ${colored}`);

    // ── "+" in a folder's list: a new project there, with this engine ────────────────────────
    await navRow(page, top.id).click();
    await page.waitForFunction((name) => document.querySelector(".list-head .list-name")?.textContent === name, `${label} 강의실`);
    await page.locator('.list-tools [aria-label="새 프로젝트"]').click();
    await page.waitForSelector(".start-view .start-folder");
    const folderHint = await page.locator(".start-folder").innerText();
    await page.locator(".engine-tab", { hasText: label }).click();
    const before = (await snapshot()).works.length;
    await page.locator(".composer-input").fill(`${label} 폴더에서 시작한 요청`);
    await page.locator(".composer-input").press("Enter");
    await until(async () => (await snapshot()).works.length === before + 1);
    const started = (await snapshot()).works.sort((a, b) => b.createdAt - a.createdAt)[0]!;
    await until(async () => (await snapshot()).sessions.some((session) => session.workId === started.id && session.previewAt !== null), 20_000);
    const session = (await snapshot()).sessions.find((entry) => entry.workId === started.id)!;
    await listRow(page, started.id).waitFor({ timeout: 8000 });
    await page.waitForTimeout(300);
    await shot("03-new-in-folder.png");
    pass(
      "목록 머리의 + = 그 폴더에 새 프로젝트: 이 엔진으로 보낸 요청이 폴더 안 프로젝트가 되고 목록에 바로 보임",
      folderHint.includes(`${label} 강의실`) && started.folderId === top.id && session.provider === provider && (await listRow(page, started.id).locator(".side-row-engine").count()) === 1,
      `${folderHint} · ${session.provider}`,
    );

    // ── projects outside folders: the "프로젝트" row, with and without 하위 포함 ───────────
    const loose = await makeWork(`${label} 폴더 밖 메모`);
    await navRow(page, "nav:root").click();
    await listRow(page, loose.id).waitFor();
    const withSub = await listRow(page, started.id).count();
    await page.locator('.list-tools [aria-label="하위 포함"]').click();
    await page.waitForTimeout(250);
    const own = { loose: await listRow(page, loose.id).count(), inFolder: await listRow(page, started.id).count() };
    await page.locator(".list-pane").screenshot({ path: join(outDir, `${provider}-04-root-own.png`) });
    await page.locator('.list-tools [aria-label="하위 포함"]').click();
    await listRow(page, started.id).waitFor();
    pass("'프로젝트' 줄 = 폴더 밖 프로젝트, '하위 포함'을 켜면 모든 프로젝트", withSub === 1 && own.loose === 1 && own.inFolder === 0, JSON.stringify(own));

    // ── drag one project into a folder, and out again onto "프로젝트" ────────────────────────
    await drag(page, listRow(page, loose.id), navRow(page, sub.id));
    const into = await until(async () => (await workOf(loose.id))?.folderId === sub.id);
    await drag(page, listRow(page, loose.id), navRow(page, "nav:root"), "middle", () => page.locator(".list-pane").screenshot({ path: join(outDir, `${provider}-05-drag-out.png`) }).then(() => undefined));
    const out = await until(async () => (await workOf(loose.id))?.folderId === null);
    pass("프로젝트를 폴더에 끌어 놓으면 옮겨지고, '프로젝트' 줄에 놓으면 폴더 밖으로", into && out);

    // ── several at once: Ctrl+click two, drag them together ─────────────────────────────────
    const two = [await makeWork(`${label} 함께 옮길 하나`), await makeWork(`${label} 함께 옮길 둘`)];
    await listRow(page, two[1]!.id).waitFor();
    await listRow(page, two[0]!.id).click({ modifiers: ["Control"] });
    await listRow(page, two[1]!.id).click({ modifiers: ["Control"] });
    const picked = await page.locator(".list-rows .nav-project.selected").count();
    await drag(page, listRow(page, two[0]!.id), navRow(page, sub.id), "middle", async () => {
      await shot("06-drag-many.png");
    });
    const both = await until(async () => (await Promise.all(two.map((work) => workOf(work.id)))).every((work) => work?.folderId === sub.id));
    const toast = await page.locator(".toast").innerText().catch(() => "");
    pass("Ctrl+클릭으로 여럿 골라 함께 끌어 폴더로(알림 '프로젝트 2개를 …')", picked === 2 && both && toast.includes("프로젝트 2개"), `골라진 ${picked} · ${toast.split("\n")[0]}`);

    // ── shortcuts: drag a project in, a folder from its menu, rename, reorder, remove ────────
    await drag(page, listRow(page, loose.id), page.locator(".nav-shortcuts"));
    const dragged = await until(async () => (((await prefsNow()).navShortcuts as NavShortcut[]) ?? []).some((entry) => entry.kind === "work" && entry.id === loose.id));
    await navRow(page, top.id).click({ button: "right" });
    await menuItem(page, "바로가기에 더하기");
    const added = await until(async () => (((await prefsNow()).navShortcuts as NavShortcut[]) ?? []).some((entry) => entry.kind === "folder" && entry.id === top.id));
    const folderShortcut = page.locator(".nav-shortcuts [data-shortcut-kind='folder']");
    await folderShortcut.click({ button: "right" });
    await menuItem(page, "이름표 바꾸기");
    await page.locator(".nav-shortcuts .side-rename").fill("내 강의");
    await page.keyboard.press("Enter");
    const relabeled = await until(async () => (((await prefsNow()).navShortcuts as NavShortcut[]) ?? []).some((entry) => entry.kind === "folder" && entry.label === "내 강의"));
    const folderStill = (await folderOf(top.id))?.name === `${label} 강의실`;
    // The folder shortcut (last) dragged above the first one.
    const firstShortcut = page.locator(".nav-shortcuts [data-shortcut-index]").first();
    await drag(page, page.locator(".nav-shortcuts [data-shortcut-kind='folder']"), firstShortcut, "top");
    const reordered = await until(async () => (((await prefsNow()).navShortcuts as NavShortcut[]) ?? [])[0]?.kind === "folder");
    await page.locator(".nav-shortcuts").screenshot({ path: join(outDir, `${provider}-07-shortcuts.png`) });
    // Clicking it selects the folder; the ✕ on hover takes it away.
    await page.locator(".nav-shortcuts [data-shortcut-kind='folder']").click();
    const selectedByShortcut = (await page.locator(".list-head .list-name").innerText()) === `${label} 강의실`;
    const workShortcut = page.locator(`.nav-shortcuts [data-shortcut-kind='work']`, { hasText: loose.title });
    await workShortcut.hover();
    await workShortcut.locator(".nav-shortcut-remove").click();
    const removed = await until(async () => !(((await prefsNow()).navShortcuts as NavShortcut[]) ?? []).some((entry) => entry.kind === "work" && entry.id === loose.id));
    pass(
      "바로가기: 프로젝트를 끌어 더하기 · 폴더 메뉴로 더하기 · 이름표만 바꾸기(원래 이름 그대로) · 끌어서 순서 · 누르면 폴더 선택 · ✕로 빼기",
      dragged && added && relabeled && folderStill && reordered && selectedByShortcut && removed,
      JSON.stringify({ dragged, added, relabeled, folderStill, reordered, selectedByShortcut, removed }),
    );

    // ── sorting: by name at the root, a folder keeps its own ─────────────────────────────────
    await navRow(page, "nav:root").click();
    await page.locator('.list-tools [aria-label="정렬과 줄 모양"]').click();
    await menuItem(page, /^이름$/);
    await page.waitForTimeout(300);
    const byName = (await listTitles(page)).filter((title) => title.startsWith(label));
    const sorted = [...byName].sort((a, b) => a.localeCompare(b, "ko"));
    const rootSort = (await navPrefs()).sortByFolder as Record<string, { key: string }> | undefined;
    await navRow(page, sub.id).click();
    const folderSortTitle = await page.locator('.list-tools [aria-label="정렬과 줄 모양"]').getAttribute("title");
    await page.locator('.list-tools [aria-label="정렬과 줄 모양"]').click();
    await menuItem(page, "만든 날");
    const ownSort = await until(async () => ((await navPrefs()).sortByFolder as Record<string, { key: string }> | undefined)?.[sub.id]?.key === "created");
    pass(
      "정렬: '프로젝트'에서 이름순(이 목록만), 폴더는 자기 정렬(기본 최근 활동 → 만든 날)",
      JSON.stringify(byName) === JSON.stringify(sorted) && rootSort?.root?.key === "name" && (folderSortTitle ?? "").includes("최근 활동") && ownSort,
      `${byName.length}개 · 폴더 버튼 "${folderSortTitle}"`,
    );

    // ── 하위 포함 groups: by date, then by folder ──────────────────────────────────────────
    await navRow(page, top.id).click();
    const dateHeads = await groupHeads(page);
    await page.locator('.list-tools [aria-label="정렬과 줄 모양"]').click();
    await page.locator(".context-menu [role=menuitem]", { hasText: "묶기" }).hover();
    await page.locator(".context-menu").nth(1).locator("[role=menuitem]", { hasText: "폴더별" }).click();
    await page.waitForTimeout(300);
    const folderHeads = await groupHeads(page);
    await shot("08-group-by-folder.png");
    await page.locator('.list-tools [aria-label="정렬과 줄 모양"]').click();
    await page.locator(".context-menu [role=menuitem]", { hasText: "묶기" }).hover();
    await page.locator(".context-menu").nth(1).locator("[role=menuitem]", { hasText: "날짜별" }).click();
    pass("'하위 포함' 목록의 묶음 머리: 날짜별(오늘…) 또는 폴더별(이 폴더 · 하위 폴더)", dateHeads.includes("오늘") && folderHeads.includes(`${label} 강의실`) && folderHeads.includes("2026-2"), `${dateHeads.join("·")} / ${folderHeads.join("·")}`);

    // ── the filter box (the shared project query) ───────────────────────────────────────────
    await navRow(page, "nav:root").click();
    await page.locator('.list-tools [aria-label="거르기"]').click();
    await page.locator(".list-filter input").fill(`함께 옮길 폴더:2026-2`);
    await page.waitForTimeout(300);
    const filtered = (await listTitles(page)).filter((title) => title.startsWith(label));
    await page.locator(".list-pane").screenshot({ path: join(outDir, `${provider}-09-filter.png`) });
    await page.locator(".list-filter input").press("Escape");
    await page.waitForTimeout(200);
    const cleared = (await page.locator(".list-filter").count()) === 0 && (await listTitles(page)).length > filtered.length;
    pass("거르기 칸: 공용 질의(낱말 · 폴더:이름)로 좁히고 Esc로 지움", filtered.length === 2 && filtered.every((title) => title.includes("함께 옮길")) && cleared, filtered.join(", "));

    // ── a project unfolds to its sessions; pin, stage, tags from the menu ─────────────────────
    const second = await api<Session>("POST", `/api/works/${started.id}/sessions`, { provider, purpose: "둘째 세션" });
    await listRow(page, started.id).waitFor();
    await page.waitForFunction((id) => document.querySelector(`.list-rows [data-row-id="${id}"]`)?.getAttribute("aria-expanded") !== null, started.id);
    if ((await listRow(page, started.id).getAttribute("aria-expanded")) === "false") await listRow(page, started.id).locator(".row-chevron").click();
    await page.locator(`.side-tree [data-row-id="${second.id}"]`).click();
    await page.waitForFunction((purpose) => document.querySelector(".session-tabs .session-tab.active")?.textContent?.includes(purpose), "둘째 세션", { timeout: 8000 });
    const sessionRows = await page.locator(`.list-rows .row-session`).count();
    pass("프로젝트 줄의 ▸로 세션들(지금 트리의 줄, data-row-id)을 펼치고 누르면 그 세션", sessionRows >= 2);
    // A session's "고정" keeps it in 바로가기 (where the old "고정" section showed pinned sessions).
    await page.locator(`.side-tree [data-row-id="${second.id}"]`).click({ button: "right" });
    await page.locator(".context-menu [role=menuitem]", { hasText: "고정" }).first().click();
    const sessionKept = await until(async () => (((await prefsNow()).navShortcuts as NavShortcut[]) ?? []).some((entry) => entry.kind === "session" && entry.id === second.id) && (await snapshot()).sessions.find((entry) => entry.id === second.id)?.pinned === true);
    const sessionRow = await page.locator(`.nav-shortcuts [data-shortcut-kind='session'][data-shortcut-id="${second.id}"]`, { hasText: "둘째 세션" }).count();
    pass("세션 메뉴의 '고정'은 바로가기에 둠(예전 '고정' 칸 자리, pinned도 함께)", sessionKept && sessionRow === 1);

    await listRow(page, started.id).click({ button: "right" });
    await menuItem(page, /^고정$/);
    await until(async () => (await workOf(started.id))?.pinned === true);
    await listRow(page, started.id).click({ button: "right" });
    await page.locator(".context-menu [role=menuitem]", { hasText: "단계" }).first().hover();
    await page.locator(".context-menu").nth(1).locator("[role=menuitem]", { hasText: "진행중" }).click();
    await listRow(page, started.id).locator(".stage-stamp", { hasText: "진행중" }).waitFor({ timeout: 8000 });
    await listRow(page, started.id).click({ button: "right" });
    await menuItem(page, "태그 더하기…");
    await page.locator(".tag-prompt input").fill(`수업/${label.toLowerCase()}`);
    await page.locator(".tag-prompt input").press("Enter");
    await page.locator(".nav-tags [data-tag='수업']").waitFor({ timeout: 8000 });
    const pinnedHead = (await groupHeads(page))[0];
    await page.locator(".nav-tags [data-tag='수업']").click();
    await page.waitForTimeout(250);
    const tagList = (await listTitles(page)).filter((title) => title.startsWith(label));
    await shot("10-pin-stage-tag.png");
    pass(
      "메뉴로 고정(목록 맨 위 '고정') · 단계(색 날인) · 태그 더하기(태그 칸에 생기고 고르면 그 프로젝트)",
      pinnedHead === "고정" && tagList.length === 1 && tagList[0] === (await workOf(started.id))?.title && (await page.locator(".nav-tags .nav-untagged").count()) === 1,
      `${pinnedHead} · #수업 → ${tagList.join(", ")}`,
    );

    // ── keyboard: Ctrl+Shift+E, ↑↓, Enter, ←→, F2, Delete ────────────────────────────────────
    await navRow(page, sub.id).click();
    await page.locator(".composer-input, .start-view").first().click({ position: { x: 5, y: 5 } }).catch(() => undefined);
    await page.keyboard.press("Control+Shift+E");
    const inList = await until(async () => page.evaluate(() => Boolean(document.activeElement?.closest(".list-rows"))), 3000);
    const firstId = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.rowId ?? "");
    await page.keyboard.press("ArrowDown");
    const secondId = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.rowId ?? "");
    await page.keyboard.press("Enter");
    const opened = await until(async () => (await page.locator(".topbar-title").innerText()).includes((await workOf(secondId))?.title ?? "?"), 5000);
    // Opening a project gives its input the focus (as a click does); the keys below start from the list again.
    await page.waitForTimeout(700);
    await listRow(page, secondId).focus();
    await page.keyboard.press("ArrowLeft");
    const inNav = await page.evaluate(() => Boolean(document.activeElement?.closest(".nav-pane")));
    await page.keyboard.press("ArrowRight");
    const back = await until(() => page.evaluate(() => Boolean(document.activeElement?.closest(".list-rows"))), 2000);
    await listRow(page, firstId).focus();
    await page.keyboard.press("F2");
    await page.locator(".list-rows .side-rename").fill(`${label} 키보드로 바꾼 이름`);
    await page.keyboard.press("Enter");
    const renamed = await until(async () => (await workOf(firstId))?.title === `${label} 키보드로 바꾼 이름`);
    await listRow(page, firstId).focus();
    await page.keyboard.press("Delete");
    const archived = await until(async () => Boolean((await workOf(firstId))?.archivedAt));
    await page.locator(".toast button", { hasText: "되돌리기" }).click();
    const restored = await until(async () => !(await workOf(firstId))?.archivedAt);
    pass(
      "키보드: Ctrl+Shift+E로 목록에 초점 · ↓ · Enter로 열기 · ←/→로 칸 사이 · F2 이름 · Delete 보관(되돌리기)",
      inList && firstId !== secondId && opened && inNav && back && renamed && archived && restored,
      JSON.stringify({ inList, opened, inNav, back, renamed, archived, restored }),
    );

    // ── deleting folders: empty at once; with contents "폴더만 지우기" or "보관" ─────────────
    const empty = await api<Folder>("POST", "/api/folders", { name: `${label} 빈 폴더`, parentId: null });
    await navRow(page, empty.id).waitFor();
    await navRow(page, empty.id).click({ button: "right" });
    await menuItem(page, "지우기…");
    const emptyGone = await until(async () => !(await folderOf(empty.id)));
    const keepParent = await api<Folder>("POST", "/api/folders", { name: `${label} 지울 폴더`, parentId: null });
    const keepChild = await api<Folder>("POST", "/api/folders", { name: "안쪽 폴더", parentId: keepParent.id });
    const keepWork = await makeWork(`${label} 지울 폴더 안 프로젝트`, keepParent.id);
    await navRow(page, keepParent.id).waitFor();
    await navRow(page, keepParent.id).click({ button: "right" });
    await menuItem(page, "지우기…");
    await page.waitForSelector(".nav-dialog");
    await page.waitForTimeout(150);
    await shot("11-delete-dialog.png");
    await page.locator(".nav-choice", { hasText: "폴더만 지우기" }).click();
    const lifted = await until(async () => !(await folderOf(keepParent.id)) && (await workOf(keepWork.id))?.folderId === null && (await folderOf(keepChild.id))?.parentId === null);
    const archParent = await api<Folder>("POST", "/api/folders", { name: `${label} 보관할 폴더`, parentId: null });
    const archWork = await makeWork(`${label} 보관할 폴더 안 프로젝트`, archParent.id);
    await navRow(page, archParent.id).waitFor();
    await navRow(page, archParent.id).click({ button: "right" });
    await menuItem(page, "지우기…");
    await page.locator(".nav-choice", { hasText: "보관" }).click();
    const archivedFolder = await until(async () => Boolean((await folderOf(archParent.id))?.archivedAt) && !(await workOf(archWork.id))?.archivedAt);
    const gone = await until(async () => (await navRow(page, archParent.id).count()) === 0 && (await listRow(page, archWork.id).count()) === 0, 4000);
    pass("폴더 지우기: 빈 폴더는 바로 · 내용이 있으면 '폴더만 지우기'(안의 것은 위로) 또는 '보관'(함께)", emptyGone && lifted && archivedFolder && gone, JSON.stringify({ emptyGone, lifted, archivedFolder, gone }));

    // ── folders nest by dragging (onto the middle), and come back to the top on "프로젝트" ────
    const moving = await api<Folder>("POST", "/api/folders", { name: `${label} 옮길 폴더`, parentId: null });
    const host = await api<Folder>("POST", "/api/folders", { name: `${label} 받을 폴더`, parentId: null });
    await navRow(page, host.id).waitFor();
    await drag(page, navRow(page, moving.id), navRow(page, host.id), "middle");
    const nested = await until(async () => (await folderOf(moving.id))?.parentId === host.id);
    await navRow(page, moving.id).waitFor();
    const nestedLevel = await navRow(page, moving.id).getAttribute("aria-level");
    await drag(page, navRow(page, moving.id), navRow(page, "nav:root"), "middle");
    const backTop = await until(async () => (await folderOf(moving.id))?.parentId === null);
    pass("폴더를 다른 폴더 가운데에 끌어 놓으면 그 안으로(중첩), '프로젝트' 줄에 놓으면 맨 위로", nested && nestedLevel === "3" && backTop, `aria-level ${nestedLevel}`);
    await shot("12-end.png");
  } catch (error) {
    pass("실행", false, error instanceof Error ? error.message.split("\n")[0]! : String(error));
    await shot("failure.png").catch(() => undefined);
  } finally {
    await page.close();
  }
}

/** Once: layouts, sizes, folding, 300 projects, the dark theme. */
async function shared() {
  const pass = (step: string, ok: boolean, detail = "") => check(`[배치] ${step}`, ok, detail);
  await api("PUT", "/api/prefs", { prefs: BASE_PREFS });
  // Its own few projects, so these steps stand alone.
  const shelf = await api<Folder>("POST", "/api/folders", { name: "배치 폴더", parentId: null });
  await makeWork("배치 프로젝트 하나", shelf.id);
  await makeWork("배치 프로젝트 둘", shelf.id);
  await makeWork("배치 폴더 밖 프로젝트");
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  watch(page, "배치");
  const shot = (name: string) => page.screenshot({ path: join(outDir, `layout-${name}`) });
  try {
    await page.goto(`${ready.url}/?token=${ready.token}`);
    await page.waitForSelector(".sidebar .list-pane");
    await page.waitForTimeout(500);

    // ── the divider and the right edge, remembered over a reload ────────────────────────────
    const divider = (await page.locator(".nav-divider").boundingBox())!;
    await page.mouse.move(divider.x + 0.5, divider.y + 300);
    await page.mouse.down();
    await page.mouse.move(divider.x + 40, divider.y + 300, { steps: 6 });
    await page.mouse.up();
    const edge = (await page.locator(".side-resize").boundingBox())!;
    await page.mouse.move(edge.x + 3, edge.y + 400);
    await page.mouse.down();
    await page.mouse.move(edge.x + 63, edge.y + 400, { steps: 6 });
    await page.mouse.up();
    const saved = await until(async () => {
      const prefs = await navPrefs();
      return prefs.navWidth === 256 && prefs.listWidth === 320;
    });
    const savedPrefs = await navPrefs();
    await page.reload();
    await page.waitForSelector(".sidebar .list-pane");
    await page.waitForTimeout(400);
    const navWidth = Math.round((await page.locator(".nav-pane").boundingBox())!.width);
    const listWidth = Math.round((await page.locator(".list-pane").boundingBox())!.width);
    pass("두 칸: 가운데 막대(나눔만 바뀜)와 오른쪽 가장자리로 너비를 바꾸고 다시 열어도 그대로", saved && navWidth === 256 && listWidth === 320, `탐색 ${navWidth}px · 목록 ${listWidth}px (${JSON.stringify({ nav: savedPrefs.navWidth, list: savedPrefs.listWidth })})`);
    await shot("01-dual.png");

    // ── stacked, then the single tree, from the head's switch ───────────────────────────────
    await page.locator(".side-head .side-layout").click();
    await menuItem(page, "위아래");
    await page.waitForSelector(".nav-body.stacked");
    const navTop = (await page.locator(".nav-pane").boundingBox())!;
    const listTop = (await page.locator(".list-pane").boundingBox())!;
    const bar = (await page.locator(".nav-divider").boundingBox())!;
    await page.mouse.move(bar.x + 100, bar.y + 0.5);
    await page.mouse.down();
    await page.mouse.move(bar.x + 100, bar.y + 60, { steps: 6 });
    await page.mouse.up();
    const height = await until(async () => Number((await navPrefs()).navHeight) > 0.42);
    await shot("02-stacked.png");
    pass("위아래: 탐색 칸 위, 목록 칸 아래, 가로 막대로 높이 조절(기억)", navTop.y + navTop.height <= listTop.y + 2 && Math.abs(navTop.x - listTop.x) < 2 && height, `높이 ${(await navPrefs()).navHeight}`);
    await page.locator(".side-head [aria-label='사이드바 메뉴']").click();
    await menuItem(page, "한 칸 (트리)");
    await page.waitForSelector(".sidebar .side-tree-section .side-tree");
    const tree = (await page.locator(".list-pane").count()) === 0 && (await page.locator(".sidebar .side-tree [data-row-id]").count()) > 3;
    await shot("03-tree.png");
    await page.locator(".side-head .side-layout").click();
    await menuItem(page, "창 너비에 맞추기");
    await page.waitForSelector(".sidebar.nav-dual");
    await page.setViewportSize({ width: 1000, height: 820 });
    const narrow = await page.waitForSelector(".sidebar.nav-stacked", { timeout: 3000 }).then(() => true).catch(() => false);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForSelector(".sidebar.nav-dual");
    pass("한 칸 = 예전 트리(폴더 › 작업 › 세션), '창 너비에 맞추기'면 넓은 창은 두 칸·좁은 창은 위아래", tree && narrow);

    // ── section heads fold and stay folded ──────────────────────────────────────────────────
    const tagged = await makeWork("태그 있는 프로젝트");
    await api("PUT", `/api/projects/${tagged.id}/property`, { key: "tags", values: ["접기"], type: "tags" });
    await page.locator(".nav-tags [data-tag='접기']").waitFor({ timeout: 8000 });
    for (const name of ["바로가기", "태그", "보기"]) await page.locator(".nav-pane .nav-fold", { hasText: name }).click();
    await page.waitForTimeout(300);
    const hidden = (await page.locator(".nav-shortcuts [data-shortcut-index], .nav-shortcuts .nav-empty").count()) === 0 && (await page.locator(".nav-tags [data-tag]").count()) === 0 && (await page.locator(".views-section .view-row").count()) === 0;
    await page.reload();
    await page.waitForSelector(".sidebar .list-pane");
    await page.waitForTimeout(400);
    const still = (await page.locator(".nav-pane .nav-fold[aria-expanded='false']").count()) === 3;
    await page.locator(".nav-pane").screenshot({ path: join(outDir, "layout-04-folded.png") });
    await page.locator(".side-head [aria-label='사이드바 메뉴']").click();
    await menuItem(page, "모든 섹션 펼치기");
    await page.waitForTimeout(300);
    const unfolded = (await page.locator(".nav-pane .nav-fold[aria-expanded='false']").count()) === 0;
    pass("섹션 머리(바로가기·태그·보기)를 접으면 한 줄, 다시 열어도 접힌 채, ⋯ › 모든 섹션 펼치기", hidden && still && unfolded);

    // ── rows: compact, or standard with up to three preview lines ───────────────────────────
    const long = await makeWork("미리보기가 긴 프로젝트");
    await api("PUT", `/api/projects/${long.id}/body`, { body: "첫 줄은 노트의 처음 말입니다. 이 노트는 미리보기 줄 수를 시험하려고 일부러 길게 썼습니다. 한 줄로는 다 보이지 않고 두 줄, 세 줄로 늘리면 더 보여야 합니다. 마지막 문장까지 이어집니다.\n", baseRevision: null });
    const row = page.locator(`.list-rows [data-row-id="${long.id}"]`);
    await row.locator(".nav-project-preview").waitFor({ timeout: 8000 });
    const lineHeight = async () => row.locator(".nav-project-preview").evaluate((element) => Math.round(element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight)));
    const oneLine = await lineHeight();
    const linesMenu = async (label: string) => {
      await page.locator('.list-tools [aria-label="정렬과 줄 모양"]').click();
      await page.locator(".context-menu [role=menuitem]", { hasText: "줄 모양" }).hover();
      await page.locator(".context-menu").nth(1).locator("[role=menuitem]", { hasText: label }).click();
      await page.waitForTimeout(250);
    };
    await linesMenu("미리보기 3줄");
    const threeLines = await lineHeight();
    await page.locator(".list-pane").screenshot({ path: join(outDir, "layout-05-preview-3.png") });
    await linesMenu("촘촘히");
    const compactHeight = Math.round((await row.boundingBox())!.height);
    const compactPreview = await row.locator(".nav-project-preview").count();
    await page.locator(".list-pane").screenshot({ path: join(outDir, "layout-06-compact.png") });
    await linesMenu("표준");
    await linesMenu("미리보기 1줄");
    pass("줄 모양: 표준(미리보기 1~3줄, 노트의 처음 말) · 촘촘히(한 줄)", oneLine === 1 && threeLines === 3 && compactHeight <= 32 && compactPreview === 0, `미리보기 ${oneLine}줄 → ${threeLines}줄 · 촘촘히 ${compactHeight}px`);

    // ── a saved view as a shortcut (from its menu) ───────────────────────────────────────────
    await page.locator(".views-section .view-row").first().click({ button: "right" });
    await menuItem(page, "바로가기에 더하기");
    const viewShortcut = page.locator(".nav-shortcuts [data-shortcut-kind='view']");
    await viewShortcut.waitFor({ timeout: 5000 });
    await viewShortcut.click();
    const viewName = (await viewShortcut.innerText()).trim();
    const viewOpened = await page.waitForFunction((name) => document.querySelector(".pkm-title")?.textContent === name, viewName, { timeout: 8000 }).then(() => true).catch(() => false);
    const viewSaved = await until(async () => (((await prefsNow()).navShortcuts as NavShortcut[]) ?? []).some((entry) => entry.kind === "view"), 4000);
    pass("저장된 보기도 바로가기에(보기 메뉴), 누르면 그 보기", viewOpened && viewSaved, `${viewName} · 열림 ${viewOpened} · 저장 ${viewSaved}`);

    // ── 300 projects ─────────────────────────────────────────────────────────────────────────
    const folders = await Promise.all(["많은 강의", "많은 연구", "많은 행정"].map((name) => api<Folder>("POST", "/api/folders", { name, parentId: null })));
    const started = Date.now();
    for (let index = 0; index < 300; index += 15) {
      await Promise.all(Array.from({ length: 15 }, (_, step) => makeWork(`많은 프로젝트 ${String(index + step + 1).padStart(3, "0")}`, step % 4 === 3 ? null : folders[(index + step) % 3]!.id)));
    }
    const seeding = Date.now() - started;
    await page.reload();
    await page.waitForSelector(".sidebar .list-pane");
    const shown = await until(async () => (await page.locator(".list-rows .nav-project").count()) >= 300, 15_000);
    const count = await page.locator(".list-rows .nav-project").count();
    const switching = await page.evaluate(async () => {
      const root = document.querySelector<HTMLElement>('.nav-folder-tree [data-row-id="nav:root"]')!;
      const folder = Array.from(document.querySelectorAll<HTMLElement>(".nav-folder-tree .nav-folder")).find((element) => element.textContent?.includes("많은 강의"))!;
      const time = async (element: HTMLElement) => {
        const start = performance.now();
        element.click();
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        return performance.now() - start;
      };
      const toFolder = await time(folder);
      const toRoot = await time(root);
      return { toFolder: Math.round(toFolder), toRoot: Math.round(toRoot) };
    });
    await page.waitForTimeout(300);
    const scroll = await page.evaluate(async () => {
      const scroller = document.querySelector<HTMLElement>(".list-scroll")!;
      const frames: number[] = [];
      let last = 0;
      await new Promise<void>((done) => {
        const tick = (now: number) => {
          if (last) frames.push(now - last);
          last = now;
          scroller.scrollTop += 60;
          if (scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 2) requestAnimationFrame(tick);
          else done();
        };
        requestAnimationFrame(tick);
      });
      frames.sort((a, b) => a - b);
      const lastRow = Array.from(document.querySelectorAll<HTMLElement>(".list-rows .nav-project")).at(-1)!.getBoundingClientRect();
      return { frames: frames.length, p95: Math.round(frames[Math.floor(frames.length * 0.95)] ?? 0), end: lastRow.bottom <= scroller.getBoundingClientRect().bottom + 1 };
    });
    await shot("07-many.png");
    pass(
      "프로젝트 300개: 목록이 다 그려지고, 폴더↔전체 바꾸기와 끝까지 스크롤이 부드러움(Chromium)",
      shown && count >= 300 && switching.toFolder < 250 && switching.toRoot < 250 && scroll.end && scroll.p95 < 34,
      `줄 ${count} · 만들기 ${seeding}ms · 폴더로 ${switching.toFolder}ms · 전체로 ${switching.toRoot}ms · 스크롤 ${scroll.frames}프레임 p95 ${scroll.p95}ms`,
    );

    // ── the dark theme ───────────────────────────────────────────────────────────────────────
    const { prefs } = await api<{ prefs: UiPrefs }>("GET", "/api/snapshot");
    await api("PUT", "/api/prefs", { prefs: { ...prefs, theme: "dark" } });
    await page.reload();
    await page.waitForSelector(".sidebar[data-theme='dark'] .list-pane");
    await page.locator(".nav-folder-tree .nav-folder", { hasText: "많은 강의" }).click();
    await page.waitForTimeout(500);
    const desk = await page.evaluate(() => [getComputedStyle(document.querySelector(".sidebar")!).backgroundColor, getComputedStyle(document.querySelector(".topbar")!).backgroundColor]);
    await shot("08-dark.png");
    pass("다크: 사이드바 두 칸이 틀(책상) 색 하나로", desk[0] === desk[1], desk.join(" / "));
  } catch (error) {
    pass("실행", false, error instanceof Error ? error.message.split("\n")[0]! : String(error));
    await shot("failure.png").catch(() => undefined);
  } finally {
    await page.close();
  }
}

try {
  for (const provider of providers) await flow(provider);
  await shared();
} finally {
  writeFileSync(join(outDir, "console.log"), logs.join("\n"));
  writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
  await browser.close();
  child.kill();
  await new Promise((done) => (child.exitCode === null && child.signalCode === null ? child.once("exit", done) : done(null)));
  for (const dir of [dataDir, worksDir, vaultDir]) rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((result) => !result.ok).length;
  console.log(`${results.length - failed}/${results.length} passed · console: ${logs.length ? logs.slice(0, 6).join(" | ") : "clean"}`);
  process.exitCode = failed ? 1 : 0;
}
