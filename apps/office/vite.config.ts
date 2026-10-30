import { existsSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Alias, type Plugin } from "vite";
import { collectModules, thirdPartyNotices } from "./notices.ts";

// IeumOffice's editor screens, built from vendor/ieumoffice (scripts/fetch-ieum.sh) and served on
// the editors' own origin at /office/. The editors are used unchanged:
//   docs   — the Word editor runs in the page; a bridge (src/docs.ts) stands in for its preload.
//   slides — the screen and preload run in the page; the editing code written for Electron's main
//            process runs in the page's worker, with Workbench's platform (src/platform) wherever
//            it asks Electron or Node for something (files, windows, dialogs, fonts).
//   sheets — the same, and its Rust xlsx engine runs in the worker as WebAssembly
//            (native/build-xlsx-wasm.sh) instead of a separate process.
// The editors resolve their own packages from the vendored node_modules.
const ieum = fileURLToPath(new URL("../../vendor/ieumoffice", import.meta.url));
if (!existsSync(`${ieum}/node_modules`)) throw new Error("vendor/ieumoffice is missing: run scripts/fetch-ieum.sh first");
const packages = `${ieum}/packages`;
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const slidesMain = `${ieum}/apps/slides/src/main/`;
const sheetsMain = `${ieum}/apps/sheets/src/main/`;

/** Workspace packages read from source (as IeumOffice's own builds do); subpaths before bare names. */
const aliases: Alias[] = [
  { find: /^@ieum\//, replacement: `${ieum}/` },
  ...[
    ["@genoffice/docx-engine/lazy-media", "docx-engine/src/lazy-media.ts"],
    ["@genoffice/docx-engine/zip-splice", "docx-engine/src/zip-splice.ts"],
    ["@genoffice/docx-engine/metafile", "docx-engine/src/metafile.ts"],
    ["@genoffice/docx-engine/math", "docx-engine/src/math.ts"],
    ["@genoffice/docx-engine", "docx-engine/src/index.ts"],
    ["@genoffice/odt-engine", "odt-engine/src/index.ts"],
    ["@genoffice/pptx-engine/table-grid", "pptx-engine/src/table-grid.ts"],
    ["@genoffice/pptx-engine/identity", "pptx-engine/src/identity.ts"],
    ["@genoffice/pptx-engine/named-action", "pptx-engine/src/named-action.ts"],
    ["@genoffice/pptx-engine/custgeom", "pptx-engine/src/custgeom.ts"],
    ["@genoffice/pptx-engine/background-promote", "pptx-engine/src/background-promote.ts"],
    ["@genoffice/pptx-engine/model3d", "pptx-engine/src/model3d.ts"],
    ["@genoffice/pptx-engine/chart-workbook", "pptx-engine/src/chart-workbook.ts"],
    ["@genoffice/pptx-engine", "pptx-engine/src/index.ts"],
    ["@genoffice/pptx-ops/op-docs", "pptx-ops/src/op-docs.ts"],
    ["@genoffice/pptx-ops/font-size", "pptx-ops/src/font-size.ts"],
    ["@genoffice/pptx-ops", "pptx-ops/src/index.ts"],
    ["@genoffice/pptx-render/preset-geometry", "pptx-render/src/preset-geometry.ts"],
    ["@genoffice/pptx-render", "pptx-render/src/index.ts"],
    ["@genoffice/pipelines/slides/layout-audit", "pipelines/src/slides/layout-audit.ts"],
    ["@genoffice/pipelines/slides/templates", "pipelines/src/slides/templates/index.ts"],
    ["@genoffice/i18n", "i18n/src/index.ts"],
  ].map(([find, path]) => ({ find: new RegExp(`^${find!.replace(/[/.]/g, "\\$&")}$`), replacement: `${packages}/${path}` })),
  // Our own modules use these from the vendored tree too.
  { find: /^opentype\.js$/, replacement: `${ieum}/node_modules/opentype.js/dist/opentype.mjs` },
];

/**
 * Where the slides editing code (written for Electron's main process) asks Electron or Node for
 * something, Workbench's platform answers; features Workbench does not run (the editor's AI,
 * templates, presenter windows, PDF export) are left out. Applies to the worker build only.
 */
function workbenchPlatform(): Plugin {
  const platform = (file: string) => here(`./src/platform/${file}`);
  const BY_NAME: Record<string, string> = {
    electron: platform("electron.ts"),
    "node:fs": platform("fs.ts"),
    fs: platform("fs.ts"),
    "node:fs/promises": platform("fs-promises.ts"),
    "fs/promises": platform("fs-promises.ts"),
    "node:path": platform("node.ts"),
    path: platform("node.ts"),
    "node:crypto": platform("node.ts"),
    crypto: platform("node.ts"),
    "node:zlib": platform("node.ts"),
    zlib: platform("node.ts"),
    "node:os": platform("node.ts"),
    os: platform("node.ts"),
    "node:child_process": platform("node.ts"),
    "node:stream/promises": platform("node.ts"),
    "node:url": platform("node.ts"),
    "node:http": platform("unused.ts"),
    undici: platform("unused.ts"),
    "@genoffice/ai-provider": platform("unused.ts"),
    "@genoffice/ai-provider/codex-app-server": platform("unused.ts"),
    "@genoffice/ai-provider/subscription": platform("unused.ts"),
    "@genoffice/ai-search": platform("unused.ts"),
    "@genoffice/file-parse": platform("unused.ts"),
    "@genoffice/ui/ai-subscription-login-window": platform("unused.ts"),
    "@genoffice/project-store": platform("unused.ts"),
    "@genoffice/pipelines/slides": platform("unused.ts"),
    "@genoffice/font-metrics": platform("unused.ts"),
    "@genoffice/electron-utils": platform("electron-utils.ts"),
    "@genoffice/electron-utils/atomic-write": platform("electron-utils.ts"),
    "@genoffice/electron-utils/office-encryption": platform("electron-utils.ts"),
  };
  // Modules of the slides main code Workbench replaces, by their path relative to it.
  const LOCAL: Record<string, string> = {
    "./fonts": here("./src/slides/fonts.ts"),
    "./tiff-decode": platform("unused.ts"),
    "./shaped-metrics": platform("unused.ts"),
    "./font-store": platform("unused.ts"),
    ...Object.fromEntries(
      [
        "ai-ipc",
        "attachments-ipc",
        "generate-handoff-ipc",
        "generated-page-temp",
        "pdf-export",
        "presenter-show",
        "print-window",
        "seed-deck",
        "seed-queue",
        "template-bytes",
        "template-cover",
        "template-fonts",
        "template-selection-ipc",
      ].map((name) => [`./${name}`, platform("unused.ts")]),
    ),
  };
  // And of the sheets main code: its AI runs, PDF export, template fonts, legacy .xls conversion,
  // and the engine process client (the engine runs here as WebAssembly).
  const SHEETS_LOCAL: Record<string, string> = {
    "./ai-run": platform("unused.ts"),
    "./pdf-export": platform("unused.ts"),
    "./template-fonts": platform("unused.ts"),
    "./legacy-import": platform("unused.ts"),
    "./xlsx-sidecar-client": here("./src/sheets/engine-client.ts"),
  };
  return {
    name: "workbench-platform",
    enforce: "pre",
    resolveId(source, importer) {
      if (BY_NAME[source]) return BY_NAME[source];
      if (importer?.startsWith(slidesMain) && LOCAL[source]) return LOCAL[source];
      if (importer?.startsWith(sheetsMain) && SHEETS_LOCAL[source]) return SHEETS_LOCAL[source];
      // The engine's streamed save writes through Node streams; the main code gets one that writes the working copy.
      if (importer?.startsWith(slidesMain) && source === `${packages}/pptx-engine/src/index.ts`) return here("./src/slides/engine.ts");
      return null;
    },
  };
}

/** The page side of the slides editor: its preload's Electron imports go to the page's transport. */
function pagePlatform(): Plugin {
  return {
    name: "workbench-page-platform",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === "./save-flow" && importer === `${ieum}/apps/hwp/src/renderer/App.tsx`) return here("./src/hwp-save.ts");
      if (source === "@genoffice/pdf-structure" && (importer?.includes("/apps/epub/") || importer?.includes("/packages/epub-engine/"))) return `${ieum}/apps/epub/src/renderer/translate/pdf-structure-browser.ts`;
      return source === "electron" ? here("./src/platform/electron-renderer.ts") : null;
    },
  };
}

/** Reuse the original advanced panes without mounting the unrelated shell settings dialog. */
function originalSettingsPanes(): Plugin {
  return {
    name: "workbench-original-settings-panes", enforce: "pre",
    transform(code, id) {
      if (id !== `${ieum}/apps/shell/src/renderer/src/SettingsModal.tsx`) return null;
      for (const name of ["AiModelPane", "AiMediaPane"]) {
        const marker = `function ${name}(`;
        if (code.split(marker).length !== 2) this.error("Original AI settings panes changed; review their export adapter");
        code = code.replace(marker, `export ${marker}`);
      }
      // The original normalizer trims every name keystroke, eating an internal
      // space before the next character is typed. Keep the input draft intact;
      // writeAiSettings still performs the original normalization on save.
      const rename = "setSettings(upsertCustomEndpoint(settings, { ...endpoint, name }))";
      if (code.split(rename).length !== 2) this.error("Original endpoint naming changed; review its draft adapter");
      code = code.replace(rename, "setSettings({ ...settings, customEndpoints: (settings.customEndpoints ?? []).map((item) => item.id === endpoint.id ? { ...item, name } : item) })");
      return code;
    },
  };
}

/** Electron's preview push was synchronous IPC. HTTP must finish before a frame reload. */
function textEditorPlatform(): Plugin {
  return {
    name: "workbench-text-editors",
    enforce: "pre",
    transform(code, id) {
      if (id === `${ieum}/apps/epub/src/renderer/components/ChapterFrame.tsx`) {
        const before = '      sandbox="allow-same-origin"';
        if (code.split(before).length !== 2 || !code.includes("srcDoc={props.html}")) this.error("EPUB frame changed: review WebKit event compatibility and mandatory chapter CSP");
        return `import { epubFrameSandbox } from ${JSON.stringify(here("../../packages/contracts/src/epub.ts"))};\n` + code.replace(before, "      sandbox={epubFrameSandbox(navigator.userAgent)}");
      }
      if (id === `${ieum}/apps/epub/src/renderer/reader/chapter-html.ts`) {
        const before = "csp.setAttribute('content', FRAME_CSP)";
        if (!code.includes(before)) this.error("EPUB chapter policy changed: review the scoped HTTP asset adapter");
        return `import { epubBookCsp } from ${JSON.stringify(here("../../packages/contracts/src/epub.ts"))};\n` + code.replace(before, "csp.setAttribute('content', epubBookCsp(input.baseUrl))");
      }
      if (id === `${ieum}/apps/epub/src/renderer/App.tsx`) {
        const marker = "  // ---- saving (the editing screen sends its pending edits before these) ----";
        const readOnly = "editor.setBookReadOnly(opened.readOnly !== null)";
        if (!code.includes(marker) || !code.includes(readOnly)) this.error("EPUB editor changed: review recovery and read-only adapters");
        return code.replace(readOnly, "editor.setBookReadOnly(opened.readOnly !== null || opened.workbenchReadOnly === true)")
          .replace(marker, `  useEffect(() => {
    const flush = () => {
      const done = (ok) => window.dispatchEvent(new CustomEvent('workbench:epub:flushed', { detail: ok }));
      if (editor.composing) { done(false); return; }
      void editor.flush().then(() => done(true), () => done(false));
    };
    window.addEventListener('workbench:epub:flush', flush);
    return () => window.removeEventListener('workbench:epub:flush', flush);
  }, [editor]);\n\n${marker}`);
      }
      if (id === `${ieum}/node_modules/mind-elixir/dist/MindElixir.js`) {
        // Chromium focuses a contenteditable when a Range is selected. WebKit does not.
        // Focus explicitly for topic, summary and relationship-label keyboard editing.
        const before = "function Ze(e) {\n  const t = document.createRange();";
        if (!code.includes(before) || (code.match(/Ze\(/g) ?? []).length !== 3) this.error("mind-elixir changed: review the input focus adapter");
        return code.replace(before, "function Ze(e) {\n  e.focus();\n  const t = document.createRange();");
      }
      if (id === `${ieum}/apps/mindmap/src/renderer/App.tsx`) {
        const before = "flush: (commit) =>\n      controllers.current.forEach((each) => {";
        const after = "each.flush()\n      }),\n    saving:";
        if (!code.includes(before) || !code.includes(after)) this.error("Mindmap recovery changed: review the pending note flush adapter");
        return code.replace(before, "flush: (commit) =>\n      (commit && noteRef.current?.commit(), controllers.current.forEach((each) => {")
          .replace(after, "each.flush()\n      })),\n    saving:");
      }
      if (id === `${ieum}/apps/markdown/src/renderer/editor/localImage.ts`) {
        for (const [name, adapter] of [["resolveImageSrc", "resolveTextImage"], ["unresolveImageSrc", "unresolveTextImage"]]) {
          const pattern = new RegExp(`export function ${name}\\(src: string, baseDir: string \\| null = imageBaseDir\\): string \\{[\\s\\S]*?\\n\\}`);
          if (!pattern.test(code)) this.error("Markdown image resolver changed: review the scoped asset adapter");
          code = code.replace(pattern, `export function ${name}(src: string): string { return ${adapter}(src); }`);
        }
        return `import { resolveTextImage, unresolveTextImage } from ${JSON.stringify(here("./src/text-assets.ts"))};\n${code}`;
      }
      if (id !== `${ieum}/apps/html/src/renderer/App.tsx`) return null;
      const calls = code.match(/window\.htmlApi\.updatePreview\(/g) ?? [];
      if (calls.length !== 2 || !code.includes("(nextText: string, reload = true) => {")) this.error("HTML preview changed: review the HTTP synchronization adapter");
      return code.replaceAll("window.htmlApi.updatePreview(", "await window.htmlApi.updatePreview(")
        .replace("(nextText: string, reload = true) => {", "async (nextText: string, reload = true) => {");
    },
  };
}

/**
 * TipTap's React binding (@tiptap/react 3.31, EditorInstanceManager.scheduleDestroy) destroys an
 * editor that is not mounted 1 ms after it was made. WebKit runs that timer before React's first
 * effects, so the Word editor's first instance is destroyed while it is being mounted and the page
 * crashes on it. Wait 10 s instead: the guard only exists to clean up editors that never mount.
 * Applied at build time; the vendored source is not edited.
 */
function tiptapMountGrace(): Plugin {
  const pattern = /(this\.scheduledDestructionTimeout = setTimeout\(\(\) => \{[\s\S]*?\}, )1(\);)/;
  return {
    name: "workbench-tiptap-mount-grace",
    transform(code, id) {
      if (!/[/\\]@tiptap[/\\]react[/\\]dist[/\\]index\.js$/.test(id)) return null;
      if (!pattern.test(code)) this.error("@tiptap/react changed: check the mount-grace patch in apps/office/vite.config.ts");
      return code.replace(pattern, (_, head: string, tail: string) => `${head}10000${tail}`);
    },
  };
}

export default defineConfig({
  base: "/office/",
  plugins: [
    pagePlatform(),
    originalSettingsPanes(),
    textEditorPlatform(),
    react(),
    tiptapMountGrace(),
    thirdPartyNotices([
      { title: "IeumOffice / GenOffice (Apache License 2.0)", files: [`${ieum}/NOTICE`, `${ieum}/LICENSE`] },
      { title: "Unicode data used by IeumOffice", files: [`${ieum}/LICENSE-UNICODE.txt`] },
      { title: "rhwp editor / WASM engine", files: [here("./public/studio/LICENSE-rhwp.txt"), here("./public/studio/THIRD-PARTY-LICENSES-rhwp.md")] },
      {
        title: "Fonts bundled with the editors",
        files: [`${ieum}/apps/docs/src/renderer/fonts/README.md`, `${packages}/ui/src/fonts/README.md`, `${ieum}/apps/docs/src/renderer/fonts/LICENSE-OFL.txt`],
      },
    ], [
      {
        title: "Rust crates in the spreadsheet engine (assets/xlsx-engine-*.wasm)",
        manifest: here("./native/xlsx-wasm/Cargo.toml"),
        target: "wasm32-wasip1",
        about: [
          "The spreadsheet engine is IeumOffice's xlsx engine (apps/sheets/native/xlsx-engine, Apache-2.0,",
          "above) built for WebAssembly by Workbench (apps/office/native/xlsx-wasm, with wasi.patch).",
        ],
        alsoContains: [
          "Rust standard library — MIT OR Apache-2.0 — https://github.com/rust-lang/rust",
          "wasi-libc — Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT — https://github.com/WebAssembly/wasi-libc",
          "  Its parts from musl (https://musl.libc.org):",
          "",
          "  Copyright © 2005-2020 Rich Felker, et al.",
          "",
          "  Permission is hereby granted, free of charge, to any person obtaining a copy of this software and",
          "  associated documentation files (the \"Software\"), to deal in the Software without restriction,",
          "  including without limitation the rights to use, copy, modify, merge, publish, distribute,",
          "  sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is",
          "  furnished to do so, subject to the following conditions:",
          "",
          "  The above copyright notice and this permission notice shall be included in all copies or",
          "  substantial portions of the Software.",
          "",
          "  THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT",
          "  NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND",
          "  NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES",
          "  OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN",
          "  CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.",
        ],
      },
    ]),
  ],
  resolve: { alias: aliases },
  // The slides main code reads its own location at load time (session-state.ts).
  define: { __dirname: JSON.stringify("/app/main") },
  worker: {
    format: "es",
    plugins: () => [workbenchPlatform(), collectModules()],
  },
  server: { port: 5175, fs: { allow: [fileURLToPath(new URL("../..", import.meta.url))] } },
  build: {
    outDir: fileURLToPath(new URL("../web/dist/office", import.meta.url)),
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 6000,
    rollupOptions: { input: { settings: here("./settings.html"), docs: here("./docs.html"), slides: here("./slides.html"), sheets: here("./sheets.html"), hwp: here("./hwp.html"), markdown: here("./markdown.html"), html: here("./html.html"), pdf: here("./pdf.html"), mindmap: here("./mindmap.html"), epub: here("./epub.html") } },
  },
});
