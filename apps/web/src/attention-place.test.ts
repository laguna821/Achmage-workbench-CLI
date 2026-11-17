import { describe, expect, it } from "vitest";
import { attentionPlace } from "./attention-place.ts";

const target = { workId: "w", sessionId: "s", artifactId: null, pageId: null };

describe("which place a notification opens", () => {
  it("a conversation: its project and its conversation", () => {
    expect(attentionPlace(target, {})).toEqual({ kind: "place", workId: "w", sessionId: "s", view: { kind: "work" } });
  });
  it("a document's AI opens the document with its 문서 AI (its own opener); a web page's AI likewise", () => {
    expect(attentionPlace({ ...target, artifactId: "doc" }, { documentAgent: { artifactId: "doc" } })).toEqual({ kind: "agent" });
    expect(attentionPlace({ ...target, pageId: "p" }, { pageAgent: { pageId: "p" } })).toEqual({ kind: "agent" });
  });
  it("a conversation about a document or a page opens that document or page", () => {
    expect(attentionPlace({ ...target, artifactId: "doc" }, {})).toEqual({ kind: "place", workId: "w", sessionId: "s", view: { kind: "document", artifactId: "doc", proposalId: null } });
    expect(attentionPlace({ ...target, pageId: "p" }, {})).toEqual({ kind: "place", workId: "w", sessionId: "s", view: { kind: "browser", pageId: "p" } });
  });
});
