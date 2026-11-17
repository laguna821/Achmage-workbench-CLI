/**
 * A2 (perf G1): a long conversation draws only its last turns. A 320-turn conversation was ~22,000 elements and
 * +110 MB in WebKitGTK; drawn are the last TURN_WINDOW turns, "이전 대화 보기" above them adds TURN_STEP more, and
 * anything that must reach an undrawn turn (a search hit, a link to a message, the outline, a saved reading
 * place) draws from that turn first. Numbers are turn indexes: `from` = the first drawn turn.
 */
export const TURN_WINDOW = 40;
export const TURN_STEP = 40;

/** The first turn drawn when a conversation is shown: the last TURN_WINDOW, or from the turn the reader is to come back to (one above it for context); "all": a saved place no message anchors (draw everything, as before). */
export function drawFrom(count: number, keep: number | "all" | null): number {
  if (keep === "all") return 0;
  const last = Math.max(0, count - TURN_WINDOW);
  return keep === null || keep < 0 ? last : Math.min(last, Math.max(0, keep - 1));
}

/** "이전 대화 보기": TURN_STEP turns more above. */
export const earlierFrom = (from: number) => Math.max(0, from - TURN_STEP);

/** A jump to turn `index` (-1: not found): drawn from it (one above) if it is above what is drawn. */
export const reachFrom = (from: number, index: number) => (index < 0 || index >= from ? from : Math.max(0, index - 1));

/** While the reader follows the end: once TURN_STEP turns more than the window have come, the ones above the last TURN_WINDOW are let go. */
export const slideFrom = (from: number, count: number, following: boolean) => (following && count - from > TURN_WINDOW + TURN_STEP ? count - TURN_WINDOW : from);
