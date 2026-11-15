// The studio patches for rhwp-studio v0.9.0 (scripts/hwp-studio-090.mjs, H4b MUST 4): Ieum's, minus
// the four 0.9.0 made unnecessary, with the nested-table Cut redone. Against the 0.9.0 studio source
// (the build's checkout, or a local rhwp checkout in HWP_STUDIO_FROM / refs-ext): every patch applies
// exactly once, the upstream code that replaces each dropped one is there, and the redone Cut takes a
// table in a cell through the bridge call the table-delete patch adds.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain ES module without types
import { applyStudioPatch090, CANVASKIT_TRACES, STATUS_TIMING_TRACES, DROPPED_090, OWN_090, STUDIO_COMMIT_090, STUDIO_PATCHES_090, studioPatchTargets090, unwantedStudioFiles090 } from "../../../scripts/hwp-studio-090.mjs";
import { STUDIO_PATCHES } from "../../../vendor/ieumoffice/apps/hwp/scripts/rhwp-patches.mjs";

const candidates = [
  process.env.HWP_STUDIO_FROM,
  resolve("vendor/ieumoffice/apps/hwp/node_modules/.cache/rhwp-studio/v0.9.0"),
  resolve("../../refs-ext/rhwp-0.9.0"),
].filter((dir): dir is string => !!dir && existsSync(join(dir, "rhwp-studio/src/main.ts")));
const checkout = candidates[0];
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx|mjs|js)$/.test(name) ? [path] : [];
  });
}

describe("rhwp-studio 0.9.0 patches", () => {
  it("are Ieum's in Ieum's order, without the four 0.9.0 made unnecessary, each with its reason", () => {
    expect(Object.keys(DROPPED_090).sort()).toEqual(["studio-font-memo-state", "studio-font-memo-use", "studio-memo-anchors", "studio-memo-delete-undo"]);
    for (const reason of Object.values(DROPPED_090) as string[]) expect(reason).toMatch(/upstream/);
    expect(STUDIO_PATCHES_090).toEqual([...(STUDIO_PATCHES as string[]).filter((name) => !(name in DROPPED_090)), "workbench-pdf-import-setting", "workbench-canvas2d-only", "workbench-no-canvaskit", "workbench-status-pages"]);
    expect(Object.keys(OWN_090)).toEqual(["studio-nested-table-cut", "workbench-pdf-import-setting", "workbench-canvas2d-only", "workbench-no-canvaskit", "workbench-status-pages"]);
    expect(STUDIO_COMMIT_090).toBe("c9095c5f67632e6721e800ccc7fb43ea49d26682");
  });

  it.skipIf(!checkout)("each apply exactly once to the 0.9.0 studio source", () => {
    const sources = files(join(checkout!, "rhwp-studio/src"));
    for (const name of STUDIO_PATCHES_090 as string[]) {
      const targets = sources.filter((file) => studioPatchTargets090(name, file));
      expect(targets.length, name).toBeGreaterThan(0);
      for (const file of targets) expect(() => applyStudioPatch090(name, readFileSync(file, "utf8")), `${name} → ${file}`).not.toThrow();
    }
  });

  it.skipIf(!checkout)("leave nothing undone: upstream 0.9.0 does what the dropped ones did", () => {
    const src = (path: string) => readFileSync(join(checkout!, "rhwp-studio/src", path), "utf8");
    expect(src("core/wasm-bridge.ts")).toMatch(/\n  getMemoAnchors\(\): MemoAnchor\[\] \{/);
    expect(src("engine/command.ts")).toMatch(/touchesMemoAnchor\(wasm\.getMemoAnchors\(\), target, start, end\)\) \{\n\s+this\.fragmentId = wasm\.captureDeleteRange/);
    // a deletion that touches a memo's edge counts too (Ieum's counted the inside only)
    expect(src("core/memo.ts")).toContain("memo.startCharIdx <= end && start <= memo.endCharIdx");
    expect(src("core/wasm-bridge.ts")).toContain("descriptor.set!.call(this, canvasFontResolution.resolve(String(value)));");
    expect(src("core/canvas-font-resolution-scope.ts")).toContain("export class CanvasFontResolutionScope");
  });

  it.skipIf(!checkout)("let Cut take a selected table in a cell through the bridge's deleteTableAt", () => {
    const handler = readFileSync(join(checkout!, "rhwp-studio/src/engine/input-handler.ts"), "utf8");
    const patched = applyStudioPatch090("studio-nested-table-cut", handler);
    expect(handler).toContain("if (table?.cellPath && table.cellPath.length > 1) return;");
    expect(patched).not.toContain("if (table?.cellPath && table.cellPath.length > 1) return;");
    expect(patched.split("wasm.deleteTableAt(table!);").length).toBe(2);
    // the copy before the cut and the guards around it stay
    expect(patched).toContain("if (!await this.copySelectedObject(isCurrent) || !isCurrent()) return;");
    const bridge = applyStudioPatch090("studio-table-delete-at", readFileSync(join(checkout!, "rhwp-studio/src/core/wasm-bridge.ts"), "utf8"));
    expect(bridge).toContain("deleteTableAt(ref: { sec: number; ppi: number; ci: number; cellPath?: CellPathEntry[] }): { ok: boolean } {");
    // the CRLF form of a checkout is patched the same way
    expect(applyStudioPatch090("studio-nested-table-cut", handler.replaceAll("\n", "\r\n"))).toBe(patched.replaceAll("\n", "\r\n"));
  });

  it.skipIf(!checkout)("show the PDF import setting only when the engine imports PDF (ours does not)", () => {
    const dialog = readFileSync(join(checkout!, "rhwp-studio/src/ui/options-dialog.ts"), "utf8");
    const patched = applyStudioPatch090("workbench-pdf-import-setting", dialog);
    expect(patched).toContain("    if (workbenchPdfImport(WorkbenchEngine)) panel.appendChild(this.createPdfImportSection());");
    expect(patched).toContain("import { hasPdfImportCapability as workbenchPdfImport } from '@/core/pdf-import-capability';");
    expect(patched).toContain("    if (this.pdfImportEditableRadio) userSettings.setPdfImportLayout(");
    // the capability the studio's open paths ask (core/pdf-import-capability.ts): false for our engine
    expect(readFileSync(join(checkout!, "rhwp-studio/src/core/pdf-import-capability.ts"), "utf8")).toContain("candidate.supportsPdfImport() === true");
  });

  // Review M6 (size): the studio draws with Canvas2D only; the CanvasKit chunk and WASM are not built.
  it.skipIf(!checkout)("turn every renderer request into Canvas2D and remove the one import of the CanvasKit renderer", () => {
    const backend = applyStudioPatch090("workbench-canvas2d-only", readFileSync(join(checkout!, "rhwp-studio/src/view/render-backend.ts"), "utf8"));
    expect(backend).not.toMatch(/backend: 'canvaskit'|backend: 'auto'/);
    // what is left of resolveRenderBackendRequest: no request → canvas2d (default), canvas/canvas2d/legacy →
    // canvas2d, anything else (canvaskit, skia, auto now included) → canvas2d with upstream's "unsupported" reason
    const resolver = backend.slice(backend.indexOf("export function resolveRenderBackendRequest"), backend.indexOf("export function resolveCanvasKitRenderMode("));
    expect([...resolver.matchAll(/backend: '(\w+)'/g)].map((match) => match[1])).toEqual(["canvas2d", "canvas2d", "canvas2d"]);
    expect(resolver).toContain("unsupportedReason: 'unsupportedRenderBackend'");
    const main = readFileSync(join(checkout!, "rhwp-studio/src/main.ts"), "utf8");
    expect(main.split("import('@/view/canvaskit-renderer')").length).toBe(2);
    const patchedMain = applyStudioPatch090("workbench-no-canvaskit", main);
    expect(patchedMain).not.toContain("canvaskit-renderer'");
    // no other source of the studio reaches the renderer or the CanvasKit WASM by a value import
    for (const file of files(join(checkout!, "rhwp-studio/src"))) {
      const text: string = file.endsWith("main.ts") ? patchedMain : readFileSync(file, "utf8");
      const imports = text.split("\n").filter((line) => /^\s*import (?!type)|import\(/.test(line) && /canvaskit-renderer|canvaskit-wasm/.test(line));
      expect(imports.filter((line) => !file.endsWith("canvaskit-renderer.ts") && !file.endsWith("canvaskit-wasm-url.ts")), file).toEqual([]);
    }
  });

  it("name what the built studio must not carry: the CanvasKit chunk and WASM, and upstream's root rhwp.js", () => {
    expect(unwantedStudioFiles090(["index.html", "rhwp.js", "assets/rhwp_bg-D22k40TY.wasm", "assets/canvaskit-SCAxUyCS.wasm", "assets/canvaskit-renderer-C8PouXcB.js", "assets/index-DkCoxqRm.js", "fonts/x/rhwp.js"]))
      .toEqual(["rhwp.js", "assets/canvaskit-SCAxUyCS.wasm", "assets/canvaskit-renderer-C8PouXcB.js"]);
    expect(CANVASKIT_TRACES).toEqual(["canvaskit-renderer", "canvaskit.wasm"]);
    // the builder refuses such an output, and leaves rhwp.js out of the checkout
    const builder = readFileSync("scripts/build-hwp-studio.mjs", "utf8");
    expect(builder).toContain("unwantedStudioFiles090(files(built)");
    expect(builder).toContain("'!/rhwp-studio/public/rhwp.js'");
  });

  it.skipIf(!checkout)("say '<file> — N쪽' after a document opens, without the load time", () => {
    const ko = readFileSync(join(checkout!, "rhwp-studio/src/i18n/locales/ko.ts"), "utf8");
    const patched = applyStudioPatch090("workbench-status-pages", ko);
    expect(patched).toContain('"ui.sbMessage.filePagesTimed": "{p1} — {p2}쪽",');
    expect(patched).toContain('"ui.sbMessage.filePages": "{p1} — {p2}쪽",');
    expect(patched).not.toMatch(/ms\)"/);
    for (const trace of STATUS_TIMING_TRACES as string[]) expect(patched).not.toContain(trace);
    expect(ko).toContain((STATUS_TIMING_TRACES as string[])[0]);
    expect(readFileSync("scripts/build-hwp-studio.mjs", "utf8")).toContain("STATUS_TIMING_TRACES.filter((trace) => text.includes(trace))");
  });

  it("fails loudly when the text is gone", () => {
    expect(() => applyStudioPatch090("studio-nested-table-cut", "nothing to patch")).toThrow(/exactly one occurrence/);
  });
});
