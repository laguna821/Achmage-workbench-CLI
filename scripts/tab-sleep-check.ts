/// <reference lib="dom" />
// Tab sleep (0.5.1), measured with the real built UI and gateway (a temporary data folder; no model, no user data):
// project 1's documents are opened one after another, the window goes to project 2, and the page's memory is read
// before and after the views of project 1 are taken down. The ten minutes are shortened for this run only
// (`window.__workbenchTabSleepMs`, set before the app loads); the shipped default is not touched.
// Usage: node scripts/tab-sleep-check.ts <out folder> [shot folder]
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Browser, type CDPSession, type Page } from "playwright-core";
import { editorFirst } from "./fixtures/editor-first.ts";

const out = resolve(process.argv[2]!); mkdirSync(out, { recursive: true });
const shots = resolve(process.argv[3] ?? out); mkdirSync(shots, { recursive: true });
const SLEEP_MS = 12_000;
const dir = mkdtempSync(join(tmpdir(), "wb-tab-sleep-"));
const one = join(dir, "one"), two = join(dir, "two"); mkdirSync(one); mkdirSync(two);
const fixtures = resolve("scripts/fixtures");
copyFileSync(join(fixtures, "hello.docx"), join(one, "보고서.docx"));
copyFileSync(join(fixtures, "cover.pptx"), join(one, "표지.pptx"));
copyFileSync(join(fixtures, "supplies.xlsx"), join(one, "재료.xlsx"));
writeFileSync(join(one, "메모.md"), `# 가을 특강 메모\n\n${Array.from({ length: 120 }, (_, index) => `${index + 1}. 준비할 것 — 자료, 장소, 시간표를 확인한다.`).join("\n")}\n`);
const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`); };
const pause = (ms: number) => new Promise(done => setTimeout(done, ms));
const until = async (what: () => Promise<boolean>, timeout = 30_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await what()) return; await pause(150); }
  throw Error("condition timed out");
};
/** Resident memory of this run's browser: every process under the browser's own. */
function browserRss(root: number): number {
  const parents = new Map<number, number>(), rss = new Map<number, number>();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const status = readFileSync(`/proc/${entry}/status`, "utf8");
      parents.set(Number(entry), Number(/^PPid:\s+(\d+)/m.exec(status)?.[1] ?? 0));
      rss.set(Number(entry), Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0));
    } catch { /* gone */ }
  }
  const under = (pid: number): boolean => { for (let at = pid, hops = 0; at > 1 && hops < 40; at = parents.get(at) ?? 0, hops++) if (at === root) return true; return false; };
  return Math.round([...rss].filter(([pid]) => under(pid)).reduce((sum, [, kb]) => sum + kb, 0) / 1024);
}
let child: ChildProcess | null = null, browser: Browser | null = null, page: Page | null = null;
const errors: string[] = [];
const rows: Record<string, unknown>[] = [];
try {
  child = spawn(process.execPath, ["apps/host/dist/host.mjs"], { env: { ...process.env,
    WORKBENCH_DATA_DIR: join(dir, "data"), WORKBENCH_HOST_ID: "fixture", WORKBENCH_IEUM_BOOTSTRAP: "0", WORKBENCH_WEB_DIR: resolve("apps/web/dist"),
    WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"), WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"), WORKBENCH_VAULT_SUGGEST: "",
  }, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr!.on("data", data => writeFileSync(join(out, "host.log"), data, { flag: "a" }));
  const ready = await new Promise<{ url: string; token: string }>((done, fail) => {
    const timer = setTimeout(() => fail(Error("gateway start timeout")), 30_000);
    child!.once("exit", code => { clearTimeout(timer); fail(Error(`gateway exited: ${code}`)); });
    createInterface({ input: child!.stdout! }).on("line", line => { if (line.startsWith("WORKBENCH_READY ")) { clearTimeout(timer); done(JSON.parse(line.slice(16))); } });
  });
  const api = async (path: string, method = "GET", body?: unknown) => {
    const r = await fetch(`${ready.url}${path}`, { method, headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await r.json(); if (!r.ok) throw Error(`${path}: ${r.status} ${result.message}`); return result;
  };
  const p1 = await api("/api/works", "POST", { title: "가을 특강", cwd: one });
  const p2 = await api("/api/works", "POST", { title: "연구 노트", cwd: two });
  const names = ["보고서.docx", "표지.pptx", "재료.xlsx", "메모.md"];
  const docs: { id: string; name: string }[] = [];
  for (const name of names) docs.push({ id: (await api(`/api/works/${p1.id}/artifacts`, "POST", { path: name })).id, name });
  const snapshot = async () => await api("/api/snapshot") as { artifacts: { id: string; revision: number }[]; sessions: { id: string; workId: string; documentAgent?: unknown; pageAgent?: unknown }[] };
  const revisions = async () => Object.fromEntries((await snapshot()).artifacts.filter(entry => docs.some(doc => doc.id === entry.id)).map(entry => [docs.find(doc => doc.id === entry.id)!.name, entry.revision]));
  // A conversation with something in it: six turns of the stand-in engine's sample answer (no model).
  const talk = await api(`/api/works/${p1.id}/sessions`, "POST", { provider: "claude" }) as { id: string };
  for (let turn = 0; turn < 6; turn++) {
    await api(`/api/sessions/${talk.id}/messages`, "POST", { requestId: `turn-${turn}`, text: `견본 ${turn + 1}주차 강의안을 정리해 주세요.`, refs: [], create: null, mode: "auto" });
    await until(async () => ((await api("/api/snapshot")).sessions as { id: string; status: string }[]).find(session => session.id === talk.id)?.status === "idle", 60_000);
  }
  // The first request names the project: its title as it is now.
  const oneTitle = ((await api("/api/snapshot")).works as { id: string; title: string }[]).find(work => work.id === p1.id)!.title;
  await api("/api/prefs", "PUT", { prefs: { onboarding: "done", layoutScope: "global", sidebar: true } });
  // The window as it was left: project 2's page on screen; project 1's tabs behind it (not mounted until shown).
  const tab = (id: string, view: unknown, workId: string, sessionId: string | null = null) => ({ id, view, workId, sessionId });
  const tabs = [tab("tab-p2", { kind: "project", workId: p2.id }, p2.id), ...docs.map((doc, index) => tab(`tab-d${index}`, { kind: "document", artifactId: doc.id, proposalId: null }, p1.id)),
    ...(talk ? [tab("tab-talk", { kind: "work" }, p1.id, talk.id)] : [])];
  await api("/api/layouts/global", "PUT", { expectedRevision: 0, layout: { version: 2, focus: "a", panes: [{ ...tabs[0], id: "a", tabs, activeTabId: "tab-p2", recentTabIds: ["tab-p2"] }] } });
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(ms => { (window as unknown as { __workbenchTabSleepMs: number }).__workbenchTabSleepMs = ms; }, SLEEP_MS);
  await editorFirst(context);
  // What the editor pages say about where their view is (office-leftovers point 3), recorded for the report.
  await context.addInitScript(() => { if (window.top !== window) return; (window as unknown as { __viewPositions: unknown[] }).__viewPositions = []; window.addEventListener("message", (event) => { const data = event.data as { type?: string; position?: unknown }; if (data?.type === "office:view-position") (window as unknown as { __viewPositions: unknown[] }).__viewPositions.push(data.position); }); });
  page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  const cdp: CDPSession = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  const browserPid = Number(execFileSync("pgrep", ["-P", String(process.pid), "-f", "headless"]).toString().trim().split("\n")[0]);
  const measure = async (label: string) => {
    await pause(1500);
    await cdp.send("HeapProfiler.collectGarbage"); await pause(700);
    const metrics = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(metric => [metric.name, metric.value]));
    const dom = await page!.evaluate(() => ({ panes: document.querySelectorAll("section.pane").length, officeFrames: document.querySelectorAll("iframe.office-frame").length, frames: document.querySelectorAll("iframe").length, nodes: document.querySelectorAll("*").length }));
    const row = { label, rssMb: browserRss(browserPid), heapMb: Math.round(metrics.JSHeapUsedSize! / 1048576 * 10) / 10, mainDocNodes: dom.nodes, cdpNodes: metrics.Nodes, mountedPanes: dom.panes, officeFrames: dom.officeFrames, iframes: dom.frames };
    rows.push(row); console.log(JSON.stringify(row)); return row;
  };
  /** The rail's 프로젝트, the list of every project, the project's row. */
  const toProject = async (title: string) => {
    const row = page!.locator("aside").getByText(title, { exact: true }).filter({ visible: true });
    const back = page!.getByRole("button", { name: /프로젝트 목록/ }).filter({ visible: true });
    for (let step = 0; step < 4 && !(await row.count()); step++) {
      if (await back.count()) await back.first().click();
      else await page!.getByRole("button", { name: "프로젝트", exact: true }).first().click();
      await pause(500);
    }
    if (!(await row.count())) console.log("visible in the list column:", (await page!.locator("aside").filter({ visible: true }).allInnerTexts()).join(" | ").replace(/\s+/g, " ").slice(0, 400));
    await row.first().click();
  };
  await page.goto(`${ready.url}/?token=${ready.token}`);
  await until(async () => await page!.locator("section.pane").count() > 0);
  await pause(2500);
  // TAB_SLEEP_ONLY=typed: only the save-before-sleep part (a shorter run while working on the rig).
  // TAB_SLEEP_ONLY=position: only the woken-position part (office-leftovers point 3).
  const only = process.env.TAB_SLEEP_ONLY ?? "";
  const measured = only !== "typed" && only !== "position";
  if (!measured) { await toProject(oneTitle); await until(async () => await page!.getByRole("tab").count() >= docs.length); }
  if (measured) {
  const base = await measure("project 2 on screen, nothing of project 1 shown yet");
  check("tabs restored at start are not mounted until looked at", base.mountedPanes === 1 && base.officeFrames === 0, `${base.mountedPanes} view(s)`);
  // Project 1: each of its tabs is shown once (the strip shows the project's tabs).
  await toProject(oneTitle);
  await until(async () => await page!.getByRole("tab").count() >= docs.length);
  const before = await revisions();
  const perTab: Record<string, unknown>[] = [];
  let last = await measure("project 1 chosen (its tab in front mounted)");
  for (const name of [...names, ...(talk ? ["대화"] : [])]) {
    const strip = page.getByRole("tab");
    const index = name === "대화" ? await strip.count() - 1 : (await strip.allInnerTexts()).findIndex(text => text.includes(name));
    await strip.nth(index).click();
    if (name !== "대화") await until(async () => await page!.locator("section.pane:not([hidden]) iframe.office-frame").count() > 0, 60_000).catch(() => undefined);
    await pause(name.endsWith(".md") || name === "대화" ? 2500 : 7000);
    const now = await measure(`+ ${name} shown`);
    perTab.push({ tab: name, rssMb: now.rssMb - last.rssMb, heapMb: Math.round((now.heapMb - last.heapMb) * 10) / 10, nodes: now.mainDocNodes - last.mainDocNodes, officeFrames: now.officeFrames - last.officeFrames });
    last = now;
  }
  const awake = last;
  check("every tab of project 1 that was shown is mounted", awake.mountedPanes >= docs.length + 1, `${awake.mountedPanes} views, ${awake.officeFrames} office frames`);
  await pause(SLEEP_MS + 6000);
  const still = await measure(`project 1 still on screen ${Math.round((SLEEP_MS + 6000) / 1000)} s later`);
  check("in the project on screen its six most recently shown tabs stay mounted", still.mountedPanes === awake.mountedPanes, `${still.mountedPanes} views`);
  // To project 2: project 1's tabs are off screen.
  await toProject("연구 노트");
  await until(async () => await page!.locator("section.pane:not([hidden])").count() === 1 && await page!.locator('section.pane:not([hidden])[data-tab="tab-p2"]').count() === 1);
  // Tabs that were behind another for longer than the sleep time go at the next look of the timer; the one that was in front waits its own time.
  await measure("project 2 on screen, a moment after leaving project 1");
  await until(async () => await page!.locator("section.pane").count() === 1, SLEEP_MS + 90_000);
  await pause(3000);
  const asleep = await measure("project 1's tabs asleep");
  check("off screen for the sleep time: every view of project 1 is unmounted", asleep.mountedPanes === 1 && asleep.officeFrames === 0, `${asleep.mountedPanes} view, ${asleep.officeFrames} office frames`);
  const after = await revisions();
  check("no document was changed by sleeping (nothing was typed)", JSON.stringify(before) === JSON.stringify(after), `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  // Back: the tabs are there, the one in front is mounted again.
  await toProject(oneTitle);
  await until(async () => await page!.locator("section.pane:not([hidden])").count() === 1 && await page!.locator('section.pane:not([hidden])[data-tab="tab-p2"]').count() === 0);
  await pause(6000);
  const woken = await measure("back in project 1 (the tab in front woken)");
  check("back in project 1: all its tabs are on the strip, the one in front is mounted again", await page.getByRole("tab").count() >= docs.length && woken.mountedPanes === 2, `${await page.getByRole("tab").count()} tabs, ${woken.mountedPanes} views`);
  await page.screenshot({ path: join(shots, "project-1-after-waking.png") });
  writeFileSync(join(out, "memory.json"), JSON.stringify({ sleepMs: SLEEP_MS, rows, perTab, saved: { rssMb: still.rssMb - asleep.rssMb, heapMb: Math.round((still.heapMb - asleep.heapMb) * 10) / 10, nodes: still.mainDocNodes - asleep.mainDocNodes, officeFrames: still.officeFrames - asleep.officeFrames }, revisions: { before, after } }, null, 2));
  }
  // A woken document comes back where it was (office-leftovers point 3): Markdown scrolled down, Excel on a cell.
  {
    const place: Record<string, unknown> = {};
    const tabs = page.getByRole("tab");
    const show = async (name: string) => {
      await tabs.nth((await tabs.allInnerTexts()).findIndex(text => text.includes(name))).click();
      await page!.locator("section.pane:not([hidden]) iframe.office-frame").waitFor({ timeout: 60_000 });
    };
    const inFrame = async <T,>(fn: (arg: string) => T, arg = "") => { const handle = await page!.locator("section.pane:not([hidden]) iframe.office-frame").elementHandle(); const frame = await handle!.contentFrame(); return await frame!.evaluate(fn, arg); };
    const mdScroller = () => {
      let best: HTMLElement | null = null, area = 0;
      for (const el of document.querySelectorAll<HTMLElement>("body *")) {
        if (el.scrollHeight - el.clientHeight < 8 || !/(auto|scroll)/.test(getComputedStyle(el).overflowY) || !el.querySelector("[contenteditable], .ProseMirror")) continue;
        const r = el.getBoundingClientRect(); if (r.width * r.height > area) { best = el; area = r.width * r.height; }
      }
      return best;
    };
    await show("메모.md");
    await page.frameLocator("section.pane:not([hidden]) iframe.office-frame").locator('[contenteditable="true"]').first().waitFor({ timeout: 60_000 });
    await pause(2500);
    place.mdScrolledTo = await inFrame((src) => { const find = new Function(`return (${src})`)() as () => HTMLElement | null; const el = find(); if (!el) return null; el.scrollTop = 900; return Math.round(el.scrollTop); }, mdScroller.toString());
    await pause(2500);
    const scrollers = () => [...document.querySelectorAll<HTMLElement>("body *")].filter((el) => el.scrollHeight - el.clientHeight >= 8 && /(auto|scroll)/.test(getComputedStyle(el).overflowY + getComputedStyle(el).overflowX)).map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]} sh=${el.scrollHeight} ch=${el.clientHeight} st=${el.scrollTop} pm=${Boolean(el.querySelector("[contenteditable], .ProseMirror, .cm-content, iframe"))}`);
    place.mdScrollersBefore = await inFrame(scrollers);
    await show("재료.xlsx");
    await until(async () => Boolean(await inFrame(() => Boolean((window as unknown as { __workbenchUniverAPI?: unknown }).__workbenchUniverAPI))), 60_000).catch(() => undefined);
    await pause(3000);
    place.xlsxSet = await inFrame(() => { const api = (window as unknown as { __workbenchUniverAPI?: { getActiveWorkbook(): { getActiveSheet(): { getRange(a: string): { activate(): unknown } }; getActiveRange(): { getA1Notation(): string } | null } } }).__workbenchUniverAPI; const wb = api?.getActiveWorkbook(); wb?.getActiveSheet().getRange("C5").activate(); return wb?.getActiveRange()?.getA1Notation() ?? null; });
    await pause(2500);
    place.said = await page.evaluate(() => (window as unknown as { __viewPositions?: unknown[] }).__viewPositions ?? []);
    const stored = await api("/api/layouts/global") as Record<string, unknown>;
    const record = (stored.record ?? stored) as Record<string, unknown>;
    const layout = ((record.layout ?? record) as { panes?: { tabs?: { id: string; ui?: { office?: unknown } }[] }[] });
    place.kept = Object.fromEntries((layout.panes ?? []).flatMap(pane => pane.tabs ?? []).filter(tab => tab.ui?.office).map(tab => [tab.id, tab.ui!.office]));
    await page.screenshot({ path: join(shots, "position-before-sleep.png") });
    // The document's tab is in "편집기에 집중": back to the work screen (the list column) first.
    const listBack = page.getByRole("button", { name: /작업 화면으로/ }).filter({ visible: true });
    if (await listBack.count()) { await listBack.first().click(); await pause(600); }
    await toProject("연구 노트");
    await until(async () => await page!.locator('section.pane[data-tab="tab-d3"]').count() === 0 && await page!.locator('section.pane[data-tab="tab-d2"]').count() === 0, SLEEP_MS + 120_000).catch(() => { place.stayedAwake = true; });
    await toProject(oneTitle);
    await page.locator("section.pane:not([hidden]) iframe.office-frame").waitFor({ timeout: 60_000 });
    await pause(8000);
    place.xlsxAfterWaking = await inFrame(() => (window as unknown as { __workbenchUniverAPI?: { getActiveWorkbook(): { getActiveRange(): { getA1Notation(): string } | null } } }).__workbenchUniverAPI?.getActiveWorkbook()?.getActiveRange()?.getA1Notation() ?? null);
    await page.screenshot({ path: join(shots, "position-xlsx-after-waking.png") });
    await show("메모.md");
    await page.frameLocator("section.pane:not([hidden]) iframe.office-frame").locator('[contenteditable="true"]').first().waitFor({ timeout: 60_000 });
    await pause(5000);
    place.mdScrollersAfter = await inFrame(scrollers);
    place.mdAfterWaking = await inFrame((src) => { const find = new Function(`return (${src})`)() as () => HTMLElement | null; const el = find(); return el ? Math.round(el.scrollTop) : null; }, mdScroller.toString());
    await page.screenshot({ path: join(shots, "position-md-after-waking.png") });
    writeFileSync(join(out, "position.json"), JSON.stringify(place, null, 2));
    check("woken Markdown comes back at its scroll", !place.stayedAwake && typeof place.mdScrolledTo === "number" && (place.mdScrolledTo as number) > 0 && Math.abs((place.mdAfterWaking as number) - (place.mdScrolledTo as number)) <= 4, JSON.stringify(place));
    check("woken Excel comes back on its cell", !place.stayedAwake && place.xlsxSet === "C5" && place.xlsxAfterWaking === "C5", JSON.stringify(place));
  }
  if (only !== "position") {
  // Save before sleep, in the real Markdown editor: a sentence is typed, the window goes to project 2 with it unsaved.
  const typed: Record<string, unknown> = {};
  const SENTENCE = "잠들기 전에 쓴 문장";
  const memo = docs.find(doc => doc.name === "메모.md")!;
  const strip = page.getByRole("tab");
  await strip.nth((await strip.allInnerTexts()).findIndex(text => text.includes("메모.md"))).click();
  const editor = () => page!.frameLocator("section.pane:not([hidden]) iframe.office-frame").locator('[contenteditable="true"]').first();
  await editor().waitFor({ timeout: 60_000 });
  await pause(2500);
  await editor().click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.type(`${SENTENCE} `);
  await pause(1200);
  // The document's tab is in "편집기에 집중": back to the work screen (the list column), the document still in front.
  await page.getByRole("button", { name: /작업 화면으로/ }).first().click();
  await pause(600);
  typed.revisionWhenLeaving = (await revisions())["메모.md"];
  typed.fileHadItWhenLeaving = readFileSync(join(one, "메모.md"), "utf8").includes(SENTENCE);
  await toProject("연구 노트");
  await until(async () => await page!.locator('section.pane[data-tab="tab-d3"]').count() === 0, SLEEP_MS + 90_000);
  typed.revisionAsleep = (await revisions())["메모.md"];
  typed.fileHasItAsleep = readFileSync(join(one, "메모.md"), "utf8").includes(SENTENCE);
  typed.gatewayTextHasIt = String((await api(`/api/artifacts/${memo.id}/text`).catch(() => ({ text: "" }))).text ?? "").includes(SENTENCE);
  check("typed and left unsaved: the editor saved through its leave path before its view was taken down", typed.fileHasItAsleep === true, JSON.stringify(typed));
  await toProject(oneTitle);
  await editor().waitFor({ timeout: 60_000 });
  await pause(3000);
  typed.shownAfterWaking = (await editor().innerText()).includes(SENTENCE);
  typed.dialogs = await page.locator('[role="dialog"], [role="alertdialog"], dialog[open]').count();
  typed.noticeAfterWaking = (await page.locator('[role="status"], [role="alert"], .toast').filter({ visible: true }).allInnerTexts()).join(" | ").replace(/\s+/g, " ").slice(0, 200);
  check("woken: the document shows the saved sentence, and nothing was asked", typed.shownAfterWaking === true && typed.dialogs === 0, JSON.stringify(typed));
  await page.screenshot({ path: join(shots, "project-1-memo-after-waking.png") });
  // The same in the real Word editor.
  const word: Record<string, unknown> = {};
  const WORD_SENTENCE = "잠들기전에쓴워드문장";
  const docxText = (file: string) => execFileSync("python3", ["-I", "-c", "import sys,zipfile,re; print(re.sub(r'<[^>]+>', '', zipfile.ZipFile(sys.argv[1]).read('word/document.xml').decode('utf-8')))", file]).toString();
  await strip.nth((await strip.allInnerTexts()).findIndex(text => text.includes("보고서.docx"))).click();
  const wordFrame = () => page!.frameLocator("section.pane:not([hidden]) iframe.office-frame");
  await page.locator("section.pane:not([hidden]) iframe.office-frame").waitFor({ timeout: 60_000 });
  await pause(8000);
  word.editables = await wordFrame().locator('[contenteditable="true"]').count();
  word.canvases = await wordFrame().locator("canvas").count();
  word.innerFrames = await wordFrame().locator("iframe").count();
  const box = await page.locator("section.pane:not([hidden]) iframe.office-frame").boundingBox();
  if (word.editables) await wordFrame().locator('[contenteditable="true"]').first().click();
  else if (box) await page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height / 2, 320));
  await pause(500);
  await page.keyboard.press("Control+Home");
  await page.keyboard.type(`${WORD_SENTENCE} `, { delay: 30 });
  await pause(3500);
  word.saveStateTyped = await page.locator("section.pane:not([hidden]) .save-state").first().innerText().catch(() => "");
  word.frameHasItTyped = (await wordFrame().locator("body").innerText().catch(() => "")).includes(WORD_SENTENCE);
  await page.screenshot({ path: join(out, "word-typed.png") });
  const focusBack = page.getByRole("button", { name: /작업 화면으로/ }).filter({ visible: true });
  if (await focusBack.count()) await focusBack.first().click();
  await pause(600);
  word.revisionWhenLeaving = (await revisions())["보고서.docx"];
  word.fileHadItWhenLeaving = docxText(join(one, "보고서.docx")).includes(WORD_SENTENCE);
  await toProject("연구 노트");
  await until(async () => await page!.locator('section.pane[data-tab="tab-d0"]').count() === 0, SLEEP_MS + 120_000).catch(() => { word.stayedAwake = true; });
  word.revisionAsleep = (await revisions())["보고서.docx"];
  word.fileHasItAsleep = docxText(join(one, "보고서.docx")).includes(WORD_SENTENCE);
  check("Word: typed and left unsaved — the editor saved through its leave path before its view was taken down", word.frameHasItTyped === true && word.fileHadItWhenLeaving === false && word.fileHasItAsleep === true && !word.stayedAwake, JSON.stringify(word));
  await toProject(oneTitle);
  await page.locator("section.pane:not([hidden]) iframe.office-frame").waitFor({ timeout: 60_000 });
  await pause(8000);
  word.shownAfterWaking = (await wordFrame().locator("body").innerText().catch(() => "")).includes(WORD_SENTENCE);
  word.saveStateAfterWaking = await page.locator("section.pane:not([hidden]) .save-state").first().innerText().catch(() => "");
  word.dialogs = await page.locator('[role="dialog"], [role="alertdialog"], dialog[open]').count();
  check("Word, woken: the document shows the saved sentence, and nothing was asked", word.shownAfterWaking === true && word.dialogs === 0, JSON.stringify(word));
  await page.screenshot({ path: join(shots, "project-1-word-after-waking.png") });
  writeFileSync(join(out, "typed.json"), JSON.stringify({ markdown: typed, word }, null, 2));
  }
  check("no browser exceptions", errors.length === 0, errors.join("; "));
} catch (error) {
  check("tab sleep scenario", false, String(error));
  if (page) await page.screenshot({ path: join(out, "failure.png") }).catch(() => undefined);
} finally {
  await browser?.close();
  if (child && child.exitCode === null) { const exited = new Promise<void>(done => child!.once("exit", () => done())); child.kill("SIGTERM"); await exited; }
  writeFileSync(join(out, "results.json"), JSON.stringify({ results, errors, rows }, null, 2));
  console.log(`${results.filter(r => r.ok).length}/${results.length} passed`);
  if (results.some(r => !r.ok)) process.exitCode = 1;
}
