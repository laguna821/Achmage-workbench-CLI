import type { Session } from "@workbench/contracts";
import { rowState } from "./row-state.ts";
import { isBusy } from "./state.ts";

/**
 * May a held web page (its tab closed while its AI worked) close now? Closing it archives its AI, so it
 * waits while the AI works AND while its answer is unseen — the answer first shows as 새 답 (지금, 활동,
 * the row); once looked at, the page goes (tech review W1).
 */
export function heldPageMayClose(pageId: string, sessions: Record<string, Session>): boolean {
  return !Object.values(sessions).some((session) => session.pageAgent?.pageId === pageId && !session.archivedAt && (isBusy(session) || rowState(session)?.id === "unseen"));
}
