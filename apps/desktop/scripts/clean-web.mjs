// Before a release build: the web/ an earlier build copied beside the binary goes, so files the
// UI no longer has do not linger in the bundle. A script, not `node -e`, so every shell runs it.
import { existsSync, rmSync } from "node:fs";

// A web-only Vite build clears dist, including Office/design pages. Never package an
// apparently successful desktop build with those editors missing (or old debug copies).
for (const path of ["index.html", "office/docs.html", "office/slides.html", "office/sheets.html", "office/hwp.html", "office/markdown.html", "office/html.html", "office/pdf.html", "office/mindmap.html", "office/epub.html", "office/pdf-runtime/build.json", "office/studio/build.json", "design/index.html"]) {
  if (!existsSync(new URL(`../../web/dist/${path}`, import.meta.url))) throw new Error(`Missing built editor: ${path}. Run npm run build from the repository root first.`);
}

rmSync(new URL("../src-tauri/target/release/web", import.meta.url), { recursive: true, force: true });
