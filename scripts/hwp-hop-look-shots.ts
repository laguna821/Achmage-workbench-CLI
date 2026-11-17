/// <reference lib="dom" />
// The Hangul tab's top (menu row, icon row, format row, ruler) against a real gateway, for the side-by-side
// with Achmage HOP's reference frame (hop-look unit): 1440×900 and 1000×800, light and dark, each menu opened
// once, the format row's drop-downs opened. Fixture document typed through the engine (no corpus text).
// Usage: node scripts/hwp-hop-look-shots.ts OUT_DIR [PREFIX]   (needs the host, web and office builds)
// HOP_LOOK_SETS=top,menus,dropdowns (default all); HOP_LOOK_PALETTES="atlas:graphite" (light:dark set ids).
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Frame, type Page } from "playwright-core";
import { editorFirst } from "./fixtures/editor-first.ts";
import init, { ENGINE_DIR, HwpDocument } from "../third_party/hop/engine.ts";

const outDir = process.argv[2];
const prefix = process.argv[3] ?? "after";
if (!outDir) throw new Error("usage: node scripts/hwp-hop-look-shots.ts OUT_DIR [PREFIX]");
const sets = new Set((process.env.HOP_LOOK_SETS ?? "top,menus,dropdowns").split(","));
const [paletteLight, paletteDark] = (process.env.HOP_LOOK_PALETTES ?? "atlas:graphite").split(":");
mkdirSync(outDir, { recursive: true });
await init({ module_or_path: readFileSync(join(ENGINE_DIR, "rhwp_bg.wasm")) });

const doc = HwpDocument.createEmpty();
let bytes: Uint8Array;
try {
  doc.createBlankDocument();
  const line = (value: string) => {
    let last = doc.getParagraphCount(0) - 1;
    if (doc.getParagraphLength(0, last) > 0) { doc.splitParagraph(0, last, doc.getParagraphLength(0, last)); last++; }
    doc.insertText(0, last, 0, value);
    return last;
  };
  line("한글 편집기 화면 확인용 문서");
  for (let i = 1; i <= 6; i++) line(`채움 문단 ${i}: 메뉴와 도구 상자 모양을 확인하는 문장입니다.`);
  bytes = doc.exportHwpx();
} finally { doc.free(); }

const dataDir = mkdtempSync(join(tmpdir(), "wb-hoplook-"));
const cwd = mkdtempSync(join(tmpdir(), "wb-hoplook-cwd-"));
// one file per window: a closed window still holds its file's edit lease for a while (the next opens read-only)
const files = ["light-1440", "light-1000", "dark-1440", "dark-1000"].map((key) => `확인-${key}.hwpx`);
for (const file of files) writeFileSync(join(cwd, file), bytes);
const child = spawn(process.execPath, ["apps/host/dist/host.mjs"], {
  env: { ...process.env, WORKBENCH_DATA_DIR: dataDir, WORKBENCH_WEB_DIR: "apps/web/dist", WORKBENCH_HOST_LABEL: "한글 화면" },
  stdio: ["ignore", "pipe", "inherit"],
});
const ready = await new Promise<{ url: string; token: string }>((resolve) => {
  createInterface({ input: child.stdout! }).on("line", (text) => { if (text.startsWith("WORKBENCH_READY ")) resolve(JSON.parse(text.slice(16))); });
});
const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${ready.url}${path}`, { method, headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = (await response.json()) as T & { message?: string };
  if (!response.ok) throw new Error(`${method} ${path}: ${json.message}`);
  return json;
};
await api("PUT", "/api/prefs", { prefs: { onboarding: "done", startScreen: "last", paletteLight, paletteDark } });
const work = await api<{ id: string }>("POST", "/api/works", { title: "한글 화면", folderId: null, cwd });
for (const file of files) await api("POST", `/api/works/${work.id}/artifacts`, { path: file });

const studioFrame = (page: Page): Frame | undefined => page.frames().find((frame) => frame.url().includes("/studio/"));
const lines: string[] = [];
const browser = await chromium.launch();
async function open(scheme: "light" | "dark", width: number, height: number) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message.slice(0, 160)));
  await page.addInitScript((id) => localStorage.setItem("workbench.lastWork", id), work.id);
  await editorFirst(page);
  await page.goto(`${ready.url}/?token=${ready.token}`);
  await page.waitForSelector(".note-head-more");
  await page.locator(".note-head-more").click();
  await page.locator(".note-menu").getByText(`확인-${scheme}-${width}.hwpx`, { exact: true }).click();
  const deadline = Date.now() + 90_000;
  for (;;) {
    const frame = studioFrame(page);
    const pages = frame ? await frame.evaluate(() => document.querySelectorAll("canvas").length).catch(() => 0) : 0;
    if (pages > 0) break;
    if (Date.now() > deadline) { await page.screenshot({ path: join(outDir, "failed-load.png") }); throw new Error(`${scheme}: the studio drew no page`); }
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(6000); // the dark icon sheet arrives late (H1)
  return { context, page, frame: studioFrame(page)!, errors };
}
/** The studio iframe's box in the page (playwright gives nested frames' boxes in page coordinates). */
async function studioBox(page: Page) {
  const box = await (await studioFrame(page)!.frameElement()).boundingBox();
  if (!box) throw new Error("no studio frame box");
  return box;
}

try {
  for (const scheme of ["light", "dark"] as const) {
    for (const [width, height] of [[1440, 900], [1000, 800]] as const) {
      const wanted = sets.has("top") || (width === 1440 && (sets.has("menus") || sets.has("dropdowns")));
      if (!wanted) continue;
      const { context, page, frame, errors } = await open(scheme, width, height);
      const box = await studioBox(page);
      if (process.env.HOP_LOOK_EXPERIMENT) {
        // experiment only: the studio without the app's skin, with HOP's theme sheet over it
        const theme = readFileSync(process.env.HOP_LOOK_EXPERIMENT, "utf8");
        await frame.evaluate((css) => {
          for (const style of Array.from(document.querySelectorAll("style"))) if (style.textContent?.includes("--wb-ui-bg")) style.remove();
          const element = document.createElement("style"); element.textContent = css; document.head.append(element);
        }, theme);
        await page.waitForTimeout(1500);
      }
      const name = `${prefix}-${scheme}-${width}`;
      if (sets.has("top")) {
        await page.screenshot({ path: join(outDir, `${name}-window.png`) });
        await page.screenshot({ path: join(outDir, `${name}-top.png`), clip: { x: box.x, y: box.y, width: box.width, height: 200 } });
        const facts = await frame.evaluate(() => {
          const px = (selector: string) => { const e = document.querySelector(selector); return e ? Math.round(e.getBoundingClientRect().height) : -1; };
          const font = (selector: string) => { const e = document.querySelector(selector); if (!e) return "-"; const s = getComputedStyle(e); return `${s.fontSize} ${s.fontWeight} ${s.color} / ${s.fontFamily.split(",")[0]}`; };
          return { menu: px("#menu-bar"), icons: px("#icon-toolbar"), format: px("#style-bar"), ruler: px("#h-ruler") , menuFont: font("#menu-bar .menu-title"), labelFont: font("#icon-toolbar .tb-label"), bg: getComputedStyle(document.querySelector("#icon-toolbar")!).backgroundImage + " " + getComputedStyle(document.querySelector("#icon-toolbar")!).backgroundColor };
        });
        lines.push(`${name}: rows menu ${facts.menu} icons ${facts.icons} format ${facts.format} ruler ${facts.ruler}; menu ${facts.menuFont}; label ${facts.labelFont}; icon row ${facts.bg}; errors ${errors.length}${errors.length ? ` (${errors.join(" | ")})` : ""}`);
      }
      if (width === 1440 && sets.has("menus")) {
        const titles = await frame.locator("#menu-bar .menu-title").allTextContents();
        for (const [index, title] of titles.entries()) {
          await frame.locator("#menu-bar .menu-title").nth(index).click();
          await page.waitForTimeout(300);
          await page.screenshot({ path: join(outDir, `${name}-menu-${index + 1}.png`), clip: { x: box.x, y: box.y, width: Math.min(box.width, 900), height: Math.min(box.height, 760) } });
          await frame.locator("#menu-bar .menu-title").nth(index).click();
          await page.keyboard.press("Escape");
          await page.waitForTimeout(150);
          lines.push(`${name}: menu ${index + 1} ${title}`);
        }
      }
      if (width === 1440 && sets.has("dropdowns")) {
        for (const id of ["style-name", "font-lang", "font-name", "linespacing-select"]) {
          const trigger = frame.locator(`#style-bar .custom-select[data-select-id="${id}"] .custom-select-trigger`);
          if (!(await trigger.count())) { lines.push(`${name}: no drawn drop-down ${id}`); continue; }
          await trigger.first().click();
          await page.waitForTimeout(300);
          await page.screenshot({ path: join(outDir, `${name}-drop-${id}.png`), clip: { x: box.x, y: box.y, width: Math.min(box.width, 900), height: 480 } });
          await page.keyboard.press("Escape");
          await page.waitForTimeout(150);
        }
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
  child.kill("SIGTERM");
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
}
for (const text of lines) console.log(text);
