/// <reference lib="dom" />
// Browser check of ① 들어가는 길 (docs/design/프로젝트-노트-설계.md §3, §13), for Codex and Claude
// alike, against a real gateway driving stand-in engines (no model):
// - the home input's project chip: "새 프로젝트" by default and without a folder a new project as
//   before; a folder that already has a live project defaults to it ("→ ‹작업›에 새 세션") and the
//   request becomes a new session there; "새 프로젝트" picked by hand makes one in that folder; a
//   project found by name in the chip gets the new session;
// - opening a work (its sidebar row) lands on the session that needs the user: waiting for an
//   approval, then a failed turn, then an unseen reply, then the one looked at last;
// - "새 프로젝트 폴더 위치" in the settings: the next project started without a folder is made under
//   the chosen folder, older works stay where they are, "기본으로" goes back.
// Usage: node scripts/entry-check.ts [outDir] [codex|claude]

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Page } from "playwright-core";
import type { Provider, Session, UiPrefs, Work, WorksDirView } from "@workbench/contracts";

const outDir = process.argv[2] ?? join(tmpdir(), "wb-entry");
const providers: Provider[] = process.argv[3] === "codex" || process.argv[3] === "claude" ? [process.argv[3]] : ["codex", "claude"];
mkdirSync(outDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "workbench-entry-"));
// Folders the user picks (work folders, the new project location).
const roots = mkdtempSync(join(tmpdir(), "workbench-entry-folders-"));
// Claude Code's own settings for the stand-in: ask before acting (Codex's fake asks on its own).
const claudeConfig = mkdtempSync(join(tmpdir(), "workbench-entry-claude-"));
writeFileSync(join(claudeConfig, "settings.json"), JSON.stringify({ permissions: { defaultMode: "default" } }));
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
    CLAUDE_CONFIG_DIR: claudeConfig,
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
const snapshot = () => api<{ works: Work[]; sessions: Session[]; prefs: UiPrefs }>("GET", "/api/snapshot");
const workOf = async (id: string) => (await snapshot()).works.find((entry) => entry.id === id)!;
const sessionOf = async (id: string) => (await snapshot()).sessions.find((entry) => entry.id === id)!;
const until = async (what: () => Promise<boolean>, timeout = 15_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await what()) return true;
    await new Promise((done) => setTimeout(done, 100));
  }
  return false;
};
const real = (path: string) => (existsSync(path) ? realpathSync(path) : path);
await api("PUT", "/api/prefs", { prefs: { onboarding: "done", startScreen: "last" } });
const defaultDir = join(dataDir, "works");

const browser = await chromium.launch();
const logs: string[] = [];

async function flow(provider: Provider) {
  const label = provider === "codex" ? "Codex" : "Claude";
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on("console", (message) => message.type() === "error" && logs.push(`[${label} error] ${message.text().slice(0, 200)}`));
  page.on("pageerror", (error) => logs.push(`[${label} pageerror] ${error.message.slice(0, 200)}`));
  const shot = (name: string) => page.screenshot({ path: join(outDir, `${provider}-${name}`) });
  const pass = (step: string, ok: boolean, detail = "") => check(`[${label}] ${step}`, ok, detail);
  const chip = () => page.locator(".start-view .project-button");
  const chipText = async () => (await chip().innerText()).trim();
  const home = async (p: Page = page) => {
    await p.locator(".topbar .brand").click();
    await p.waitForSelector(".start-view .composer-input");
    await p.locator(".engine-tab", { hasText: label }).click();
  };
  const send = async (text: string) => {
    const input = page.locator(".composer-input");
    await input.fill(text);
    await input.press("Enter");
  };
  // No system dialog in a browser: the folder menu takes a typed path.
  const pickFolder = async (path: string) => {
    await page.locator(".start-view .composer-right .select-button:not(.project-button)").click();
    const field = page.locator(".folder-menu .menu-form input");
    await field.fill(path);
    await field.press("Enter");
  };
  const worksNow = async () => (await snapshot()).works;
  const sessionsIn = async (workId: string) => (await snapshot()).sessions.filter((entry) => entry.workId === workId);
  const named = async (title: string) => {
    const work = await api<Work>("POST", "/api/works", { title, cwd: join(roots, `${provider}-${randomUUID().slice(0, 6)}`) });
    mkdirSync(work.cwd, { recursive: true });
    // Named by hand, so automatic titles leave it as it is.
    return api<Work>("PATCH", `/api/works/${work.id}`, { title });
  };
  const message = (sessionId: string, text: string) => api("POST", `/api/sessions/${sessionId}/messages`, { requestId: randomUUID(), text });
  const activeTab = async () => (await page.locator(".session-tabs .session-tab.active").innerText().catch(() => "")).trim();

  try {
    // ── the project chip on home ───────────────────────────────────────────────────────────
    const folderX = join(roots, `${provider}-강의`);
    mkdirSync(folderX);
    const madeX = await api<Work>("POST", "/api/works", { title: `${label} 가을 특강`, cwd: folderX });
    const workX = await api<Work>("PATCH", `/api/works/${madeX.id}`, { title: `${label} 가을 특강` });
    await api<Session>("POST", `/api/works/${workX.id}/sessions`, { provider, purpose: "처음 세션" });

    await page.goto(`${ready.url}/?token=${ready.token}`);
    await page.waitForSelector(".start-view .composer-input");
    await page.locator(".engine-tab", { hasText: label }).click();
    await page.waitForTimeout(300);
    const first = await chipText();
    await shot("01-home-default.png");
    const count = (await worksNow()).length;
    await send(`${label} 폴더 없이 첫 요청`);
    await until(async () => (await worksNow()).length === count + 1);
    const loose = (await worksNow()).sort((a, b) => b.createdAt - a.createdAt)[0]!;
    await until(async () => (await sessionsIn(loose.id)).length === 1);
    pass(
      "기본은 '새 프로젝트', 폴더 없이 보내면 지금처럼 새 프로젝트(앱 폴더)",
      first === "새 프로젝트" && loose.cwdManaged && loose.cwd.startsWith(`${defaultDir}/`) && (await sessionsIn(loose.id)).length === 1,
      `chip="${first}" cwd=${loose.cwd}`,
    );

    // A folder that already has a live project: it is the default. (The request sent before is
    // not left in home's input.)
    await home();
    const leftOver = await page.locator(".start-view .composer-input").inputValue();
    await pickFolder(`${folderX}/`);
    const defaulted = await page.waitForFunction(() => document.querySelector(".project-button")?.textContent?.includes("에 새 세션"), undefined, { timeout: 5000 }).then(() => true).catch(() => false);
    const sameText = await chipText();
    await shot("02-folder-default.png");
    const sessionsBefore = (await sessionsIn(workX.id)).length;
    const worksBefore = (await worksNow()).length;
    await send(`${label} 같은 폴더 요청`);
    await until(async () => (await sessionsIn(workX.id)).length === sessionsBefore + 1);
    await page.waitForSelector(".work-view .transcript");
    const added = (await sessionsIn(workX.id)).sort((a, b) => b.createdAt - a.createdAt)[0]!;
    await until(async () => (await sessionOf(added.id)).previewAt !== null);
    const shownTitle = (await page.locator(".topbar-title").innerText()).trim();
    await shot("03-same-project.png");
    pass(
      "프로젝트가 있는 폴더를 고르면 그 프로젝트가 기본 → 거기에 새 세션(새 작업 없음)",
      leftOver === "" && defaulted && sameText === `→ ${workX.title}에 새 세션` && (await worksNow()).length === worksBefore && added.provider === provider && (await workOf(workX.id)).activeSessionId === added.id && shownTitle === workX.title,
      `input="${leftOver}" chip="${sameText}" works ${worksBefore}→${(await worksNow()).length} sessions ${sessionsBefore}→${sessionsBefore + 1} engine=${added.provider} title=${shownTitle}`,
    );

    // "새 프로젝트" picked by hand in the same folder.
    await home();
    await pickFolder(folderX);
    await page.waitForFunction(() => document.querySelector(".project-button")?.textContent?.includes("에 새 세션"), undefined, { timeout: 5000 }).catch(() => undefined);
    await chip().click();
    await page.waitForSelector(".project-menu");
    await page.waitForTimeout(150);
    await shot("04-chip-menu.png");
    const menu = await page.locator(".project-menu").innerText();
    await page.locator(".project-menu .menu-item", { hasText: "새 프로젝트" }).click();
    const explicit = await chipText();
    const worksBeforeNew = (await worksNow()).length;
    await send(`${label} 같은 폴더지만 새 프로젝트`);
    await until(async () => (await worksNow()).length === worksBeforeNew + 1);
    const fresh = (await worksNow()).sort((a, b) => b.createdAt - a.createdAt)[0]!;
    pass(
      "칩에서 '새 프로젝트'를 고르면 같은 폴더에 새 프로젝트",
      menu.includes("새 프로젝트") && menu.includes(workX.title) && explicit === "새 프로젝트" && fresh.id !== workX.id && real(fresh.cwd) === real(folderX) && !fresh.cwdManaged,
      `chip="${explicit}" new=${fresh.title} cwd=${fresh.cwd}`,
    );

    // An existing project found by name in the chip (no folder picked).
    await home();
    await chip().click();
    await page.waitForSelector(".project-menu .project-filter input");
    await page.locator(".project-menu .project-filter input").fill(`${label} 가을`);
    await page.waitForTimeout(150);
    const listed = await page.locator(".project-menu .project-list .menu-item").allInnerTexts();
    await page.locator(".project-menu .project-filter input").press("Enter");
    const picked = await chipText();
    const folderShown = (await page.locator(".start-view .composer-right .select-button:not(.project-button)").innerText()).trim();
    await shot("05-picked-by-name.png");
    const beforePick = (await sessionsIn(workX.id)).length;
    const worksBeforePick = (await worksNow()).length;
    await send(`${label} 이름으로 고른 프로젝트`);
    await until(async () => (await sessionsIn(workX.id)).length === beforePick + 1);
    const pickedSession = (await sessionsIn(workX.id)).sort((a, b) => b.createdAt - a.createdAt)[0]!;
    pass(
      "칩에서 이름으로 찾은 기존 프로젝트에 고른 엔진으로 새 세션",
      listed.length === 2 && picked === `→ ${workX.title}에 새 세션` && folderShown === `${provider}-강의` && (await worksNow()).length === worksBeforePick && pickedSession.provider === provider,
      `list=${listed.map((entry) => entry.replace(/\s+/g, " ")).join(" | ")} chip="${picked}" folder=${folderShown}`,
    );

    // ── opening a work lands on the session that needs the user ───────────────────────────
    await home();
    const workB = await named(`${label} 열기 순서`);
    const make = (purpose: string) => api<Session>("POST", `/api/works/${workB.id}/sessions`, { provider, purpose });
    const last = await make("마지막에 본 세션");
    const unseen = await make("새 답 세션");
    const failing = await make("실패한 세션");
    const waiting = await make("승인 대기 세션");
    await message(last.id, "인사만 해 줘");
    await until(async () => (await sessionOf(last.id)).previewAt !== null && (await sessionOf(last.id)).status === "idle");
    await api("PATCH", `/api/sessions/${last.id}`, { seen: true });
    await message(unseen.id, "짧게 답해 줘");
    await message(failing.id, "일부러 실패해 줘");
    await message(waiting.id, "명령 실행해 줘");
    const settled = await until(async () => {
      const [u, f, w] = await Promise.all([sessionOf(unseen.id), sessionOf(failing.id), sessionOf(waiting.id)]);
      return u.status === "idle" && u.previewAt !== null && f.status === "idle" && Boolean(f.lastError) && w.status === "awaitingApproval";
    });
    await api("PATCH", `/api/works/${workB.id}`, { activeSessionId: last.id });
    const row = page.locator(`.sidebar [data-row-id="${workB.id}"]`);
    const lands = async (expected: Session) => {
      await row.click();
      const ok = await until(async () => (await workOf(workB.id)).activeSessionId === expected.id, 5000);
      await page.waitForFunction((purpose) => document.querySelector(".session-tabs .session-tab.active")?.textContent?.includes(purpose), expected.purpose, { timeout: 5000 }).catch(() => undefined);
      // Its conversation, not "불러오는 중…", in the screenshot.
      await page.waitForSelector(".work-view .transcript .turn-request", { timeout: 5000 }).catch(() => undefined);
      return ok && (await activeTab()).includes(expected.purpose);
    };
    const toApproval = await lands(waiting);
    const card = await page.waitForSelector(".approval-card", { timeout: 5000 }).then(() => true).catch(() => false);
    await shot("06-open-approval.png");
    pass("작업을 열면 승인을 기다리는 세션으로(확인 필요가 먼저)", settled && toApproval && card, `active=${await activeTab()}`);
    await page.locator(".approval-card .button.primary").click();
    await until(async () => (await sessionOf(waiting.id)).status === "idle");
    // Its reply came while it was on screen: read.
    await until(async () => {
      const session = await sessionOf(waiting.id);
      return (session.seenAt ?? 0) >= (session.previewAt ?? 0);
    });

    await home();
    const toFailure = await lands(failing);
    const failure = await page.waitForFunction(() => document.querySelector(".work-view .transcript")?.textContent?.includes("가짜 오류"), undefined, { timeout: 5000 }).then(() => true).catch(() => false);
    await shot("07-open-error.png");
    pass("다음은 실패한 세션(오류)", toFailure && failure, `active=${await activeTab()}`);
    // Looked at: it no longer pulls.
    await until(async () => {
      const session = await sessionOf(failing.id);
      return (session.seenAt ?? 0) >= session.updatedAt;
    });

    await home();
    const toUnseen = await lands(unseen);
    await shot("08-open-unseen.png");
    pass("그다음은 새 답이 온 세션", toUnseen, `active=${await activeTab()}`);

    // The one looked at last: picked in the sidebar, then the work opened again from home.
    await page.locator(`.sidebar [data-row-id="${last.id}"]`).click();
    await until(async () => (await workOf(workB.id)).activeSessionId === last.id, 5000);
    await home();
    const toLast = await lands(last);
    await shot("09-open-last.png");
    pass("기다리는 것이 없으면 마지막에 본 세션", toLast, `active=${await activeTab()}`);

    // ── "새 프로젝트 폴더 위치" ────────────────────────────────────────────────────────────
    await page.locator('.topbar button[aria-label="연결과 설정"]').click();
    await page.waitForSelector(".works-dir .works-dir-path");
    await page.waitForFunction(() => !document.querySelector(".works-dir .works-dir-path")?.textContent?.includes("확인 중"));
    const settingRow = page.locator(".works-dir");
    await settingRow.scrollIntoViewIfNeeded();
    const shownDefault = (await settingRow.locator(".works-dir-path").innerText()).trim();
    const defaultNote = await settingRow.innerText();
    await shot("10-settings-default.png");
    const chosen = join(roots, `${provider}-새 프로젝트들`);
    await settingRow.locator("button", { hasText: "위치 바꾸기" }).click();
    await settingRow.locator(".works-dir-form input").fill(chosen);
    await settingRow.locator(".works-dir-form button", { hasText: "저장" }).click();
    const changed = await page.waitForFunction((path) => document.querySelector(".works-dir .works-dir-path")?.textContent?.trim() === path, chosen, { timeout: 5000 }).then(() => true).catch(() => false);
    const changedNote = await settingRow.innerText();
    await settingRow.screenshot({ path: join(outDir, `${provider}-11-settings-changed.png`) });
    pass(
      "설정에 지금 위치(기본)가 보이고, 고른 폴더로 바꿈",
      shownDefault === defaultDir && defaultNote.includes("기본 위치") && changed && changedNote.includes("고른 위치") && existsSync(chosen),
      `${shownDefault} → ${chosen}`,
    );
    await page.keyboard.press("Escape");

    await home();
    const worksBeforeLoose = (await worksNow()).length;
    await send(`${label} 새 위치에 만들 프로젝트`);
    await until(async () => (await worksNow()).length === worksBeforeLoose + 1);
    const placed = (await worksNow()).sort((a, b) => b.createdAt - a.createdAt)[0]!;
    const older = await workOf(loose.id);
    await page.waitForSelector(".work-view .transcript");
    await shot("12-new-location.png");
    pass(
      "다음 폴더 없는 프로젝트는 고른 위치 아래에, 이전 작업은 제자리",
      placed.cwdManaged && placed.cwd.startsWith(`${chosen}/`) && existsSync(placed.cwd) && older.cwd === loose.cwd && existsSync(older.cwd) && older.cwd.startsWith(`${defaultDir}/`),
      `new=${placed.cwd} old=${older.cwd}`,
    );

    // Back to the default from the setting.
    await page.locator('.topbar button[aria-label="연결과 설정"]').click();
    await page.waitForSelector(".works-dir .works-dir-path");
    await page.locator(".works-dir button", { hasText: "기본으로" }).click();
    const reset = await page.waitForFunction((path) => document.querySelector(".works-dir .works-dir-path")?.textContent?.trim() === path, defaultDir, { timeout: 5000 }).then(() => true).catch(() => false);
    const view = await api<WorksDirView>("GET", "/api/entry/works-dir");
    await page.keyboard.press("Escape");
    pass("'기본으로'를 누르면 기본 위치로 돌아감", reset && !view.custom && view.path === defaultDir && (await workOf(placed.id)).cwd === placed.cwd, view.path);
    await shot("13-final.png");
  } catch (error) {
    pass("실행", false, error instanceof Error ? error.message.split("\n")[0]! : String(error));
    await page.screenshot({ path: join(outDir, `${provider}-99-failure.png`) }).catch(() => undefined);
  } finally {
    await page.close();
  }
}

try {
  for (const provider of providers) await flow(provider);
} finally {
  writeFileSync(join(outDir, "console.log"), logs.join("\n"));
  writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
  await browser.close();
  child.kill();
  await new Promise((done) => (child.exitCode === null && child.signalCode === null ? child.once("exit", done) : done(null)));
  for (const dir of [dataDir, roots, claudeConfig]) rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((result) => !result.ok).length;
  console.log(`${results.length - failed}/${results.length} passed · console: ${logs.length ? logs.slice(0, 6).join(" | ") : "clean"}`);
  process.exitCode = failed ? 1 : 0;
}
