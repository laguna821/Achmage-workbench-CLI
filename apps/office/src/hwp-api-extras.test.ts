// window.hwpApi's v0.13.0 members that are not the document's (unit hwp13): the print route through the preview,
// and the polite answers of what Workbench does not offer.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { HANGUL_NOT_OFFERED, hangulFileCommand, hangulPrintLayout, PRINT_LAYOUT_NOT_YET } from "./hwp-api-extras.ts";

describe("the Hangul File menu's print route", () => {
  it("opens the print preview for 인쇄 and Ctrl+P, only opens it for 미리 보기, exports a PDF at once", () => {
    const emit = vi.fn();
    for (const command of ["print", "preview", "pdf", "open", "importPdf", "nonsense"]) hangulFileCommand({ emit }, command);
    expect(emit.mock.calls).toEqual([["previewRequest", "print"], ["previewRequest", "open"], ["printRequest", "pdf"]]);
  });
  it("is the route hwp.ts takes for the tab's print command, the File menu and Ctrl+P", () => {
    const page = readFileSync(new URL("./hwp.ts", import.meta.url), "utf8");
    expect(page).toContain('else hangulFileCommand(events, command === "export-pdf" ? "pdf" : "print");');
    expect(page).toContain("else hangulFileCommand(events, command);");
    expect(page).toContain('onPreviewRequest: events.on("previewRequest"),');
    expect(page).toContain('hwpApi.requestFileCommand(key === "s" ? event.shiftKey ? "saveAs" : "save" : "print");');
  });
});

describe("what the Hangul page does not offer answers in words", () => {
  it("고급 인쇄", async () => {
    for (const call of [hangulPrintLayout.preview, hangulPrintLayout.print, hangulPrintLayout.savePdf, hangulPrintLayout.setLabelSpec]) {
      await expect((call as () => Promise<unknown>)()).resolves.toEqual({ ok: false, error: PRINT_LAYOUT_NOT_YET });
    }
    expect(PRINT_LAYOUT_NOT_YET).toContain("아직 연결되지 않았습니다");
    await expect(hangulPrintLayout.getLabelSpec()).resolves.toBeNull();
    await expect(hangulPrintLayout.cancel()).resolves.toBeUndefined();
    expect(typeof hangulPrintLayout.onProgress()).toBe("function");
  });
  it("the AI's attachment reader and importer, web search and picture reading", async () => {
    const korean = /[가-힣]/;
    const read = await HANGUL_NOT_OFFERED.readAttachmentDocument("/x.hwpx");
    expect(read.ok).toBe(false); expect(read.error).toMatch(korean);
    const made = await HANGUL_NOT_OFFERED.importAttachmentAsDocument("/x.md", "표로");
    expect(made.ok).toBe(false); expect(made.error).toContain("한글 문서 만들기");
    const search = await HANGUL_NOT_OFFERED.webSearch("날씨");
    expect(search).toMatchObject({ results: [], method: "error" }); expect(search.error).toMatch(korean);
    const looked = await HANGUL_NOT_OFFERED.analyzeMedia({ mediaUrls: ["data:image/png;base64,AA=="], requirements: "what" });
    expect(looked.error).toMatch(korean);
  });
  it("notes a stopped run by its rule only", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    HANGUL_NOT_OFFERED.noteAiRunStop({ kind: "repeating", faults: {}, tools: ["replace_text"] });
    HANGUL_NOT_OFFERED.noteAiRunStop(null);
    expect(warn.mock.calls.map((call) => call[0])).toEqual(["[hwp] the AI run was stopped by the editor's own rule (repeating)", "[hwp] the AI run was stopped by the editor's own rule (unknown)"]);
    warn.mockRestore();
  });
  it("override the shared AI bridge's members in hwp.ts (spread after it)", () => {
    const page = readFileSync(new URL("./hwp.ts", import.meta.url), "utf8");
    expect(page.indexOf("...HANGUL_NOT_OFFERED,")).toBeGreaterThan(page.indexOf("...ai.desktop,"));
    for (const member of ["printLayout: hangulPrintLayout,", "consumeHeadlessExport: async () => null,", "headlessExportDone: () => {},"]) expect(page).toContain(member);
  });
});
