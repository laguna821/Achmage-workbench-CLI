import type { TaskRef } from "./tasks.ts";

export type AttentionKind = "completed" | "failed" | "input_needed";
export type AttentionDelivery = "pending" | "suppressed" | "sent" | "unavailable" | "unknown";
/** Identifiers and generic copy only. Prompt, reply, file and project names stay out of OS/push payloads. */
export type AttentionPayload = { title: string; body: string; attentionId: string };
export type AttentionEvent = {
  id: string; kind: AttentionKind; taskRef: TaskRef; workId: string; itemId: string;
  createdAt: number; readAt: number | null; resolvedAt: number | null;
  delivery: AttentionDelivery; deliveryError: string | null;
};
export type AttentionList = { events: AttentionEvent[]; unread: number };
/** Ephemeral UI presence. It never owns or extends a job's execution lease. */
export type AttentionPresence = { clientId: string; sessionId: string | null; visible: boolean };
export type AttentionTarget = { hostId: string; workId: string; sessionId: string; itemId: string; artifactId: string | null; taskRef: TaskRef };
export const ATTENTION_LABEL: Record<AttentionKind, string> = {
  completed: "작업이 완료되었습니다.", failed: "작업을 마치지 못했습니다.", input_needed: "확인이 필요한 작업이 있습니다.",
};
