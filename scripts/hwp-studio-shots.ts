/// <reference lib="dom" />
// Captures of the Hangul tab (the office HWP page with the built studio, Workbench's skin, fonts and
// AI dock) opening three documents built here — one with a table, one with memos, one with footnotes
// and endnotes — in light and dark, in the real Workbench UI against a real gateway (H4b).
// The documents are typed through the engine's editing calls with the filler text below (never a
// corpus document's text).
// Usage: node scripts/hwp-studio-shots.ts OUT_DIR    (needs the host, web and office builds)
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Frame, type Page } from "playwright-core";
import { editorFirst } from "./fixtures/editor-first.ts";
import init, { ENGINE_DIR, enginePackage, HwpDocument } from "../third_party/hop/engine.ts";

const outDir = process.argv[2];
if (!outDir) throw new Error("usage: node scripts/hwp-studio-shots.ts OUT_DIR");
mkdirSync(outDir, { recursive: true });
await init({ module_or_path: readFileSync(join(ENGINE_DIR, "rhwp_bg.wasm")) });

/** A document typed through the engine's own editing calls (as a person in the studio would make it). */
function typed(make: (doc: InstanceType<typeof HwpDocument>, line: (text: string) => number) => void): Uint8Array {
  const doc = HwpDocument.createEmpty();
  try {
    doc.createBlankDocument();
    // a new paragraph at the end (the blank document's first one is used as it is)
    const line = (value: string) => {
      let last = doc.getParagraphCount(0) - 1;
      if (doc.getParagraphLength(0, last) > 0) { doc.splitParagraph(0, last, doc.getParagraphLength(0, last)); last++; }
      doc.insertText(0, last, 0, value);
      return last;
    };
    make(doc, line);
    return doc.exportHwpx();
  } finally { doc.free(); }
}
const filler = (line: (text: string) => number, n: number) => { for (let i = 1; i <= n; i++) line(`채움 문단 ${i}: 한글 편집기 화면 확인용 문장입니다.`); };
const documents: Record<string, Uint8Array> = {
  "표": typed((doc, line) => {
    line("표가 있는 문서");
    const at = line("아래는 세 줄 세 칸짜리 표입니다.");
    const made = JSON.parse(doc.createTable(0, at, doc.getParagraphLength(0, at), 3, 3)) as { paraIdx?: number; controlIdx?: number };
    const host = made.paraIdx ?? at + 1, control = made.controlIdx ?? 0;
    ["구분", "내용", "비고", "첫째", "가나다", "-", "둘째", "라마바", "-"].forEach((value, cell) => doc.insertTextInCell(0, host, control, cell, 0, 0, value));
    filler(line, 4);
  }),
  "메모": typed((doc, line) => {
    line("메모가 있는 문서");
    const first = line("메모가 달린 첫째 문장입니다.");
    doc.insertMemo(0, first, 0, 6, JSON.stringify({ author: "검토자", text: "첫 메모의 내용" }));
    const second = line("둘째 메모가 달린 문장입니다.");
    doc.insertMemo(0, second, 0, 5, JSON.stringify({ author: "검토자", text: "둘째 메모" }));
    filler(line, 5);
  }),
  "각주": typed((doc, line) => {
    // every line first: a split at the end of a line would carry a note placed there into the next one
    line("각주와 미주가 있는 문서");
    const first = line("본문 문장");
    const second = line("다음 문장");
    filler(line, 8);
    const one = JSON.parse(doc.insertFootnote(0, first, doc.getParagraphLength(0, first))) as { controlIdx?: number };
    doc.insertTextInFootnote(0, first, one.controlIdx ?? 0, 0, 0, "첫 각주 설명");
    const two = JSON.parse(doc.insertFootnote(0, second, doc.getParagraphLength(0, second))) as { controlIdx?: number };
    doc.insertTextInFootnote(0, second, two.controlIdx ?? 0, 0, 0, "둘째 각주");
    doc.insertEndnote(0, second, doc.getParagraphLength(0, second));
  }),
};

const dataDir = mkdtempSync(join(tmpdir(), "wb-hwp-shots-"));
const cwd = mkdtempSync(join(tmpdir(), "wb-hwp-shots-cwd-"));
for (const [name, bytes] of Object.entries(documents)) writeFileSync(join(cwd, `${name}.hwpx`), bytes);
const child = spawn(process.execPath, ["apps/host/dist/host.mjs"], {
  env: { ...process.env, WORKBENCH_DATA_DIR: dataDir, WORKBENCH_WEB_DIR: "apps/web/dist", WORKBENCH_HOST_LABEL: "한글 화면" },
  stdio: ["ignore", "pipe", "inherit"],
});
const ready = await new Promise<{ url: string; token: string }>((resolve) => {
  createInterface({ input: child.stdout! }).on("line", (line) => { if (line.startsWith("WORKBENCH_READY ")) resolve(JSON.parse(line.slice(16))); });
});
const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${ready.url}${path}`, { method, headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = (await response.json()) as T & { message?: string };
  if (!response.ok) throw new Error(`${method} ${path}: ${json.message}`);
  return json;
};
await api("PUT", "/api/prefs", { prefs: { onboarding: "done", startScreen: "last" } });
const work = await api<{ id: string }>("POST", "/api/works", { title: "한글 화면", folderId: null, cwd });
for (const name of Object.keys(documents)) await api("POST", `/api/works/${work.id}/artifacts`, { path: `${name}.hwpx` });

const studioFrame = (page: Page): Frame | undefined => page.frames().find((frame) => frame.url().includes("/studio/"));
const results: string[] = [];
const browser = await chromium.launch();
try {
  for (const scheme of ["light", "dark"] as const) {
    for (const name of Object.keys(documents)) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 920 }, colorScheme: scheme });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message.slice(0, 160)));
      await page.addInitScript((id) => localStorage.setItem("workbench.lastWork", id), work.id);
      await editorFirst(page);
      await page.goto(`${ready.url}/?token=${ready.token}`);
      await page.waitForSelector(".note-head-more");
      await page.locator(".note-head-more").click();
      await page.locator(".note-menu").getByText(`${name}.hwpx`, { exact: true }).click();
      const deadline = Date.now() + 90_000;
      let pages = 0;
      for (;;) {
        const frame = studioFrame(page);
        pages = frame ? await frame.evaluate(() => document.querySelectorAll("canvas").length).catch(() => 0) : 0;
        if (pages > 0) break;
        if (Date.now() > deadline) throw new Error(`${scheme} ${name}: the studio drew no page`);
        await page.waitForTimeout(500);
      }
      // the memo column (closed by default) is opened for the memo document
      if (name === "메모") {
        const office = page.frames().find((frame) => frame.url().includes("/office/hwp.html"));
        await office?.getByRole("button", { name: "메모", exact: true }).first().click().catch(() => undefined);
      }
      await page.waitForTimeout(9000); // the dark toolbar icon sprite arrives late (H1)
      const file = join(outDir, `${scheme}-${name === "표" ? "table" : name === "메모" ? "memo" : "notes"}.png`);
      await page.screenshot({ path: file });
      const frame = studioFrame(page)!;
      const facts = await frame.evaluate(() => ({
        ai: !!document.querySelector("[data-panel-id='ai-assistant'], .ai-assistant, #ai-assistant"),
        pdf: Array.from(document.querySelectorAll("[data-cmd], .menu-item, button")).some((element) => /PDF\s*(열기|가져오기)/.test(element.textContent ?? "")),
        canvases: document.querySelectorAll("canvas").length,
      }));
      results.push(`${scheme} ${name}: canvases ${facts.canvases}, upstream AI panel ${facts.ai ? "PRESENT" : "absent"}, PDF open entry ${facts.pdf ? "PRESENT" : "absent"}, page errors ${errors.length}${errors.length ? ` (${errors.join(" | ")})` : ""} → ${file}`);
      await context.close();
    }
  }
} finally {
  await browser.close();
  child.kill("SIGTERM");
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
}
console.log(`engine ${enginePackage.version} wasm ${enginePackage.rhwp.wasmSha256}`);
for (const line of results) console.log(line);
