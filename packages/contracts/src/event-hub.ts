import type { AgentProfile, SubmitCommand } from "./agent-profiles.ts";

export type HubConnectorKind = "github" | "slack" | "discord";
export type HubConnector = {
  id: string; revision: number; name: string; kind: HubConnectorKind;
  enabled: boolean; credentialConfigured: boolean; publicKey: string | null;
  createdAt: number; updatedAt: number; lastReceivedAt: number | null;
};
export type HubConnectorInput = {
  id?: string; expectedRevision?: number; name: string; kind: HubConnectorKind;
  enabled: boolean; secret?: string; publicKey?: string;
};
export type HubWorkflowInput = {
  id?: string; expectedRevision?: number; name: string; connectorId: string;
  enabled: boolean; allowedSources: string[]; eventTypes: string[];
  hostId: string; workspaceId: string; sessionId: string; profileId: string | null;
  instructions: string; minIntervalSeconds: number; expiresAt: number | null;
};
export type HubWorkflow = Omit<HubWorkflowInput, "id" | "expectedRevision"> & {
  id: string; revision: number; createdAt: number; updatedAt: number;
};
export type HubDeliveryStatus = "received" | "accepted" | "running" | "waiting_input" | "completed" | "failed" | "rejected" | "outcome_unknown";
export type HubDeliveryState = {
  id: string; connectorId: string; deliveryId: string; workflowId: string;
  workflowRevision: number; targetHostId: string; targetWorkspaceId: string;
  sessionId: string; workId: string; eventType: string; source: string;
  state: HubDeliveryStatus; commandId: string | null; payloadHash: string;
  createdAt: number; updatedAt: number; detail: string | null; resultRef: string | null;
};
export type HubRecovery = { action: "dispatch" | "reconcile" | "ignore"; commandId: string | null };
/** Local journal only. The command body never appears in management snapshots. */
export type HubJournalEntry = { delivery: HubDeliveryState; command: SubmitCommand | null };
export type HubSnapshot = {
  hostId: string; connectors: HubConnector[]; workflows: HubWorkflow[];
  deliveries: HubDeliveryState[];
  targets: { sessionId: string; workspaceId: string; workId: string; label: string }[];
  profiles: AgentProfile[];
  ingress: { enabled: boolean; url: string | null; message?: string };
};
export const HUB_STATUS_LABEL: Record<HubDeliveryStatus, string> = {
  received: "접수됨", accepted: "전달됨", running: "작업 중", waiting_input: "입력 필요",
  completed: "완료", failed: "실패", rejected: "거절됨", outcome_unknown: "결과 확인 필요",
};
