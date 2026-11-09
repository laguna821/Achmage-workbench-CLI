// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  bookExecutionJson, readBookExecution, captureBookSelection, restoreBookSelection,
  createOriginalBookLock, waitOriginalBookTranslation, recordOriginalBookOutputs,
  finishOriginalBookTranslation, originalBookTranslationResult,
} from "./execution-book-state.ts";

describe("original book executor handoff", () => {
  it("round-trips skill context once and rejects a different admitted instruction", () => {
    const state = { schema: 1 as const, request: { text: "선택한 문단", skillUse: { text: "\nPinned skill", chips: [{ id: "skill-a" }] } } };
    const captured = bookExecutionJson(state);
    state.request.skillUse.chips[0]!.id = "changed-after-send";
    expect(readBookExecution(captured, "선택한 문단\nPinned skill")).toEqual({ ...captured, request: { text: "선택한 문단", skillUse: { text: "\nPinned skill", chips: [{ id: "skill-a" }] } } });
    expect(() => readBookExecution(captured, "선택한 문단\nPinned skill\nPinned skill")).toThrow("일치하지");
  });

  it("restores the second equal EPUB passage and refuses changed saved text", () => {
    document.body.innerHTML = "<p>same passage</p><p>same passage</p>";
    const selected = document.querySelectorAll("p")[1]!.firstChild!;
    const range = document.createRange(); range.setStart(selected, 0); range.setEnd(selected, 4);
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
    const bookmark = captureBookSelection(document);
    document.body.innerHTML = "<p>same passage</p><p>same passage</p>";
    expect(restoreBookSelection(document, bookmark)).toBe(true);
    expect(document.getSelection()!.anchorNode).toBe(document.querySelectorAll("p")[1]!.firstChild);
    document.body.innerHTML = "<p>same passage</p><p>changed passage</p>";
    expect(restoreBookSelection(document, bookmark)).toBe(false);
  });

  it("locks original document shortcuts but leaves native Undo in the question editable", () => {
    document.body.innerHTML = '<div class="ribbon"></div><div class="epub-reader"></div><div role="dialog"><textarea></textarea></div>';
    const ribbon = document.querySelector<HTMLElement>(".ribbon")!;
    ribbon.inert = true;
    const lock = createOriginalBookLock(".ribbon, .epub-reader");
    const originalKey = vi.fn(); window.addEventListener("keydown", originalKey);
    try {
      lock(true);
      expect(document.querySelector<HTMLElement>(".epub-reader")!.inert).toBe(true);
      const save = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true });
      document.body.dispatchEvent(save); expect(save.defaultPrevented).toBe(true);
      const undo = new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true });
      document.querySelector("textarea")!.dispatchEvent(undo);
      expect(undo.defaultPrevented).toBe(false); expect(originalKey).not.toHaveBeenCalled();
    } finally { lock(false); window.removeEventListener("keydown", originalKey); }
    expect(ribbon.inert).toBe(true);
    expect(document.querySelector<HTMLElement>(".epub-reader")!.inert).toBeFalsy();
  });

  it("keeps the original translation tool pending until output writing and unlock finish", async () => {
    let settled = false;
    const pending = waitOriginalBookTranslation(() => ({ opened: true as const }), true);
    void pending.then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    recordOriginalBookOutputs([{ kind: "translated", path: "/output/translated.epub" }], []);
    await Promise.resolve(); expect(settled).toBe(false);
    finishOriginalBookTranslation({ state: "complete", done: 5, total: 5 });
    const result = await pending;
    expect(result.workbenchTranslation).toMatchObject({ state: "complete", outputs: [{ path: "/output/translated.epub" }] });
    expect(originalBookTranslationResult(result)?.output).toContain("/output/translated.epub");
  });

  it("reports original output failure and explicit cancellation without a completion claim", async () => {
    const failed = waitOriginalBookTranslation(() => ({ opened: true as const }), true);
    recordOriginalBookOutputs([], ["original write refused"]);
    finishOriginalBookTranslation({ state: "complete" });
    const failure = await failed;
    expect(failure.workbenchTranslation?.state).toBe("failed");
    expect(originalBookTranslationResult(failure)?.isError).toBe(true);
    const cancelled = waitOriginalBookTranslation(() => ({ opened: true as const }), true);
    finishOriginalBookTranslation({ state: "cancelled" });
    expect((await cancelled).workbenchTranslation).toMatchObject({ state: "cancelled", outputs: [] });
  });

  it("does not mark an unobserved original write as completed or re-open a pending dialog", async () => {
    const pending = waitOriginalBookTranslation(() => ({ opened: true as const }), true);
    const secondOpen = vi.fn(() => ({ opened: true as const }));
    await expect(waitOriginalBookTranslation(secondOpen, true)).rejects.toThrow("끝나지");
    expect(secondOpen).not.toHaveBeenCalled();
    finishOriginalBookTranslation({ state: "complete" });
    expect((await pending).workbenchTranslation?.state).toBe("failed");
    expect(await waitOriginalBookTranslation(() => ({ unavailable: true as const }), true)).toEqual({ unavailable: true });
    expect(await waitOriginalBookTranslation(() => ({ opened: true as const }), false)).toEqual({ opened: true });
  });
});
