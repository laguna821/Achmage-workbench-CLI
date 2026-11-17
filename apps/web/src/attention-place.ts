// Which place a notification opens (0.5.3 window-ux): the one rule behind a click on an OS notification, the
// top bar's notice and the 알림 centre. A document's or web page's AI goes through its own opener (beside its
// document with its 문서 AI, or the read-only conversation once archived); everything else is a place in the panes.
import type { AttentionTarget } from "@workbench/contracts";

export type AttentionPlace =
  | { kind: "agent" }
  | { kind: "place"; workId: string; sessionId: string; view: { kind: "work" } | { kind: "document"; artifactId: string; proposalId: null } | { kind: "browser"; pageId: string } };

export function attentionPlace(target: Pick<AttentionTarget, "workId" | "sessionId" | "artifactId" | "pageId">, session: { documentAgent?: unknown; pageAgent?: unknown }): AttentionPlace {
  if (session.documentAgent || session.pageAgent) return { kind: "agent" };
  const view = target.pageId ? { kind: "browser" as const, pageId: target.pageId }
    : target.artifactId ? { kind: "document" as const, artifactId: target.artifactId, proposalId: null }
    : { kind: "work" as const };
  return { kind: "place", workId: target.workId, sessionId: target.sessionId, view };
}
