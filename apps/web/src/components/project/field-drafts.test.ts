// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { keepField, keptFields, readField, UNKNOWN_BASE } from "./field-drafts.ts";

// The one store of what is typed into a project page's fields.

afterEach(() => {
  vi.restoreAllMocks();
  for (const { field } of keptFields("w", "")) keepField("w", field, null);
  localStorage.clear();
});

describe("the project page's kept fields", () => {
  it("keeps each entry under its note with the revision it was typed at, and lists a note's entries by name", () => {
    keepField("w", "prop:중요도", { text: "보통", baseRevision: 4 });
    keepField("w", "prop:새키", { text: "값", baseRevision: null, added: "text" });
    keepField("w", "add:decision", { text: "결정", baseRevision: 4 });
    keepField("w.x", "prop:중요도", { text: "다른 노트", baseRevision: 9 });
    expect(readField("w", "prop:중요도")).toEqual({ text: "보통", baseRevision: 4 });
    expect(keptFields("w", "prop:")).toEqual([
      { field: "prop:새키", draft: { text: "값", baseRevision: null, added: "text" } },
      { field: "prop:중요도", draft: { text: "보통", baseRevision: 4 } },
    ]);
    expect(keptFields("w.x", "prop:")).toEqual([{ field: "prop:중요도", draft: { text: "다른 노트", baseRevision: 9 } }]);
    keepField("w", "prop:중요도", null);
    expect(readField("w", "prop:중요도")).toBeNull();
  });

  it("keeps an emptied value as text of its own (the person cleared the field)", () => {
    keepField("w", "prop:중요도", { text: "", baseRevision: 4 });
    expect(readField("w", "prop:중요도")).toEqual({ text: "", baseRevision: 4 });
  });

  it("reads an entry that says no revision (an earlier build's plain text) with a base no note has, so writing it always asks", () => {
    localStorage.setItem("workbench.projectField.w.prop:중요도", "옛 방식으로 남은 글");
    localStorage.setItem("workbench.projectField.w.add:decision", JSON.stringify({ text: "판 없는 결정" }));
    expect(readField("w", "prop:중요도")).toEqual({ text: "옛 방식으로 남은 글", baseRevision: UNKNOWN_BASE });
    expect(readField("w", "add:decision")).toEqual({ text: "판 없는 결정", baseRevision: UNKNOWN_BASE });
    expect(UNKNOWN_BASE).toBeLessThan(0);
  });

  it("reads what was typed last, not the older text the storage still holds, once the storage is full (m2)", () => {
    keepField("w", "prop:중요도", { text: "보", baseRevision: 4 });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    keepField("w", "prop:중요도", { text: "보통", baseRevision: 4 });
    expect(readField("w", "prop:중요도")).toEqual({ text: "보통", baseRevision: 4 });
    expect(keptFields("w", "prop:")).toEqual([{ field: "prop:중요도", draft: { text: "보통", baseRevision: 4 } }]);
    // Put away: nothing is read back, not the older stored text either.
    keepField("w", "prop:중요도", null);
    expect(readField("w", "prop:중요도")).toBeNull();
    expect(keptFields("w", "prop:")).toEqual([]);
  });

  it("still keeps what is typed when the browser's storage refuses", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    keepField("w", "prop:중요도", { text: "보통", baseRevision: 4 });
    expect(readField("w", "prop:중요도")).toEqual({ text: "보통", baseRevision: 4 });
    expect(keptFields("w", "prop:")).toEqual([{ field: "prop:중요도", draft: { text: "보통", baseRevision: 4 } }]);
    keepField("w", "prop:중요도", null);
    expect(readField("w", "prop:중요도")).toBeNull();
  });
});
