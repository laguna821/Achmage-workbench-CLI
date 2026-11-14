// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { Artifact, Proposal } from "@workbench/contracts";
import { initialState, type State } from "./state.ts";
import { modeDocument, modeOf, restorePosition, reviewProposal, workModeKey } from "./workmodes.ts";

// Work screen modes: which view a mode asks for, what 검토 opens, Alt+1–5, the reading position.

const key = (init: Partial<KeyboardEvent>) => ({ altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, isComposing: false, code: "", key: "", ...init });

describe("work modes", () => {
  it("reads the mode from the view", () => {
    expect(modeOf({ kind: "work" }, false)).toBe("chat");
    expect(modeOf({ kind: "document", proposalId: null }, false)).toBe("doc");
    expect(modeOf({ kind: "document", proposalId: "p" }, false)).toBe("review");
    // 나란히: the document beside its conversation, in that conversation's tab.
    expect(modeOf({ kind: "work", beside: { kind: "document", artifactId: "d", proposalId: null } }, false)).toBe("split");
    // A web page beside a conversation is not a document mode.
    expect(modeOf({ kind: "work", beside: { kind: "browser", pageId: "p" } }, false)).toBe("chat");
    expect(modeOf({ kind: "document", proposalId: null }, true)).toBe("read");
    expect(modeOf({ kind: "new" }, false)).toBeNull();
  });

  it("is about the document the view shows: its own tab's, or the conversation's companion", () => {
    expect(modeDocument({ kind: "document", artifactId: "a" }, ["b"], "b")).toBe("a");
    expect(modeDocument({ kind: "work", beside: { kind: "document", artifactId: "a", proposalId: null } }, ["b"], "b")).toBe("a");
  });

  it("in a conversation with nothing beside it: a document of the project open in a tab now — the one shown last, else the newest tab", () => {
    expect(modeDocument({ kind: "work" }, ["a", "b"], "a")).toBe("a");
    expect(modeDocument({ kind: "work" }, ["a", "b"], undefined)).toBe("b");
    expect(modeDocument({ kind: "work" }, ["a", "b"], "closed")).toBe("b");
  });

  it("no document open: no modes — a document shown once and closed since does not bring them back", () => {
    expect(modeDocument({ kind: "work" }, [], undefined)).toBeNull();
    expect(modeDocument({ kind: "work" }, [], "closed")).toBeNull();
  });

  it("reviews the newest proposal made on the current revision first", () => {
    const proposal = (id: string, baseRevision: number, createdAt: number, status: Proposal["status"] = "pending"): Proposal =>
      ({ id, artifactId: "d", sessionId: "s", requestId: id, baseRevision, workingPath: "", status, added: 0, removed: 0, appliedRevision: null, createdAt, updatedAt: createdAt }) as Proposal;
    const state: State = {
      ...initialState,
      artifacts: { d: { id: "d", revision: 3 } as Artifact },
      proposals: { a: proposal("a", 3, 1), b: proposal("b", 2, 9), c: proposal("c", 3, 5), x: proposal("x", 3, 20, "applied") },
    };
    expect(reviewProposal(state, "d")?.id).toBe("c");
    expect(reviewProposal({ ...state, proposals: { b: proposal("b", 2, 9) } }, "d")?.id).toBe("b");
    expect(reviewProposal({ ...state, proposals: {} }, "d")).toBeNull();
  });

  it("takes Alt+1–5 by key position, never while composing or with other modifiers", () => {
    expect(workModeKey(key({ altKey: true, code: "Digit4", key: "4" }))).toBe("split");
    expect(workModeKey(key({ altKey: true, code: "Digit5", key: "¡" }))).toBe("read");
    expect(workModeKey(key({ altKey: true, code: "", key: "2" }))).toBe("doc");
    expect(workModeKey(key({ altKey: true, code: "Digit6", key: "6" }))).toBeNull();
    expect(workModeKey(key({ code: "Digit1", key: "1" }))).toBeNull();
    expect(workModeKey(key({ altKey: true, ctrlKey: true, code: "Digit1" }))).toBeNull();
    expect(workModeKey(key({ altKey: true, isComposing: true, code: "Digit1" }))).toBeNull();
  });

  it("brings a document back to how far down it was read", () => {
    const body = document.createElement("div");
    Object.defineProperty(body, "scrollHeight", { value: 2000 });
    Object.defineProperty(body, "clientHeight", { value: 500 });
    expect(restorePosition(body, { page: null, fraction: 0.5 })).toBe(true);
    expect(body.scrollTop).toBe(750);
  });
});
