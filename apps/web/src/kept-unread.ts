import type { Session } from "@workbench/contracts";

// A person's 읽지 않음으로 표시 stands wherever the answer is shown (tech review 4, MINOR): a place that
// marks an answer seen when it is on screen (지금's open row, a pane) leaves THIS answer unread. A newer
// answer is not covered: it is seen when it is shown.
const kept = new Map<string, number | null>();

export function keepUnread(sessionId: string, previewAt: number | null | undefined) {
  kept.set(sessionId, previewAt ?? null);
}

export function isKeptUnread(session: Pick<Session, "id" | "previewAt">) {
  return kept.has(session.id) && kept.get(session.id) === (session.previewAt ?? null);
}

/** The person marked it read (or it is gone): nothing is kept. */
export function forgetUnread(sessionId: string) {
  kept.delete(sessionId);
}
