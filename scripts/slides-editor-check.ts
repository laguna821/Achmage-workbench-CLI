/// <reference lib="dom" />
// Browser check of the in-app PowerPoint editor (IeumOffice's slides editor built into Workbench:
// its screen in the page, its editing code in the page's worker) in the real Workbench UI against a
// real gateway: open a .pptx, edit a title and save it as the next revision (Ctrl+S, leaving the tab),
// refuse a save over a revision made elsewhere and keep my edits as the next one, AI hidden.
// Usage: node scripts/slides-editor-check.ts [outDir]

import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Frame, type Page } from "playwright-core";

const outDir = process.argv[2] ?? join(tmpdir(), "wb-slides-editor");
mkdirSync(outDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "workbench-slides-editor-"));
const cwd = mkdtempSync(join(tmpdir(), "workbench-slides-editor-cwd-"));
const scratch = mkdtempSync(join(tmpdir(), "workbench-slides-editor-tmp-"));
const results: { step: string; ok: boolean; detail: string }[] = [];
const check = (step: string, ok: boolean, detail = "") => {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`);
};

// The slides' text, and an edit made "elsewhere" (a word replaced in slide 1), with Python's zipfile.
const PPTX_PY = String.raw`
import sys, zipfile, re
cmd = sys.argv[1]
if cmd == 'read':
    with zipfile.ZipFile(sys.argv[2]) as z:
        names = sorted(n for n in z.namelist() if re.match(r'ppt/slides/slide\d+\.xml$', n))
        print('\n'.join(''.join(re.findall(r'<a:t>([^<]*)</a:t>', z.read(n).decode('utf-8'))) for n in names))
elif cmd == 'replace':
    src, out, old, new = sys.argv[2:6]
    with zipfile.ZipFile(src) as z:
        items = [(info, z.read(info.filename)) for info in z.infolist()]
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as w:
        for info, data in items:
            if info.filename == 'ppt/slides/slide1.xml':
                data = data.decode('utf-8').replace(old, new).encode('utf-8')
            w.writestr(info, data)
`;
const pptx = (...args: string[]) => execFileSync("python3", ["-I", "-c", PPTX_PY, ...args]).toString();

copyFileSync(join(import.meta.dirname, "fixtures/cover.pptx"), join(cwd, "표지.pptx"));

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

// The app opens on home by default; these checks start in the work.
await api("PUT", "/api/prefs", { prefs: { onboarding: "done", startScreen: "last" } });
const work = await api<{ id: string }>("POST", "/api/works", { title: "PPT 편집", folderId: null, cwd });
const artifact = await api<{ id: string }>("POST", `/api/works/${work.id}/artifacts`, { path: "표지.pptx" });
const revisions = () => api<{ revision: number }[]>("GET", `/api/artifacts/${artifact.id}/revisions`);
async function textOf(revision: number) {
  const file = join(scratch, `r${revision}.pptx`);
  writeFileSync(file, Buffer.from(await (await fetch(`${ready.url}/api/artifacts/${artifact.id}/raw?revision=${revision}`, { headers: auth })).arrayBuffer()));
  return pptx("read", file);
}
/** Someone else makes the next revision: the latest one with a word replaced on slide 1. */
async function editElsewhere(from: string, to: string) {
  const latest = (await revisions()).at(-1)!.revision;
  await textOf(latest);
  const out = join(scratch, `elsewhere-${latest}.pptx`);
  pptx("replace", join(scratch, `r${latest}.pptx`), out, from, to);
  const response = await fetch(`${ready.url}/api/artifacts/${artifact.id}/bytes?expectedRevision=${latest}`, { method: "PUT", headers: auth, body: new Uint8Array(readFileSync(out)) });
  if (!response.ok) throw new Error(`edit elsewhere: ${response.status}`);
  return ((await response.json()) as { revision: number }).revision;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
const logs: string[] = [];
page.on("console", (message) => {
  if (message.type() === "error" || message.text().startsWith("[workbench office]")) logs.push(`[${message.type()}] ${message.text().slice(0, 200)}`);
});
page.on("pageerror", (error) => logs.push(`[pageerror] ${error.message.slice(0, 200)}`));

const editorFrame = (p: Page) => p.frames().find((frame) => frame.url().includes("/office/slides.html")) as Frame | undefined;
const status = (p: Page) => p.locator(".save-state").innerText();
const waitStatus = (p: Page, text: string, timeout = 20_000) =>
  p.waitForFunction((t) => document.querySelector(".save-state")?.textContent?.includes(t) ?? false, text, { timeout });
async function waitFor(what: string, test: () => Promise<boolean>, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (!(await test().catch(() => false))) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
/** Where a word of the slide being edited is drawn, in page coordinates (from the editor's Konva stage). */
async function wordAt(p: Page, word: string) {
  const frame = editorFrame(p)!;
  const offset = (await (await frame.frameElement()).boundingBox())!;
  const spot = await frame.evaluate((wanted) => {
    type Node = { text?: () => string; getClientRect(): { x: number; y: number; width: number; height: number } };
    type Stage = { width(): number; container(): HTMLElement; find(selector: string): Node[] };
    const stages = (window as unknown as { Konva: { stages: Stage[] } }).Konva.stages;
    const main = stages.reduce((a, b) => (b.width() > a.width() ? b : a));
    const node = main.find("Text").find((candidate) => candidate.text?.().includes(wanted));
    if (!node) return null;
    const rect = node.getClientRect();
    const box = main.container().getBoundingClientRect();
    const scale = box.width / main.width();
    return { x: box.left + (rect.x + rect.width / 2) * scale, y: box.top + (rect.y + rect.height / 2) * scale };
  }, word);
  if (!spot) throw new Error(`"${word}" is not on the slide`);
  return { x: offset.x + spot.x, y: offset.y + spot.y };
}

/** Double-click a word of the slide's text, put the caret at the end of that text and type. */
async function editText(p: Page, word: string, typed: string) {
  const { x, y } = await wordAt(p, word);
  await p.mouse.dblclick(x, y);
  await editorFrame(p)!.locator("[contenteditable]").first().waitFor({ timeout: 10_000 });
  await p.keyboard.press("Control+End");
  await p.keyboard.type(typed);
  await p.keyboard.press("Escape");
}

try {
  await page.addInitScript((id) => localStorage.setItem("workbench.lastWork", id), work.id);
  await page.goto(`${ready.url}/?token=${ready.token}`);
  await page.waitForSelector(".docs-button");
  await page.locator(".docs-button").click();
  await page.locator(".docs-menu").getByText("표지.pptx", { exact: true }).click();
  await waitFor("slide stage", async () => (await editorFrame(page)?.locator(".konvajs-content").count()) === 1 || ((await editorFrame(page)?.locator(".konvajs-content").count()) ?? 0) > 0, 60_000);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(outDir, "01-open.png") });
  check("문서 화면 안에서 PPT 편집기로 열림", (await status(page)).includes("r1 저장됨"), await status(page));

  const visibleAi = await editorFrame(page)!.locator("body").evaluate(() =>
    Array.from(document.querySelectorAll(".ai-entry, .ai-dock, .stage-ai-bar, .ai-ask-trigger")).filter((el) => el.getClientRects().length > 0).length,
  );
  check("편집기 자체 AI 진입점 숨김", visibleAi === 0, `visible=${visibleAi}`);

  // Edit the title, then Ctrl+S → the next revision.
  await editText(page, "특강", " — 워크벤치");
  await waitStatus(page, "저장 안 됨");
  await page.keyboard.press("Control+s");
  await waitStatus(page, "r2 저장됨");
  const r2 = await textOf(2);
  check("제목 고치고 Ctrl+S → r2, 파일에 반영", r2.includes("가을 특강 — 워크벤치"), r2.split("\n")[0]);
  await page.screenshot({ path: join(outDir, "02-saved.png") });

  // Leaving for the conversation tab saves first.
  await editText(page, "특강", " 탭");
  await waitStatus(page, "저장 안 됨");
  await page.locator(".doc-tab.conversation").click();
  await page.waitForFunction(() => !document.querySelector("iframe.office-frame"), undefined, { timeout: 30_000 });
  check("대화 탭으로 옮기면 먼저 저장(r3)", (await revisions()).length === 3 && (await textOf(3)).includes("워크벤치 탭"));

  // Back, then a revision made elsewhere while I have unsaved edits: refused, then "keep my edits".
  await page.locator(".doc-tab-open", { hasText: "표지.pptx" }).click();
  await waitStatus(page, "r3 저장됨", 60_000);
  await page.waitForTimeout(1500);
  await editText(page, "특강", " 또");
  await waitStatus(page, "저장 안 됨");
  await editElsewhere("질문에서", "질문으로부터");
  await page.waitForSelector(".doc-conflict", { timeout: 20_000 });
  await page.screenshot({ path: join(outDir, "03-conflict.png") });
  check("편집 중 다른 곳에서 r4 → 충돌 안내", true, (await page.locator(".doc-conflict").innerText()).replace(/\s+/g, " ").slice(0, 100));
  await page.getByRole("button", { name: "내 편집을 새 판으로" }).click();
  await waitStatus(page, "r5 저장됨", 30_000);
  const r5 = await textOf(5);
  check("내 편집을 새 판으로 → r5, r4는 기록에 남음", r5.includes("탭 또") && (await textOf(4)).includes("질문으로부터"), r5.replace(/\n/g, " / "));

  // A revision made elsewhere with nothing unsaved here: the editor shows it.
  await editElsewhere("시작하는", "출발하는");
  await waitFor("editor shows r6", async () => (await editorFrame(page)?.locator(".konvajs-content").count() ?? 0) > 0 && (await status(page)).includes("r6 저장됨"), 60_000);
  check("저장 안 된 편집이 없으면 새 판(r6)을 바로 보여 줌", (await page.locator(".doc-conflict").count()) === 0);
} catch (error) {
  check("실행", false, error instanceof Error ? error.message.split("\n")[0]! : String(error));
  await page.screenshot({ path: join(outDir, "99-failure.png") }).catch(() => undefined);
} finally {
  writeFileSync(join(outDir, "console.log"), logs.join("\n"));
  writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
  await browser.close();
  child.kill();
  // The gateway's data, the work folder and the downloaded revisions belong to this run only.
  await new Promise((resolve) => (child.exitCode === null && child.signalCode === null ? child.once("exit", resolve) : resolve(null)));
  for (const dir of [dataDir, cwd, scratch]) rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((result) => !result.ok).length;
  console.log(`${results.length - failed}/${results.length} passed · console: ${logs.length ? logs.slice(0, 6).join(" | ") : "clean"}`);
  process.exitCode = failed ? 1 : 0;
}
