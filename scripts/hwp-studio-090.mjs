// The studio build for rhwp-studio v0.9.0: Ieum's builder (vendor/ieumoffice/apps/hwp/scripts/
// build-studio.mjs) and Ieum's studio patches (rhwp-patches.mjs) are vendored and stay unedited;
// scripts/build-hwp-studio.mjs runs an adapted copy of the builder, and takes the studio patches from
// here: all of Ieum's, in Ieum's order, then Workbench's own (OWN_090). Since IeumOffice v0.13.0 builds
// v0.9.0 itself (unit hwp13), what this file used to drop or redo is gone: the four Ieum patches 0.9.0 had
// made unnecessary are no longer in Ieum's list, and Ieum has its own 0.9.0 nested-table Cut.
// Each patch replaces text found exactly once and fails the build loudly otherwise.
import { IEUM_HWP_DIR } from './ieum-earlier-source.mjs'
const { applyPatch, patchTargets, STUDIO_PATCHES } = await import(new URL(`../${IEUM_HWP_DIR}/apps/hwp/scripts/rhwp-patches.mjs`, import.meta.url).href)

/** The 0.9.0 studio commit the build checks out (the engine's tag). */
export const STUDIO_COMMIT_090 = 'c9095c5f67632e6721e800ccc7fb43ea49d26682'

/** Workbench's own studio patches (no Ieum form), applied after Ieum's. */
export const OWN_090 = {}

/**
 * `workbench-pdf-import-setting`: the
 * options dialog always offers "PDF 가져오기" (how an imported PDF is laid out), though the studio
 * opens no PDF when the engine has no PDF import (ours is built without it); the section is shown
 * only when the engine can import PDF, as the studio's open paths already decide.
 */
OWN_090['workbench-pdf-import-setting'] = {
  file: /[\\/]rhwp-studio[\\/]src[\\/]ui[\\/]options-dialog\.ts$/,
  edits: [
    {
      find: "import type { PdfImportLayout } from '@/core/pdf-import-layout';\n",
      replace: [
        "import type { PdfImportLayout } from '@/core/pdf-import-layout';",
        "import { HwpDocument as WorkbenchEngine } from '@wasm/rhwp.js';",
        "import { hasPdfImportCapability as workbenchPdfImport } from '@/core/pdf-import-capability';",
        '',
      ].join('\n'),
    },
    {
      find: '    panel.appendChild(this.createPdfImportSection());\n',
      replace: '    if (workbenchPdfImport(WorkbenchEngine)) panel.appendChild(this.createPdfImportSection());\n',
    },
    {
      // without the section there is no choice to keep (OK must still work)
      find: "    userSettings.setPdfImportLayout(this.pdfImportEditableRadio.checked ? 'editable' : 'fidelity');\n",
      replace: "    if (this.pdfImportEditableRadio) userSettings.setPdfImportLayout(this.pdfImportEditableRadio.checked ? 'editable' : 'fidelity');\n",
    },
  ],
}

/**
 * `workbench-canvas2d-only` + `workbench-no-canvaskit` (review M6, size): 0.9.0's studio can draw with
 * CanvasKit (Skia in WASM, 7.3 MB) when its URL asks for it (`?renderer=canvaskit|skia|auto`);
 * Workbench opens `studio/index.html?chrome=embed` and never asks. Every renderer request becomes
 * the default Canvas2D (an unknown one already did: upstream's own "unsupported renderer" path, which
 * warns and draws with Canvas2D), and the one dynamic import that pulled the CanvasKit renderer and
 * its WASM into the build is gone, so Rollup emits neither. The build checks the output
 * (unwantedStudioFiles090, CANVASKIT_TRACES in scripts/build-hwp-studio.mjs).
 */
OWN_090['workbench-canvas2d-only'] = {
  file: /[\\/]rhwp-studio[\\/]src[\\/]view[\\/]render-backend\.ts$/,
  edits: [
    {
      find: [
        "  if (normalized === 'auto') {",
        "    return { backend: 'auto', source: 'url', requested: normalized };",
        '  }',
        "  if (normalized === 'canvaskit' || normalized === 'skia') {",
        "    return { backend: 'canvaskit', source: 'url', requested: normalized };",
        '  }',
        '',
      ].join('\n'),
      replace: '',
    },
  ],
}
OWN_090['workbench-no-canvaskit'] = {
  file: /[\\/]rhwp-studio[\\/]src[\\/]main\.ts$/,
  edits: [
    {
      find: [
        "        msg.textContent = 'CanvasKit 로딩 중...';",
        "        const { CanvasKitLayerRenderer } = await import('@/view/canvaskit-renderer');",
        '        return CanvasKitLayerRenderer.create(mode, surface, {',
        '          requirePreparedFontFamilies: true,',
        '        });',
      ].join('\n'),
      replace: "        throw new Error(`Workbench studio: no CanvasKit renderer (${mode}, ${surface})`);",
    },
  ],
}

/**
 * `workbench-status-pages`: after a document opens, the status line said "강의계획서.hwpx — 1페이지
 * (572.3ms)" — a developer's load time. A teacher reads "강의계획서.hwpx — 1쪽" ("쪽" as everywhere in
 * the app); the time is not shown (upstream does not log it elsewhere either).
 */
OWN_090['workbench-status-pages'] = {
  file: /[\\/]rhwp-studio[\\/]src[\\/]i18n[\\/]locales[\\/]ko\.ts$/,
  edits: [
    {
      find: '  "ui.sbMessage.filePages": "{p1} — {p2}페이지",\n  "ui.sbMessage.filePagesTimed": "{p1} — {p2}페이지 ({p3}ms)",\n',
      replace: '  "ui.sbMessage.filePages": "{p1} — {p2}쪽",\n  "ui.sbMessage.filePagesTimed": "{p1} — {p2}쪽",\n',
    },
  ],
}
/** Text that must not be in the built studio: the load time in the status line. */
export const STATUS_TIMING_TRACES = ['페이지 ({p3}ms)', '쪽 ({p3}ms)']

/**
 * `workbench-file-menu`: v0.13.0's plugin puts two new items into the File menu that Workbench does not
 * offer: "PDF 가져오기" (PDF → 한글 through Electron's importPdfAsHwp; Workbench's engine is built without
 * PDF import and the owner passed on PDF → Hangul) and "열기" (Electron's own open dialog and window; in
 * Workbench documents open from the document list into tabs). A menu item that cannot work would only fail.
 * Save, Save As, PDF, Print Preview and Print stay.
 */
OWN_090['workbench-file-menu'] = {
  file: /[\\/]studio-plugin[\\/]agent-plugin\.mjs$/,
  edits: [
    {
      find: "  { command: 'open', id: 'ext:ieum-open', shortcut: 'Ctrl+O' },\n",
      replace: '',
    },
    {
      find: "  { command: 'importPdf', id: 'ext:ieum-import-pdf' },\n",
      replace: '',
    },
  ],
}

/** The patches the 0.9.0 studio build applies: Ieum's in Ieum's order, then Workbench's own. */
export const STUDIO_PATCHES_090 = [...STUDIO_PATCHES, 'workbench-pdf-import-setting', 'workbench-canvas2d-only', 'workbench-no-canvaskit', 'workbench-status-pages', 'workbench-file-menu']

/**
 * What the built 0.9.0 studio must not carry (review M6): the CanvasKit renderer chunk and its WASM,
 * and upstream's root `rhwp.js` (another build's engine glue from rhwp-studio/public, never loaded;
 * the studio imports the engine through `@wasm`). Returns the offending paths (relative), [] if none.
 */
export function unwantedStudioFiles090(paths) {
  return paths.filter((path) => {
    const name = path.split(/[\\/]/).pop()
    return path === 'rhwp.js' || /^canvaskit.*\.wasm$/.test(name) || /^canvaskit-renderer.*\.js$/.test(name)
  })
}
/** Text in the built JS that would load CanvasKit (a chunk name or its WASM). */
export const CANVASKIT_TRACES = ['canvaskit-renderer', 'canvaskit.wasm']

/** One patch to `code`: ours for 0.9.0 where we have one, otherwise Ieum's. */
export function applyStudioPatch090(name, code) {
  const own = OWN_090[name]
  if (!own) return applyPatch(name, code)
  const eol = code.includes('\r\n') ? '\r\n' : '\n'
  let next = code
  for (const edit of own.edits) {
    const find = edit.find.replaceAll('\n', eol)
    const first = next.indexOf(find)
    if (first === -1 || next.indexOf(find, first + 1) !== -1) {
      throw new Error(`rhwp 0.9.0 studio patch ${name}: expected exactly one occurrence of the text to replace; the upstream source changed, review scripts/hwp-studio-090.mjs`)
    }
    next = next.replace(find, () => edit.replace.replaceAll('\n', eol))
  }
  return next
}

/** Vite plugin applying STUDIO_PATCHES_090; the build fails if one never found its file. */
export function studioPatches090() {
  const applied = new Set()
  return {
    name: 'workbench-rhwp-studio-090-patches',
    apply: 'build',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0]
      let next = code
      for (const name of STUDIO_PATCHES_090) {
        if (!studioPatchTargets090(name, file)) continue
        next = applyStudioPatch090(name, next)
        applied.add(name)
      }
      return next === code ? null : { code: next, map: null }
    },
    buildEnd() {
      const missing = STUDIO_PATCHES_090.filter((name) => !applied.has(name))
      if (missing.length > 0) this.error(`rhwp 0.9.0 studio patches never applied: ${missing.join(', ')} (file not loaded)`)
    },
  }
}

/** Whether patch `name` is written against `file` (ours for 0.9.0 where we have one). */
export function studioPatchTargets090(name, file) {
  return OWN_090[name] ? OWN_090[name].file.test(file) : patchTargets(name, file)
}
