import { describe, expect, it } from "vitest";
import type { Session } from "@workbench/contracts";
import { heldPageMayClose } from "./held-page.ts";

// Technical review W1: a page whose tab was closed while its AI worked stayed open ("closing a tab stops
// nothing") — but the moment the AI finished it was released, its AI archived with it, and the answer
// never showed as 새 답 anywhere. A held page closes only once its AI neither works nor holds an answer
// nobody has seen; until then the answer shows as 새 답 in 지금, 활동 and the row.
const ai = (patch: Partial<Session>) => ({ id: "ai", workId: "w", provider: "codex", purpose: "웹 AI", status: "idle", queued: [], archivedAt: null, pageAgent: { pageId: "p" }, preview: null, previewAt: null, seenAt: null, unread: false, ...patch }) as unknown as Session;
describe("a held web page closes only when nothing of its AI is left to see", () => {
  it("waits while its AI works", () => expect(heldPageMayClose("p", { ai: ai({ status: "running" }) })).toBe(false));
  it("waits while its AI's answer is unseen (새 답)", () => expect(heldPageMayClose("p", { ai: ai({ preview: "답", previewAt: 5, seenAt: 1 }) })).toBe(false));
  it("closes once the answer was seen", () => expect(heldPageMayClose("p", { ai: ai({ preview: "답", previewAt: 5, seenAt: 9 }) })).toBe(true));
  it("closes when its AI never answered or is archived", () => {
    expect(heldPageMayClose("p", { ai: ai({}) })).toBe(true);
    expect(heldPageMayClose("p", { ai: ai({ status: "running", archivedAt: 3 } as Partial<Session>) })).toBe(true);
  });
});
