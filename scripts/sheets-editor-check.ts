/// <reference lib="dom" />
// Browser check of the in-app Excel editor (IeumOffice's spreadsheet editor built into Workbench:
// its screen in the page, its editing code and the Rust xlsx engine — as WebAssembly — in the
// page's worker) in the real Workbench UI against a real gateway: open a .xlsx, change a cell and
// save it as the next revision (Ctrl+S, leaving the tab), refuse a save over a revision made
// elsewhere and keep my save as the next one, show a revision made elsewhere, AI hidden; the saved
// revision carries formula results (an existing total and a newly typed formula).
// Usage: node scripts/sheets-editor-check.ts [outDir]   (CHECK_STACKS=1: page errors with their stacks and step)

import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Frame, type Page } from "playwright-core";

const outDir = process.argv[2] ?? join(tmpdir(), "wb-sheets-editor");
mkdirSync(outDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "workbench-sheets-editor-"));
const cwd = mkdtempSync(join(tmpdir(), "workbench-sheets-editor-cwd-"));
const scratch = mkdtempSync(join(tmpdir(), "workbench-sheets-editor-tmp-"));
const results: { step: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ step: name, ok, detail });
  step = `after ${name}`;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// A cell's value (or formula) in the first sheet, and an edit made "elsewhere" (a text cell replaced), with Python's zipfile.
const XLSX_PY = String.raw`
import sys, zipfile, re
cmd = sys.argv[1]
def strings(z):
    if 'xl/sharedStrings.xml' not in z.namelist(): return []
    xml = z.read('xl/sharedStrings.xml').decode('utf-8')
    return [''.join(re.findall(r'<t[^>]*>([^<]*)</t>', si)) for si in re.findall(r'<si>(.*?)</si>', xml, re.S)]
if cmd == 'cell':
    path, ref = sys.argv[2:4]
    with zipfile.ZipFile(path) as z:
        sheet = z.read('xl/worksheets/sheet1.xml').decode('utf-8')
        shared = strings(z)
    m = re.search(r'<c r="%s"([^>]*?)(?:/>|>(.*?)</c>)' % ref, sheet, re.S)
    if not m: print(''); sys.exit()
    attrs, body = m.group(1), m.group(2) or ''
    v = re.search(r'<v>([^<]*)</v>', body)
    t = re.search(r't="([^"]+)"', attrs)
    if t and t.group(1) == 's' and v: print(shared[int(v.group(1))])
    elif t and t.group(1) == 'inlineStr': print(''.join(re.findall(r'<t[^>]*>([^<]*)</t>', body)))
    else: print(v.group(1) if v else '')
elif cmd == 'formula':
    path, ref = sys.argv[2:4]
    with zipfile.ZipFile(path) as z:
        sheet = z.read('xl/worksheets/sheet1.xml').decode('utf-8')
    m = re.search(r'<c r="%s"[^>]*?>(.*?)</c>' % ref, sheet, re.S)
    f = re.search(r'<f[^>]*>([^<]*)</f>', m.group(1)) if m else None
    v = re.search(r'<v>([^<]*)</v>', m.group(1)) if m else None
    print('%s=%s' % (f.group(1) if f else '', v.group(1) if v else ''))
elif cmd == 'replace':
    src, out, old, new = sys.argv[2:6]
    with zipfile.ZipFile(src) as z:
        items = [(info, z.read(info.filename)) for info in z.infolist()]
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as w:
        for info, data in items:
            if info.filename in ('xl/sharedStrings.xml', 'xl/worksheets/sheet1.xml'):
                data = data.decode('utf-8').replace('>%s<' % old, '>%s<' % new).encode('utf-8')
            w.writestr(info, data)
`;
const xlsx = (...args: string[]) => execFileSync("python3", ["-I", "-c", XLSX_PY, ...args]).toString().trim();

copyFileSync(join(import.meta.dirname, "fixtures/supplies.xlsx"), join(cwd, "비품.xlsx"));

const child = spawn(process.execPath, ["apps/host/src/main.ts"], {
  env: { ...process.env, WORKBENCH_DATA_DIR: dataDir, WORKBENCH_WEB_DIR: "apps/web/dist", WORKBENCH_HOST_LABEL: "노트북" },
  stdio: ["ignore", "pipe", "inherit"],
});
const ready = await new Promise<{ url: string; token: string }>((resolve) => {
  createInterface({ input: child.stdout! }).on("line", (line) => {
    if (line.startsWith("WORKBENCH_READY ")) resolve(JSON.parse(line.slice(16)));
  });
});
const auth = { authorization: `Bearer ${ready.token}` };
const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${ready.url}${path}`, { method, headers: { ...auth, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = (await response.json()) as T & { message?: string };
  if (!response.ok) throw new Error(`${method} ${path}: ${json.message}`);
  return json;
};

await api("PUT", "/api/prefs", { prefs: { onboarding: "done" } });
const work = await api<{ id: string }>("POST", "/api/works", { title: "엑셀 편집", folderId: null, cwd });
const artifact = await api<{ id: string }>("POST", `/api/works/${work.id}/artifacts`, { path: "비품.xlsx" });
const revisions = () => api<{ revision: number }[]>("GET", `/api/artifacts/${artifact.id}/revisions`);
async function fileOf(revision: number) {
  const file = join(scratch, `r${revision}.xlsx`);
  writeFileSync(file, Buffer.from(await (await fetch(`${ready.url}/api/artifacts/${artifact.id}/raw?revision=${revision}`, { headers: auth })).arrayBuffer()));
  return file;
}
const cellOf = async (revision: number, ref: string) => xlsx("cell", await fileOf(revision), ref);
/** Someone else makes the next revision: the latest one with a text cell's value replaced. */
async function editElsewhere(from: string, to: string) {
  const latest = (await revisions()).at(-1)!.revision;
  const source = await fileOf(latest);
  const out = join(scratch, `elsewhere-${latest}.xlsx`);
  xlsx("replace", source, out, from, to);
  const response = await fetch(`${ready.url}/api/artifacts/${artifact.id}/bytes?expectedRevision=${latest}`, { method: "PUT", headers: auth, body: new Uint8Array(readFileSync(out)) });
  if (!response.ok) throw new Error(`edit elsewhere: ${response.status}`);
  return ((await response.json()) as { revision: number }).revision;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
const logs: string[] = [];
page.on("console", (message) => {
  const text = message.text();
  if ((message.type() === "error" || text.startsWith("[workbench office]") || text.startsWith("[xlsx engine]")) && !text.includes("already exists")) logs.push(`[${message.type()}] ${text.slice(0, 200)}`);
});
let step = "start";
page.on("pageerror", (error) => logs.push(`[pageerror] ${error.message.slice(0, 200)}${process.env.CHECK_STACKS ? ` @${step}\n${error.stack}` : ""}`));

const editorFrame = (p: Page) => p.frames().find((frame) => frame.url().includes("/office/sheets.html")) as Frame | undefined;
const status = (p: Page) => p.locator(".save-state").innerText();
const waitStatus = (p: Page, text: string, timeout = 30_000) =>
  p.waitForFunction((t) => document.querySelector(".save-state")?.textContent?.includes(t) ?? false, text, { timeout });
async function waitFor(what: string, test: () => Promise<boolean>, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (!(await test().catch(() => false))) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
/** Go to a cell through the name box, then type a value and press Enter. */
async function setCell(p: Page, ref: string, value: string) {
  const frame = editorFrame(p)!;
  // The name box (left of the formula bar) is Univer's first bordered input.
  const nameBox = frame.locator('input[class*="univer-box-border"]').first();
  await nameBox.click();
  await nameBox.fill(ref);
  await p.keyboard.press("Enter");
  await p.waitForTimeout(300);
  await p.keyboard.type(value);
  await p.keyboard.press("Enter");
}
/**
 * The workbook has loaded, and the screen has had a moment to finish setting up: the editor (Univer)
 * registers its screen services just after the load message, and a name-box jump before that fails
 * to scroll (a person does not type in that first second either).
 */
async function loaded(p: Page) {
  await waitFor("workbook loaded", async () => ((await editorFrame(p)?.locator("body").innerText()) ?? "").includes("통합 문서를 모두 로드했습니다"), 60_000);
  await p.waitForTimeout(1_500);
}

try {
  await page.addInitScript((id) => localStorage.setItem("workbench.lastWork", id), work.id);
  await page.goto(`${ready.url}/?token=${ready.token}`);
  await page.waitForSelector(".docs-button");
  await page.locator(".docs-button").click();
  await page.locator(".docs-menu").getByText("비품.xlsx", { exact: true }).click();
  await loaded(page);
  await page.screenshot({ path: join(outDir, "01-open.png") });
  check("문서 화면 안에서 엑셀 편집기로 열림(엔진은 WebAssembly)", (await status(page)).includes("r1 저장됨"), await status(page));

  const visibleAi = await editorFrame(page)!.locator("body").evaluate(() =>
    Array.from(document.querySelectorAll(".ai-entry, .copilot, .ai-ask-trigger")).filter((el) => el.getClientRects().length > 0).length,
  );
  check("편집기 자체 AI 진입점 숨김", visibleAi === 0, `visible=${visibleAi}`);

  // Change a cell and type a new formula, then Ctrl+S → the next revision.
  await setCell(page, "B2", "7");
  await setCell(page, "E2", "=B2+C2");
  await waitStatus(page, "저장 안 됨");
  await page.keyboard.press("Control+s");
  await waitStatus(page, "r2 저장됨");
  const b2 = await cellOf(2, "B2");
  check("칸 고치고 Ctrl+S → r2, 파일에 반영", b2 === "7", `B2=${b2}`);
  // The engine keeps the total a formula and saves its new value (7 × 1200).
  const d2 = xlsx("formula", await fileOf(2), "D2");
  check("수식 칸은 수식으로 남고 값이 다시 계산됨", d2 === "B2*C2=8400", `D2: ${d2}`);
  const e2 = xlsx("formula", await fileOf(2), "E2");
  check("새로 넣은 수식도 결과와 함께 저장", e2 === "B2+C2=1207", `E2: ${e2}`);
  await page.screenshot({ path: join(outDir, "02-saved.png") });

  // Leaving for the conversation tab saves first.
  await setCell(page, "B3", "11");
  await waitStatus(page, "저장 안 됨");
  await page.locator(".doc-tab.conversation").click();
  await page.waitForFunction(() => !document.querySelector("iframe.office-frame"), undefined, { timeout: 60_000 });
  check("대화 탭으로 옮기면 먼저 저장(r3)", (await revisions()).length === 3 && (await cellOf(3, "B3")) === "11");

  // Back; a revision made elsewhere while I have unsaved edits: my save is refused, then kept as the next one.
  await page.locator(".doc-tab-open", { hasText: "비품.xlsx" }).click();
  await loaded(page);
  await waitStatus(page, "r3 저장됨");
  await setCell(page, "B4", "9");
  await waitStatus(page, "저장 안 됨");
  await editElsewhere("지우개", "연필");
  await page.waitForSelector(".doc-conflict", { timeout: 30_000 });
  await page.screenshot({ path: join(outDir, "03-conflict.png") });
  check("편집 중 다른 곳에서 r4 → 충돌 안내", true, (await page.locator(".doc-conflict").innerText()).replace(/\s+/g, " ").slice(0, 100));
  await page.getByRole("button", { name: "내 편집을 새 판으로" }).click();
  await waitStatus(page, "r5 저장됨", 60_000);
  check("내 편집을 새 판으로 → r5, r4는 기록에 남음", (await cellOf(5, "B4")) === "9" && (await cellOf(4, "A4")) === "연필", `r5 B4=${await cellOf(5, "B4")}`);

  // A revision made elsewhere with nothing unsaved here: the editor shows it.
  await editElsewhere("펜", "볼펜");
  await waitFor("editor shows r6", async () => (await status(page)).includes("r6 저장됨"), 60_000);
  await loaded(page);
  check("저장 안 된 편집이 없으면 새 판(r6)을 바로 보여 줌", (await page.locator(".doc-conflict").count()) === 0);
} catch (error) {
  check("실행", false, error instanceof Error ? error.message.split("\n")[0]! : String(error));
  await page.screenshot({ path: join(outDir, "99-failure.png") }).catch(() => undefined);
} finally {
  writeFileSync(join(outDir, "console.log"), logs.join("\n"));
  writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
  await browser.close();
  child.kill();
  const failed = results.filter((result) => !result.ok).length;
  console.log(`${results.length - failed}/${results.length} passed · console: ${logs.length ? logs.slice(0, 6).join(" | ") : "clean"}`);
  process.exitCode = failed ? 1 : 0;
}
