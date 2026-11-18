/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// The conversions IeumOffice v0.13.0 brought (unit conv2), on the built gateway and UI in Chromium, 1440×900 light:
//   a Word document → 「한글 문서로 내보내기…」 (row menu): the dialog, the ledger before anything is written, 저장,
//     열기 — the new .hwpx opens in the Hangul tab, with its table and its picture (counted by the one engine);
//   the Word editor's own File item 「한글 문서로 내보내기…」 opens the same dialog with the editor's document;
//   an old .doc, an old .ppt and an .ods: listed; opening shows 「변환해서 열기」 (the .ppt from its row menu), and
//     each opens as a NEW .docx / .pptx / .xlsx in its editor, the original untouched, its one line said.
// Fixtures only (IeumOffice's own test files; the .ods is written the way the xlsx engine's tests write one).
// Usage (through ux/run-isolated.sh): node scripts/convert-bridges-check.ts <outDir>
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import JSZip from "jszip";
import { chromium, type Frame } from "playwright-core";
import init, { ENGINE_DIR, HwpDocument } from "../third_party/hop/engine.ts";
import { hwpStructureOf } from "../apps/host/src/hwp-structure.ts";
import { editorFirst } from "./fixtures/editor-first.ts";

const outDir = resolve(process.argv[2] ?? join(tmpdir(), "wb-conv2-shots"));
mkdirSync(outDir, { recursive: true });
const results: { step: string; ok: boolean; detail: string }[] = [];
const check = (step: string, ok: boolean, detail = "") => { results.push({ step, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`); };
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const VENDOR = resolve("vendor/ieumoffice");
const dataDir = mkdtempSync(join(tmpdir(), "wb-conv2-data-"));
const project = mkdtempSync(join(tmpdir(), "wb-conv2-project-"));
writeFileSync(join(project, "가정통신문.docx"), readFileSync(join(VENDOR, "packages/docx2hwp/tests/fixtures/notice.docx")));
// IeumOffice's kitchen-sink Word sample: a table, two pictures, an equation (left out) and a link (kept as text).
writeFileSync(join(project, "학회 안내.docx"), readFileSync(join(VENDOR, "apps/docs/tests/pagination-corpus/docx/fixture-kitchen-sink.docx")));
writeFileSync(join(project, "옛 회의록.doc"), readFileSync(join(VENDOR, "packages/doc2docx/tests/fixtures/table.doc")));
writeFileSync(join(project, "옛 강의.ppt"), readFileSync(join(VENDOR, "packages/file-parse/tests/fixtures/legacy-sample.ppt")));
{
  const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2"';
  const row = (name: string, score: number) => `<table:table-row><table:table-cell office:value-type="string"><text:p>${name}</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="${score}"><text:p>${score}</text:p></table:table-cell></table:table-row>`;
  const body = `<table:table table:name="성적"><table:table-column table:number-columns-repeated="2"/>${row("김가람", 92)}${row("이나래", 88)}<table:table-row><table:table-cell office:value-type="string"><text:p>합계</text:p></table:table-cell><table:table-cell table:formula="of:=SUM([.B1:.B2])" office:value-type="float" office:value="180"><text:p>180</text:p></table:table-cell></table:table-row></table:table>`;
  const zip = new JSZip();
  zip.file("mimetype", "application/vnd.oasis.opendocument.spreadsheet", { compression: "STORE" });
  zip.file("content.xml", `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${NS} office:version="1.2"><office:automatic-styles/><office:body><office:spreadsheet>${body}</office:spreadsheet></office:body></office:document-content>`);
  zip.file("styles.xml", `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${NS} office:version="1.2"><office:styles/><office:automatic-styles/><office:master-styles/></office:document-styles>`);
  zip.file("META-INF/manifest.xml", '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:version="1.2" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/></manifest:manifest>');
  writeFileSync(join(project, "성적.ods"), await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}
const originals = Object.fromEntries(readdirSync(project).map((name) => [name, sha(readFileSync(join(project, name)))]));

const gateway = spawn(process.execPath, [resolve("apps/host/dist/host.mjs")], {
  env: { ...process.env, WORKBENCH_DATA_DIR: dataDir, WORKBENCH_WEB_DIR: resolve("apps/web/dist"), WORKBENCH_PORT: "0", WORKBENCH_EDITORS_PORT: "0", WORKBENCH_EXIT_ON_STDIN_CLOSE: "1",
    WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"), WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"), WORKBENCH_HOST_LABEL: "노트북" },
  stdio: ["pipe", "pipe", "pipe"],
});
let gatewayLog = ""; gateway.stderr.on("data", (data: Buffer) => { gatewayLog += data.toString(); });
const ready = await new Promise<{ url: string; token: string }>((done, reject) => {
  const timer = setTimeout(() => reject(new Error(`gateway not ready\n${gatewayLog.slice(-2000)}`)), 60_000);
  createInterface({ input: gateway.stdout }).on("line", (line) => { if (line.startsWith("WORKBENCH_READY ")) { clearTimeout(timer); done(JSON.parse(line.slice(16))); } });
});
const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${ready.url}${path}`, { method, headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await response.json() as T & { message?: string };
  if (!response.ok) throw new Error(`${method} ${path}: ${json.message}`);
  return json;
};
type Listed = { id: string; name: string; format: string };
const work = await api<{ id: string }>("POST", "/api/works", { title: "가을 학기 수업", folderId: null, cwd: project });
const listed: Record<string, Listed> = {};
for (const name of ["가정통신문.docx", "학회 안내.docx", "옛 회의록.doc", "옛 강의.ppt", "성적.ods"]) listed[name] = await api<Listed>("POST", `/api/works/${work.id}/artifacts`, { path: name });
check("목록: .doc·.ppt·.ods가 문서로 들어감 (각자의 종류)", listed["옛 회의록.doc"]!.format === "doc" && listed["옛 강의.ppt"]!.format === "ppt" && listed["성적.ods"]!.format === "ods");
const { prefs } = await api<{ prefs: Record<string, unknown> }>("GET", "/api/snapshot");
await api("PUT", "/api/prefs", { prefs: { ...prefs, onboarding: "done", startScreen: "last", theme: "light", sidebar: true } });

const browser = await chromium.launch();
const errors: string[] = [];
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
// Documents open in their editor (the app's default is 쪽 보기 first): the rigs' one way (fixtures/editor-first).
await editorFirst(context);
const page = await context.newPage();
page.on("pageerror", (error) => errors.push(error.message));
const shot = (name: string) => page.screenshot({ path: join(outDir, `light-${name}.png`) });
const has = (selector: string, text = "") => page.evaluate(([s, t]) => [...document.querySelectorAll(s!)].some((e) => !t || (e.textContent ?? "").includes(t!)), [selector, text] as const);
const waitFor = async (what: () => Promise<boolean>, ms = 20_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await what().catch(() => false)) return true; await sleep(250); } return false; };
/** Clicks the first element ON SCREEN (other tabs' views stay mounted, hidden) matching the selector and text. */
const click = (selector: string, text = "") => page.evaluate(([s, t]) => { const e = [...document.querySelectorAll<HTMLElement>(s!)].find((x) => x.getClientRects().length > 0 && (!t || (x.textContent ?? "").includes(t!))); e?.click(); return Boolean(e); }, [selector, text] as const);
const shown = (selector: string, text = "") => page.evaluate(([s, t]) => [...document.querySelectorAll<HTMLElement>(s!)].some((x) => x.getClientRects().length > 0 && (!t || (x.textContent ?? "").includes(t!))), [selector, text] as const);
const menuItem = (label: string) => click("[role^=menuitem]", label);
const rowMenu = (id: string) => page.evaluate((rowId) => { const row = document.querySelector<HTMLElement>(`.sidebar [data-row-id="${rowId}"]`); if (!row) return false; const box = row.getBoundingClientRect(); row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: box.left + 40, clientY: box.top + box.height / 2 })); return true; }, id);
const docsRail = async () => {
  if (!await page.$(".sidebar")) await click('.topbar-left [aria-label="사이드바 열기"], .topbar-left [aria-label="목록 열기"]');
  await page.waitForSelector(".nav-rail [data-rail=docs]", { timeout: 15_000 });
  await click(".nav-rail [data-rail=docs]");
};
const openRow = async (id: string) => { await docsRail(); await page.waitForSelector(`.nav-docs [data-row-id="${id}"]`, { timeout: 15_000 }); await click(`.nav-docs [data-row-id="${id}"]`); };
const header = (name: string) => waitFor(() => shown(".document-view .doc-header", name), 30_000);
/** The editor frame on screen (the editor pool's or the tab's own), once there (null: none). */
const editorFrame = async (): Promise<Frame | null> => {
  const handle = await page.locator('.editor-pool iframe[data-pool-shown="true"], section.pane:not([hidden]) iframe.office-frame').filter({ visible: true }).first().elementHandle({ timeout: 60_000 }).catch(() => null);
  return handle ? await handle.contentFrame() : null;
};
const artifacts = async () => (await api<{ artifacts: (Listed & { path: string })[] }>("GET", "/api/snapshot")).artifacts;
const byName = async (name: string) => (await artifacts()).find((entry) => entry.name === name);

await page.goto(`${ready.url}/?token=${ready.token}`);
await page.waitForSelector(".topbar-left", { timeout: 30_000 });
await docsRail();
await sleep(800);
check("문서 목록에 옛 형식 세 파일", await waitFor(() => page.evaluate((ids) => ids.every((id) => document.querySelector(`.nav-docs [data-row-id="${id}"]`)), [listed["옛 회의록.doc"]!.id, listed["옛 강의.ppt"]!.id, listed["성적.ods"]!.id])));
await shot("01-list-old-files");

// 1. Word → Hangul from the Word row's menu: dialog → ledger (before anything is written) → 저장 → 열기 → the Hangul tab.
const word = listed["학회 안내.docx"]!;
await docsRail();
await rowMenu(word.id);
check("워드 행 메뉴에 「한글 문서로 내보내기…」", await waitFor(() => has("[role^=menuitem]", "한글 문서로 내보내기…")));
await sleep(300); await shot("02-word-row-menu");
await menuItem("한글 문서로 내보내기…");
check("내보내기 창 (워드 문서: 형식, 서식 없음)", await waitFor(() => has(".hconv-dialog", "워드 문서의 모양을 그대로 옮깁니다")) && !await has(".hconv-dialog .hconv-field", "서식"));
await sleep(300); await shot("03-word-export-dialog");
await click(".hconv-dialog button[type=submit]");
const ledgerOrDone = await waitFor(() => page.evaluate(() => Boolean(document.querySelector(".hconv-ledger") || document.querySelector(".hconv-dialog [role=status]"))), 120_000);
const ledger = await has(".hconv-ledger");
check("만들기 전에 잃는 것을 보여 줌 (수식: 빠지는 것, 하이퍼링크: 바뀌는 것)", ledgerOrDone && ledger && await has(".hconv-ledger", "수식") && await has(".hconv-ledger", "하이퍼링크"));
if (ledger) {
  check("장부가 있는 동안 아직 파일 없음", !readdirSync(project).some((name) => name.endsWith(".hwpx")));
  await sleep(300); await shot("04-word-export-ledger");
  await click(".hconv-dialog button[type=submit]", "저장");
}
check("「학회 안내.hwpx」 만들어짐", await waitFor(() => has(".hconv-dialog [role=status]", "학회 안내.hwpx"), 60_000));
await sleep(300); await shot("05-word-export-done");
await click(".hconv-dialog button", "열기");
check("한글 탭에서 열림", await header("학회 안내.hwpx"));
const hwpFrame = await editorFrame();
const studioUp = hwpFrame ? await hwpFrame.waitForSelector('.hwp-app[data-phase="ready"]', { timeout: 90_000 }).then(() => true, () => false) : false;
const studioPage = studioUp && hwpFrame ? await (await (await hwpFrame.waitForSelector(".hwp-editor-host iframe", { timeout: 30_000 }))!.contentFrame())!.waitForSelector(".document-page-canvas, canvas", { timeout: 60_000 }).then(() => true, () => false) : false;
check("한글 편집기가 쪽을 그림", studioUp && studioPage);
await sleep(2500); await shot("06-hwpx-in-hangul-tab");
{
  const made = await byName("학회 안내.hwpx");
  await init({ module_or_path: readFileSync(resolve(ENGINE_DIR, "rhwp_bg.wasm")) });
  const doc = new HwpDocument(new Uint8Array(readFileSync(made!.path)));
  try {
    const objects = hwpStructureOf(doc).objects;
    const pictures = Object.entries(objects).filter(([kind]) => /그림|pic/i.test(kind)).reduce((sum, [, count]) => sum + count, 0);
    check("새 한글 문서에 표와 그림 (엔진이 셈)", (objects.tbl ?? 0) >= 1 && pictures >= 1, JSON.stringify(objects));
  } finally { doc.free(); }
}

// 2. The Word editor's own File item (export-hwp): the same window dialog, with the editor's document.
await openRow(listed["가정통신문.docx"]!.id);
check("워드 문서 열림", await header("가정통신문.docx"));
const wordFrame = await editorFrame();
const wordReady = wordFrame ? await wordFrame.waitForSelector(".pv-page, .ProseMirror", { timeout: 90_000 }).then(() => true, () => false) : false;
check("워드 편집기 준비", wordReady);
await page.evaluate(() => { const frame = [...document.querySelectorAll<HTMLIFrameElement>('.editor-pool iframe[data-pool-shown="true"], section.pane:not([hidden]) iframe.office-frame')].find((f) => f.getClientRects().length > 0); frame?.contentWindow?.postMessage({ type: "office:show-commands" }, new URL(frame.src).origin); });
const listedCommand = wordFrame ? await waitFor(async () => Boolean(await wordFrame.$('button.wb-office-command[data-command-id="export-hwp"]'))) : false;
check("편집기 명령에 「한글 문서로 내보내기…」 (파일)", listedCommand);
await sleep(300); await shot("07-word-editor-command");
if (listedCommand) await wordFrame!.click('button.wb-office-command[data-command-id="export-hwp"]');
check("편집기에서 연 창: 편집기 내용으로 만든다는 줄", await waitFor(() => has(".hconv-dialog", "편집기에 열린 내용"), 30_000));
await sleep(300); await shot("08-word-editor-export-dialog");
await click(".hconv-dialog button", "취소");
await waitFor(async () => !await has(".hconv-dialog"));

// 3. 변환해서 열기: .doc (open view), .ppt (row menu), .ods (open view) → the copy opens in its editor.
const convertOpen = async (name: string, copy: string, frameReady: string, how: "view" | "menu", frame: string) => {
  const source = listed[name]!;
  if (how === "view") {
    await openRow(source.id);
    check(`「${name}」 열면 「변환해서 열기」`, await waitFor(() => shown(".doc-legacy button", "변환해서 열기")));
    await sleep(300); await shot(`${frame}-${name.replace(/\s/g, "_")}-open-view`);
    await click(".doc-legacy button", "변환해서 열기");
  } else {
    await docsRail();
    await rowMenu(source.id);
    check(`「${name}」 행 메뉴에 「변환해서 열기」`, await waitFor(() => has("[role^=menuitem]", "변환해서 열기")));
    await sleep(300); await shot(`${frame}-${name.replace(/\s/g, "_")}-row-menu`);
    await menuItem("변환해서 열기");
  }
  // The line is a notice in the bar (6 s) — looked for at once — and the copy's record keeps it.
  const said = await waitFor(() => has(".top-notice", `원본 「${name}」은 그대로 둡니다.`), 30_000);
  await shot(`${frame}a-${name.replace(/\s/g, "_")}-line`);
  check(`「${name}」의 한 줄 (어디서 왔는지, 옮기지 못한 것)`, said);
  check(`「${copy}」 열림`, await header(copy));
  const editor = await editorFrame();
  check(`「${copy}」 편집기가 그림`, editor ? await editor.waitForSelector(frameReady, { timeout: 120_000 }).then(() => true, () => false) : false);
  await sleep(2000); await shot(`${frame}b-${copy.replace(/\s/g, "_")}-opened`);
};
await convertOpen("옛 회의록.doc", "옛 회의록.docx", ".pv-page, .ProseMirror", "view", "09");
await convertOpen("옛 강의.ppt", "옛 강의.pptx", "canvas, .slide, [class*=slide]", "menu", "10");
await convertOpen("성적.ods", "성적.xlsx", "canvas, [class*=grid], [class*=sheet]", "view", "11");

const files = readdirSync(project).sort();
check("원본 파일은 모두 그대로", Object.entries(originals).every(([name, hash]) => sha(readFileSync(join(project, name))) === hash));
check("새 문서만 생김 (.hwpx, .docx, .pptx, .xlsx)", ["학회 안내.hwpx", "옛 회의록.docx", "옛 강의.pptx", "성적.xlsx"].every((name) => files.includes(name)), files.join(", "));
const copies = await artifacts();
const linked = await Promise.all(["옛 회의록.docx", "옛 강의.pptx", "성적.xlsx", "학회 안내.hwpx"].map(async (name) => {
  const entry = copies.find((item) => item.name === name);
  if (!entry) return false;
  const revisions = await api<{ derivedFrom?: unknown[]; convertedFrom?: { converter: string } }[]>("GET", `/api/artifacts/${entry.id}/revisions`).catch(() => []);
  return Boolean(revisions[0]?.derivedFrom?.length && revisions[0]?.convertedFrom?.converter);
}));
check("사본마다 derivedFrom + convertedFrom", linked.every(Boolean), JSON.stringify(linked));
check("페이지 오류 없음", errors.length === 0, errors.slice(0, 3).join(" | "));
writeFileSync(join(outDir, "results.json"), JSON.stringify({ results, files, errors }, null, 2));
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
await browser.close();
gateway.stdin.end();
setTimeout(() => process.exit(results.every((r) => r.ok) ? 0 : 1), 500);
