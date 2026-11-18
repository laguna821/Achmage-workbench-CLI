/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// Captures of 불러오기 / 내보내기 (unit hangul-convert): the built gateway and UI in Chromium, a project with a
// Hangul document, a Markdown document and a password-protected HWPX (fixtures only). Frames at 1440×900,
// light and dark: the 문서 head's "문서 불러오기…" key, the row menu ("Markdown 문서로 변환"), files dropped on
// 문서 → the 변환 dialog, the password question, the report, the export dialog with its template chooser and
// its report line. Asserts what each frame must show; results.json beside the frames.
// Usage (through ux/run-isolated.sh): node scripts/hconv-shots-check.ts <outDir>
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium } from "playwright-core";

const outDir = resolve(process.argv[2] ?? join(tmpdir(), "wb-hconv-shots"));
mkdirSync(outDir, { recursive: true });
const results: { step: string; ok: boolean; detail: string }[] = [];
const check = (step: string, ok: boolean, detail = "") => { results.push({ step, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`); };
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const dataDir = mkdtempSync(join(tmpdir(), "wb-hconv-data-"));
const project = mkdtempSync(join(tmpdir(), "wb-hconv-project-"));
copyFileSync(resolve("apps/host/src/channels/fixtures/강의계획서.hwpx"), join(project, "강의계획서.hwpx"));
writeFileSync(join(project, "주간 보고.md"), "# 주간 보고\n\n이번 주에 한 일을 정리합니다.\n\n| 요일 | 한 일 |\n| --- | --- |\n| 월 | 회의 |\n| 수 | 수업 준비 |\n\n> [!note] 다음 주\n> 휴강 공지\n");
const fixtures = resolve("apps/host/src/hanmark/fixtures");
const dropped = [
  { name: "받은 공문.hwpx", base64: readFileSync(join(fixtures, "HWP5-password-123456.hwpx")).toString("base64") },
  { name: "학회 원고 양식.hwpx", base64: readFileSync(join(fixtures, "청소년학 템플릿.hwpx")).toString("base64") },
];

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
const work = await api<{ id: string }>("POST", "/api/works", { title: "가을 학기 수업", folderId: null, cwd: project });
const hwp = await api<{ id: string }>("POST", `/api/works/${work.id}/artifacts`, { path: "강의계획서.hwpx" });
const md = await api<{ id: string }>("POST", `/api/works/${work.id}/artifacts`, { path: "주간 보고.md" });
const { prefs } = await api<{ prefs: Record<string, unknown> }>("GET", "/api/snapshot");

const browser = await chromium.launch();
const errors: string[] = [];
for (const theme of ["light", "dark"] as const) {
  await api("PUT", "/api/prefs", { prefs: { ...prefs, onboarding: "done", startScreen: "last", theme, sidebar: true, navigator: { rail: "projects", level: "project", project: work.id } } });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(`${theme}: ${error.message}`));
  const shot = (name: string) => page.screenshot({ path: join(outDir, `${theme}-${name}.png`) });
  const has = (selector: string, text = "") => page.evaluate(([s, t]) => [...document.querySelectorAll(s!)].some((e) => !t || (e.textContent ?? "").includes(t!)), [selector, text] as const);
  const waitFor = async (what: () => Promise<boolean>, ms = 20_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await what()) return true; await sleep(200); } return false; };
  const menuItem = (label: string) => page.evaluate((text) => { const item = [...document.querySelectorAll<HTMLElement>("[role^=menuitem]")].find((e) => (e.textContent ?? "").includes(text)); item?.click(); return Boolean(item); }, label);
  const context_ = (id: string) => page.evaluate((rowId) => { const row = document.querySelector<HTMLElement>(`.sidebar [data-row-id="${rowId}"]`); if (!row) return false; const box = row.getBoundingClientRect(); row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: box.left + 40, clientY: box.top + box.height / 2 })); return true; }, id);
  const inside = () => has(".nav-level-two .nav-inside-docs");
  /** The list column open (a document laid it away), the rail on 프로젝트, this project's level 2. */
  const enter = async () => {
    for (let step = 0; step < 12 && !await inside(); step++) {
      await page.evaluate((id) => {
        const click = (s: string) => { const e = document.querySelector<HTMLElement>(s); e?.click(); return Boolean(e); };
        if (!document.querySelector(".sidebar")) return click('.topbar-left [aria-label="사이드바 열기"], .topbar-left [aria-label="목록 열기"]');
        if (!document.querySelector('.sidebar[data-rail="projects"]')) return click('.nav-rail [data-rail="projects"]');
        return click(`.sidebar [data-row-id="${id}"]`);
      }, work.id);
      await sleep(700);
    }
    return inside();
  };
  await page.goto(`${ready.url}/?token=${ready.token}`);
  await page.waitForSelector(".topbar-left", { timeout: 30_000 });
  // Into the project's list: the column open, the rail on 프로젝트, the project's row (level 2).
  if (!await enter()) await shot("00-not-inside");
  check(`${theme}: 프로젝트 안 목록`, await waitFor(inside));
  await sleep(800);

  // 1. The 문서 head: "문서 불러오기…" beside +.
  await page.focus(".nav-inside-docs .nav-inside-import");
  check(`${theme}: 문서 머리의 「문서 불러오기…」`, await has('.nav-inside-docs .nav-inside-head [aria-label="문서 불러오기…"]'));
  await shot("01-docs-head-import-key");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  // 2. The row menu of a Hangul document: "Markdown 문서로 변환".
  await context_(hwp.id);
  check(`${theme}: 한글 문서 행 메뉴에 「Markdown 문서로 변환」`, await waitFor(() => has("[role^=menuitem]", "Markdown 문서로 변환")));
  await sleep(300); await shot("02-row-menu-convert");
  await menuItem("Markdown 문서로 변환");
  check(`${theme}: 변환 창 (프리셋 4가지)`, await waitFor(() => has(".hconv-dialog", "기본 (권장)")));
  await sleep(400); await shot("03-import-dialog");
  await page.click('.hconv-dialog button[type=submit]');
  // A clean single import just opens the new document.
  check(`${theme}: 깨끗한 한 건은 새 문서가 바로 열림`, await waitFor(() => page.evaluate(() => !document.querySelector(".hconv-dialog") && Boolean(document.querySelector(".document-view")) && [...document.querySelectorAll(".document-view .doc-header")].some((head) => (head.textContent ?? "").includes("강의계획서"))), 60_000)
    && readdirSync(project).some((name) => /^강의계획서( \(\d\))?\.md$/.test(name)));
  await sleep(1500); await shot("04-converted-opened");

  check(`${theme}: 목록으로 돌아옴`, await enter());
  // 3. Files dropped from the computer onto 문서: copied in, the dialog for both; a password asked.
  await page.evaluate((files) => {
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(new File([Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0))], file.name));
    const target = document.querySelector(".nav-inside-docs")!;
    target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, dropped);
  check(`${theme}: 끌어다 놓은 두 파일의 변환 창`, await waitFor(() => has(".hconv-dialog", "문서 2개")));
  await sleep(400); await shot("05-dropped-dialog");
  await page.click('.hconv-dialog button[type=submit]');
  check(`${theme}: 암호 질문`, await waitFor(() => has('.hconv-dialog input[type=password]')));
  await page.fill('.hconv-dialog input[type=password]', "000000");
  await page.click('.hconv-dialog button[type=submit]');
  check(`${theme}: 틀린 암호 뒤 남은 횟수`, await waitFor(() => has(".hconv-dialog", "남은 횟수 2번")));
  await sleep(300); await shot("06-password");
  await page.fill('.hconv-dialog input[type=password]', "123456");
  await page.click('.hconv-dialog button[type=submit]');
  check(`${theme}: 보고 (표·그림·확인할 점)`, await waitFor(() => has('.hconv-report', "표 "), 60_000));
  await sleep(400); await shot("07-import-report");
  await page.click('.hconv-dialog button[type=submit]');
  await waitFor(async () => !await has(".hconv-dialog"));

  check(`${theme}: 목록으로 돌아옴 (내보내기 전)`, await enter());
  // 4. 내보내기 from the Markdown document: the template chooser, then the report line.
  await context_(md.id);
  check(`${theme}: 마크다운 행 메뉴에 「한글 문서로 내보내기…」`, await waitFor(() => has("[role^=menuitem]", "한글 문서로 내보내기…")));
  await menuItem("한글 문서로 내보내기…");
  check(`${theme}: 내보내기 창`, await waitFor(() => has(".hconv-dialog", "한글 문서로 내보내기")));
  await sleep(300); await shot("08-export-dialog");
  await page.evaluate(() => { const triggers = [...document.querySelectorAll<HTMLElement>(".hconv-dialog .hconv-field button")]; triggers.find((b) => /기본/.test(b.textContent ?? ""))?.click(); });
  check(`${theme}: 서식 목록 (기본·한국언론학회·청소년학·공문서)`, await waitFor(() => has("[role=option], [role=menuitemradio]", "한국언론학회")));
  await sleep(300); await shot("09-export-templates");
  await page.evaluate(() => { const option = [...document.querySelectorAll<HTMLElement>("[role=option], [role=menuitemradio]")].find((e) => (e.textContent ?? "").includes("한국언론학회")); option?.click(); });
  await sleep(300);
  await page.click('.hconv-dialog button[type=submit]');
  check(`${theme}: 내보내기 보고 줄`, await waitFor(() => has('.hconv-dialog [role=status]', "한국언론학회 서식으로 만들었습니다"), 60_000));
  await sleep(300); await shot("10-export-report");
  await page.click('.hconv-dialog button[type=submit]');
  await context.close();
}
const files = readdirSync(project).sort();
check("프로젝트 폴더: 원본은 그대로, 새 문서만 생김", files.includes("강의계획서.hwpx") && files.includes("주간 보고.md") && files.some((name) => /^주간 보고.*\.hwpx$/.test(name)) && files.includes("받은 공문.md"), files.join(", "));
check("페이지 오류 없음", errors.length === 0, errors.slice(0, 3).join(" | "));
writeFileSync(join(outDir, "results.json"), JSON.stringify({ results, files, errors }, null, 2));
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
await browser.close();
gateway.stdin.end();
setTimeout(() => process.exit(results.every((r) => r.ok) ? 0 : 1), 500);
