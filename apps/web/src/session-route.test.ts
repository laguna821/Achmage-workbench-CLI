import { describe, expect, it } from "vitest";
import type { Session } from "@workbench/contracts";
import type { Work } from "@workbench/contracts";
import { becomesActive, lookingChangesState, opensBeside, restoreRefusal, sessionView } from "./session-route.ts";

const session = (extra: Partial<Session> = {}) => ({ id: "s", workId: "w", archivedAt: null, ...extra }) as unknown as Session;
const docAi = { documentAgent: { artifactId: "lecture", parentSessionId: "p" } } as Partial<Session>;
const pageAi = { pageAgent: { pageId: "page", parentSessionId: "p" } } as Partial<Session>;

describe("where opening a conversation goes", () => {
  it("a live document or web AI opens beside its document or page", () => {
    expect(sessionView(session(docAi))).toEqual({ kind: "document", artifactId: "lecture", proposalId: null });
    expect(sessionView(session(pageAi))).toEqual({ kind: "browser", pageId: "page" });
    expect(sessionView(session())).toEqual({ kind: "work" });
  });

  it("an archived one — any kind — opens as the conversation it is (read-only), never another", () => {
    expect(sessionView(session({ ...docAi, archivedAt: 5 }))).toEqual({ kind: "work" });
    expect(sessionView(session({ ...pageAi, archivedAt: 5 }))).toEqual({ kind: "work" });
    expect(sessionView(session({ archivedAt: 5 }))).toEqual({ kind: "work" });
  });
});

describe("looking at a conversation", () => {
  it("marks it seen and makes it the project's active one, except an archived one", () => {
    expect(lookingChangesState(session())).toBe(true);
    expect(lookingChangesState(session({ archivedAt: 5 }))).toBe(false);
  });
});

describe("the one rule for what looking at a conversation may change", () => {
  const work = { id: "w", activeSessionId: "now" } as unknown as Work;
  it.each([
    // focusing a pane or tab, selecting, placing, restoring a layout: the session it shows
    ["a live conversation of the project", session({ id: "other" }), true],
    ["the one already active", session({ id: "now" }), false],
    ["an archived conversation", session({ id: "other", archivedAt: 5 }), false],
    ["an archived document AI", session({ id: "other", archivedAt: 5, ...docAi }), false],
    ["a live document AI (shown beside its document)", session({ id: "other", ...docAi }), false],
    ["a live web AI", session({ id: "other", ...pageAi }), false],
    ["a conversation of another project", session({ id: "other", workId: "x" }), false],
  ])("%s → becomes the project's active one: %s", (_, shown, active) => {
    expect(becomesActive(work, shown)).toBe(active);
  });
  it("nothing becomes active without a project or a session", () => {
    expect(becomesActive(undefined, session())).toBe(false);
    expect(becomesActive(work, undefined)).toBe(false);
  });
});

describe("a row's conversation in a window of its own", () => {
  it("opens beside its document or page only while live; an archived one is shown as the conversation it is", () => {
    expect(opensBeside(session(docAi))).toBe(true);
    expect(opensBeside(session(pageAi))).toBe(true);
    expect(opensBeside(session({ ...docAi, archivedAt: 5 }))).toBe(false);
    expect(opensBeside(session({ ...pageAi, archivedAt: 5 }))).toBe(false);
    expect(opensBeside(session())).toBe(false);
  });
});

// 되돌리기 on an archived document AI whose document was removed: the gateway refuses (409
// document_removed), so the menu says why instead of offering it.
describe("bringing back an archived AI", () => {
  const agent = (artifactId: string) => ({ id: "a", archivedAt: 5, documentAgent: { artifactId, parentSessionId: "m" } }) as unknown as Session;
  it("is refused, with the reason, while its document is removed", () => {
    expect(restoreRefusal(agent("gone"), () => false)).toBe("문서를 먼저 되돌려 주세요");
  });
  it("is offered for its document still there, and for any other conversation", () => {
    expect(restoreRefusal(agent("here"), () => true)).toBeNull();
    expect(restoreRefusal({ id: "c", archivedAt: 5 } as unknown as Session, () => false)).toBeNull();
  });
});
