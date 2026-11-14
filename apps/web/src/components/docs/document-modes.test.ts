import { describe, expect, it } from "vitest";
import { EDITOR_MIN_WIDTH, documentConversationShown, editorKeepsAiPanel, isOfficeEditing, narrowPaneStep, narrowView, readView, type NarrowInput, type ShownInput } from "./document-modes.ts";

const base: ShownInput = { format: "markdown", mode: "rich", visible: true, sessionId: "agent", editorHere: true, editorHidden: false, editorAi: null, column: false };
const shown = (patch: Partial<ShownInput>) => documentConversationShown({ ...base, ...patch });

it("counts the app's conversation column as on screen, whatever the document is shown in", () => {
  expect(shown({ mode: "edit", column: true })).toBe("agent");
  expect(shown({ mode: "preview", column: true })).toBe("agent");
  expect(shown({ format: "markdown", mode: "rich", column: true })).toBe("agent");
  expect(shown({ format: "pptx", mode: "edit", column: true })).toBe("agent");
  // Pages only (edited in another tab or window): the column is still this screen's.
  expect(shown({ format: "docx", mode: "edit", editorHere: false, column: true })).toBe("agent");
  expect(shown({ mode: "edit", column: false })).toBeNull();
});

it("counts an editor's own AI sidebar only once the editor has said it is open", () => {
  // Word reports its AI sidebar: closed means the conversation is not on screen.
  expect(shown({ format: "docx", mode: "edit", editorAi: true })).toBe("agent");
  expect(shown({ format: "docx", mode: "edit", editorAi: false })).toBeNull();
  // Until Word has said either, its conversation is not known to be on screen.
  expect(shown({ format: "docx", mode: "edit", editorAi: null })).toBeNull();
  // Editors that say nothing are not taken to show it: the app's column is where it is known to be.
  expect(shown({ format: "markdown", mode: "rich" })).toBeNull();
  expect(shown({ format: "html", mode: "rich" })).toBeNull();
  expect(shown({ format: "hwpx", mode: "edit" })).toBeNull();
  expect(shown({ format: "pptx", mode: "edit" })).toBeNull();
  // Edited in another tab or window: this screen has pages only, no editor and no AI panel.
  expect(shown({ format: "docx", mode: "edit", editorAi: true, editorHere: false })).toBeNull();
  // A comparison or an older revision covers the editor.
  expect(shown({ format: "docx", mode: "edit", editorAi: true, editorHidden: true })).toBeNull();
});

it("shows nothing from a tab behind or without a conversation", () => {
  expect(shown({ visible: false })).toBeNull();
  expect(shown({ sessionId: null })).toBeNull();
});

import type { Session } from "@workbench/contracts";
import { documentAgentParent, documentAttentionSession } from "./document-modes.ts";

const ai = (id: string, artifactId = "doc") => ({ id, documentAgent: { artifactId, parentSessionId: "main" }, archivedAt: null, createdAt: id === "b" ? 2 : 1 }) as unknown as Session;

it("draws the AI its pane's session names; otherwise the one asked for when the document opened", () => {
  // Clicking B's row while the document shows A: the pane names B, so the view asks for B.
  expect(documentAgentParent("doc", ai("b"), "a")).toBe("b");
  // The pane names a conversation that is not an AI of this document: the opening choice stands.
  expect(documentAgentParent("doc", { id: "main" } as Session, "main")).toBe("main");
  expect(documentAgentParent("doc", ai("x", "other"), "main")).toBe("main");
});

it("counts as on screen the AI actually drawn, not another of the same document", () => {
  const sessions = { a: ai("a"), b: ai("b") };
  // B is drawn: B is the one looked at; A's unseen answer stays unseen.
  expect(documentAttentionSession("doc", "b", ai("a"), sessions)).toBe("b");
  // Nothing reported yet: the pane's AI of this document, else its newest.
  expect(documentAttentionSession("doc", null, ai("a"), sessions)).toBe("a");
  expect(documentAttentionSession("doc", null, null, sessions)).toBe("b");
});

// The embedded editors keep a 360px AI panel beside the page: measured, the text column is the
// pane's width minus 504px. Below EDITOR_MIN_WIDTH it is a few characters wide. A size change
// never removes an editor that is already open, whatever it reports (Word and PowerPoint report
// unsaved edits only every 2 seconds): it stays and the other view is offered. The app's own view
// is chosen by itself only when a document is opened into an already narrow pane, before any
// editor is mounted.
describe("a pane too narrow for the embedded editor", () => {
  const base: NarrowInput = { width: 1000, editing: true, mounted: true, opening: false, forced: false, auto: false, unsaved: false };
  const step = (patch: Partial<NarrowInput>) => narrowPaneStep({ ...base, ...patch });

  it("an editor that is open stays, however narrow: the other view is only offered", () => {
    expect(step({ width: EDITOR_MIN_WIDTH - 1 })).toBe("offer-view");
    expect(step({ width: 420 })).toBe("offer-view");
    expect(step({ width: EDITOR_MIN_WIDTH })).toBe("stay");
    expect(step({ width: 900 })).toBe("stay");
  });

  it("no size ever answers with a step that removes an open editor", () => {
    for (const width of [null, 0, 200, 420, EDITOR_MIN_WIDTH - 1, EDITOR_MIN_WIDTH, 900, 2000])
      for (const opening of [false, true]) for (const forced of [false, true]) for (const auto of [false, true]) for (const unsaved of [false, true])
        expect(["stay", "offer-view"]).toContain(step({ width, opening, forced, auto, unsaved, editing: true, mounted: true }));
  });

  it("a document opened into an already narrow pane, before any editor is mounted, opens in the app's own view", () => {
    expect(step({ width: 420, mounted: false, opening: true })).toBe("open-own-view");
    expect(step({ width: EDITOR_MIN_WIDTH - 1, mounted: false, opening: true })).toBe("open-own-view");
    expect(step({ width: EDITOR_MIN_WIDTH, mounted: false, opening: true })).toBe("stay");
    // Only at the opening: a later resize while the editor is still on its way changes nothing.
    expect(step({ width: 420, mounted: false, opening: false })).toBe("stay");
  });

  it("stays in the editor the person asked for (편집기로 열기), however narrow, offering nothing", () => {
    expect(step({ width: 420, forced: true })).toBe("stay");
    expect(step({ width: 420, forced: true, mounted: false, opening: true })).toBe("stay");
  });

  it("does nothing while the width is not known", () => {
    expect(step({ width: null })).toBe("stay");
    expect(step({ width: 0 })).toBe("stay");
    expect(step({ width: null, mounted: false, opening: true })).toBe("stay");
    expect(step({ width: null, editing: false, mounted: false, auto: true })).toBe("stay");
  });

  it("goes to the editor when the pane widens — only from the view the app chose itself, and never over unsaved edits", () => {
    const own = { editing: false, mounted: false };
    expect(step({ ...own, width: 900, auto: true })).toBe("back-to-editor");
    expect(step({ ...own, width: 900, auto: true, unsaved: true })).toBe("stay");
    // A view the person picked stays.
    expect(step({ ...own, width: 900, auto: false })).toBe("stay");
    expect(step({ ...own, width: 500, auto: true })).toBe("stay");
  });

  it("stands in with the app's own view of each format, and names the button that goes there", () => {
    expect(narrowView("markdown")).toEqual({ mode: "edit", label: "원문", go: "원문으로 보기" });
    expect(narrowView("html")).toEqual({ mode: "source", label: "원문", go: "원문으로 보기" });
    expect(narrowView("docx")).toEqual({ mode: "preview", label: "글 보기", go: "글 보기로 바꾸기" });
    expect(narrowView("pdf")).toEqual({ mode: "preview", label: "미리보기", go: "미리보기로 바꾸기" });
    expect(narrowView("hwpx")).toEqual({ mode: "preview", label: "글 보기", go: "글 보기로 바꾸기" });
  });
});

// Beside a conversation a document is read: every format has a view of the app's own, and none of
// them is an embedded editor (whose own AI panel and input would sit beside the conversation's).
it("gives every format a read view that is not an embedded editor", () => {
  const formats = ["markdown", "html", "docx", "pptx", "xlsx", "pdf", "hwpx", "hwp", "xmind", "epub", "text", "design"] as const;
  for (const format of formats) expect(isOfficeEditing(format, readView(format))).toBe(false);
  expect(readView("markdown")).toBe("preview");
  expect(readView("html")).toBe("render");
  expect(["docx", "pptx", "xlsx"].map((format) => readView(format as "docx"))).toEqual(["pages", "pages", "pages"]);
  expect(readView("hwpx")).toBe("preview");
  expect(readView("pdf")).toBe("preview");
});

describe("the embedded editor's own AI panel", () => {
  it("is not beside a Hangul document: its AI is the tab's 문서 AI, so the column fits where the editor alone fits", () => {
    for (const format of ["hwp", "hwpx"] as const) {
      expect(editorKeepsAiPanel(format, null)).toBe(false);
      expect(editorKeepsAiPanel(format, true)).toBe(false);
    }
    // The other editors keep theirs (Word says when it is closed).
    expect(editorKeepsAiPanel("docx", null)).toBe(true);
    expect(editorKeepsAiPanel("docx", false)).toBe(false);
    expect(editorKeepsAiPanel("pptx", null)).toBe(true);
  });
});
