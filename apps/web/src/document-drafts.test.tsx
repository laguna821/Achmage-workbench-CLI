// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { clearRecoveredDraft, keepDraft, newestDraft } from "./document-drafts.ts";
afterEach(() => localStorage.clear());
it("keeps independent editor copies and never deletes a newer recovery snapshot", () => {
  keepDraft("doc", "first", { baseRevision: 1, text: "older unsaved", at: 10 });
  keepDraft("doc", "second", { baseRevision: 2, text: "other draft", at: 20 });
  const recovered = newestDraft("doc")!;
  keepDraft("doc", "second", { baseRevision: 2, text: "newer unsaved", at: 30 });
  clearRecoveredDraft(recovered);
  expect(newestDraft("doc")?.text).toBe("newer unsaved");
  keepDraft("doc", "first", null);
  expect(newestDraft("doc")?.text).toBe("newer unsaved");
  clearRecoveredDraft(newestDraft("doc"));
  expect(newestDraft("doc")).toBeNull();
});
it("reads legacy drafts while preserving unknown entries", () => {
  localStorage.setItem("workbench.docDraft.doc", JSON.stringify({ baseRevision: 1, text: "legacy" }));
  localStorage.setItem("workbench.docDraft.doc.foreign", "unknown");
  expect(newestDraft("doc")?.text).toBe("legacy");
  clearRecoveredDraft(newestDraft("doc"));
  expect(localStorage.getItem("workbench.docDraft.doc.foreign")).toBe("unknown");
});
