/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// Rig check of what the Hangul tab gained with IeumOffice v0.13.0's renderer (unit hwp13, brief point 4): the built
// gateway and UI in Chromium, two .hwpx documents made here with the one engine, and a STAND-IN engine for the
// document AI (a local OpenAI-compatible endpoint — no real model, credential or outside host).
//   nested  H1  tables inside tables: a row, a column, merge and split, a cell border, all in the inner table
//   keys    H2  the table keys: F5 cell block, 표 자동 채우기 (A)
//   picture H3  a picture moved with the arrow keys and cropped with Shift + a corner
//   paste   H4  a table and a picture copied from one Hangul document and pasted into another
//   hanja   H5  한자로 바꾸기 (F9) with the seeded dictionary
//   print   H6  Ctrl+P opens 인쇄 미리 보기; its 인쇄 goes to Workbench's print (office:output print)
//   check   H8  공문서 규칙 검사 runs; "AI에게 맡기기" reaches the dock, and the request reaches the engine
//   info    H9  문서 정보 (글자 수) and the status bar's count
//   tools   H14 the new AI tools in the engine's list (and the three not offered absent); a turn calls three
//   menu        File menu: no 열기 / PDF 가져오기; Save, Save As, PDF, Print Preview and Print there
// Frames → outDir. Usage (through ux/run-isolated.sh): node scripts/hwp-0130-check.ts <outDir> [--only=a,b]
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { crc32, deflateSync } from "node:zlib";
import { chromium, type Frame } from "playwright-core";
import init, { HwpDocument } from "../third_party/hop/engine.ts";
import { hwpWasmPath } from "../apps/host/src/hwp-resource.ts";
import { editorFirst } from "./fixtures/editor-first.ts";

const args = process.argv.slice(2);
const outDir = resolve(args.find((arg) => !arg.startsWith("--")) ?? join(tmpdir(), "wb-hwp-0130"));
const only = args.find((arg) => arg.startsWith("--only="))?.slice(7).split(",");
const want = (name: string) => !only || only.includes(name);
mkdirSync(outDir, { recursive: true });
const results: { step: string; ok: boolean; detail: string }[] = [];
const check = (step: string, ok: boolean, detail = "") => {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const waitFor = async (what: () => Promise<boolean>, ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { if (await what().catch(() => false)) return true; await sleep(250); } return false; };

// ---- the documents (the one engine, as the gateway runs it) ---------------------------------------------
await init({ module_or_path: readFileSync(hwpWasmPath()) });
function png(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, "latin1");
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, sum]);
  };
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const at = y * (width * 3 + 1) + 1 + x * 3; raw[at] = 40 + x * 3; raw[at + 1] = 120; raw[at + 2] = 200 - y * 3; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}
/** A: a table with a table in its first cell; a 1 × 4 table for 자동 채우기; a word for 한자; a picture. */
function documentA(): { bytes: Uint8Array; nestedPara: number; fillPara: number; hanjaPara: number; picturePara: number } {
  const doc = HwpDocument.createEmpty(); doc.createBlankDocument();
  const lines = ["표 안의 표", "", "자동 채우기", "", "대한민국", "그림", "", "끝"];
  lines.forEach((text, i) => { if (i) doc.splitParagraph(0, i - 1, doc.getParagraphLength(0, i - 1)); if (text) doc.insertText(0, i, 0, text); });
  const outer = JSON.parse(doc.createTable(0, 1, 0, 2, 2)) as { paraIdx: number };
  const first = [{ controlIndex: 0, cellIndex: 0, cellParaIndex: 0 }];
  const inner = JSON.parse(doc.createTableInCellByPath(0, outer.paraIdx, JSON.stringify(first), 0, JSON.stringify({ rowCount: 2, colCount: 2 }))) as { controlIdx: number };
  ["가", "나", "다", "라"].forEach((text, cell) => doc.insertTextInCellByPath(0, outer.paraIdx, JSON.stringify([...first, { controlIndex: inner.controlIdx, cellIndex: cell, cellParaIndex: 0 }]), 0, text));
  const paraOf = (text: string) => { for (let i = 0; i < doc.getParagraphCount(0); i++) if (doc.getTextRange(0, i, 0, doc.getParagraphLength(0, i)) === text) return i; throw new Error(text); };
  const fill = JSON.parse(doc.createTable(0, paraOf("자동 채우기") + 1, 0, 1, 4)) as { paraIdx: number };
  ["1", "2"].forEach((text, cell) => doc.insertTextInCell(0, fill.paraIdx, 0, cell, 0, 0, text));
  const picturePara = paraOf("그림") + 1;
  doc.insertPicture(0, picturePara, 0, "", png(60, 40), 12000, 8000, 60, 40, "png", "rig picture");
  try { return { bytes: doc.exportHwpx(), nestedPara: outer.paraIdx, fillPara: fill.paraIdx, hanjaPara: paraOf("대한민국"), picturePara }; } finally { doc.free(); }
}
function documentB(): Uint8Array {
  const doc = HwpDocument.createEmpty(); doc.createBlankDocument();
  doc.insertText(0, 0, 0, "붙여넣을 곳");
  doc.splitParagraph(0, 0, doc.getParagraphLength(0, 0));
  try { return doc.exportHwpx(); } finally { doc.free(); }
}
const A = documentA();

// ---- the stand-in engine -------------------------------------------------------------------------------
type Msg = { role: string; content?: unknown };
const textOf = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (part as { text?: string }).text ?? "").join("") : "";
const requests: { scenario: string; step: number; instruction: string; tools: string[] }[] = [];
const provider = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  let input = ""; for await (const part of req) input += String(part);
  const body = JSON.parse(input || "{}") as { messages?: Msg[]; tools?: { function?: { name: string } }[] };
  const messages = body.messages ?? [];
  const lastUser = messages.map((m, i) => [m, i] as const).filter(([m]) => m.role === "user").at(-1);
  const instruction = lastUser ? textOf(lastUser[0].content) : "";
  const step = lastUser ? messages.slice(lastUser[1] + 1).filter((m) => m.role === "tool").length : 0;
  const scenario = /\[새도구\]/.test(instruction) ? "tools" : /공문서|행정|규칙|점검/.test(instruction) ? "check" : "answer";
  requests.push({ scenario, step, instruction: instruction.slice(0, 400), tools: (body.tools ?? []).map((tool) => tool.function?.name ?? "") });
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (delta: Record<string, unknown>, finish: string | null = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  const done = () => { res.write("data: [DONE]\n\n"); res.end(); };
  const call = (name: string, input: unknown) => { send({ tool_calls: [{ index: 0, id: `call_${scenario}_${step}`, type: "function", function: { name, arguments: JSON.stringify(input) } }] }); send({}, "tool_calls"); done(); };
  const answer = (text: string) => { send({ content: text }); send({}, "stop"); done(); };
  if (scenario === "tools") {
    if (step === 0) return call("set_page_number", { position: "bottom_center" });
    if (step === 1) return call("set_columns", { count: 2, line: "solid" });
    if (step === 2) return call("insert_title_box", { find: "끝", look: "box" });
    return answer("쪽 번호를 아래 가운데에 넣고, 두 단으로 나누고, '끝'을 제목 상자로 꾸몄습니다.");
  }
  return answer(scenario === "check" ? "공문서 점검 결과를 받았습니다." : "네.");
});
await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
const providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`;

// ---- the gateway ---------------------------------------------------------------------------------------
const dataDir = mkdtempSync(join(tmpdir(), "wb-hwp-0130-data-"));
const project = mkdtempSync(join(tmpdir(), "wb-hwp-0130-project-"));
mkdirSync(join(dataDir, "office"));
writeFileSync(join(dataDir, "office", "ai-settings.json"), JSON.stringify({ provider: "custom", providers: { custom: { model: "fixture-model", apiKey: "fixture-only-key", baseUrl: providerUrl } } }), { mode: 0o600 });
writeFileSync(join(project, "표 안의 표.hwpx"), A.bytes);
writeFileSync(join(project, "붙여넣기.hwpx"), documentB());
copyFileSync(resolve("apps/host/src/channels/fixtures/강의계획서.hwpx"), join(project, "강의계획서.hwpx"));
const gateway = spawn(process.execPath, [resolve("apps/host/dist/host.mjs")], {
  env: { ...process.env, WORKBENCH_DATA_DIR: dataDir, WORKBENCH_WEB_DIR: resolve("apps/web/dist"), WORKBENCH_PORT: "0", WORKBENCH_EDITORS_PORT: "0", WORKBENCH_EXIT_ON_STDIN_CLOSE: "1",
    WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"), WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"), WORKBENCH_HOST_LABEL: "노트북" },
  stdio: ["pipe", "pipe", "pipe"],
});
let gatewayLog = ""; gateway.stderr.on("data", (data: Buffer) => { gatewayLog += data.toString(); });
const ready = await new Promise<{ url: string; token: string }>((done, reject) => {
  const timer = setTimeout(() => reject(new Error(`gateway not ready\n${gatewayLog.slice(-2000)}`)), 30_000);
  createInterface({ input: gateway.stdout }).on("line", (line) => { if (line.startsWith("WORKBENCH_READY ")) { clearTimeout(timer); done(JSON.parse(line.slice(16))); } });
});
const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${ready.url}${path}`, { method, headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await response.json() as T & { message?: string };
  if (!response.ok) throw new Error(`${method} ${path}: ${json.message}`);
  return json;
};
const { prefs } = await api<{ prefs: Record<string, unknown> }>("GET", "/api/snapshot");
await api("PUT", "/api/prefs", { prefs: { ...prefs, onboarding: "done", startScreen: "last", theme: "light", sidebar: true, navigator: { rail: "projects", level: "projects" } } });
const work = await api<{ id: string }>("POST", "/api/works", { title: "한글 0.13 검사", folderId: null, cwd: project });
const docA = await api<{ id: string }>("POST", `/api/works/${work.id}/artifacts`, { path: "표 안의 표.hwpx" });
const docB = await api<{ id: string }>("POST", `/api/works/${work.id}/artifacts`, { path: "붙여넣기.hwpx" });

// ---- the browser ---------------------------------------------------------------------------------------
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.grantPermissions(["clipboard-read", "clipboard-write"]);
await editorFirst(context);
// Workbench's print (the desktop's print_svg) is reached through the shell's office:output message: recorded here.
await context.addInitScript({ content: `(() => { if (window.top !== window) return; window.__wbOutputs = []; window.addEventListener("message", (event) => { const data = event.data; if (data && data.type === "office:output") window.__wbOutputs.push({ action: data.action, pages: data.job && Array.isArray(data.job.pages) ? data.job.pages.length : null, mode: data.job && data.job.mode }); }, true); })();` });
const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => { if (message.type() === "error" && /TypeError|is not a function/.test(message.text())) errors.push(`console: ${message.text().slice(0, 300)}`); });
const shot = async (name: string) => { await page.screenshot({ path: join(outDir, `${name}.png`) }); };
await page.goto(`${ready.url}/?token=${ready.token}`);
await page.waitForSelector(".topbar-left", { timeout: 30_000 });
const click = (selector: string, text?: string) => page.evaluate(([selector, text]) => {
  const found = [...document.querySelectorAll<HTMLElement>(selector!)].find((e) => !text || e.textContent?.includes(text));
  found?.click(); return Boolean(found);
}, [selector, text ?? ""] as const);
if (await page.$(".topbar-right button:has-text('작업공간 보기')")) await click(".topbar-right button", "작업공간 보기");
if (!await page.$(".sidebar")) await click('.topbar-left [aria-label="사이드바 열기"]');

let outer: Frame;
/** Opens a document of the project in its editor; the editor's page frame. */
async function openDocument(id: string, name: string): Promise<Frame> {
  if (!await page.$(".nav-docs")) await click('.topbar-left [aria-label="사이드바 열기"], .topbar-left [aria-label="목록 열기"]');
  await sleep(300);
  if (!await page.$(`.nav-docs [data-row-id="${id}"]`)) await click(".nav-rail [data-rail=docs]");
  await page.waitForSelector(`.nav-docs [data-row-id="${id}"]`, { timeout: 15_000 });
  await click(`.nav-docs [data-row-id="${id}"]`);
  await page.waitForSelector(".document-view .doc-header", { timeout: 15_000 });
  await page.evaluate(() => { const r = [...document.querySelectorAll<HTMLElement>(".document-view:not([hidden]) .doc-header [role=radio]")].find((e) => /편집/.test(e.textContent ?? "")); if (r && r.getAttribute("aria-checked") !== "true") r.click(); });
  const handle = await page.waitForSelector(`iframe.office-frame[title$="· ${name}"]`, { state: "visible", timeout: 30_000 });
  const frame = (await handle.contentFrame())!;
  await frame.waitForSelector('.hwp-app[data-phase="ready"]', { timeout: 90_000 });
  const studio = (await (await frame.waitForSelector(".hwp-editor-host iframe", { timeout: 30_000 })).contentFrame())!;
  await studio.waitForFunction(() => !!(window as unknown as { rhwpStudio?: { automation?: unknown } }).rhwpStudio?.automation, null, { timeout: 60_000 });
  await studio.waitForSelector("canvas", { timeout: 60_000 });
  await sleep(1500);
  return frame;
}
const studioOf = async (frame: Frame): Promise<Frame> => (await (await frame.waitForSelector(".hwp-editor-host iframe", { timeout: 30_000 })).contentFrame())!;
/** Runs `fn` in the studio page with its services: the live document, the input handler and command execution. */
type StudioServices = { wasm: { doc: HwpDocument }; getInputHandler(): any };
type StudioGlobal = { rhwpStudio: { automation: { execute(id: string, params?: unknown): unknown; options: { dispatcher: { services: StudioServices } } } } };
const inStudio = async <R, Arg>(frame: Frame, fn: (arg: Arg) => R, arg: Arg): Promise<R> => (await studioOf(frame)).evaluate(fn as never, arg as never) as Promise<R>;
const reveal = (frame: Frame, place: unknown) => inStudio(frame, (place) => { (window as unknown as StudioGlobal).rhwpStudio.automation.execute("ext:ieum-reveal", place); }, place);
const run = (frame: Frame, id: string) => inStudio(frame, (id) => { (window as unknown as StudioGlobal).rhwpStudio.automation.execute(id); }, id);
const docCall = <R>(frame: Frame, method: string, ...params: unknown[]) => inStudio(frame, ([method, params]) => {
  const doc = (window as unknown as StudioGlobal).rhwpStudio.automation.options.dispatcher.services.wasm.doc as unknown as Record<string, (...a: unknown[]) => unknown>;
  return doc[method as string]!(...(params as unknown[]));
}, [method, params] as const) as Promise<R>;
const focusStudio = async (frame: Frame) => { const studio = await studioOf(frame); await studio.evaluate(() => { const box = document.querySelector<HTMLElement>("textarea, [contenteditable]") ; box?.focus(); }); };
const key = async (frame: Frame, combo: string) => { await focusStudio(frame); await (await studioOf(frame)).page().keyboard.press(combo); await sleep(250); };
const dialogText = (frame: Frame) => inStudio(frame, () => [...document.querySelectorAll<HTMLElement>(".dialog-wrap, .modal-dialog, [role=dialog]")].filter((e) => e.offsetParent).map((e) => e.textContent ?? "").join(" | "), undefined);

outer = await openDocument(docA.id, "표 안의 표.hwpx");
await shot("00-opened");
check("문서가 열리고 오류 없음(onPreviewRequest 등 새 멤버)", errors.length === 0, errors.slice(0, 3).join(" / "));

// ---- menu: the File menu ------------------------------------------------------------------------------
if (want("menu")) {
  const items = await inStudio(outer, () => {
    const title = document.querySelector<HTMLElement>('#menu-bar [data-menu="file"] .menu-title');
    title?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    const labels = [...document.querySelectorAll<HTMLElement>('#menu-bar [data-menu="file"] [data-cmd]')].filter((e) => e.offsetParent && getComputedStyle(e).display !== "none").map((e) => `${e.dataset.cmd}=${(e.textContent ?? "").trim()}`);
    return { opened: Boolean(title), labels };
  }, undefined);
  await sleep(300);
  await shot("01-file-menu");
  const cmds = items.labels.join(" ");
  console.log("File menu:", cmds);
  check("파일 메뉴에 저장 · 다른 이름 · PDF · 인쇄 미리 보기 · 인쇄", ["ext:ieum-save", "ext:ieum-save-as", "ext:ieum-export-pdf", "ext:ieum-preview", "ext:ieum-print"].every((id) => cmds.includes(id)), cmds.slice(0, 400));
  check("파일 메뉴에 열기 · PDF 가져오기 없음", items.labels.length > 0 && !cmds.includes("ext:ieum-open") && !cmds.includes("ext:ieum-import-pdf") && !/file:open=|file:import-pdf/.test(cmds));
  await inStudio(outer, () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), undefined);
  await key(outer, "Escape");
}

// ---- H1: tables inside tables ---------------------------------------------------------------------------
const innerPath = (cell = 0) => JSON.stringify([{ controlIndex: 0, cellIndex: 0, cellParaIndex: 0 }, { controlIndex: 0, cellIndex: cell, cellParaIndex: 0 }]);
const innerDims = async () => JSON.parse(await docCall<string>(outer, "getTableDimensionsByPath", 0, A.nestedPara, innerPath(0))) as { rowCount: number; colCount: number; cellCount: number };
const intoInner = (cell = 0) => reveal(outer, { sec: 0, para: A.nestedPara, offset: 0, path: [{ controlIndex: 0, cellIndex: 0, cellParaIndex: 0 }, { controlIndex: 0, cellIndex: cell, cellParaIndex: 0 }] });
if (want("nested")) {
  const start = await innerDims();
  await intoInner(0);
  await run(outer, "table:insert-row-below"); await sleep(400);
  const rows = await innerDims();
  check("H1 안쪽 표에 줄 추가(아래)", rows.rowCount === start.rowCount + 1 && rows.colCount === start.colCount, `${JSON.stringify(start)} → ${JSON.stringify(rows)}`);
  await intoInner(0);
  await run(outer, "table:insert-col-right"); await sleep(400);
  const cols = await innerDims();
  check("H1 안쪽 표에 칸 추가(오른쪽)", cols.colCount === rows.colCount + 1, JSON.stringify(cols));
  await shot("02-nested-row-col");
  // merge: F5 (cell block) on the first inner cell, Shift+→ widens it, M merges (Hangul's keys)
  await intoInner(0);
  await key(outer, "F5"); await key(outer, "F5"); await key(outer, "ArrowRight");
  await shot("03-nested-block");
  await key(outer, "m");
  const merged = await innerDims();
  const span = JSON.parse(await docCall<string>(outer, "getCellInfoByPath", 0, A.nestedPara, innerPath(0))) as { colSpan: number };
  // the engine keeps a merged cell's covered cells in the table's grid count; the first cell spans two columns
  check("H1 안쪽 표 셀 합치기(F5 블록 → M)", span.colSpan === 2, `cells ${cols.cellCount} → ${merged.cellCount}, first cell colSpan ${span.colSpan}`);
  await shot("04-nested-merged");
  // split: S on the merged cell opens 셀 나누기; Enter keeps its proposal
  await key(outer, "Escape"); await intoInner(0);
  await key(outer, "F5"); await key(outer, "s"); await sleep(400);
  const splitDialog = await dialogText(outer);
  await shot("05-nested-split-dialog");
  await inStudio(outer, () => { const ok = [...document.querySelectorAll<HTMLElement>(".dialog-wrap button, [role=dialog] button")].find((b) => b.offsetParent && /^(나누기|확인|OK)(\(\w\))?$/.test((b.textContent ?? "").trim())); ok?.click(); }, undefined);
  await sleep(500);
  const split = await innerDims();
  const spanAfter = JSON.parse(await docCall<string>(outer, "getCellInfoByPath", 0, A.nestedPara, innerPath(0))) as { colSpan: number };
  check("H1 안쪽 표 셀 나누기(S → 셀 나누기)", spanAfter.colSpan === 1 || split.cellCount > merged.cellCount, `cells ${merged.cellCount} → ${split.cellCount}, first cell colSpan ${spanAfter.colSpan} · ${splitDialog.slice(0, 40)}`);
  // a border: the cell block's L (각 셀마다 테두리) dialog, its first line kind, applied
  await key(outer, "Escape"); await intoInner(0);
  const borderBefore = await docCall<string>(outer, "getCellPropertiesByPath", 0, A.nestedPara, innerPath(0), 0).catch((error: Error) => `error ${error.message}`);
  await key(outer, "F5"); await key(outer, "l"); await sleep(500);
  await shot("06-nested-border-dialog");
  const borderDialog = await dialogText(outer);
  await inStudio(outer, () => {
    const dialog = [...document.querySelectorAll<HTMLElement>(".dialog-wrap, [role=dialog]")].find((e) => e.offsetParent);
    if (!dialog) return;
    // a double line on every side, as a person picks it: the line kind, then 모두
    const kinds = [...dialog.querySelectorAll<HTMLElement>(".tcp-line-type-item")].filter((e) => e.offsetParent);
    kinds.at(-1)?.click();
    const all = [...dialog.querySelectorAll<HTMLElement>("button")].find((b) => /^모두$/.test((b.textContent ?? "").trim()));
    all?.click();
    const ok = [...dialog.querySelectorAll<HTMLElement>("button")].find((b) => /^(설정|확인|OK)$/.test((b.textContent ?? "").trim()));
    ok?.click();
  }, undefined);
  await sleep(500);
  const borderAfter = await docCall<string>(outer, "getCellPropertiesByPath", 0, A.nestedPara, innerPath(0), 0).catch((error: Error) => `error ${error.message}`);
  const changedKeys = (() => { try { const a = JSON.parse(borderBefore), b = JSON.parse(borderAfter); return Object.keys(b).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).map((k) => `${k} ${JSON.stringify(a[k])}→${JSON.stringify(b[k])}`).join(", "); } catch { return ""; } })();
  check("H1 안쪽 표 셀 테두리(L → 각 셀마다, 이중선)", changedKeys.length > 0, `${borderDialog.slice(0, 20)} · ${changedKeys.slice(0, 200) || borderAfter.slice(0, 300)}`);
  await key(outer, "Escape");
  await shot("07-nested-after");
}

// ---- H2: the table keys and 표 자동 채우기 -----------------------------------------------------------------
if (want("keys")) {
  const cellText = (cell: number) => docCall<string>(outer, "getTextInCell", 0, A.fillPara, 0, cell, 0, 0, 20).catch(() => "");
  const width = async (cell: number) => (JSON.parse(await docCall<string>(outer, "getCellInfo", 0, A.fillPara, 0, cell)) as { width?: number }).width ?? JSON.parse(await docCall<string>(outer, "getCellProperties", 0, A.fillPara, 0, cell)).width;
  // one cell's size (Hangul: F5, then Shift+→ widens that cell alone; patch 0016), undone after
  await reveal(outer, { sec: 0, para: A.fillPara, offset: 0, path: [{ controlIndex: 0, cellIndex: 0, cellParaIndex: 0 }] });
  const w0 = await width(0), w1 = await width(1);
  await key(outer, "F5"); await key(outer, "Shift+ArrowRight");
  const w0b = await width(0), w1b = await width(1);
  check("H2 셀 하나 크기(F5 → Shift+→): 그 칸만 넓어짐", w0b > w0 && w1b < w1, `${w0}/${w1} → ${w0b}/${w1b}`);
  await shot("08-cell-resize");
  await key(outer, "Escape"); await key(outer, "Control+z");
  // 표 자동 채우기: F5 F5 then → three times makes the block of the four cells, A fills it
  await reveal(outer, { sec: 0, para: A.fillPara, offset: 0, path: [{ controlIndex: 0, cellIndex: 0, cellParaIndex: 0 }] });
  await key(outer, "F5"); await key(outer, "F5"); for (let i = 0; i < 3; i++) await key(outer, "ArrowRight");
  await shot("08-fill-block");
  await key(outer, "a"); await sleep(500);
  const texts = [await cellText(0), await cellText(1), await cellText(2), await cellText(3)];
  check("H2 표 자동 채우기(F5 블록 → A): 1 2 → 3 4", texts.join(",") === "1,2,3,4", texts.join(","));
  await key(outer, "Escape");
  await shot("09-fill-done");
}

// ---- H5: 한자로 바꾸기 --------------------------------------------------------------------------------------
if (want("hanja")) {
  await reveal(outer, { sec: 0, para: A.hanjaPara, offset: 4 });
  await key(outer, "F9"); await sleep(1500);
  const dialog = await dialogText(outer);
  await shot("10-hanja-dialog");
  check("H5 F9: 한자로 바꾸기 창에 후보가 보임", /한자/.test(dialog) && /大韓民國|大韓/.test(dialog), dialog.slice(0, 160));
  await (await studioOf(outer)).page().keyboard.press("Enter"); await sleep(600);
  const text = await docCall<string>(outer, "getTextRange", 0, A.hanjaPara, 0, 8);
  check("H5 고른 한자가 문서에 들어감", /大韓民國/.test(text), text);
  await shot("11-hanja-done");
}

// ---- H9: 문서 정보 / 글자 수 ----------------------------------------------------------------------------------
if (want("info")) {
  const status = await inStudio(outer, () => document.querySelector("#status-bar")?.textContent ?? "", undefined);
  check("H9 상태 줄에 글자 수", /글자/.test(status) && /\d/.test(status), status.replace(/\s+/g, " ").slice(0, 160));
  await inStudio(outer, () => {
    document.querySelector<HTMLElement>('#menu-bar [data-menu="file"] .menu-title')?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    document.querySelector<HTMLElement>('#menu-bar [data-cmd="ieum:document-info"]')?.click();
  }, undefined);
  await sleep(1000);
  const dialog = await dialogText(outer);
  await shot("12-document-info");
  check("H9 문서 정보 창(글자 수)", /문서 정보/.test(dialog) && /글자/.test(dialog), dialog.replace(/\s+/g, " ").slice(0, 200));
  await inStudio(outer, () => { const close = [...document.querySelectorAll<HTMLElement>(".dialog-wrap button, [role=dialog] button")].find((b) => b.offsetParent && /^(닫기|확인|OK)$/.test((b.textContent ?? "").trim())); close?.click(); }, undefined);
  await sleep(300);
  check("H9 문서 정보 창이 닫힘", !/문서 정보/.test(await dialogText(outer)));
}

// ---- H3: pictures moved and cropped like Hangul ------------------------------------------------------------
const pictureProps = async () => JSON.parse(await docCall<string>(outer, "getPictureProperties", 0, A.picturePara, 0)) as Record<string, number | string | boolean>;
if (want("picture")) {
  const before = await pictureProps();
  await inStudio(outer, ([para]) => {
    const input = (window as unknown as StudioGlobal).rhwpStudio.automation.options.dispatcher.services.getInputHandler();
    input.cursor.enterPictureObjectSelectionDirect(0, para, 0, "image");
    input.updateCaret?.();
  }, [A.picturePara] as const);
  await sleep(300);
  await shot("13-picture-selected");
  // the arrow keys move a selected object (Hangul: 개체 이동); the picture is inline with the text at first, so
  // the move reads in its offset where it floats, or nowhere for a glyph-like picture — both are reported
  for (let i = 0; i < 5; i++) await (await studioOf(outer)).page().keyboard.press("ArrowRight");
  await sleep(400);
  const moved = await pictureProps();
  const keys = ["horzOffset", "vertOffset", "offsetX", "offsetY", "horizontalOffset", "verticalOffset"];
  const delta = keys.filter((name) => name in before && before[name] !== moved[name]).map((name) => `${name} ${before[name]}→${moved[name]}`);
  // Shift + a corner handle drag crops (object-drag.mjs cropsPicture): handles are drawn by the studio; dragged with the mouse
  // the picture's bottom-right corner on screen: its box on the page (the engine's layout) over the page's canvas
  const handle = await inStudio(outer, ([para]) => {
    const doc = (window as unknown as StudioGlobal).rhwpStudio.automation.options.dispatcher.services.wasm.doc as unknown as { getPageControlLayout(page: number): string; getPageInfo(page: number): string };
    const image = (JSON.parse(doc.getPageControlLayout(0)).controls as { type: string; paraIdx: number; x: number; y: number; w: number; h: number }[]).find((c) => c.type === "image" && c.paraIdx === para);
    const pageWidth = JSON.parse(doc.getPageInfo(0)).width as number;
    const canvas = [...document.querySelectorAll<HTMLCanvasElement>("#scroll-container canvas")].filter((c) => c.offsetParent).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
    if (!image || !canvas) return { x: 0, y: 0, count: 0 };
    const box = canvas.getBoundingClientRect(), k = box.width / pageWidth;
    return { x: box.left + (image.x + image.w) * k - 1, y: box.top + (image.y + image.h) * k - 1, count: 1 };
  }, [A.picturePara] as const);
  let cropped = "no handle found";
  if (handle.x > 0) {
    // Playwright gives a frame element's box in the top page's coordinates already
    const frameBox = await (await outer.$(".hwp-editor-host iframe"))!.boundingBox();
    const x = frameBox!.x + handle.x, y = frameBox!.y + handle.y;
    await page.mouse.move(x, y); await page.keyboard.down("Shift"); await page.mouse.down();
    await page.mouse.move(x - 30, y - 20, { steps: 8 }); await page.mouse.up(); await page.keyboard.up("Shift");
    await sleep(500);
    const after = await pictureProps();
    cropped = ["cropLeft", "cropTop", "cropRight", "cropBottom", "cropExtentWidth", "cropExtentHeight", "width", "height"].filter((name) => name in before && before[name] !== after[name]).map((name) => `${name} ${before[name]}→${after[name]}`).join(", ") || `unchanged (${JSON.stringify(after).slice(0, 200)})`;
  }
  await shot("14-picture-moved-cropped");
  check("H3 선택한 그림을 화살표로 옮김", delta.length > 0, delta.join(", ") || `unchanged (${JSON.stringify(moved).slice(0, 200)})`);
  check("H3 Shift+모서리 끌기로 그림 자르기", /crop/.test(cropped), cropped);
  await key(outer, "Escape");
}

// ---- H4: copy a table and a picture into another Hangul document ---------------------------------------------
if (want("paste")) {
  // the outer table as an object (Hangul: F5 three times selects the table; here the studio's own table selection)
  await reveal(outer, { sec: 0, para: A.fillPara, offset: 0, path: [{ controlIndex: 0, cellIndex: 0, cellParaIndex: 0 }] });
  await inStudio(outer, () => {
    const input = (window as unknown as StudioGlobal).rhwpStudio.automation.options.dispatcher.services.getInputHandler();
    const pos = input.cursor.getPosition?.() ?? {};
    input.cursor.enterTableObjectSelectionDirect?.(pos.sectionIndex ?? 0, pos.parentParaIndex, pos.controlIndex ?? 0);
  }, undefined);
  await key(outer, "Control+c");
  const frameB = await openDocument(docB.id, "붙여넣기.hwpx");
  await reveal(frameB, { sec: 0, para: 1, offset: 0 });
  await key(frameB, "Control+v"); await sleep(800);
  const tables = async (frame: Frame) => (JSON.parse(await docCall<string>(frame, "getControls")) as { ctrlId: string }[]).filter((c) => c.ctrlId === "tbl").length;
  const pastedTables = await tables(frameB);
  await shot("15-paste-table");
  check("H4 다른 한글 문서로 표 복사·붙여넣기", pastedTables >= 1, `표 ${pastedTables}개`);
  // the picture
  const frameA = await openDocument(docA.id, "표 안의 표.hwpx");
  await inStudio(frameA, ([para]) => { const input = (window as unknown as StudioGlobal).rhwpStudio.automation.options.dispatcher.services.getInputHandler(); input.cursor.enterPictureObjectSelectionDirect(0, para, 0, "image"); }, [A.picturePara] as const);
  await key(frameA, "Control+c");
  const frameB2 = await openDocument(docB.id, "붙여넣기.hwpx");
  const count = await docCall<number>(frameB2, "getParagraphCount", 0);
  await reveal(frameB2, { sec: 0, para: count - 1, offset: 0 });
  await key(frameB2, "Control+v"); await sleep(800);
  const pictures = (JSON.parse(await docCall<string>(frameB2, "getControls")) as { ctrlId: string }[]).filter((c) => /gso|pic|\$pic/.test(c.ctrlId)).length;
  await shot("16-paste-picture");
  check("H4 다른 한글 문서로 그림 복사·붙여넣기", pictures >= 1, `그림 ${pictures}개`);
  outer = await openDocument(docA.id, "표 안의 표.hwpx");
}

// ---- H6: 인쇄 미리 보기 and Workbench's print -------------------------------------------------------------------
if (want("print")) {
  await key(outer, "Control+p");
  const opened = await waitFor(() => outer.evaluate(() => Boolean(document.querySelector(".print-preview, .hwp-preview, [class*=preview][role=dialog]"))), 15_000);
  await sleep(1500);
  await shot("17-print-preview");
  check("H6 Ctrl+P → 인쇄 미리 보기", opened);
  const before = await page.evaluate(() => (window as unknown as { __wbOutputs: unknown[] }).__wbOutputs.length);
  await outer.evaluate(() => { const button = [...document.querySelectorAll<HTMLElement>("button")].find((b) => b.offsetParent && /^인쇄(…|\.\.\.)?$/.test((b.textContent ?? "").trim())); button?.click(); });
  const printed = await waitFor(() => page.evaluate((before) => (window as unknown as { __wbOutputs: { action: string }[] }).__wbOutputs.slice(before).some((o) => o.action === "print"), before), 30_000);
  const outputs = await page.evaluate(() => (window as unknown as { __wbOutputs: unknown[] }).__wbOutputs);
  await sleep(800);
  await shot("18-print-sent");
  check("H6 미리 보기의 인쇄 → Workbench 인쇄(office:output print)", printed, JSON.stringify(outputs).slice(0, 200));
  // 고급 인쇄 (소책자 …) is not connected: the preview says so in words, nothing throws
  await outer.evaluate(() => { const label = [...document.querySelectorAll<HTMLElement>("label")].find((l) => /소책자/.test(l.textContent ?? "")); label?.click(); });
  await sleep(600);
  // its 인쇄 asks the print layout (printLayout.print): the answer's words reach the preview's status line; its
  // 결과 미리 보기 (printLayout.preview) shows upstream's own line (the panel drops the answer's words)
  await outer.evaluate(() => { const b = [...document.querySelectorAll<HTMLElement>("button")].find((e) => e.offsetParent && /^인쇄(…|\.\.\.)?$/.test((e.textContent ?? "").trim())); b?.click(); });
  await sleep(1500);
  await outer.evaluate(() => { const b = [...document.querySelectorAll<HTMLElement>("button")].find((e) => e.offsetParent && /결과 미리 보기/.test(e.textContent ?? "")); b?.click(); });
  const said = await waitFor(() => outer.evaluate(() => /아직 연결되지 않았습니다/.test(document.body.textContent ?? "")), 15_000);
  await sleep(500);
  await shot("18b-print-layout-not-yet");
  check("H6 고급 인쇄(소책자)는 '아직 연결되지 않았습니다'로 답함", said && errors.length === 0, errors.slice(-2).join(" / "));
  await key(outer, "Escape");
  await outer.evaluate(() => { const close = [...document.querySelectorAll<HTMLElement>("button")].find((b) => b.offsetParent && /닫기/.test(b.getAttribute("aria-label") ?? b.textContent ?? "")); close?.click(); });
  await sleep(500);
}

// ---- H8: 공문서 규칙 검사 and "AI에게 맡기기" ---------------------------------------------------------------------
const openDock = async () => {
  await page.evaluate(() => { const toggle = document.querySelector<HTMLElement>(".document-view:not([hidden]) .doc-agent-toggle"); if (toggle?.getAttribute("aria-expanded") !== "true") toggle?.click(); });
  await outer.waitForSelector(".hwp-app .ai-dock:not(.collapsed) .ai-input-box textarea", { timeout: 20_000 });
};
const ended = () => waitFor(async () => !await outer.evaluate(() => Boolean(document.querySelector(".ai-dock .ai-msg-streaming") || document.documentElement.hasAttribute("data-wb-ai-hold"))), 60_000);
if (want("check")) {
  const opened = await outer.evaluate(() => { const b = [...document.querySelectorAll<HTMLElement>(".hwp-topbar button")].find((e) => /점검|검사/.test(e.textContent ?? "")); b?.click(); return b?.textContent ?? null; });
  const ran = await waitFor(() => outer.evaluate(() => /위반|항목|규칙|지침|가이드라인/.test(document.querySelector(".doc-check, .doc-check-panel, [class*=doc-check]")?.textContent ?? "")), 20_000);
  await sleep(800);
  await shot("19-doc-check");
  check("H8 공문서 규칙 검사 패널이 열리고 검사함", Boolean(opened) && ran, `${opened} · ${(await outer.evaluate(() => document.querySelector("[class*=doc-check]")?.textContent ?? "")).replace(/\s+/g, " ").slice(0, 160)}`);
  const handed = await outer.evaluate(() => { const b = [...document.querySelectorAll<HTMLElement>("[class*=doc-check] button")].find((e) => /AI/.test(e.textContent ?? "")); b?.click(); return b?.textContent ?? null; });
  await sleep(1200);
  const prefill = await outer.evaluate(() => (document.querySelector<HTMLTextAreaElement>(".ai-dock .ai-input-box textarea")?.value ?? ""));
  await shot("20-doc-check-handed");
  check("H8 AI에게 맡기기 → 문서 AI 입력 칸에 요청(보내지 않음)", Boolean(handed) && prefill.length > 20, `${handed} · ${prefill.slice(0, 100)}`);
  if (prefill) {
    const sent = requests.length;
    await outer.locator(".hwp-app .ai-dock .ai-input-box textarea").press("Enter");
    const reached = await waitFor(async () => requests.slice(sent).some((r) => r.scenario === "check"), 30_000);
    await ended();
    check("H8 그 요청이 Workbench의 문서 AI(엔진)에 닿음", reached, requests.slice(sent).map((r) => r.instruction.slice(0, 60)).join(" / "));
    await shot("21-doc-check-answered");
  }
}

// ---- H14: the new AI tools ---------------------------------------------------------------------------------
if (want("tools")) {
  await openDock();
  const sent = requests.length;
  const box = outer.locator(".hwp-app .ai-dock .ai-input-box textarea");
  await box.fill("[새도구] 쪽 번호, 두 단, 제목 상자"); await box.press("Enter");
  await waitFor(async () => requests.slice(sent).some((r) => r.scenario === "tools" && r.step >= 3), 60_000);
  await ended(); await sleep(1500);
  const offered = requests.slice(sent).find((r) => r.scenario === "tools")?.tools ?? [];
  const wanted = ["set_page_setup", "set_columns", "set_page_number", "insert_equations", "insert_title_box", "set_page_border", "set_header_footer", "check_layout", "read_page_layout", "list_equations"];
  check("H14 새 도구가 엔진에 제공됨", wanted.every((name) => offered.includes(name)), wanted.filter((name) => !offered.includes(name)).join(", ") || `${offered.length} tools`);
  check("H14 제공하지 않는 도구는 목록에 없음(import_attachment · analyze_picture · web_search)", !["import_attachment", "analyze_picture", "web_search"].some((name) => offered.includes(name)), offered.filter((name) => /import_attachment|analyze_picture|web_search/.test(name)).join(", "));
  check("H14 한글 문서 만들기는 그대로 제공", offered.includes("make_hangul_document"));
  const columns = JSON.parse(await docCall<string>(outer, "getColumnDef", 0)) as Record<string, number>;
  const chat = await outer.evaluate(() => [...document.querySelectorAll(".ai-dock .ai-msg")].slice(-2).map((e) => e.textContent ?? "").join(" / "));
  check("H14 엔진 차례가 세 도구를 불러 문서가 바뀜(두 단)", (columns.count ?? columns.columnCount) === 2, `${JSON.stringify(columns).slice(0, 120)} · ${chat.slice(0, 160)}`);
  await shot("22-new-tools");
}

writeFileSync(join(outDir, "results.json"), JSON.stringify({ results, requests: requests.map((r) => ({ ...r, tools: r.tools.length })), errors: errors.slice(0, 50) }, null, 2));
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed; page errors: ${errors.length}`);
await browser.close();
gateway.stdin.end(); provider.close();
setTimeout(() => process.exit(results.every((r) => r.ok) ? 0 : 1), 500);
