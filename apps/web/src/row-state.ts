import { isUnseen, type Session } from "@workbench/contracts";

// ONE state word for a conversation, everywhere it is shown (skin 2, ruling S3): the list column
// (both levels), the tabs' marks, 활동, 지금/home, the project page, the document head. Plain data
// (no React) so every surface and the tests read the same table. The words, in precedence order:
//   확인 필요 › 실패 › 진행 중 › 새 답 › 예약 › 완료
// 완료 is derived, not stored: idle, nothing unseen, no error, and a finished reply exists.
// A conversation that never answered (just created) has no word: `rowState` returns null.

export type RowStateId = "attention" | "failed" | "running" | "waiting" | "unseen" | "queued" | "done";

/**
 * The glyph is a name from the one icon set (`Icon`), except "turn": the quiet turning mark of a
 * running conversation (drawn by `StateMark`, nav/rows.tsx). `tone` is the CSS hook
 * (`tone-<tone>` on the glyph and the word); colour never says the state alone — the word does.
 */
export type RowStateGlyph = "alert" | "x" | "turn" | "dot" | "clock" | "check";
export type RowStateTone = "attention" | "error" | "active" | "new" | "queued" | "done";

export type RowStateInfo = { id: RowStateId; word: string; glyph: RowStateGlyph; tone: RowStateTone; rank: number };

/** The table, in precedence order (rank 0 wins). */
export const ROW_STATES: Record<RowStateId, RowStateInfo> = {
  attention: { id: "attention", word: "확인 필요", glyph: "alert", tone: "attention", rank: 0 },
  failed: { id: "failed", word: "실패", glyph: "x", tone: "error", rank: 1 },
  running: { id: "running", word: "진행 중", glyph: "turn", tone: "active", rank: 2 },
  // 0.5.3: a request waits for a free slot (the resource manager's line); 예약's mark, its own word.
  waiting: { id: "waiting", word: "대기 중", glyph: "clock", tone: "queued", rank: 2.5 },
  unseen: { id: "unseen", word: "새 답", glyph: "dot", tone: "new", rank: 3 },
  queued: { id: "queued", word: "예약", glyph: "clock", tone: "queued", rank: 4 },
  done: { id: "done", word: "완료", glyph: "check", tone: "done", rank: 5 },
};

export const ROW_STATE_ORDER: RowStateId[] = ["attention", "failed", "running", "waiting", "unseen", "queued", "done"];

export const isWorking = (session: Pick<Session, "status">) => session.status === "starting" || session.status === "running" || session.status === "interrupting";

/** Requests kept after a stop, a failure or a restart: they go only when the person sends them. */
export const heldCount = (session: Pick<Session, "queued">) => (session.queued ?? []).filter((entry) => entry.held).length;

export type RowStateOptions = {
  /** The conversation is on screen now: its reply is being read, so it is not "새 답". */
  onScreen?: boolean;
};

/**
 * The one state of a conversation (or a document/web AI — they are conversations too).
 * - 확인 필요: waits for an approval, or holds requests a stop left behind (only the person sends them)
 * - 실패: the engine failed (status error), or the last turn left an error and nothing runs
 * - 진행 중: starting, running or stopping
 * - 대기 중: a request waits for a free slot (0.5.3)
 * - 새 답: a reply not looked at (or marked unread), unless it is on screen
 * - 예약: requests wait for the turn to end
 * - 완료: idle, nothing unseen, a finished reply exists
 * - null: never answered yet (no word; rows show the hollow mark)
 */
export function rowState(session: Session, options: RowStateOptions = {}): RowStateInfo | null {
  if (session.status === "awaitingApproval") return ROW_STATES.attention;
  const working = isWorking(session);
  if (session.status === "error" || (!working && session.lastError)) return ROW_STATES.failed;
  if (!working && heldCount(session) > 0) return ROW_STATES.attention;
  if (working) return ROW_STATES.running;
  if (session.queued?.some((entry) => entry.slot && !entry.held)) return ROW_STATES.waiting;
  if (!options.onScreen && isUnseen(session)) return ROW_STATES.unseen;
  if (session.queued?.length) return ROW_STATES.queued;
  if (session.previewAt || session.preview) return ROW_STATES.done;
  return null;
}

/** The state that wins among several (a document's AIs, a project's conversations). */
export function leadState<T>(items: T[], stateOf: (item: T) => RowStateInfo | null): { item: T; state: RowStateInfo } | null {
  let best: { item: T; state: RowStateInfo } | null = null;
  for (const item of items) {
    const state = stateOf(item);
    if (state && (!best || state.rank < best.state.rank)) best = { item, state };
  }
  return best;
}

/** Does this state ask the person for something (the number on project rows and on 지금)? */
export const needsPerson = (state: RowStateInfo | null) => state?.id === "attention" || state?.id === "failed";

/**
 * A project's (or any group's) summary for its row: how many conversations need the person
 * (확인 필요 + 실패 → the small number pill) and how many run (→ the quiet running mark).
 */
export function groupState(sessions: Session[], onScreenId: string | null = null): { needs: number; running: number; unseen: number } {
  let needs = 0;
  let running = 0;
  let unseen = 0;
  for (const session of sessions) {
    const state = rowState(session, { onScreen: session.id === onScreenId });
    if (needsPerson(state)) needs += 1;
    else if (state?.id === "running") running += 1;
    else if (state?.id === "unseen") unseen += 1;
  }
  return { needs, running, unseen };
}
