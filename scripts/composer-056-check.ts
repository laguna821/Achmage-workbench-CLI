/// <reference lib="dom" />
// 0.5.6 composer-056 (ux/briefs/composer-056-brief.md), end to end on the built UI and gateway with the
// repository's stand-in engines (no model), a stand-in keyring and a temporary data folder:
//   1. A new project in a FOLDED folder shows: 새로 만들기 › 새 프로젝트… (the open project in that folder),
//      the folder's ⋯ › 이 폴더에 새 작업, a project moved in by its menu — the folders unfold, the row is
//      listed, in view and current, and a click on it opens it (level 2). Two folders clicked at once both fold.
//   2. 첨부 shows the conversation's working folder first (name, path on hover) and 작업 폴더 바꾸기…; for a
//      conversation not started the folder is set (the gateway's session cwd), for one with turns it says what
//      happens; 파일 첨부… / 사진 below.
//   3. Files dropped on the conversation (the transcript, not the input): the overlay says
//      "여기에 놓으면 첨부합니다"; a drop with files and a drop with a file:// uri-list both attach.
// Usage (from the repository, through ux/run-isolated.sh, after the web and host builds):
//   node scripts/composer-056-check.ts <outDir> [--only=1,2,3]
// Prints one PASS/FAIL line per check, writes frames and results.json to <outDir>, exits 1 on a failure.
import { gatewayLaunch } from "./fixtures/launch-gateway.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Browser, type Page } from "playwright-core";
import type { Session, Snapshot, TranscriptItem, Workspace } from "@workbench/contracts";

const out = resolve(process.argv[2] ?? "composer-056-out"); mkdirSync(out, { recursive: true });
const only = (process.argv.find((arg) => arg.startsWith("--only="))?.slice(7) ?? "1,2,3").split(",");
const dataDir = mkdtempSync(join(tmpdir(), "wb-composer-056-"));
const authDir = join(dataDir, "engine-auth");
mkdirSync(authDir, { recursive: true });
writeFileSync(join(authDir, "claude"), "signed in");
writeFileSync(join(authDir, "codex"), "signed in");

const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
/** Waits for a condition, bounded generously (a slow machine is not a failure). */
const wait = async (what: () => boolean | Promise<boolean>, ms = 30_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await what()) return true; } catch { /* not yet */ } await new Promise((done) => setTimeout(done, 100)); }
  return false;
};

let child: ChildProcess | null = null, browser: Browser | null = null, page: Page | null = null;
const errors: string[] = [];
const started = gatewayLaunch("apps/host/dist/host.mjs", resolve("scripts/fixtures/fake-secret.mjs"));
try {
  child = spawn(started.command, started.args, {
    env: {
      ...process.env, WORKBENCH_DATA_DIR: dataDir, WORKBENCH_HOST_ID: "fixture", WORKBENCH_HOST_LABEL: "노트북", WORKBENCH_IEUM_BOOTSTRAP: "0", WORKBENCH_VAULT_SUGGEST: "",
      WORKBENCH_WEB_DIR: resolve("apps/web/dist"),
      WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"), WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"),
      FAKE_ENGINE_AUTH_DIR: authDir, FAKE_SECRET_OFF: join(dataDir, "keyring-off"), ...started.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (data) => writeFileSync(join(out, "host.log"), data, { flag: "a" }));
  const ready = await new Promise<{ url: string; token: string }>((done, fail) => {
    const timer = setTimeout(() => fail(Error("gateway start timeout")), 60_000);
    child!.once("exit", (code) => { clearTimeout(timer); fail(Error(`gateway exited: ${code}`)); });
    createInterface({ input: child!.stdout! }).on("line", (line) => { if (line.startsWith("WORKBENCH_READY ")) { clearTimeout(timer); done(JSON.parse(line.slice(16))); } });
  });
  console.log(`gateway pid ${child.pid}`);
  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${ready.url}${path}`, { method, headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    if (!response.ok) throw Error(`${method} ${path}: ${response.status} ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : null) as T;
  };
  const snapshot = () => api<Snapshot>("GET", "/api/snapshot");

  // ── fixture: 강의 (with 2026-2 inside), a project in each, one outside; 강의 folded as 0.5.5 saved it ──
  const lecture = await api<{ id: string }>("POST", "/api/folders", { name: "강의", parentId: null });
  const term = await api<{ id: string }>("POST", "/api/folders", { name: "2026-2", parentId: lecture.id });
  const week1 = await api<{ id: string }>("POST", "/api/works", { title: "강의 1주차", cwd: null });
  const graded = await api<{ id: string }>("POST", "/api/works", { title: "과제 채점", cwd: null });
  const notes = await api<{ id: string }>("POST", "/api/works", { title: "논문 메모", cwd: null });
  await api("PATCH", `/api/works/${week1.id}`, { folderId: lecture.id });
  await api("PATCH", `/api/works/${graded.id}`, { folderId: term.id });
  const basePrefs = { onboarding: "done", layoutScope: "global", sidebar: true, theme: "light", navigator: { rail: "projects", level: "projects" }, tree: { closedFolders: [lecture.id], openWorks: [], closedWorks: [], openDocs: [] } };
  await api("PUT", "/api/prefs", { prefs: basePrefs });

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (error) => errors.push(error.message));
  const p = page;
  await p.goto(`${ready.url}/?token=${ready.token}`);
  const row = (id: string) => p.locator(`.sidebar [data-row-id="${id}"][data-list-row]`);
  const toList = async () => {
    if (!(await p.locator('.sidebar[data-rail="projects"]').count())) await p.locator('.nav-rail [data-rail="projects"]').click();
    if (await p.locator(".sidebar[data-level=project]").count()) await p.locator(".sidebar .nav-back").click();
    await p.locator(".sidebar[data-level=projects]").waitFor();
  };
  const inView = async (id: string) => {
    const box = await row(id).boundingBox();
    const list = await p.locator(".sidebar .nav-scroll").boundingBox();
    return Boolean(box && list && box.y >= list.y - 1 && box.y + box.height <= list.y + list.height + 1);
  };
  const folded = async (id: string) => (await row(id).getAttribute("aria-expanded")) === "false";
  const fold = async (id: string) => { if (!(await folded(id))) await row(id).locator(".row-chevron").click(); await wait(() => folded(id), 5_000); };
  await toList();
  await row(lecture.id).waitFor();

  if (only.includes("1")) {
    // ── 1a. 새로 만들기 › 새 프로젝트… while the open project is in the folded folder 강의 ──
    check("1: 강의 starts folded (the state 0.5.5 saved)", await folded(lecture.id));
    await row(lecture.id).locator(".row-chevron").click();
    await row(week1.id).click();
    await p.locator(".sidebar[data-level=project]").waitFor();
    await toList();
    await fold(lecture.id);
    check("1a: folded again, 강의 1주차 is hidden (its tab stays)", (await row(week1.id).count()) === 0);
    const before = new Set((await snapshot()).works.map((work) => work.id));
    await p.locator(".sidebar .nav-new").click();
    await p.getByRole("menuitem", { name: "새 프로젝트…" }).click();
    let made = "";
    await wait(async () => { made = (await snapshot()).works.find((work) => !before.has(work.id))?.id ?? ""; return Boolean(made); });
    check("1a: the project is made in 강의", (await snapshot()).works.find((work) => work.id === made)?.folderId === lecture.id);
    const field = p.locator(".sidebar input.side-rename");
    const named = await field.waitFor({ timeout: 10_000 }).then(() => true, () => false);
    check("1a: the list is at level 1 and the new row waits for its name there, 강의 unfolded", named && (await p.locator(".sidebar[data-level=projects]").count()) === 1 && !(await folded(lecture.id)) && (await p.locator(`.sidebar [data-row-id="${made}"] input.side-rename`).count()) === 1);
    await p.screenshot({ path: join(out, "1440-light-1a-new-project-naming.png") });
    if (named) { await field.fill("3주차 실습"); await field.press("Enter"); }
    check("1a: the name is kept", await wait(async () => (await snapshot()).works.find((work) => work.id === made)?.title === "3주차 실습"));
    check("1a: the row is listed, in view and current", await wait(async () => (await row(made).count()) === 1 && (await inView(made)) && (await row(made).getAttribute("aria-selected")) === "true", 10_000));
    await p.screenshot({ path: join(out, "1440-light-1a-new-project-listed.png") });
    await row(made).click();
    check("1a: a click on it goes inside it (level 2)", await wait(async () => (await p.locator(".sidebar[data-level=project]").count()) === 1 && (await p.locator(".sidebar .nav-project-name").textContent()) === "3주차 실습", 10_000));
    await toList();

    // ── 1b. the folded folder's ⋯ › 이 폴더에 새 작업: home's input with the folder, a request, a project in 2026-2 ──
    await fold(term.id);
    await fold(lecture.id);
    await row(lecture.id).locator(".row-chevron").click();
    await wait(async () => !(await folded(lecture.id)), 5_000);
    await row(term.id).hover();
    await row(term.id).locator(".row-more").click();
    await p.getByRole("menuitem", { name: /이 폴더에 새 작업/ }).click();
    const input = p.locator(".composer-input:visible").first();
    await input.waitFor();
    const before2 = new Set((await snapshot()).works.map((work) => work.id));
    await input.fill("기말 과제 기준 정리");
    await input.press("Enter");
    let made2 = "";
    await wait(async () => { made2 = (await snapshot()).works.find((work) => !before2.has(work.id))?.id ?? ""; return Boolean(made2); });
    check("1b: a request from 이 폴더에 새 작업 makes a project in 2026-2", (await snapshot()).works.find((work) => work.id === made2)?.folderId === term.id);
    await p.waitForTimeout(500);
    await toList();
    check("1b: back in the list, 2026-2 is unfolded and the project is listed", await wait(async () => !(await folded(term.id)) && (await row(made2).count()) === 1, 10_000));
    await row(made2).scrollIntoViewIfNeeded();
    await p.screenshot({ path: join(out, "1440-light-1b-folder-new-work.png") });

    // ── 1c. a project moved into the folded folder by its menu ──
    await fold(lecture.id);
    await row(notes.id).click({ button: "right" });
    await p.getByRole("menuitem", { name: /폴더로 옮기기/ }).hover();
    // A folder choice is a checkable item (menuitemcheckbox / menuitemradio).
    await p.locator('[role^="menuitem"]').filter({ hasText: /^\s*강의\s*$/ }).first().click();
    check("1c: moved by its menu into 강의 (folded): 강의 unfolds and the project is listed", await wait(async () => (await snapshot()).works.find((work) => work.id === notes.id)?.folderId === lecture.id && !(await folded(lecture.id)) && (await row(notes.id).count()) === 1, 10_000));

    // ── 1d. folds every time: two folders clicked one after the other (inside the double-click window) both fold ──
    if (await folded(lecture.id)) await row(lecture.id).locator(".row-chevron").click();
    if (await folded(term.id)) await row(term.id).locator(".row-chevron").click();
    await wait(async () => !(await folded(lecture.id)) && !(await folded(term.id)), 5_000);
    await row(term.id).locator(".nav-folder-name").click();
    await row(lecture.id).locator(".nav-folder-name").click();
    const both = await wait(async () => (await folded(lecture.id)) && (await p.locator(`.sidebar [data-row-id="${term.id}"]`).count()) === 0, 5_000);
    check("1d: two folders clicked at once both fold", both, both ? "" : JSON.stringify({ lecture: await row(lecture.id).getAttribute("aria-expanded"), term: await p.locator(`.sidebar [data-row-id="${term.id}"]`).count(), closed: ((await snapshot()).prefs as { tree?: { closedFolders?: string[] } }).tree?.closedFolders, field: await p.locator(".sidebar input.side-rename").count() }));
    if (!both) await p.screenshot({ path: join(out, "1d-failure.png") });
    const storedClosed = async () => ((await snapshot()).prefs as { tree?: { closedFolders?: string[] } }).tree?.closedFolders ?? [];
    check("1d: …and the gateway keeps both folds (a waiting fold built on the latest preferences)", await wait(async () => { const ids = await storedClosed(); return ids.includes(lecture.id) && ids.includes(term.id); }, 10_000), JSON.stringify(await storedClosed()));
    await row(lecture.id).locator(".nav-folder-name").click();
    check("1d: a click unfolds it again (after the double-click window)", await wait(async () => !(await folded(lecture.id)), 5_000));
    await row(lecture.id).focus();
    await p.keyboard.press("ArrowLeft");
    check("1d: ← folds it", await wait(() => folded(lecture.id), 5_000));
    await p.keyboard.press("ArrowRight");
    check("1d: → unfolds it", await wait(async () => !(await folded(lecture.id)), 5_000));
  }

  // ── 2 and 3: a conversation of 글쓰기 수업 (outside folders) ──
  const writing = await api<{ id: string; cwd: string }>("POST", "/api/works", { title: "글쓰기 수업", cwd: null });
  const classFolder = join(dataDir, "수업 자료"), laterFolder = join(dataDir, "기말 자료");
  mkdirSync(classFolder); mkdirSync(laterFolder);
  const conversation = await api<Session>("POST", `/api/works/${writing.id}/sessions`, { provider: "codex" });
  const sessionOf = async (id: string) => (await snapshot()).sessions.find((entry) => entry.id === id)!;
  const cwdOfSession = async (id: string) => { const shot = await snapshot(); const session = shot.sessions.find((entry) => entry.id === id)!; return (shot.workspaces as Workspace[] | undefined)?.find((entry) => entry.id === session.workspaceId)?.cwd; };
  // The PC's folder chooser in this browser: a stand-in that answers the folder the check asks for next.
  let nextFolder = classFolder;
  const conversationPage = async (target: Page, id: string) => {
    await target.exposeFunction("__rigFolder", () => nextFolder).catch(() => undefined);
    await target.addInitScript(() => { (window as unknown as { __workbenchPickFolder: () => Promise<string> }).__workbenchPickFolder = () => (window as unknown as { __rigFolder: () => Promise<string> }).__rigFolder(); });
    await target.goto(`${ready.url}/?token=${ready.token}`);
    const listRow = target.locator(`.sidebar [data-row-id="${writing.id}"][data-list-row]`);
    await wait(async () => {
      if (await target.locator(`.sidebar [data-row-id="${id}"]`).first().isVisible()) return true;
      if (!(await target.locator('.sidebar[data-rail="projects"]').count())) await target.locator('.nav-rail [data-rail="projects"]').click();
      else if (await target.locator(".sidebar[data-level=project]").count()) await target.locator(".sidebar .nav-back").click();
      else if (await listRow.isVisible()) await listRow.click();
      return false;
    }, 20_000);
    await target.locator(`.sidebar [data-row-id="${id}"]`).first().click();
    await target.locator(".work-view .composer-input:visible").first().waitFor();
  };
  const attachMenu = (target: Page) => target.getByRole("menu", { name: "사진 또는 파일 첨부" });
  const openAttach = async (target: Page) => { await target.locator(".work-view").getByRole("button", { name: "사진 또는 파일 첨부" }).first().click(); await attachMenu(target).waitFor(); };

  if (only.includes("2")) {
    await p.close();
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on("pageerror", (error) => errors.push(error.message));
    const c = page;
    await conversationPage(c, conversation.id);
    await openAttach(c);
    const menu = attachMenu(c);
    const folderRow = menu.locator(".composer-folder");
    check("2: 첨부 names the working folder first: 프로젝트 폴더, its path on hover", (await folderRow.textContent())?.trim() === "프로젝트 폴더" && (await folderRow.getAttribute("title")) === writing.cwd, `${await folderRow.textContent()} / ${await folderRow.getAttribute("title")}`);
    const labels = (await menu.getByRole("menuitem").allTextContents()).map((text) => text.trim());
    check("2: then 작업 폴더 바꾸기…, apart from 파일 첨부… / 사진", labels[0] === "작업 폴더 바꾸기…" && labels[1] === "파일 첨부…" && labels.some((label) => label.startsWith("사진")), labels.join(" | "));
    check("2: a conversation not started: the line says it starts in the folder chosen", (await menu.textContent())?.includes("이 대화가 고른 폴더에서 시작합니다.") === true);
    await c.waitForTimeout(400);
    await c.screenshot({ path: join(out, "1440-light-2-attach-folder.png") });
    nextFolder = classFolder;
    await menu.getByRole("menuitem", { name: "작업 폴더 바꾸기…" }).click();
    check("2: 작업 폴더 바꾸기… sets this conversation's folder (not started)", await wait(async () => (await cwdOfSession(conversation.id)) === realpathSync(classFolder)));
    check("2: …and says so", await wait(async () => (await c.getByText(/작업 폴더를 「수업 자료」로 바꿨습니다/).count()) > 0, 10_000));
    check("2: the project's own folder is unchanged", (await snapshot()).works.find((work) => work.id === writing.id)?.cwd === writing.cwd);
    await openAttach(c);
    check("2: 첨부 now names 수업 자료 (its path on hover)", await wait(async () => (await attachMenu(c).locator(".composer-folder").textContent())?.trim() === "수업 자료" && (await attachMenu(c).locator(".composer-folder").getAttribute("title")) === realpathSync(classFolder), 10_000));
    await c.waitForTimeout(400);
    await c.screenshot({ path: join(out, "1440-light-2-attach-folder-changed.png") });
    await c.keyboard.press("Escape");
    // A request: the conversation has started (the stand-in engine answers).
    const input = c.locator(".work-view .composer-input:visible").first();
    await input.fill("자료 목록 만들어 줘");
    await input.press("Enter");
    await wait(async () => (await sessionOf(conversation.id)).status === "idle" && Boolean((await sessionOf(conversation.id)).nativeSessionId), 60_000);
    await openAttach(c);
    check("2: started, the line says a new conversation opens in the folder chosen", await wait(async () => (await attachMenu(c).textContent())?.includes("시작한 대화는 그대로 두고, 고른 폴더에서 새 대화를 엽니다.") === true, 10_000));
    const count = (await snapshot()).sessions.length;
    nextFolder = laterFolder;
    await attachMenu(c).getByRole("menuitem", { name: "작업 폴더 바꾸기…" }).click();
    let opened = "";
    check("2: started: it stays in 수업 자료; a new conversation is made in 기말 자료", await wait(async () => {
      const shot = await snapshot();
      const made = shot.sessions.filter((entry) => entry.workId === writing.id && entry.id !== conversation.id).at(-1);
      opened = made?.id ?? "";
      return shot.sessions.length === count + 1 && Boolean(made) && (await cwdOfSession(made!.id)) === realpathSync(laterFolder) && (await cwdOfSession(conversation.id)) === realpathSync(classFolder);
    }));
    check("2: …and it opens in this pane", await wait(async () => (await c.locator(`.sidebar [data-row-id="${opened}"][aria-current]`).count()) > 0 || (await c.locator(".work-view .composer-input:visible").count()) > 0 && (await c.getByText(/새 대화를 열었습니다/).count()) > 0, 10_000));
    await c.screenshot({ path: join(out, "1440-light-2-new-conversation-there.png") });
    // Dark: the same menu.
    await api("PUT", "/api/prefs", { prefs: { ...(await snapshot()).prefs, theme: "dark" } });
    const dark = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    dark.on("pageerror", (error) => errors.push(`dark: ${error.message}`));
    await conversationPage(dark, conversation.id);
    await openAttach(dark);
    await dark.waitForTimeout(300);
    await dark.screenshot({ path: join(out, "1440-dark-2-attach-folder.png") });
    await dark.close();
    await api("PUT", "/api/prefs", { prefs: { ...(await snapshot()).prefs, theme: "light" } });
    // The phone page (390×844): the folder shown, no PC chooser.
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    phone.on("pageerror", (error) => errors.push(`phone: ${error.message}`));
    await phone.goto(`${ready.url}/?token=${ready.token}`);
    const phoneOpened = await wait(async () => {
      const key = phone.locator(".work-view").getByRole("button", { name: "사진 또는 파일 첨부" }).first();
      // The list column lies over the conversation on a phone until it is closed.
      const scrim = phone.locator(".sidebar-scrim");
      if (await key.isVisible() && await scrim.isVisible()) { await scrim.click({ position: { x: 360, y: 400 } }); return false; }
      if (await key.isVisible()) return true;
      const target = phone.locator(`.sidebar [data-row-id="${conversation.id}"]`).first();
      if (await target.isVisible()) { await target.click(); return false; }
      const project = phone.locator(`.sidebar [data-row-id="${writing.id}"][data-list-row]`);
      if (await project.isVisible()) { await project.click(); return false; }
      const opener = phone.getByRole("button", { name: "사이드바 열기" });
      if (await opener.isVisible()) { await opener.click(); return false; }
      const rail = phone.locator('.nav-rail [data-rail="projects"]');
      if (await rail.isVisible()) await rail.click();
      return false;
    }, 30_000);
    if (phoneOpened) {
      await openAttach(phone);
      check("2: phone page: the folder is shown and the menu says it is changed on the PC", (await attachMenu(phone).locator(".composer-folder").count()) === 1 && (await attachMenu(phone).textContent())?.includes("작업 폴더는 PC에서 바꿉니다.") === true && (await attachMenu(phone).getByRole("menuitem", { name: "작업 폴더 바꾸기…" }).count()) === 0);
      await phone.waitForTimeout(400);
      await phone.screenshot({ path: join(out, "390-phone-2-attach-folder.png") });
    } else { check("2: phone page reached the conversation", false); await phone.screenshot({ path: join(out, "390-phone-failure.png") }); }
    await phone.close();
  }

  if (only.includes("3")) {
    const d = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    d.on("pageerror", (error) => errors.push(`drop: ${error.message}`));
    page = d;
    await conversationPage(d, conversation.id);
    const transcript = d.locator(".work-view .transcript").first();
    await transcript.waitFor();
    // A drop with files (bytes in the page), as a browser or the Windows/macOS app gives it.
    const dropFiles = async (files: { name: string; text: string }[], uriList: string, stopAt: "over" | "drop") => d.evaluate(({ files, uriList, stopAt }) => {
      const target = document.querySelector(".work-view .transcript")!;
      const transfer = new DataTransfer();
      for (const file of files) transfer.items.add(new File([file.text], file.name, { type: "text/plain" }));
      if (uriList) transfer.setData("text/uri-list", uriList);
      const box = target.getBoundingClientRect();
      const at = { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: box.left + box.width / 2, clientY: box.top + box.height / 3 };
      target.dispatchEvent(new DragEvent("dragenter", at));
      target.dispatchEvent(new DragEvent("dragover", at));
      if (stopAt === "drop") target.dispatchEvent(new DragEvent("drop", at));
    }, { files, uriList, stopAt });
    await dropFiles([{ name: "출석부.txt", text: "1 김\n" }, { name: "과제 기준.txt", text: "분량 2쪽\n" }], "", "over");
    check("3: files over the transcript: the overlay says 여기에 놓으면 첨부합니다", await wait(async () => (await d.getByText("여기에 놓으면 첨부합니다").count()) === 1, 5_000));
    await d.screenshot({ path: join(out, "1440-light-3-drop-overlay.png") });
    await dropFiles([{ name: "출석부.txt", text: "1 김\n" }, { name: "과제 기준.txt", text: "분량 2쪽\n" }], "", "drop");
    check("3: a drop with files on the transcript attaches both", await wait(async () => (await d.locator(".attach-pending .attach-name").allTextContents()).join("|") === "출석부.txt|과제 기준.txt" && (await d.locator(".attach-pending .spinner").count()) === 0, 15_000), (await d.locator(".attach-pending .attach-name").allTextContents()).join("|"));
    check("3: the overlay is gone after the drop", (await d.getByText("여기에 놓으면 첨부합니다").count()) === 0);
    // A file manager's drop as WebKitGTK gives it: a file:// list and no files.
    const syllabus = join(dataDir, "강의계획서.txt"), rubric = join(dataDir, "채점 기준.md");
    writeFileSync(syllabus, "1주차 소개\n"); writeFileSync(rubric, "# 기준\n");
    const list = [syllabus, rubric].map((path) => `file://${path.split("/").map(encodeURIComponent).join("/")}`).join("\r\n");
    await dropFiles([], list, "drop");
    check("3: a drop with only a file:// list attaches the files by their paths", await wait(async () => (await d.locator(".attach-pending .attach-name").allTextContents()).join("|") === "출석부.txt|과제 기준.txt|강의계획서.txt|채점 기준.md" && (await d.locator(".attach-pending .spinner").count()) === 0 && (await d.locator(".attach-pending .failed").count()) === 0, 15_000), (await d.locator(".attach-pending").allTextContents()).join("|"));
    await d.screenshot({ path: join(out, "1440-light-3-dropped-files.png") });
    const input = d.locator(".work-view .composer-input:visible").first();
    await input.fill("이 자료로 1주차 안내문 써 줘");
    await input.press("Enter");
    const sentWith = async () => {
      const items = (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${conversation.id}/items`)).items;
      const last = items.filter((item): item is Extract<TranscriptItem, { kind: "user" }> => item.kind === "user").at(-1);
      return last?.attachments?.map((attachment) => attachment.name) ?? [];
    };
    check("3: the request goes with all four files", await wait(async () => (await sentWith()).length === 4, 30_000), JSON.stringify(await sentWith().catch(() => [])));
  }

  check("no browser exceptions", errors.length === 0, errors.join("; "));
} catch (error) {
  check("composer-056 scenario", false, String(error));
  if (page) await page.screenshot({ path: join(out, "failure.png") }).catch(() => undefined);
} finally {
  await browser?.close();
  if (child && child.exitCode === null) { const exited = new Promise<void>((done) => child!.once("exit", () => done())); child.kill("SIGTERM"); await exited; }
  started.cleanup();
  writeFileSync(join(out, "results.json"), JSON.stringify({ results, errors }, null, 2));
  console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}
