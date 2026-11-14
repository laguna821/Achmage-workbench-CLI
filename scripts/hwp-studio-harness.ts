// The built rhwp studio (apps/office/public/studio) in headless Chromium, with the office page's
// report builder (apps/office/src/hwp-structure-report.ts, bundled exactly as the office bundle has
// it) installed in the studio page. Used by scripts/hwp-studio-census-check.ts (every corpus
// document) and scripts/check-hwp-studio-report.ts (the build's check that the report still works).
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright-core";
import type { HwpStructure } from "../packages/contracts/src/hwp.ts";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const studioDir = join(repoRoot, "apps/office/public/studio");
const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".ttf": "font/ttf" };

export type Studio = {
  /** Loads `bytes` the way the app does (the studio's loadFile) and returns the office page's report of it (null: none, and `why`), and the studio's exports in `formats`. */
  load(bytes: Uint8Array, name: string, formats: ("hwp" | "hwpx")[]): Promise<{ structure: HwpStructure | null; why?: string; exports: Map<string, Uint8Array> }>;
  close(): Promise<void>;
};

export async function openStudio(dir = studioDir): Promise<Studio> {
  // The report builder as the office page runs it; the page is the studio itself, not a frame around it.
  const report = (await build({
    stdin: { contents: 'import { studioReport } from "./apps/office/src/hwp-structure-report.ts";\n(window as any).__workbenchStudioReport = () => studioReport({ contentWindow: window } as unknown as HTMLIFrameElement);\n', resolveDir: repoRoot, loader: "ts" },
    bundle: true, write: false, format: "iife", platform: "browser",
  })).outputFiles[0]!.text;
  const documents: Uint8Array[] = [];
  const exports = new Map<string, Uint8Array>();
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://local");
    if (url.pathname.startsWith("/__doc/")) { res.writeHead(200, { "content-type": "application/octet-stream" }); return res.end(documents[Number(url.pathname.slice(7))]); }
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
  let browser: Browser | undefined;
  const close = async () => {
    await browser?.close().catch(() => undefined);
    await new Promise<void>((done) => server.close(() => done()));
  };
  let page: Page;
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch();
    page = await browser.newPage();
    page.on("dialog", (dialog) => void dialog.dismiss().catch(() => undefined));
    await page.goto(`${origin}/`);
    await page.waitForFunction(() => !!(window as unknown as { rhwpStudio?: { automation?: unknown } }).rhwpStudio?.automation, null, { timeout: 60_000 });
    await page.addScriptTag({ content: report });
  } catch (error) { await close(); throw error; }
  return {
    close,
    async load(bytes, name, formats) {
      const index = documents.push(bytes) - 1;
      try {
        const report = await page.evaluate(async ({ url, name, index, formats }) => {
          let next = index * 10;
          const request = (method: string, params: Record<string, unknown> = {}) => new Promise<unknown>((done, fail) => {
            const id = ++next;
            const listen = (event: MessageEvent) => {
              if (event.data?.type !== "rhwp-response" || event.data.id !== id) return;
              window.removeEventListener("message", listen);
              if (event.data.error) fail(new Error(typeof event.data.error === "string" ? event.data.error : JSON.stringify(event.data.error))); else done(event.data.result);
            };
            window.addEventListener("message", listen);
            window.postMessage({ type: "rhwp-request", id, method, params }, "*");
          });
          await request("loadFile", { data: await (await fetch(url)).arrayBuffer(), fileName: name, skipUnsavedGuard: true, suppressDialogs: true });
          const count = (window as unknown as { __workbenchStudioReport(): unknown }).__workbenchStudioReport();
          for (const format of formats) {
            const exported = new Uint8Array(await request(format === "hwp" ? "exportHwp" : "exportHwpx") as number[]);
            await fetch(`/__export/${index}-${format}`, { method: "POST", body: exported });
          }
          return count;
        }, { url: `/__doc/${index}`, name, index, formats }) as { structure: HwpStructure } | { why: string };
        const out = new Map<string, Uint8Array>();
        for (const format of formats) { out.set(format, exports.get(`${index}-${format}`)!); exports.delete(`${index}-${format}`); }
        return "structure" in report ? { structure: report.structure, exports: out } : { structure: null, why: report.why, exports: out };
      } finally { documents[index] = new Uint8Array(); }
    },
  };
}

/**
 * The build check's line when the built studio gives no report (`why` from studioReport): its live
 * document not reachable (renamed internals), or reachable but its census failing (an engine call;
 * the error kind only) — T3, m3-5.
 */
export function noReportLine(dir: string, why: string): string {
  const after = "every Hangul save would go without the structure report";
  if (/could not be counted/.test(why)) {
    const kind = /\(([^()]*)\)\)?$/.exec(why)?.[1] ?? "error";
    return `the built studio (${dir}) gives the office page its live document, but counting it failed (${kind}) — ${after}. Update packages/contracts/src/hwp-structure.ts / hwp-text.ts to the engine's calls.`;
  }
  return `the built studio (${dir}) gives the office page no live document at rhwpStudio.automation.options.dispatcher.services.wasm.doc — ${after}. Update apps/office/src/hwp-structure-report.ts to the studio's new internals.`;
}
