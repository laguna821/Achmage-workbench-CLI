import type { Provider } from "./index.ts";

export type TaskState = "queued" | "running" | "waiting_input" | "completed" | "failed" | "cancelled" | "interrupted" | "outcome_unknown";
export type TaskRef = {
  hostId: string; workspaceId: string | null; sessionId: string; nativeSessionId: string | null;
  runId: string; parentRunId: string | null; executorKind: "session" | "office" | "native_agent";
};
export type TaskCapabilities = { observe: true; send: boolean; queue: boolean; steer: boolean; stop: boolean; approve: boolean };
export type TaskSummary = TaskRef & {
  workId: string; parentSessionId: string | null; provider: Provider; title: string; requestId: string | null;
  state: TaskState; activity: string | null; preview: string | null; updatedAt: number;
  approvalIds: string[]; capabilities: TaskCapabilities; sourceItemId: string | null;
};
export type TaskSnapshot = { epoch: string; seq: number; tasks: TaskSummary[] };
export type TaskCommandKind = "stop" | "approve" | "cancel_queue" | "send_queue";
export type TaskCommand = { commandId: string; target: TaskRef; kind: TaskCommandKind; itemId?: string; decision?: "accept" | "decline"; queuedId?: string };
export type CommandReceipt = {
  commandId: string; targetRunId: string; sessionId: string; payloadHash: string;
  status: "accepted" | "running" | "completed" | "rejected" | "outcome_unknown";
  resultRef: string | null; detail: string | null; createdAt: number; updatedAt: number;
};
export type ReceiptObservation = { kind: "transport_retry" } | { kind: "observed"; status: "running" | "completed" | "rejected"; detail?: string };
/** Shared by browser and desktop adapters; a view's visibility is never an execution lease. */
export type ControlLease = { targetId: string; ownerRunId: string; generation: number; expiresAt: string; handoffState: "agent" | "human" | "handoff_pending" };
export type NativeAgentObservation = {
  parentNativeSessionId?: string; operation: string;
  children: { nativeSessionId: string; state: TaskState; title?: string; result?: string | null }[];
};
export const TASK_STATE_LABEL: Record<TaskState, string> = {
  queued: "보낼 예정", running: "작업 중", waiting_input: "입력 필요", completed: "완료", failed: "실패",
  cancelled: "취소됨", interrupted: "끊김", outcome_unknown: "결과 확인 필요",
};
