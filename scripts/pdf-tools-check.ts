/// <reference lib="dom" />
// IeumOffice v0.13.0's PDF tools in Workbench (unit pdf-tools). Real built UI and gateway, Chromium, two PDF tabs:
// copy two pages from A, paste into B (a new revision; one undo brings B back), cut (copy + delete as one revision),
// 파일 크기 줄이기 (a smaller `{stem} (작게).pdf` beside the source; the source untouched), a JPG page export of the
// current page, a bookmark added and saved, the hand tool, opening at 100 %, the new marks (물결 밑줄, 캐럿, 다각형)
// and the measuring tool, and a password-protected PDF that opens editable and saves still protected.
// Usage: node scripts/pdf-tools-check.ts <out folder>   (through ux/run-isolated.sh, after the web, office and host builds)
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { deflateSync } from "node:zlib";
import { chromium, type Browser, type FrameLocator, type Page } from "playwright-core";
import { editorFirst } from "./fixtures/editor-first.ts";

const require = createRequire(new URL("../vendor/ieumoffice/package.json", import.meta.url));
const { PDFDocument, PDFName, PDFHexString, PDFDict, PDFRef, StandardFonts } = require("pdf-lib");
const out = resolve(process.argv[2] ?? "pdf-tools"); mkdirSync(out, { recursive: true });
const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice(7).split(",");
const wants = (step: string) => !only || only.includes(step);
const dir = mkdtempSync(join(tmpdir(), "wb-pdf-tools-"));
const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`); };
const until = async (what: () => Promise<boolean>, timeout = 60_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await what().catch(() => false)) return true; await new Promise(done => setTimeout(done, 200)); }
  return false;
};

async function makePdf(label: string, pages: number, options: { outline?: boolean; bloat?: number } = {}) {
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`${label} ${i + 1}`, { x: 72, y: 760, size: 48, font });
    for (let line = 0; line < 30; line++) page.drawText(`${label} line ${line + 1} of page ${i + 1}: measured text for marks.`, { x: 72, y: 700 - line * 20, size: 12, font });
  }
  if (options.outline) {
    const outlines = doc.context.nextRef(), item = doc.context.nextRef();
    doc.context.assign(item, doc.context.obj({ Title: PDFHexString.fromText("마지막 쪽"), Parent: outlines, Dest: [doc.getPage(pages - 1).ref, "Fit"] }));
    doc.context.assign(outlines, doc.context.obj({ Type: "Outlines", First: item, Last: item, Count: 1 }));
    doc.catalog.set(PDFName.of("Outlines"), outlines);
  }
  // (the bookmark points at the last page: the cut step removes the first)
  // A weakly compressed (stored) stream: 용량 줄이기 re-deflates it at level 9.
  if (options.bloat) { const stored = deflateSync(Buffer.alloc(options.bloat, "Workbench handout "), { level: 0 }); doc.context.register(doc.context.stream(stored, { Filter: "FlateDecode", Length: stored.length })); }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}
const pagesOf = async (file: string) => (await PDFDocument.load(readFileSync(file), { ignoreEncryption: true })).getPageCount();
async function outlineTitles(file: string) {
  const doc = await PDFDocument.load(readFileSync(file)), titles: string[] = [];
  const root = doc.catalog.lookupMaybe(PDFName.of("Outlines"), PDFDict);
  let node = root?.lookupMaybe(PDFName.of("First"), PDFDict);
  while (node && titles.length < 100) { titles.push(node.lookup(PDFName.of("Title")).decodeText()); node = node.lookupMaybe(PDFName.of("Next"), PDFDict); }
  return titles;
}
async function annotSubtypes(file: string) {
  const doc = await PDFDocument.load(readFileSync(file), { ignoreEncryption: true }), kinds: string[] = [];
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    for (let i = 0; i < (annots?.size() ?? 0); i++) { const ref = annots!.get(i), annot = ref instanceof PDFRef ? doc.context.lookup(ref) : ref; kinds.push(String(annot.get(PDFName.of("Subtype")))); }
  }
  return kinds;
}

let child: ChildProcess | null = null, browser: Browser | null = null, page: Page | null = null;
const errors: string[] = [];
try {
  child = spawn(process.execPath, ["apps/host/dist/host.mjs"], { env: { ...process.env,
    WORKBENCH_DATA_DIR: dir, WORKBENCH_HOST_ID: "fixture", WORKBENCH_IEUM_BOOTSTRAP: "0", WORKBENCH_WEB_DIR: resolve("apps/web/dist"),
    WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"), WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"), WORKBENCH_VAULT_SUGGEST: "",
  }, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr!.on("data", data => writeFileSync(join(out, "host.log"), data, { flag: "a" }));
  const ready = await new Promise<{ url: string; token: string }>((done, fail) => {
    const timer = setTimeout(() => fail(Error("gateway start timeout")), 60_000);
    child!.once("exit", code => { clearTimeout(timer); fail(Error(`gateway exited: ${code}`)); });
    createInterface({ input: child!.stdout! }).on("line", line => { if (line.startsWith("WORKBENCH_READY ")) { clearTimeout(timer); done(JSON.parse(line.slice(16))); } });
  });
  const api = async (path: string, method = "GET", body?: unknown) => {
    const r = await fetch(`${ready.url}${path}`, { method, headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await r.json(); if (!r.ok) throw Error(`${path}: ${r.status} ${result.message}`); return result;
  };
  const work = await api("/api/works", "POST", { title: "PDF 도구 검사", cwd: null });
  const main = await api(`/api/works/${work.id}/sessions`, "POST", { provider: "codex", purpose: "메인 채팅" });
  const write = (name: string, bytes: Buffer) => { const file = join(work.cwd, name); writeFileSync(file, bytes); return file; };
  const files = {
    a: write("가.pdf", await makePdf("Alpha", 4, { outline: true })),
    b: write("나.pdf", await makePdf("Beta", 2)),
    fat: write("두꺼운.pdf", await makePdf("Fat", 2, { bloat: 2_000_000 })),
    locked: join(work.cwd, "암호.pdf"),
  };
  copyFileSync(resolve("vendor/ieumoffice/apps/shell/tests/fixtures/testPassword4Spaces.pdf"), files.locked);
  const artifacts: Record<string, { id: string }> = {};
  for (const [key, path] of Object.entries(files)) artifacts[key] = await api(`/api/works/${work.id}/artifacts`, "POST", { path });
  const revisions = async (key: string) => (await api(`/api/artifacts/${artifacts[key]!.id}/revisions`) as unknown[]).length;
  const tabs = [
    ...Object.entries(artifacts).map(([key, artifact]) => ({ id: key, workId: work.id, sessionId: null, view: { kind: "document", artifactId: artifact.id, proposalId: null } })),
    { id: "main", workId: work.id, sessionId: main.id, view: { kind: "work" } },
  ];
  await api(`/api/works/${work.id}`, "PATCH", { activeSessionId: main.id });
  await api("/api/layouts/global", "PUT", { expectedRevision: 0, layout: { version: 2, focus: "test-pane", panes: [{ ...tabs[0], id: "test-pane", tabs, activeTabId: "main", recentTabIds: ["main"] }] } });
  await api("/api/prefs", "PUT", { prefs: { onboarding: "done", layoutScope: "global", startScreen: "last", sidebar: false, theme: "light" } });
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
  await context.addInitScript(id => localStorage.setItem("workbench.lastWork", id), work.id);
  await editorFirst(context);
  page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${ready.url}/?token=${ready.token}`);
  const activate = async (id: string) => {
    await page!.locator(`.pane[data-pane-active="true"] .group-tab[data-tab-id="${id}"] [role="tab"]`).click();
    await page!.locator(`.pane[data-pane-active="true"][data-tab="${id}"]`).waitFor();
  };
  const frame = (): FrameLocator => page!.frameLocator('.pane[data-pane-active="true"] iframe.office-frame, .editor-pool iframe.office-frame[data-pool-shown="true"][data-pane-active="true"]');
  const pageShown = () => frame().locator('.pdf-page[data-page="0"] canvas').first().isVisible();
  const bodyText = () => frame().locator("body").evaluate((body) => (body as HTMLElement).innerText);
  const says = (pattern: RegExp, timeout = 20_000) => until(async () => pattern.test(await bodyText()), timeout);
  const shot = (name: string) => page!.screenshot({ path: join(out, `${name}.png`) });
  // Pressing the tab that is already open folds the ribbon (upstream's collapse): press again when it folded.
  const tab = async (label: "홈" | "주석" | "편집" | "페이지" | "보기") => {
    await frame().locator(".ribbon-tabs .ribbon-tab:not(.ribbon-tab-context)", { hasText: label }).first().click();
    if (!(await until(() => frame().locator(".ribbon-group").first().isVisible(), 1_500))) await frame().locator(".ribbon-tabs .ribbon-tab:not(.ribbon-tab-context)", { hasText: label }).first().click();
  };
  const thumbs = async () => {
    if (!(await frame().locator(".pdf-thumb").first().isVisible().catch(() => false))) { await tab("보기"); await frame().locator("button.rb-big", { hasText: "미리보기" }).first().click(); }
    await frame().locator(".pdf-thumb").first().waitFor({ timeout: 20_000 });
  };
  const thumbMenu = async (index: number, item: string) => {
    await frame().locator(".pdf-thumb").nth(index).click({ button: "right", position: { x: 20, y: 20 } });
    await frame().locator(".thumb-menu button", { hasText: item }).first().click();
  };
  const save = async () => { await frame().locator(".pdf-scroll").first().click({ position: { x: 20, y: 20 } }); await page!.keyboard.press("Control+s"); };

  // ── opening at 100 % (D11) ──
  await activate("a");
  check("A: the first page is drawn", await until(pageShown, 90_000));
  await shot("01-a-open");

  // ── 쪽 복사 · 붙여넣기 between PDFs (D1) ──
  if (wants("clip")) {
    await thumbs();
    await frame().locator(".pdf-thumb").nth(1).click({ position: { x: 20, y: 20 } });
    await frame().locator(".pdf-thumb").nth(3).click({ position: { x: 20, y: 20 }, modifiers: ["Control"] });
    await thumbMenu(3, "복사");
    check("A: two pages copied", await says(/페이지 2개를 복사했습니다/));
    await shot("02-a-copied");
    await activate("b");
    check("B: the first page is drawn", await until(pageShown, 90_000));
    await thumbs();
    const before = await revisions("b");
    await thumbMenu(0, "붙여넣기");
    check("B: pasted (said)", await says(/페이지 2개를 붙여 넣었습니다/, 30_000));
    check("B: the file now has 4 pages, as a new revision", await until(async () => await pagesOf(files.b) === 4 && await revisions("b") === before + 1, 30_000), `${await pagesOf(files.b)} pages, ${await revisions("b")} revisions`);
    check("B: shows 4 pages", await until(async () => await frame().locator(".pdf-thumb").count() === 4, 20_000));
    await shot("03-b-pasted");
    // ONE undo: the view goes back to B before the paste; saving writes it as the next revision.
    await frame().locator(".pdf-scroll").first().click({ position: { x: 20, y: 20 } });
    await page.keyboard.press("Control+z");
    check("B: one undo shows 2 pages again", await until(async () => await frame().locator(".pdf-thumb").count() === 2, 30_000));
    await shot("04-b-undone");
    await save();
    check("B: saving the undone view writes 2 pages", await until(async () => await pagesOf(files.b) === 2, 30_000), `${await pagesOf(files.b)} pages, ${await revisions("b")} revisions`);
    // 잘라내기 = copy + delete, written at once as one revision.
    await activate("a");
    const aBefore = await revisions("a");
    await thumbs();
    await frame().locator(".pdf-thumb").nth(0).click({ position: { x: 20, y: 20 } });
    await thumbMenu(0, "잘라내기");
    check("A: cut (said)", await says(/페이지 1개를 잘라냈습니다/));
    check("A: the cut is written at once (3 pages, one new revision)", await until(async () => await pagesOf(files.a) === 3 && await revisions("a") === aBefore + 1, 30_000), `${await pagesOf(files.a)} pages, ${await revisions("a")} revisions`);
    await activate("b");
    await thumbs();
    await thumbMenu(1, "붙여넣기");
    check("B: the cut page pastes at the end", await until(async () => await pagesOf(files.b) === 3, 30_000));
    await shot("05-b-cut-pasted");
  }

  // ── 파일 크기 줄이기 (D2) ──
  if (wants("reduce")) {
    await activate("fat");
    check("Fat: the first page is drawn", await until(pageShown, 90_000));
    const sourceBytes = readFileSync(files.fat), sourceRevisions = await revisions("fat");
    await tab("페이지");
    await frame().locator("button.rb-big", { hasText: "파일 크기 줄이기" }).first().click();
    const dialog = page.locator('.office-output-dialog[aria-label="PDF로 저장"]');
    check("reduce: Workbench's picker offers `{stem} (작게).pdf`", await until(async () => /두꺼운 \(작게\)\.pdf$/.test(await dialog.locator('input[aria-label="저장할 파일 경로"]').inputValue()), 20_000));
    await shot("06-reduce-picker");
    await dialog.locator('button[type="submit"]').click();
    const small = join(work.cwd, "두꺼운 (작게).pdf");
    check("reduce: a smaller sibling is written", await until(async () => existsSync(small) && statSync(small).size < sourceBytes.length / 4, 60_000), existsSync(small) ? `${sourceBytes.length} → ${statSync(small).size} B` : "missing");
    check("reduce: the sizes are said", await says(/줄였습니다.*\(\d+(\.\d)?(MB|KB) → \d+(\.\d)?(MB|KB)\)/, 20_000));
    check("reduce: the source is untouched (same bytes, no new revision)", readFileSync(files.fat).equals(sourceBytes) && await revisions("fat") === sourceRevisions);
    check("reduce: the sibling opens as a PDF of 2 pages", existsSync(small) && await pagesOf(small) === 2);
    await shot("07-reduce-done");
  }

  // ── JPG page export, current page only (D12) ──
  if (wants("jpg")) {
    await activate("a");
    await tab("홈");
    await frame().locator('[data-action="convert-pdf"]').click();
    await frame().locator('[data-action="export-current-page-jpg"]').click();
    const dialog = page.locator('.office-output-dialog[aria-label="JPG 그림으로 내보내기"]');
    check("JPG: the folder dialog names JPG", await until(() => dialog.isVisible(), 30_000));
    await shot("08-jpg-dialog");
    await dialog.locator('button[type="submit"]').click();
    const jpgs = () => readdirSync(work.cwd).filter((name) => name.includes("-images-")).flatMap((folder) => readdirSync(join(work.cwd, folder)).map((name) => join(work.cwd, folder, name)));
    check("JPG: exactly the current page is written as a JPEG", await until(async () => { const list = jpgs(); return list.length === 1 && list[0]!.endsWith(".jpg") && readFileSync(list[0]!).subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])); }, 60_000), jpgs().map((file) => file.slice(work.cwd.length + 1)).join(", "));
  }

  // ── 책갈피 add / rename / delete (D8) — one added and saved ──
  if (wants("bookmark")) {
    await activate("a");
    await tab("보기");
    await frame().locator("button.rb-big", { hasText: "개요" }).first().click();
    await frame().locator(".pdf-outline-pane").waitFor({ timeout: 20_000 });
    await frame().locator('.pdf-outline-header button[aria-label="책갈피 편집"]').click();
    await frame().locator(".pdf-outline-pane .pdf-bookmark-add").click();
    check("bookmark: the new one shows", await says(/제목 없는 책갈피/));
    await frame().locator('.pdf-outline-header button[aria-label="책갈피 편집"]').click();
    await shot("09-bookmark-added");
    await save();
    check("bookmark: saved into the file", await until(async () => (await outlineTitles(files.a)).includes("제목 없는 책갈피"), 30_000), (await outlineTitles(files.a)).join(" | "));
  }

  // ── the hand tool (D11) ──
  if (wants("hand")) {
    await activate("a");
    const scroller = frame().locator(".pdf-scroll").first();
    await scroller.click({ position: { x: 300, y: 300 } });
    await page.keyboard.press("h");
    check("hand: H turns the hand tool on", await until(async () => /pdf-hand/.test(await scroller.getAttribute("class") ?? ""), 10_000));
    const top = await scroller.evaluate((el) => el.scrollTop), box = (await scroller.boundingBox())!;
    // press in the middle of the pages (a notice may sit at the bottom edge)
    await page.mouse.move(box.x + 400, box.y + box.height / 2 + 150); await page.mouse.down();
    const panning = await scroller.evaluate((el) => (el as HTMLElement).dataset.panning !== undefined);
    await page.mouse.move(box.x + 400, box.y + box.height / 2 - 150, { steps: 8 }); await page.mouse.up();
    check("hand: dragging moves the pages", await until(async () => await scroller.evaluate((el) => el.scrollTop) > top + 150, 10_000), `${top} → ${await scroller.evaluate((el) => el.scrollTop)}; panning on press: ${panning}; scroll room ${await scroller.evaluate((el) => el.scrollHeight - el.clientHeight)}`);
    await shot("10-hand");
    await page.keyboard.press("Escape");
  }

  // ── the new marks (D7) and the measuring tool (D5) ──
  if (wants("marks")) {
    await activate("a");
    // the whole first page in view (페이지 맞춤), so every placement lands on it
    await tab("보기");
    await frame().locator("button.rb-big", { hasText: "페이지 맞춤" }).first().click();
    await tab("주석");
    const tool = async (name: string) => { await frame().locator(`button[data-tip="${name}"], button[aria-label="${name}"]`).first().click(); };
    const pageBox = async () => (await frame().locator('.pdf-page[data-page="0"]').first().boundingBox())!;
    const before = await annotSubtypes(files.a);
    await frame().locator('.pdf-page[data-page="0"]').first().evaluate((el) => el.scrollIntoView({ block: "start" }));
    // 물결 밑줄 over a selected line of text (a line of the text layer, dragged across)
    const line = frame().locator('.pdf-page[data-page="0"] .textLayer span', { hasText: "line 3" }).first();
    const span = (await line.boundingBox())!;
    await page.mouse.move(span.x + 2, span.y + span.height / 2); await page.mouse.down(); await page.mouse.move(span.x + span.width - 2, span.y + span.height / 2, { steps: 8 }); await page.mouse.up();
    await tool("물결 밑줄");
    let box = await pageBox();
    const at = (fx: number, fy: number) => [box.x + box.width * fx, box.y + box.height * fy] as const;
    await tool("다각형");
    await page.mouse.click(...at(0.2, 0.62)); await page.mouse.click(...at(0.45, 0.64)); await page.mouse.click(...at(0.3, 0.72));
    await page.keyboard.press("Enter");
    await tool("측정"); box = await pageBox();
    await page.mouse.move(...at(0.2, 0.8)); await page.mouse.down(); await page.mouse.move(...at(0.6, 0.8), { steps: 8 }); await page.mouse.up();
    // the first measured line asks for its real length (축척 보정), then it is a measured line
    const calibrate = frame().locator(".pdf-modal", { hasText: "축척 보정" });
    check("measure: the first line asks for the scale (축척 보정)", await until(() => calibrate.isVisible(), 10_000));
    if (await calibrate.isVisible()) { await calibrate.locator("input").first().fill("10"); await calibrate.locator("button", { hasText: "보정" }).last().click(); }
    await tool("캐럿"); box = await pageBox(); await page.mouse.click(...at(0.7, 0.9));
    await shot("11-marks");
    await page.keyboard.press("Escape");
    await save();
    await until(async () => (await annotSubtypes(files.a)).length > before.length, 30_000);
    const saved = await annotSubtypes(files.a);
    check("marks: 물결 밑줄 saved", saved.includes("/Squiggly"), saved.join(" "));
    check("marks: 캐럿 saved", saved.includes("/Caret"));
    check("marks: 다각형 saved", saved.includes("/Polygon"));
    check("measure: the measured line saved", saved.includes("/Line") || saved.includes("/PolyLine"));
  }

  // ── a password-protected PDF: opens editable after its password, saves still protected (985b73c7a) ──
  if (wants("locked")) {
    await activate("locked");
    const asked = await until(() => frame().locator('.pdf-pwd-dialog input[type="password"]').isVisible(), 60_000);
    check("locked: the password is asked for", asked);
    if (asked) {
      await frame().locator('.pdf-pwd-dialog input[type="password"]').fill("    ");
      await frame().locator(".pdf-pwd-dialog .primary").click();
      check("locked: it opens after the password", await until(pageShown, 60_000));
      check("locked: not read-only", await until(async () => !/(보기|읽기) 전용/.test(await bodyText()), 15_000));
      await shot("12-locked-open");
      const before = await revisions("locked");
      await thumbs();
      await thumbMenu(0, "오른쪽으로 회전");
      await save();
      check("locked: a save is a new revision and the file stays protected", await until(async () => await revisions("locked") === before + 1, 30_000) && readFileSync(files.locked).includes(Buffer.from("/Encrypt")), `${await revisions("locked")} revisions`);
    }
  }
  // ── opening at 100 % (D11): 보기 › 열 때 보기 = 100 %, then the next opening of a PDF uses it ──
  if (wants("open")) {
    await activate("b");
    await tab("보기");
    await frame().locator(".rb-open-view select").selectOption("actual");
    await page.reload();
    await activate("b");
    check("B: the first page is drawn after reopening", await until(pageShown, 90_000));
    check("B: opens at 100 % once chosen", await until(async () => (await frame().locator(".zoom-value").first().innerText()).trim() === "100%", 20_000), await frame().locator(".zoom-value").first().innerText().catch(() => "?"));
    await shot("13-open-100");
  }
} catch (error) {
  check("rig ran to the end", false, error instanceof Error ? error.stack : String(error));
  await page?.screenshot({ path: join(out, "failure.png") }).catch(() => {});
} finally {
  await browser?.close().catch(() => {});
  child?.kill();
}
writeFileSync(join(out, "results.json"), JSON.stringify({ results, errors }, null, 1));
console.log(`${results.filter(r => r.ok).length}/${results.length} passed; page errors: ${errors.length}`);
for (const error of errors) console.log(`page error: ${error}`);
process.exit(results.every(r => r.ok) ? 0 : 1);
