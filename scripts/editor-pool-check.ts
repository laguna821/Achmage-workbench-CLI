/// <reference lib="dom" />
// Rig check of the editor pool (0.5.4, brief editor-pool): Word documents in one window share their editor frame.
// The built gateway and UI in Chromium, a STAND-IN model (a local OpenAI-compatible endpoint: no real model, credential
// or outside host), fixture documents only.
//   a. five Word tabs opened one after another: ONE editor frame;
//   b. tab 2 edited (unsaved) and scrolled, another tab shown, tab 2 again: the edit, its "저장 안 됨" and its place are there;
//   c. a 문서 AI turn in tab 3 while tab 4 is looked at: tab 3 keeps its frame for the turn (two frames meanwhile), the turn
//      completes, tab 3 has the result, back to one frame;
//   d. two panes with two Word documents: two frames; one pane closed: one frame again;
//   e. the frame killed (its page reloaded under it) with unsaved edits: they come back from the recovery copy.
// Memory and timings are measured in WebKitGTK (scripts/perf/wk-editor-pool.py), not here.
// Usage (through ux/run-isolated.sh): node scripts/editor-pool-check.ts <outDir>
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Browser, type Frame, type Page } from "playwright-core";
import JSZip from "jszip";
import { editorFirst } from "./fixtures/editor-first.ts";

const out = resolve(process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? join(tmpdir(), "wb-editor-pool")); mkdirSync(out, { recursive: true });
const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice(7).split(",");
const part = (name: string) => !only || only.includes(name);
const dir = mkdtempSync(join(tmpdir(), "wb-editor-pool-"));
const results: { name: string; ok: boolean; detail?: string }[] = [];
const numbers: Record<string, unknown> = {};
const check = (name: string, ok: boolean, detail?: string) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
const waitFor = async (what: () => Promise<boolean>, ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { if (await what().catch(() => false)) return true; await wait(50); } return false; };

// ---- the stand-in model: [EDIT-n] inserts a paragraph with the marker through Word's own tool, then holds its final answer
const released = new Map<string, () => void>();
const server = createServer(async (req, res: ServerResponse) => {
  let raw = ""; for await (const part of req) raw += String(part);
  if (req.url === "/v1/models") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "pool-fixture" }] })); return; }
  if (req.url !== "/v1/chat/completions") { res.statusCode = 404; res.end(); return; }
  const body = JSON.parse(raw);
  const lastUser = JSON.stringify(body.messages.filter((message: { role: string }) => message.role === "user").at(-1)?.content ?? "");
  const marker = /\[(EDIT-\d+)\]/.exec(lastUser)?.[1] ?? "OTHER";
  res.setHeader("content-type", "text/event-stream");
  const send = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: marker, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  if (marker === "OTHER") { send({ content: "검사용 답입니다." }); send({}, "stop"); res.end("data: [DONE]\n\n"); return; }
  if (body.messages.at(-1)?.role === "tool") {
    send({ role: "assistant", content: `${marker} 고쳤습니다.` });
    await new Promise<void>((go) => released.set(marker, go));
    send({}, "stop"); res.end("data: [DONE]\n\n"); return;
  }
  send({ tool_calls: [{ index: 0, id: `call-${marker}`, type: "function", function: { name: "insert_content", arguments: JSON.stringify({ html: `<p>${marker}</p>`, afterBlockIndex: -1 }) } }] });
  send({}, "tool_calls"); res.end("data: [DONE]\n\n");
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address(); if (!address || typeof address === "string") throw Error("no fixture port");

let child: ChildProcess | null = null, browser: Browser | null = null, page: Page | null = null;
const errors: string[] = [];
try {
  child = spawn(process.execPath, ["apps/host/dist/host.mjs"], { env: { ...process.env,
    WORKBENCH_DATA_DIR: dir, WORKBENCH_HOST_ID: "fixture", WORKBENCH_IEUM_BOOTSTRAP: "0", WORKBENCH_WEB_DIR: resolve(process.env.POOL_WEB_DIR ?? "apps/web/dist"),
    WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"), WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"), WORKBENCH_VAULT_SUGGEST: "",
  }, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr!.on("data", (data) => writeFileSync(join(out, "host.log"), data, { flag: "a" }));
  const ready = await new Promise<{ url: string; token: string }>((done, fail) => {
    const timer = setTimeout(() => fail(Error("gateway start timeout")), 30_000);
    child!.once("exit", (code) => { clearTimeout(timer); fail(Error(`gateway exited: ${code}`)); });
    createInterface({ input: child!.stdout! }).on("line", (line) => { if (line.startsWith("WORKBENCH_READY ")) { clearTimeout(timer); done(JSON.parse(line.slice(16))); } });
  });
  const api = async (path: string, method = "GET", body?: unknown) => {
    const r = await fetch(`${ready.url}${path}`, { method, headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await r.json(); if (!r.ok) throw Error(`${path}: ${r.status} ${result.message}`); return result;
  };
  const work = await api("/api/works", "POST", { title: "편집기 풀 검사", cwd: null });
  const main = await api(`/api/works/${work.id}/sessions`, "POST", { provider: "codex", purpose: "메인 채팅" });
  // Five Word documents long enough to scroll, each with its own first line.
  const source = await JSZip.loadAsync(readFileSync(resolve("vendor/ieumoffice/apps/docs/tests/pagination-corpus/docx/simple.docx")));
  const xml = await source.file("word/document.xml")!.async("string");
  const docs: { id: string }[] = [];
  for (let n = 1; n <= 5; n += 1) {
    const zip = await JSZip.loadAsync(readFileSync(resolve("vendor/ieumoffice/apps/docs/tests/pagination-corpus/docx/simple.docx")));
    const lines = `<w:p><w:r><w:t>문서${n} 첫 줄</w:t></w:r></w:p>` + Array.from({ length: 120 }, (_, i) => `<w:p><w:r><w:t>문서${n} 문단 ${i + 1}. 스크롤이 되는지 보는 줄입니다.</w:t></w:r></w:p>`).join("");
    zip.file("word/document.xml", xml.replace(/<w:sectPr/, `${lines}<w:sectPr`));
    writeFileSync(join(work.cwd, `문서${n}.docx`), await zip.generateAsync({ type: "nodebuffer" }));
    docs.push(await api(`/api/works/${work.id}/artifacts`, "POST", { path: join(work.cwd, `문서${n}.docx`) }));
  }
  const config = await api("/api/office-ai/settings");
  config.settings.provider = "custom"; config.settings.subscriptionNoticeSeen = true; config.settings.customEndpoint = "fixture";
  config.settings.customEndpoints = [{ id: "fixture", name: "Local fixture", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "", model: "pool-fixture", kind: "local", modelProfiles: { "pool-fixture": { tools: true, toolsSource: "user", contextLength: 1000000, contextSource: "user" } } }];
  mkdirSync(join(dir, "office"), { recursive: true }); writeFileSync(join(dir, "office/ai-settings.json"), JSON.stringify(config.settings));
  await api(`/api/works/${work.id}`, "PATCH", { activeSessionId: main.id });
  const tabs = [{ id: "main", workId: work.id, sessionId: main.id, view: { kind: "work" } },
    ...docs.map((doc, index) => ({ id: `doc-${index + 1}`, workId: work.id, sessionId: null, view: { kind: "document", artifactId: doc.id, proposalId: null } }))];
  await api("/api/layouts/global", "PUT", { expectedRevision: 0, layout: { version: 2, focus: "p", panes: [{ ...tabs[0], id: "p", tabs, activeTabId: "main", recentTabIds: ["main"] }] } });
  await api("/api/prefs", "PUT", { prefs: { onboarding: "done", layoutScope: "global", startScreen: "last", sidebar: true } });

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript((id) => localStorage.setItem("workbench.lastWork", id), work.id);
  await editorFirst(context);
  // --pool=off: the per-tab frames of 0.5.3 (the before of the comparison).
  if (process.argv.includes("--pool=off")) await context.addInitScript(() => localStorage.setItem("workbench.pool.docs", "off"));
  // --recent=N: the recent frames per kind (default: by memory). a–e are the one-frame checks (run with --recent=0); f is N = 2.
  const recentArg = process.argv.find((arg) => arg.startsWith("--recent="))?.slice(9);
  if (recentArg !== undefined) await context.addInitScript((n) => localStorage.setItem("workbench.pool.recent", n), recentArg);
  page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("crash", () => errors.push("page crashed"));
  await page.goto(`${ready.url}/?token=${ready.token}`);
  await page.locator("section.pane:not([hidden])").first().waitFor({ timeout: 60_000 });

  const poolFrames = () => page!.locator(".editor-pool iframe").count();
  const shownFrame = async (tab?: string): Promise<Frame | null> => {
    const pooledFrame = `.editor-pool iframe[data-pool-shown="true"]${tab ? `[data-tab="${tab}"]` : ""}`, ownFrame = `section.pane:not([hidden])${tab ? `[data-tab="${tab}"]` : ""} iframe.office-frame`;
    const handle = await page!.locator(`${pooledFrame}, ${ownFrame}`).first().elementHandle({ timeout: 2_000 }).catch(() => null);
    return handle ? handle.contentFrame() : null;
  };
  const textOf = async (tab?: string) => (await shownFrame(tab))?.evaluate(() => document.querySelector(".tiptap, .ProseMirror")?.textContent ?? "").catch(() => "") ?? "";
  const activate = async (id: string) => {
    const onStrip = page!.locator(`.pane[data-pane-active="true"] .group-tab[data-tab-id="${id}"] [role="tab"]`);
    if (await onStrip.waitFor({ timeout: 5_000 }).then(() => true, () => false)) await onStrip.click();
    else {
      await page!.locator('.pane[data-pane-active="true"] .group-tab-more').click();
      await page!.locator('.group-tab-list [role^="menuitem"]:not([aria-disabled="true"])').filter({ hasText: id === "main" ? "메인 채팅" : `문서${id.slice(4)}` }).first().click();
    }
  };
  /** Show the tab and wait until its document is drawn in the frame on screen; the time it took. */
  const show = async (n: number) => {
    const t = Date.now();
    await activate(`doc-${n}`);
    const ok = await waitFor(async () => (await textOf(`doc-${n}`)).includes(`문서${n} 첫 줄`) && (process.argv.includes("--pool=off") || await page!.locator(`.editor-pool iframe[data-pool-shown="true"][data-tab="doc-${n}"]`).evaluate((el) => (el as HTMLElement).style.opacity === "1")), 90_000);
    return ok ? Date.now() - t : null;
  };
  const saveLabel = (n: number) => page!.locator(`section.pane[data-tab="doc-${n}"]`).first().innerText().then((text) => /저장 안 됨/.test(text)).catch(() => false);
  const shot = (name: string) => page!.screenshot({ path: join(out, `${name}.png`) });

  // ---- w. warm at restore: the conversation is in front; the Word tab last shown (here the first) starts its editor behind
  if (part("w")) {
    const warmed = await waitFor(async () => await poolFrames() === 1, 30_000);
    const warmTab = await page.locator(".editor-pool iframe").first().getAttribute("data-tab").catch(() => null);
    numbers.wDom = await page.evaluate(() => [...document.querySelectorAll("section.pane")].map((el) => `${el.getAttribute("data-tab")} hidden=${(el as HTMLElement).hidden} slot=${el.querySelectorAll(".office-slot").length} reading=${el.querySelectorAll(".doc-reading").length}`));
    const firstShow = await show(1);
    numbers.w = { warmed, warmTab, firstShowMs: firstShow, frames: await poolFrames() };
    check("w. at restore one Word editor is started behind (only Word, only one), for the tab shown last", warmed && await poolFrames() === 1, JSON.stringify(numbers.w));
  }

  // ---- a. five Word tabs: one frame -------------------------------------------------------------------------------
  if (part("a")) {
  const opens: (number | null)[] = [];
  for (let n = 1; n <= 5; n += 1) opens.push(await show(n));
  numbers.openMs = opens;
  check("a. five Word tabs opened one after another, each shown", opens.every((ms) => ms !== null), JSON.stringify(opens));
  await wait(4_000);
  check("a. five Word tabs: ONE editor frame", await poolFrames() === 1, `${await poolFrames()} frames`);
  const switches: (number | null)[] = [];
  for (const n of [1, 5, 2, 4, 3]) switches.push(await show(n));
  numbers.switchMs = switches;
  check("a. going between them stays one frame", await poolFrames() === 1 && switches.every((ms) => ms !== null), `${await poolFrames()} frames, ${JSON.stringify(switches)} ms`);
  await shot("a-five-tabs");
  }

  // ---- f. the documents worked between stay live (N = 2 recent frames) ------------------------------------------
  if (part("f")) {
    const undoMark = "되돌리기검사표시";
    await show(1);
    await (await shownFrame("doc-1"))!.evaluate((text) => { const el = document.querySelector<HTMLElement>(".tiptap p, .ProseMirror p")!; el.focus(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(true); const s = getSelection()!; s.removeAllRanges(); s.addRange(r); document.execCommand("insertText", false, text); }, undoMark);
    await waitFor(async () => (await textOf("doc-1")).includes(undoMark), 5_000);
    const elementOf = (tab: string) => page!.locator(`.editor-pool iframe[data-tab="${tab}"]`).first().evaluate((el) => { (el as HTMLElement).dataset.probe ??= String(Math.random()); return (el as HTMLElement).dataset.probe!; }).catch(() => null);
    const before = await elementOf("doc-1");
    await show(2);
    const backMs = await show(1);
    const after = await elementOf("doc-1");
    // Undo in the same editor: the typed text goes.
    const f1 = (await shownFrame("doc-1"))!;
    await f1.evaluate(() => document.querySelector<HTMLElement>(".tiptap, .ProseMirror")!.focus());
    await page.keyboard.press("Control+z");
    const undone = await waitFor(async () => !(await textOf("doc-1")).includes(undoMark), 5_000);
    numbers.f = { backMs, sameFrame: before !== null && before === after, undone, frames: await poolFrames() };
    check("f. back to a recent document: the same live editor, under ~300 ms", Boolean(before && before === after) && backMs !== null && backMs <= 400, JSON.stringify(numbers.f));
    check("f. its undo works after going to another Word document and back", undone, JSON.stringify(numbers.f));
    // Doc 2 edited, then 3 and 4 shown: with N = 2 the oldest off-screen document (2) is parked; its edit is still there.
    await show(2);
    const parkMark = "가장오래된문서표시";
    await (await shownFrame("doc-2"))!.evaluate((text) => { const el = document.querySelector<HTMLElement>(".tiptap p, .ProseMirror p")!; el.focus(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(true); const s = getSelection()!; s.removeAllRanges(); s.addRange(r); document.execCommand("insertText", false, text); }, parkMark);
    await waitFor(async () => (await textOf("doc-2")).includes(parkMark), 5_000);
    await show(1); await show(3); await show(4);
    await wait(4_000);
    const framesNow = await poolFrames();
    const doc2Live = await page.locator('.editor-pool iframe[data-tab="doc-2"]').count();
    await show(2);
    const survived = await waitFor(async () => (await textOf("doc-2")).includes(parkMark), 15_000);
    numbers.f2 = { framesNow, doc2Live, survived };
    check("f. a 4th document: three frames at most, the oldest (2) parked", framesNow <= 3 && doc2Live === 0, JSON.stringify(numbers.f2));
    check("f. the parked document's edit survives", survived, JSON.stringify(numbers.f2));
    await shot("f-recent");
  }

  // ---- b. an unsaved edit and the place survive a switch ---------------------------------------------------------
  if (part("b")) {
  await show(2);
  const typed = "풀검사입력표시";
  {
    const f = (await shownFrame("doc-2"))!;
    await f.evaluate((text) => { const el = document.querySelector<HTMLElement>(".tiptap p, .ProseMirror p")!; el.focus(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(true); const s = getSelection()!; s.removeAllRanges(); s.addRange(r); document.execCommand("insertText", false, text); }, typed);
    await waitFor(() => saveLabel(2), 10_000);
    await f.evaluate(() => { const el = document.querySelector<HTMLElement>(".editor-scroll")!; el.scrollTop = 1500; });
    await wait(2_500);
  }
  const revisionOf = async (n: number) => { const snap = await api("/api/snapshot") as { artifacts: Record<string, { id: string; revision: number }> | { id: string; revision: number }[] }; return (Array.isArray(snap.artifacts) ? snap.artifacts : Object.values(snap.artifacts)).find((entry) => entry.id === docs[n - 1]!.id)!.revision; };
  const revisionBefore = await revisionOf(2);
  const placeBefore = await (await shownFrame("doc-2"))!.evaluate(() => Math.round(document.querySelector<HTMLElement>(".editor-scroll")!.scrollTop));
  const unsavedBefore = await saveLabel(2);
  await show(3);
  await wait(1_000);
  const unsavedWhileAway = await saveLabel(2);
  const revisionAway = await revisionOf(2);
  await show(2);
  await waitFor(async () => (await textOf("doc-2")).includes(typed), 15_000);
  await wait(2_000);
  const placeAfter = await (await shownFrame("doc-2"))!.evaluate(() => Math.round(document.querySelector<HTMLElement>(".editor-scroll")!.scrollTop));
  const editBack = (await textOf("doc-2")).includes(typed);
  numbers.b = { revisionBefore, revisionAway, placeBefore, placeAfter, unsavedBefore, unsavedWhileAway, editBack, unsavedAfter: await saveLabel(2) };
  check("b. the unsaved edit is back after another document took the frame", editBack, JSON.stringify(numbers.b));
  // Showing another tab saves a Word tab's edits (the leave path, as in 0.5.3 — measured the same with --pool=off): nothing
  // is lost and nothing reads unsaved afterwards. (The pool's own keeping of edits that were NOT saved on leaving — the
  // recovery copy written at the park — is OfficeEditor.pool.test.tsx's and e. below.)
  check("b. 저장 안 됨 while edited; leaving saved it as a new revision (as 0.5.3 does); no mark afterwards", unsavedBefore && revisionAway > revisionBefore && !unsavedWhileAway && !(await saveLabel(2)), JSON.stringify(numbers.b));
  check("b. the place comes back", Math.abs(placeAfter - placeBefore) <= 40 && placeBefore > 500, `${placeBefore} → ${placeAfter}`);
  check("b. one frame", await poolFrames() === 1, `${await poolFrames()}`);
  await shot("b-edit-back");
  }

  // ---- c. a 문서 AI turn in tab 3 while tab 4 is looked at -------------------------------------------------------
  if (part("c")) {
  await show(3);
  {
    const headKey = page.locator('.pane[data-pane-active="true"] .doc-header-right .doc-agent-toggle');
    const f = (await shownFrame("doc-3"))!;
    await f.waitForSelector(".ai-dock, .copilot", { timeout: 30_000 });
    await wait(800);
    if ((await headKey.getAttribute("aria-expanded")) !== "true") await headKey.click();
    await f.waitForSelector(".ai-dock:not(.collapsed) textarea, .copilot:not(.collapsed) textarea", { timeout: 20_000 });
    const box = f.locator(".ai-dock:not(.collapsed) textarea, .copilot:not(.collapsed) textarea").first();
    await box.fill("[EDIT-1] 고쳐 줘"); await box.press("Enter");
  }
  const edited = await waitFor(async () => released.has("EDIT-1"), 90_000);
  const liveEdit = await waitFor(async () => (await textOf("doc-3")).includes("EDIT-1"), 15_000);
  await show(4);
  await wait(1_500);
  const framesDuringTurn = await poolFrames();
  released.get("EDIT-1")?.();
  const sessionOf = async () => (await api("/api/snapshot")).sessions.find((s: { documentAgent?: { artifactId?: string } }) => s.documentAgent?.artifactId === docs[2]!.id)?.id as string | undefined;
  const completed = await waitFor(async () => { const id = await sessionOf(); return Boolean(id) && (await api(`/api/sessions/${id}/items`)).items.some((item: { kind: string; status?: string }) => item.kind === "turnEnd" && item.status === "completed"); }, 60_000);
  const backToOne = await waitFor(async () => await poolFrames() === 1, 30_000);
  await show(3);
  const result = await waitFor(async () => (await textOf("doc-3")).includes("EDIT-1"), 20_000);
  numbers.c = { edited, liveEdit, framesDuringTurn, completed, backToOne, result };
  check("c. the turn ran live in tab 3's editor (its edit visible there)", edited && liveEdit, JSON.stringify(numbers.c));
  check("c. tab 3 kept its frame for the turn while tab 4 was shown (two frames meanwhile)", framesDuringTurn === 2, JSON.stringify(numbers.c));
  check("c. the turn completed, tab 3 has the result, back to one frame", completed && result && backToOne, JSON.stringify(numbers.c));
  await shot("c-turn-result");
  }

  // ---- e. the frame killed with unsaved edits: recovery --------------------------------------------------------
  if (part("e")) {
  await show(5);
  const killMark = "프레임종료전입력";
  {
    const f = (await shownFrame("doc-5"))!;
    await f.evaluate((text) => { const el = document.querySelector<HTMLElement>(".tiptap p, .ProseMirror p")!; el.focus(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(true); const s = getSelection()!; s.removeAllRanges(); s.addRange(r); document.execCommand("insertText", false, text); }, killMark);
    await waitFor(() => saveLabel(5), 10_000);
    // The editor's own recovery copy is written every 30 s while there are unsaved edits.
    await wait(35_000);
    // A crash of the editor takes the window with it in WebKitGTK (one web process): the window is loaded again.
    // (Reloading only the Word page in place grows without bound in Chromium — the same with --pool=off, 0.5.3 —
    // so that is not the simulation here.)
    // As a crash: no unload handler runs (nothing is saved on the way out), then the app opens again.
    await page.close({ runBeforeUnload: false });
    page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${ready.url}/?token=${ready.token}`);
    await page.locator("section.pane:not([hidden])").first().waitFor({ timeout: 60_000 });
  }
  const recovered = await waitFor(async () => (await textOf("doc-5")).includes(killMark), 60_000);
  await wait(1_500);
  numbers.e = { recovered, unsaved: await saveLabel(5), revision: await (async () => { const snap = await api("/api/snapshot") as { artifacts: Record<string, { id: string; revision: number }> | { id: string; revision: number }[] }; return (Array.isArray(snap.artifacts) ? snap.artifacts : Object.values(snap.artifacts)).find((entry) => entry.id === docs[4]!.id)!.revision; })() };
  check("e. the window (and its editor frame) gone with unsaved edits: they come back from the recovery copy, still unsaved, not saved behind the person's back", recovered && await saveLabel(5) && (numbers.e as { revision: number }).revision === 1, JSON.stringify(numbers.e));
  await shot("e-recovered");
  // Leave nothing unsaved for the layout reload below (the person's own 저장).
  await page.keyboard.press("Control+s").catch(() => undefined);
  }
  for (const n of [2, 5]) { await show(n); await (await shownFrame(`doc-${n}`))?.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true }))).catch(() => undefined); await waitFor(async () => !(await saveLabel(n)), 20_000); }

  // ---- d. two panes: two frames; one pane again: one frame -----------------------------------------------------
  if (part("d")) {
    const revision = (await api("/api/layouts/global")).record?.revision ?? 0;
    const left = [tabs[0]!, tabs[4]!], right = [tabs[5]!];
    await api("/api/layouts/global", "PUT", { expectedRevision: revision, layout: { version: 2, focus: "l", grid: 2, panes: [
      { ...left[1], id: "l", tabs: left, activeTabId: "doc-4", recentTabIds: ["doc-4"] }, { ...right[0], id: "r", tabs: right, activeTabId: "doc-5", recentTabIds: ["doc-5"] }] } });
    // Wide enough for two Word pages side by side (a narrower window folds the panes to one at a time).
    await page.setViewportSize({ width: 2400, height: 1000 });
    await page.reload();
    // A pane restored zoomed ("이 칸 확대") shows alone: back to both.
    await page.locator('section.pane').first().waitFor({ timeout: 60_000 });
    await wait(2_000);
    const zoomed = page.locator('button[aria-label="전체 칸 보기"]').first();
    if (await zoomed.count()) await zoomed.click();
    const two = await waitFor(async () => (await textOf("doc-4")).includes("문서4 첫 줄") && (await textOf("doc-5")).includes("문서5 첫 줄"), 90_000);
    const panes = await page.locator("section.pane:not([hidden])").count();
    numbers.dDom = await page.evaluate(() => ({ cls: document.querySelector(".panes")?.className, w: document.querySelector(".panes")?.clientWidth, sections: [...document.querySelectorAll("section.pane")].map((el) => `${el.getAttribute("data-tab")} ${el.getAttribute("data-pane")} hidden=${(el as HTMLElement).hidden} ${(el as HTMLElement).style.width}`) }));
    console.log("d dom", JSON.stringify(numbers.dDom));
    numbers.d = { two, panes, frames: await poolFrames() };
    check("d. two panes with two Word documents: both shown, two frames", two && panes === 2 && await poolFrames() === 2, JSON.stringify(numbers.d));
    await shot("d-two-panes");
    const close = page.locator('section.pane[data-tab="doc-5"] .pane-head button[aria-label$="칸 닫기"]');
    // Nothing of the pool lies over a pane's head (the frames cover only their slot).
    numbers.dHead = await close.evaluate((el) => { const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { top: top ? `${top.tagName}.${String(top.className).slice(0, 40)}` : null, self: top === el || el.contains(top), visible: r.width > 0 && r.height > 0 }; });
    console.log("d head", JSON.stringify(numbers.dHead));
    await close.click({ timeout: 5_000 }).catch(() => close.evaluate((el) => (el as HTMLElement).click()));
    const one = await waitFor(async () => await poolFrames() === 1 && await page!.locator("section.pane:not([hidden])").count() === 1, 30_000);
    check("d. one pane closed: one frame again", one, `${await poolFrames()} frames`);
  }
} catch (error) {
  check("run", false, error instanceof Error ? error.stack?.split("\n").slice(0, 4).join(" | ") : String(error));
  if (page) await page.screenshot({ path: join(out, "failure.png") }).catch(() => undefined);
} finally {
  writeFileSync(join(out, "results.json"), JSON.stringify({ results, numbers, errors }, null, 1));
  await browser?.close().catch(() => undefined);
  child?.kill();
  server.close();
}
const failed = results.filter((result) => !result.ok);
console.log(failed.length ? `FAILED ${failed.length}: ${failed.map((result) => result.name).join("; ")}` : `all ${results.length} passed`);
process.exit(failed.length ? 1 : 0);
