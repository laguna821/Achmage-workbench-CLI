import { PROVIDER_LABEL, type Session, type UsageWindow } from "@workbench/contracts";

export function statusText(session: Session): string {
  switch (session.status) {
    case "idle":
      return "대기 중";
    case "starting":
      return session.activity ?? "응답 준비 중";
    case "running":
      return session.activity ?? "응답 중";
    case "awaitingApproval":
      return "승인 필요";
    case "interrupting":
      return "중단하는 중";
    case "error":
      return "오류";
  }
}

export type Tone = "idle" | "active" | "attention" | "error";

export function statusTone(session: Session): Tone {
  switch (session.status) {
    case "starting":
    case "running":
    case "interrupting":
      return "active";
    case "awaitingApproval":
      return "attention";
    case "error":
      return "error";
    default:
      return "idle";
  }
}

export const sessionLabel = (session: Session) => `${session.purpose} · ${PROVIDER_LABEL[session.provider]}`;

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
