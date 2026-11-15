/// <reference lib="dom" />
// Drives the BUILT studio (apps/office/public/studio, or the folder given) once in headless Chromium
// (review M6 + the status line): opens a document of our own words as the app does
// (`index.html?chrome=embed`, the studio's loadFile), types into it, saves it (the studio's HWP and HWPX
// exports, as the app's save takes them), then opens it again with `?renderer=canvaskit` (the URL that
// used to load CanvasKit). It records EVERY request the page makes and fails if one asks for the
// CanvasKit chunk or WASM or the root rhwp.js, if a page has no drawn pixels, if the typed words are
// not in the saved files, or if the status line shows a load time ("…ms)"). Only 127.0.0.1.
// Usage: node scripts/hwp-studio-canvas2d-drive.ts [STUDIO_DIR] [--shots OUT_DIR]
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, resolve } from "node:path";
import { chromium } from "playwright-core";
import init, { ENGINE_DIR, HwpDocument } from "../third_party/hop/engine.ts";

const args = process.argv.slice(2);
const shotsAt = args.indexOf("--shots");
const shots = shotsAt >= 0 ? args.splice(shotsAt, 2)[1] : undefined;
const dir = resolve(args[0] ?? "apps/office/public/studio");
if (!existsSync(join(dir, "index.html"))) throw new Error(`no built studio at ${dir}`);
if (shots) mkdirSync(shots, { recursive: true });
await init({ module_or_path: readFileSync(join(ENGINE_DIR, "rhwp_bg.wasm")) });

const OWN = "워크벤치 편집기 확인 문서";
const doc = HwpDocument.createEmpty();
doc.createBlankDocument(); doc.insertText(0, 0, 0, OWN);
const original = doc.exportHwpx(); doc.free();

const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".ttf": "font/ttf" };
const exports = new Map<string, Buffer>();
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://local");
  if (url.pathname === "/__doc") { res.writeHead(200, { "content-type": "application/octet-stream" }); return res.end(original); }
  if (url.pathname.startsWith("/__export/") && req.method === "POST") {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk)).on("end", () => { exports.set(url.pathname.slice(10), Buffer.concat(chunks)); res.writeHead(204).end(); });
    return;
  }
  const path = normalize(join(dir, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname)));
  if (!path.startsWith(dir) || !existsSync(path)) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" }); res.end(readFileSync(path));
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const browser = await chromium.launch();
const failures: string[] = [];
const check = (ok: boolean, what: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failures.push(what); };
try {
  for (const query of ["?chrome=embed", "?chrome=embed&renderer=canvaskit"]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const requested: string[] = [], foreign: string[] = [], errors: string[] = [];
    page.on("request", (request) => { const url = new URL(request.url()); if (url.origin === origin) requested.push(url.pathname); else if (url.protocol !== "data:" && url.protocol !== "blob:") foreign.push(url.origin); });
    page.on("pageerror", (error) => errors.push(error.name));
    page.on("dialog", (dialog) => void dialog.dismiss().catch(() => undefined));
    await page.route(/^(?!http:\/\/127\.0\.0\.1)/, (route) => route.abort());
    await page.goto(`${origin}/index.html${query}`);
    await page.waitForFunction(() => !!(window as unknown as { rhwpStudio?: { automation?: unknown } }).rhwpStudio?.automation, null, { timeout: 60_000 });
    const request = (method: string, params: Record<string, unknown> = {}) => page.evaluate(({ method, params }) => new Promise<unknown>((done, fail) => {
      const id = Math.floor(Math.random() * 1e9);
      const listen = (event: MessageEvent) => {
        if (event.data?.type !== "rhwp-response" || event.data.id !== id) return;
        window.removeEventListener("message", listen);
        if (event.data.error) fail(new Error(String(event.data.error))); else done(event.data.result);
      };
      window.addEventListener("message", listen);
      window.postMessage({ type: "rhwp-request", id, method, params }, "*");
    }), { method, params });
    await page.evaluate(async () => {
      const data = await (await fetch("/__doc")).arrayBuffer();
      (window as unknown as { __doc: ArrayBuffer }).__doc = data;
    });
    await page.evaluate(() => new Promise<void>((done, fail) => {
      const id = 77;
      const listen = (event: MessageEvent) => { if (event.data?.type === "rhwp-response" && event.data.id === id) { window.removeEventListener("message", listen); if (event.data.error) fail(new Error(String(event.data.error))); else done(); } };
      window.addEventListener("message", listen);
      window.postMessage({ type: "rhwp-request", id, method: "loadFile", params: { data: (window as unknown as { __doc: ArrayBuffer }).__doc, fileName: "확인.hwpx", skipUnsavedGuard: true, suppressDialogs: true } }, "*");
    }));
    await page.waitForTimeout(1_500);
    // a page is drawn: some non-white pixel on the first page canvas
    const drawn = await page.evaluate(() => {
      for (const canvas of Array.from(document.querySelectorAll("canvas"))) {
        if (canvas.width < 100 || canvas.height < 100) continue;
        const context = canvas.getContext("2d"); if (!context) continue;
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3]! > 0 && (pixels[i]! < 200 || pixels[i + 1]! < 200 || pixels[i + 2]! < 200)) return true;
      }
      return false;
    });
    check(drawn, `${query}: the page is drawn (Canvas2D, ink on the page canvas)`);
    const status = await page.evaluate(() => document.querySelector("#status-bar")?.textContent ?? "");
    check(/1쪽/.test(status) && !/ms\)/.test(status) && !/페이지 \(/.test(status), `${query}: the status line says "… — 1쪽" without a load time (${JSON.stringify(status.replace(/\s+/g, " ").slice(0, 60))})`);
    // type: click into the text on the page, then keys (ASCII) and composed text (Hangul)
    const box = await page.evaluate(() => { const canvas = Array.from(document.querySelectorAll("canvas")).sort((a, b) => b.width * b.height - a.width * a.height)[0]!; const r = canvas.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
    await page.mouse.click(box.x + box.w * 0.3, box.y + Math.min(box.h * 0.12, 140));
    await page.keyboard.press("End");
    await page.keyboard.type("abc ");
    await page.keyboard.insertText("타자");
    await page.waitForTimeout(500);
    if (shots) await page.screenshot({ path: join(shots, `studio${query.includes("canvaskit") ? "-canvaskit-url" : ""}.png`) });
    // save: the studio's exports, as the app's save takes them
    for (const format of ["hwp", "hwpx"] as const) {
      const bytes = new Uint8Array(await request(format === "hwp" ? "exportHwp" : "exportHwpx") as number[]);
      const saved = new HwpDocument(bytes);
      try {
        const text = saved.getTextFileText();
        check(text.includes(OWN.slice(0, 4)) && text.includes("abc") && text.includes("타자"), `${query}: the ${format.toUpperCase()} save holds the document's words and the typed ones`);
      } finally { saved.free(); }
    }
    const unwanted = requested.filter((path) => /canvaskit/i.test(path) || path === "/rhwp.js");
    check(unwanted.length === 0, `${query}: no request for CanvasKit or the root rhwp.js (${requested.length} requests: ${[...new Set(requested.map((path) => path.split("/").slice(0, 2).join("/")))].join(", ")})`);
    check(requested.some((path) => /rhwp_bg-.*\.wasm$/.test(path)), `${query}: the engine WASM is what loaded`);
    check(foreign.length === 0, `${query}: no request outside 127.0.0.1 (${foreign.length})`);
    check(errors.length === 0, `${query}: no page error (${errors.join(", ")})`);
    await page.close();
  }
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
console.log(failures.length ? `studio drive: ${failures.length} FAILED` : "studio drive: all passed");
process.exitCode = failures.length ? 1 : 0;
