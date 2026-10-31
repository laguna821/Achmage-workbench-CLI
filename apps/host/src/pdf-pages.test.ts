import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";
const require = createRequire(new URL("../../../vendor/ieumoffice/package.json", import.meta.url));
const { PDFDocument } = require("pdf-lib");

describe("embedded PDF page copies", () => {
  it("preserves source/revision and existing names under concurrent copy requests", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-pdf-pages-"));
    const manager = new SessionManager(new Store(join(dir, "state.sqlite")), new EventBus(), { hostId: "test", hostLabel: "test", managedWorksDir: join(dir, "works"), dataDir: dir });
    const work = manager.createWork({ title: "PDF copies", cwd: join(dir, "project") }); mkdirSync(work.cwd, { recursive: true });
    const doc = await PDFDocument.create(); doc.addPage([400, 600]).drawText("Source text"); doc.addPage([500, 700]);
    const path = join(work.cwd, "source.pdf"), source = Buffer.from(await doc.save()); writeFileSync(path, source);
    const occupied = join(work.cwd, "source.편집.pdf"); writeFileSync(occupied, "existing user file");
    const artifact = manager.openFile(work.id, "source.pdf");
    const results = await Promise.all([
      manager.editPdf(artifact.id, { rotate: [{ pages: [1], degrees: 90 }] }),
      manager.editPdf(artifact.id, { delete: [2] }),
    ]);
    expect(new Set(results.map(a => a.path)).size).toBe(2);
    expect(results.map(a => a.name).sort()).toEqual(["source.편집2.pdf", "source.편집3.pdf"]);
    expect((await PDFDocument.load(readFileSync(results[0]!.path))).getPage(0).getRotation().angle).toBe(90);
    expect((await PDFDocument.load(readFileSync(results[1]!.path))).getPageCount()).toBe(1);
    expect(readFileSync(path)).toEqual(source); expect(readFileSync(occupied, "utf8")).toBe("existing user file");
    expect(manager.documents.get(artifact.id).revision).toBe(artifact.revision);
    expect(manager.documents.revisions(artifact.id)).toHaveLength(1);
    expect(manager.tools().hop.available).toBe(false); expect(manager.tools().pdfcraft?.available).toBe(false);
    expect(manager.tools().hwp?.available).toBe(true); expect(manager.tools().pdf?.available).toBe(true);
  });
});
