/// <reference lib="dom" />
// Rig check of the editor pool for Excel (0.5.4, round 2): workbooks in one window share their editor frame
// (run with --recent=0 so every switch swaps). s1 three workbooks, one frame, each its own; s2 an edit (a cell set) and
// the active cell survive a swap; s3 a 문서 AI turn in workbook 3 while workbook 4 is shown keeps its frame and its
// result lands in workbook 3; s4 no error said to the person. Built from editor-pool-slides-check.ts.
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
  const tools = body.messages.filter((message: { role: string }) => message.role === "tool");
  if (tools.length === 1) {
    const id = /id=([\w-]+)/.exec(JSON.stringify(tools[0]!.content ?? ""))?.[1];
    send({ tool_calls: [{ index: 0, id: `call2-${marker}`, type: "function", function: { name: "propose_operations", arguments: JSON.stringify({ operations: [{ op: "set_cell", sheetId: id, address: "A2", value: marker }], summary: marker }) } }] });
    send({}, "tool_calls"); res.end("data: [DONE]\n\n"); return;
  }
  if (tools.length >= 2) {
    send({ role: "assistant", content: `${marker} 고쳤습니다.` });
    await new Promise<void>((go) => released.set(marker, go));
    send({}, "stop"); res.end("data: [DONE]\n\n"); return;
  }
  send({ tool_calls: [{ index: 0, id: `call-${marker}`, type: "function", function: { name: "get_workbook_context", arguments: "{}" } }] });
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
  // Four workbooks, each with its own first cell.
  const book = readFileSync(resolve("scripts/fixtures/supplies.xlsx"));
  const docs: { id: string }[] = [];
  for (let n = 1; n <= 4; n += 1) {
    const zip = await JSZip.loadAsync(book);
    const xml = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    zip.file("xl/worksheets/sheet1.xml", xml.replace(">항목<", `>통합${n} 항목<`));
    writeFileSync(join(work.cwd, `통합${n}.xlsx`), await zip.generateAsync({ type: "nodebuffer" }));
    docs.push(await api(`/api/works/${work.id}/artifacts`, "POST", { path: join(work.cwd, `통합${n}.xlsx`) }));
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
  // PowerPoint is pooled where turned on (until it is the default): --default leaves the switch as shipped.
  if (!process.argv.includes("--default")) await context.addInitScript(() => localStorage.setItem("workbench.pool.sheets", "on"));
  // --recent=N: the recent frames per kind (default: by memory). a–e are the one-frame checks (run with --recent=0); f is N = 2.
  const recentArg = process.argv.find((arg) => arg.startsWith("--recent="))?.slice(9);
  if (recentArg !== undefined) await context.addInitScript((n) => localStorage.setItem("workbench.pool.recent", n), recentArg);
  page = await context.newPage();
  await context.addInitScript(() => { if (window.top !== window) return; const w = window as unknown as { __errors: string[]; __mcp: Record<string, unknown> }; w.__errors = []; w.__mcp = {}; window.addEventListener("message", (event) => { const d = event.data as { type?: string; message?: string; requestId?: string; reply?: unknown }; if (d?.type === "office:error") w.__errors.push(String(d.message)); if (d?.type === "office:mcp-result" && d.requestId) w.__mcp[d.requestId] = d.reply; }); });
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
  type Uni = { getActiveWorkbook(): { getActiveSheet(): { getRange(a: string): { getValue(): unknown; setValue(v: unknown): unknown; activate(): unknown } }; getActiveRange(): { getA1Notation(): string } | null } | null };
  const cell = async (tab: string, address: string) => (await shownFrame(tab))?.evaluate((a) => String((window as unknown as { __workbenchUniverAPI?: Uni }).__workbenchUniverAPI?.getActiveWorkbook()?.getActiveSheet().getRange(a).getValue() ?? ""), address).catch(() => "") ?? "";
  const textOf = async (tab?: string) => cell(tab ?? "", "A1");
  const activeCell = async (tab: string) => (await shownFrame(tab))?.evaluate(() => (window as unknown as { __workbenchUniverAPI?: Uni }).__workbenchUniverAPI?.getActiveWorkbook()?.getActiveRange()?.getA1Notation() ?? null).catch(() => null) ?? null;
  const activate = async (id: string) => {
    const onStrip = page!.locator(`.pane[data-pane-active="true"] .group-tab[data-tab-id="${id}"] [role="tab"]`);
    if (await onStrip.waitFor({ timeout: 5_000 }).then(() => true, () => false)) await onStrip.click();
    else {
      await page!.locator('.pane[data-pane-active="true"] .group-tab-more').click();
      await page!.locator('.group-tab-list [role^="menuitem"]:not([aria-disabled="true"])').filter({ hasText: id === "main" ? "메인 채팅" : `통합${id.slice(4)}` }).first().click();
    }
  };
  /** Show the tab and wait until its document is drawn in the frame on screen; the time it took. */
  const show = async (n: number) => {
    const t = Date.now();
    await activate(`doc-${n}`);
    const ok = await waitFor(async () => (await textOf(`doc-${n}`)).includes(`통합${n}`) && (process.argv.includes("--pool=off") || await page!.locator(`.editor-pool iframe[data-pool-shown="true"][data-tab="doc-${n}"]`).evaluate((el) => (el as HTMLElement).style.opacity === "1")), 90_000);
    return ok ? Date.now() - t : null;
  };
  const saveLabel = (n: number) => page!.locator(`section.pane[data-tab="doc-${n}"]`).first().innerText().then((text) => /저장 안 됨/.test(text)).catch(() => false);
  const shot = (name: string) => page!.screenshot({ path: join(out, `${name}.png`) });


  // ---- s1. three decks, one frame, each shows its own --------------------------------------------------------------
  const opens: (number | null)[] = [];
  for (const n of [1, 2, 3]) opens.push(await show(n));
  numbers.openMs = opens;
  check("s1. three workbooks shown in turn, each its own first cell", opens.every((ms) => ms !== null), JSON.stringify(opens) + " " + (await textOf()).slice(0, 120));
  check("s1. one editor frame", await poolFrames() === 1, `${await poolFrames()} frames`);
  const switches: (number | null)[] = [];
  for (const n of [1, 3, 2]) switches.push(await show(n));
  numbers.switchMs = switches;
  check("s1. switches swap the deck in place (one frame)", switches.every((ms) => ms !== null) && await poolFrames() === 1, JSON.stringify(switches));

  // ---- s2. an edit and the active cell survive a swap ------------------------------------------------------------
  await show(2);
  const mark = "풀편집표시";
  await (await shownFrame("doc-2"))!.evaluate((m) => { const wb = (window as unknown as { __workbenchUniverAPI?: Uni }).__workbenchUniverAPI!.getActiveWorkbook()!; wb.getActiveSheet().getRange("B6").setValue(m); wb.getActiveSheet().getRange("C3").activate(); }, mark);
  const unsaved = await waitFor(() => saveLabel(2), 10_000);
  await wait(2_500);
  await show(3);
  await show(2);
  await wait(2_500);
  numbers.s2 = { unsaved, value: await cell("doc-2", "B6"), active: await activeCell("doc-2") };
  check("s2. the edit (a cell set before leaving) is there after the swap", (numbers.s2 as { value: string }).value === mark, JSON.stringify(numbers.s2));
  check("s2. the active cell comes back (C3)", (numbers.s2 as { active: string | null }).active === "C3", JSON.stringify(numbers.s2));

  // ---- s3. a 문서 AI turn in workbook 3 while workbook 4 is shown --------------------------------------------------
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
  const liveEdit = await waitFor(async () => (await cell("doc-3", "A2")) === "EDIT-1", 15_000);
  await show(4);
  await wait(1_500);
  const framesDuringTurn = await poolFrames();
  released.get("EDIT-1")?.();
  const sessionOf = async () => (await api("/api/snapshot")).sessions.find((s: { documentAgent?: { artifactId?: string } }) => s.documentAgent?.artifactId === docs[2]!.id)?.id as string | undefined;
  const completed = await waitFor(async () => { const id = await sessionOf(); return Boolean(id) && (await api(`/api/sessions/${id}/items`)).items.some((item: { kind: string; status?: string }) => item.kind === "turnEnd" && item.status === "completed"); }, 60_000);
  const backToOne = await waitFor(async () => await poolFrames() === 1, 30_000);
  await show(3);
  const result = await waitFor(async () => (await cell("doc-3", "A2")) === "EDIT-1", 20_000);
  numbers.s3 = { edited, liveEdit, framesDuringTurn, completed, backToOne, result };
  check("s3. the turn ran live in workbook 3 (its cell set there)", edited && liveEdit, JSON.stringify(numbers.s3));
  check("s3. workbook 3 kept its frame for the turn while workbook 4 was shown", framesDuringTurn === 2, JSON.stringify(numbers.s3));
  check("s3. the turn completed, workbook 3 has the result, back to one frame", completed && result && backToOne, JSON.stringify(numbers.s3));

  // ---- s4. nothing said wrongly ------------------------------------------------------------------------------------
  const said = await page.evaluate(() => (window as unknown as { __errors: string[] }).__errors);
  check("s4. no editor error during the swaps", said.length === 0, JSON.stringify(said).slice(0, 300));
  await shot("sheets-final");
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
