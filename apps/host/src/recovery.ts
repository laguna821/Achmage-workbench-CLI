import type { Provenance, Session, TranscriptItem, TurnBreak } from "@workbench/contracts";

// "끊기는 길" (design §8): the rules for a turn that does not complete, kept apart from the session
// manager. Every turn ends with a turn end — also when its engine died (the adapters say so) or the
// app restarted (made here) — so what the turn left is settled the same way each time.

type TurnEnd = Extract<TranscriptItem, { kind: "turnEnd" }>;
type UserItem = Extract<TranscriptItem, { kind: "user" }>;

/**
 * A turn end as it is kept: the model and effort the engine last reported (when the adapter did not
 * say), the request that started it, and how long it ran when an engine that died could not tell.
 */
export function stampTurnEnd(item: TurnEnd, session: Pick<Session, "engineModel" | "engineEffort"> | undefined, startedAt?: number, requestId?: string | null): TurnEnd {
  return {
    ...item,
    model: item.model !== undefined ? item.model : (session?.engineModel ?? null),
    effort: item.effort !== undefined ? item.effort : (session?.engineEffort ?? null),
    requestId: item.requestId !== undefined ? item.requestId : (requestId ?? null),
    durationMs: item.durationMs ?? (item.cause && startedAt ? Math.max(0, item.at - startedAt) : null),
  };
}

/** What an engine made in a turn: its provenance, from the turn end. */
export const provenanceOf = (end: Pick<TurnEnd, "model" | "effort" | "requestId">): Provenance => ({ model: end.model ?? null, effort: end.effort ?? null, requestId: end.requestId ?? null });

const BREAK_REASON: Record<TurnBreak, string> = {
  stop: "멈췄기 때문에",
  failure: "응답이 끝나지 못해서",
  crash: "엔진이 멈춰",
  restart: "앱이 다시 시작되어",
};

/** The notice when a turn that did not complete keeps the requests waiting for it. */
export const heldNotice = (broke: TurnBreak, count: number) => `${BREAK_REASON[broke]} 보낼 예정인 요청 ${count}개를 보내지 않았습니다. 입력창 위에서 보내거나 지울 수 있습니다.`;

/** Why a request sent from another session got no answer (shown on its card there). */
export function handoffError(broke: TurnBreak) {
  if (broke === "crash") return "엔진이 멈춰 응답이 끊겼습니다";
  if (broke === "restart") return "앱이 다시 시작되어 응답이 끊겼습니다";
  return broke === "stop" ? "중단됨" : "응답이 끝나지 못했습니다";
}

/**
 * The end of the turn an app restart cut short (no engine outlives the app): its request is the last
 * one not steered into a running turn, and it ends after the last thing it recorded. Null when that
 * request already has an end (the session was busy with something else, like a compaction).
 */
export function restartTurnEnd(items: TranscriptItem[]): TurnEnd | null {
  let start = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.kind === "turnEnd") return null;
    if (item.kind === "user" && !item.steered) {
      start = index;
      break;
    }
  }
  if (start < 0) return null;
  const request = items[start] as UserItem;
  const at = Math.max(...items.slice(start).map((item) => item.at));
  return {
    kind: "turnEnd",
    id: `end:restart:${request.id}`,
    status: "interrupted",
    cause: "restart",
    durationMs: Math.max(0, at - request.at),
    at,
    requestId: request.id.startsWith("user:") ? request.id.slice(5) : null,
  };
}
