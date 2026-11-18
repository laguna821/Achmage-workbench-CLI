import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { patchPdfHistory } from "../pdf-history-patch.ts";
import { patchPdfTools } from "../pdf-tools-patch.ts";

const app = readFileSync(new URL("../../../vendor/ieumoffice/apps/pdf/src/renderer/App.tsx", import.meta.url), "utf8");

it("applies to the pinned renderer after the history patch: paste keeps one undo, cut saves at once, sizes are said", () => {
  const code = patchPdfTools(patchPdfHistory(app, "/history.ts"));
  const paste = code.slice(code.indexOf("const pastePages = async"), code.indexOf("const insertBlankPage = ("));
  expect(paste.indexOf("const wbBefore = snapshot()")).toBeLessThan(paste.indexOf("await flushThen("));
  expect(paste).toContain("await loadDoc(filePath, doc, undefined, [], true)\n      setUndoStack((u) => [...u.slice(-49), wbBefore])");
  expect(code).toContain("deletePages(origIdxs)\n      wbSaveCut.current = true");
  expect(code).toContain("void save(false, true)");
  expect(code).toContain("wbSize(outcome.bytesBefore)");
  expect(() => patchPdfTools(app.replace("    if (cut) deletePages(origIdxs)\n", ""))).toThrow("boundary changed");
});
