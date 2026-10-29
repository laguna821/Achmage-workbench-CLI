// "끊기는 길" (design §8): what is kept when a turn does not complete. The turn still ends, with its
// cause, so the requests waiting for it stay, a working copy it changed becomes a proposal like any
// other, and a request another session sent it is settled. What an engine made says which model,
// effort and request made it — recorded as it happens, since it cannot be filled in later.

/** Why a turn ended without completing: the user stopped it, its engine process died, the app restarted. */
export type TurnCause = "stop" | "crash" | "restart";

/** How a turn that did not complete broke off: one of the causes, or a failure the engine itself reported. */
export type TurnBreak = TurnCause | "failure";

/**
 * Who closed a proposal: the user (applied or discarded it); the end of its turn when the working
 * copy did not change ("turn", or the break that cut the turn short); "failure" also when the request
 * never reached the engine.
 */
export type ProposalCloser = "user" | "turn" | TurnBreak;

/** What an engine reported for a turn (model, effort) and the request that started it. */
export type Provenance = { model?: string | null; effort?: string | null; requestId?: string | null };

export const TURN_BREAK_LABEL: Record<TurnBreak, string> = {
  stop: "멈춤",
  failure: "응답 실패",
  crash: "엔진이 멈춤",
  restart: "앱 재시작",
};

/** How a turn broke off, or null when it completed. */
export function turnBreakOf(status: "completed" | "interrupted" | "failed", cause?: TurnCause | null): TurnBreak | null {
  if (status === "completed") return null;
  return cause ?? (status === "interrupted" ? "stop" : "failure");
}

/** The end line of a turn: done, stopped, or what cut it off. */
export function turnEndText(end: { status: "completed" | "interrupted" | "failed"; cause?: TurnCause | null }) {
  if (end.status === "completed") return "끝남";
  if (end.cause === "crash") return "엔진이 멈춰 끊김";
  if (end.cause === "restart") return "앱이 다시 시작되어 끊김";
  return end.status === "interrupted" ? "중단됨" : "응답이 끝나지 못했습니다";
}

/** What a proposal from a turn cut short is called, in the card and the compare view. */
export const PARTIAL_PROPOSAL = "중단된 턴의 일부 수정안";
