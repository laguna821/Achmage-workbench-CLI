import { renameSync, writeFileSync } from "node:fs";
import { hangulPng, pictureFontBytes } from "./channels/hangul-picture.ts";
import { hangulFirstPage } from "./hwp-pages.mjs";

// One first-page picture of a Hangul document, in a process of its own (forked by
// channels/hangul-picture-run.ts): the page is drawn (rhwp) and rasterized (resvg) here, so the
// gateway's event loop is not held for it and the fonts and WASM memory go when this exits.
// The page's SVG is written before rasterizing: if rasterizing fails or this is killed, the
// gateway can still send the page without drawing it itself.

type Job = { path: string; format: string; out: string; svg: string };

// Its own limit (argv[2], ms), for when the parent cannot end it; and it ends when the parent is gone.
const limit = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 25_000;
setTimeout(() => process.exit(1), limit);
process.once("disconnect", () => process.exit(0));

process.once("message", (message: Job) => {
  void (async () => {
    const started = performance.now();
    let step: "render" | "raster" = "render";
    try {
      const page = await hangulFirstPage(message.path, message.format);
      if (!page) throw new Error("no page");
      // Whole or not at all: a child stopped mid-write leaves no half page.
      writeFileSync(`${message.svg}.part`, page.svg, { mode: 0o600 });
      renameSync(`${message.svg}.part`, message.svg);
      step = "raster";
      const drawn = performance.now();
      writeFileSync(message.out, await hangulPng(page.svg), { mode: 0o600 });
      process.send?.({ ok: true, renderMs: Math.round(drawn - started), rasterMs: Math.round(performance.now() - drawn), fontBytes: pictureFontBytes(), rss: process.memoryUsage().rss });
    } catch {
      // Only which step failed: the error's words could name the document.
      process.send?.({ ok: false, code: step });
    }
  })().finally(() => process.disconnect?.());
});
