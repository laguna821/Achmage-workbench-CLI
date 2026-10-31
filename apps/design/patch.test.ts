import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { patchDesign } from "./patch";

it("adapts all five pinned export call sites and fails closed when a source seam changes", () => {
  const files = ["engine/export/exporter.ts", "TopBar.tsx", "dialogs/DownloadDialog.tsx", "presenter/commands.tsx", "dialogs/video/VideoSection.tsx"];
  for (const file of files) {
    const path = new URL(`../../vendor/doory/src/editor/${file}`, import.meta.url);
    const source = readFileSync(path, "utf8");
    const patched = patchDesign(path.pathname, source);
    expect(patched).not.toBe(source);
    expect(patched).toMatch(file.includes("exporter") ? /await globalThis.workbenchDesignDownloads/ : /await downloadFiles/);
    expect(() => patchDesign(path.pathname, source.replaceAll("downloadFiles", "changedDownload"))).toThrow();
  }
});
