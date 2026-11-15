import { PROVIDER_LABEL, type Session, type UsageWindow } from "@workbench/contracts";
import { rowState } from "./row-state.ts";

/**
 * A conversation's state in words — the ONE vocabulary (row-state.ts: 확인 필요 › 실패 › 진행 중 › 새 답 ›
 * 예약 › 완료; "" for a conversation that never answered). While it works, the engine's own account of
 * what it does (activity, e.g. "명령 실행 중") may stand in for 진행 중. Skin 2 fix 1: this used to say
 * 대기 중 / 응답 중 / 승인 필요 / 오류, a second vocabulary beside rowState.
 */
export function statusText(session: Session): string {
  const state = rowState(session);
  if (state?.id === "running" && session.activity && session.status !== "interrupting") return session.activity;
  return state?.word ?? "";
}

export type Tone = "idle" | "active" | "attention" | "error";

/** The CSS tone of that same state (dot-*, tone-*). */
export function statusTone(session: Session): Tone {
  const state = rowState(session);
  return state?.id === "attention" ? "attention" : state?.id === "failed" ? "error" : state?.id === "running" ? "active" : "idle";
}

/** Session name; the engine is shown by its mark and color next to it. */
export const sessionLabel = (session: Session) => session.purpose;

export const sessionTitle = (session: Session) => `${session.purpose} · ${PROVIDER_LABEL[session.provider]}`;

export function ago(at: number | null): string {
  if (!at) return "";
  const minutes = Math.floor((Date.now() - at) / 60_000);
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "어제";
  if (days < 7) return `${days}일 전`;
  return new Date(at).toLocaleDateString("ko-KR", { month: "long", day: "numeric" });
}

export function resetIn(resetsAt: number | null): string | null {
  if (!resetsAt) return null;
  const minutes = Math.round((resetsAt - Date.now()) / 60_000);
  if (minutes <= 0) return "곧 초기화";
  if (minutes < 60) return `${minutes}분 뒤 초기화`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}시간 뒤 초기화`;
  return `${Math.round(hours / 24)}일 뒤 초기화`;
}

export function usageText(window: UsageWindow): string {
  const used = window.usedPercent === null ? "확인 불가" : `${Math.round(window.usedPercent)}% 사용`;
  const reset = resetIn(window.resetsAt);
  return reset ? `${window.label} ${used} · ${reset}` : `${window.label} ${used}`;
}

export const newRequestId = () => crypto.randomUUID();

/** First line of a prompt, trimmed for use as a work title. */
export function titleFrom(text: string) {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 40 ? `${line.slice(0, 40)}…` : line || "새 작업";
}
