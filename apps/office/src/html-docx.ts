import "./platform/globals.ts";
import type { BrowserDriver, ScreenshotOptions, Viewport } from "../../../vendor/ieumoffice/packages/html2docx/src/driver.ts";
import { convertHtmlToDocx } from "../../../vendor/ieumoffice/packages/html2docx/src/convert.ts";
import { buildPreviewDocument } from "../../../third_party/ieumoffice/text-assets/preview-document.ts";
import { browserOperation, cancelOutput, commitOutput, prepareOutput } from "./output.ts";
import type { OfficeOutputPlan } from "../../../packages/contracts/src/office-output.ts";

// Electron's original hidden driver disables background throttling. System
// WebViews can suspend animation frames, so race each frame with a short timer.
function initializeDocument() {
  const loads = { pending: 0, last: performance.now() };
  Object.defineProperty(globalThis, "__workbenchBrowserLoads", { value: loads });
  const start = () => { loads.pending++; let done = false; return () => { if (!done) { done = true; loads.pending--; loads.last = performance.now(); } }; };
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args) => { const done = start(); try { return await originalFetch(...args); } finally { done(); } };
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    const done = start(); this.addEventListener("loadend", done, { once: true });
    try { return send.apply(this, args); } catch (error) { done(); throw error; }
  };
  const raf = window.requestAnimationFrame.bind(window), caf = window.cancelAnimationFrame.bind(window);
  const frames = new Map<number, { frame: number; timer: number }>(); let serial = 0;
  window.requestAnimationFrame = (callback) => {
    const id = ++serial;
    const finish = (time: number) => { const entry = frames.get(id); if (!entry) return; frames.delete(id); caf(entry.frame); clearTimeout(entry.timer); callback(time); };
    frames.set(id, { frame: raf(finish), timer: window.setTimeout(() => finish(performance.now()), 32) });
    return id;
  };
  window.cancelAnimationFrame = (id) => { const entry = frames.get(id); if (entry) { caf(entry.frame); clearTimeout(entry.timer); frames.delete(id); } };
}

/** Only the browser adapter changes; extraction and OOXML generation are upstream. */
export class TauriBrowserDriver implements BrowserDriver {
  private id: string | null = null;
  private viewport: Viewport = { width: 794, height: 1123, deviceScaleFactor: 2 };
  private scripts = [`(${initializeDocument.toString()})()`];
  private readonly revision: number;
  private readonly html: string;
  constructor(revision: number, html: string) { this.revision = revision; this.html = html; }
  private current() { if (!this.id) throw new Error("문서 변환 창이 닫혔습니다."); return this.id; }
  async setViewport(viewport: Viewport) {
    this.viewport = viewport;
    if (this.id) await browserOperation(this.revision, { kind: "viewport", id: this.id, viewport });
  }
  async goto(_url: string, options: { timeoutMs: number }) {
    const started = performance.now();
    await this.close();
    this.id = (await browserOperation<{ id: string }>(this.revision, { kind: "create", html: this.html, viewport: this.viewport, scripts: this.scripts })).id;
    // Page load is settled natively. Wait for a quiet resource interval, bounded
    // like the original driver; the converter also waits for fonts and images.
    await this.evaluate(async ({ timeout, width, height }: { timeout: number; width: number; height: number }) => {
      const deadline = performance.now() + timeout; let last = performance.now();
      const loads = (globalThis as unknown as { __workbenchBrowserLoads: { pending: number; last: number } }).__workbenchBrowserLoads;
      const observer = new PerformanceObserver(() => { last = performance.now(); });
      observer.observe({ type: "resource", buffered: true });
      try {
        while (performance.now() < deadline && (innerWidth === 0 || innerHeight === 0 || loads.pending || performance.now() - Math.max(last, loads.last) < 500)) await new Promise(resolve => setTimeout(resolve, 100));
        if (Math.abs(innerWidth - width) > 2 || Math.abs(innerHeight - height) > 2) throw new Error(`문서 변환 화면 크기를 맞추지 못했습니다: ${innerWidth}×${innerHeight}`);
      }
      finally { observer.disconnect(); }
    }, { timeout: Math.max(0, options.timeoutMs - (performance.now() - started)), width: this.viewport.width, height: this.viewport.height });
  }
  async evaluate<T>(fn: string | ((arg?: any) => T | Promise<T>), arg?: unknown): Promise<T> {
    const expression = typeof fn === "string" ? fn : `(${fn.toString()})(${arg === undefined ? "" : JSON.stringify(arg)})`;
    return (await browserOperation<{ value: unknown }>(this.revision, { kind: "evaluate", id: this.current(), expression })).value as T;
  }
  async addScript(source: string) { await this.evaluate(`(()=>{${source}\n})()`); }
  async addInitScript(source: string) { this.scripts.push(source); }
  elementExists(selector: string) { return this.evaluate((sel: string) => document.querySelector(sel) !== null, selector); }
  async screenshotElement(selector: string, options: Pick<ScreenshotOptions, "omitBackground">) {
    const box = await this.evaluate((sel: string) => {
      const node = document.querySelector(sel); if (!node) return null;
      const r = node.getBoundingClientRect();
      return { x: Math.max(0, Math.round(r.left + scrollX)), y: Math.max(0, Math.round(r.top + scrollY)), width: Math.round(r.width), height: Math.round(r.height) };
    }, selector);
    return box && box.width > 0 && box.height > 0 ? this.screenshot({ ...options, clip: box }) : null;
  }
  async screenshot(options: ScreenshotOptions): Promise<Uint8Array> {
    const saved = await this.evaluate(() => ({ x: scrollX, y: scrollY, width: innerWidth, height: innerHeight, scroll: document.documentElement.style.scrollBehavior, background: document.documentElement.style.backgroundColor }));
    const clip = options.clip ?? { x: saved.x, y: saved.y, width: saved.width, height: saved.height }, scale = this.viewport.deviceScaleFactor;
    if (![clip.x, clip.y, clip.width, clip.height].every(Number.isFinite) || clip.width <= 0 || clip.height <= 0 || clip.width * clip.height * scale * scale > 64_000_000) throw new Error("문서 그림의 크기 한도를 넘었습니다.");
    const canvas = document.createElement("canvas"); canvas.width = Math.round(clip.width * scale); canvas.height = Math.round(clip.height * scale);
    const context = canvas.getContext("2d"); if (!context) throw new Error("문서 그림을 합치지 못했습니다.");
    try {
      await this.evaluate((transparent: boolean) => {
        document.documentElement.style.scrollBehavior = "auto";
        if (!transparent && ["transparent", "rgba(0, 0, 0, 0)"].includes(getComputedStyle(document.documentElement).backgroundColor)) document.documentElement.style.backgroundColor = "white";
      }, Boolean(options.omitBackground));
      for (let row = 0; row < clip.height;) {
        let rowHeight = clip.height - row;
        for (let column = 0; column < clip.width;) {
          const pageX = clip.x + column, pageY = clip.y + row;
          const position = await this.evaluate(async ({ x, y }: { x: number; y: number }) => {
            window.scrollTo({ left: x, top: y, behavior: "instant" });
            await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
            return { x: scrollX, y: scrollY, width: innerWidth, height: innerHeight };
          }, { x: pageX, y: pageY });
          const x = pageX - position.x, y = pageY - position.y;
          const width = Math.min(clip.width - column, position.width - x), height = Math.min(rowHeight, position.height - y);
          if (width <= 0 || height <= 0 || x < 0 || y < 0) throw new Error("문서 그림의 영역을 캡처하지 못했습니다.");
          const result = await browserOperation<{ base64: string }>(this.revision, { kind: "snapshot", id: this.current(), clip: { x, y, width, height, pageX, pageY }, transparent: Boolean(options.omitBackground) });
          const image = new Image(); image.src = `data:image/png;base64,${result.base64}`; await image.decode();
          context.drawImage(image, column * scale, row * scale, width * scale, height * scale);
          column += width; rowHeight = Math.min(rowHeight, height);
        }
        row += rowHeight;
      }
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("문서 그림을 저장하지 못했습니다.")), "image/png"));
      return new Uint8Array(await blob.arrayBuffer());
    } finally {
      await this.evaluate((state: typeof saved) => { document.documentElement.style.backgroundColor = state.background; window.scrollTo({ left: state.x, top: state.y, behavior: "instant" }); document.documentElement.style.scrollBehavior = state.scroll; }, saved).catch(() => {});
      canvas.width = canvas.height = 0;
    }
  }
  async close() {
    const id = this.id; this.id = null;
    if (id) await browserOperation(this.revision, { kind: "close", id });
  }
}

export async function exportHtmlDocx(revision: number, html: string, baseUrl: string) {
  let plan: OfficeOutputPlan | null = null, driver: TauriBrowserDriver | null = null;
  try {
    plan = await prepareOutput(revision, "docx"); if (!plan) return { ok: true, canceled: true };
    const absoluteBase = new URL(baseUrl, location.href).href;
    // A standalone native view has a different origin from the editor preview.
    // Resolve authored relative <base> URLs in this disposable copy too.
    const preview = new DOMParser().parseFromString(buildPreviewDocument(html, absoluteBase), "text/html");
    const base = preview.querySelector("base[href]");
    if (base) base.setAttribute("href", new URL(base.getAttribute("href")!, absoluteBase).href);
    const doctype = preview.doctype ? new XMLSerializer().serializeToString(preview.doctype) : "";
    driver = new TauriBrowserDriver(revision, doctype + preview.documentElement.outerHTML);
    const result = await convertHtmlToDocx({ url: absoluteBase }, driver);
    const saved = await commitOutput(plan.id, Uint8Array.from(result.docx).buffer);
    return { ok: true, path: saved.path };
  } catch (error) {
    if (plan) await cancelOutput(plan.id).catch(() => {});
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally { await driver?.close().catch(() => {}); }
}
