/** agent-desktop's upstream delivery result is not proof that an app saved a file. */
export type DesktopDelivery = "unknown" | "not_delivered" | "delivery_uncertain" | "delivered_unverified" | "delivered_verified";
export type DesktopEnvelope = { version: string; command: string; ok: boolean; data?: unknown; error?: { code: string; message: string; disposition?: { delivery: DesktopDelivery; retry: "unknown" | "safe" | "unsafe" } } };
export type DesktopWindow = { id: string; title: string; app_name: string; pid: number; process_instance?: string };
export type DesktopTarget = { id: string; sessionId: string; window: DesktopWindow; headed: boolean; createdAt: number; observation: DesktopObservation | null; needsReconcile: boolean };
export type DesktopObservation = { id: string; targetId: string; snapshotId: string; observedAt: number; complete: boolean; identityUnproven: boolean; data: unknown };
export type DesktopActionName = "click" | "double-click" | "right-click" | "type" | "set-value" | "clear" | "focus" | "select" | "toggle" | "check" | "uncheck" | "expand" | "collapse" | "scroll" | "press";
export type DesktopAction = { commandId: string; observationId: string; action: DesktopActionName; ref?: string; value?: string; direction?: "up" | "down" | "left" | "right"; amount?: number };
export type DesktopReceipt = { id: string; targetId: string; sessionId: string; action: DesktopActionName; fingerprint: string; state: "running" | "completed" | "failed" | "outcome_unknown"; delivery: DesktopDelivery; startedAt: number; finishedAt: number | null; result: DesktopEnvelope | null; error: string | null; reconciledObservationId?: string };
export type DesktopState = { version: string; installed: boolean; installing: boolean; supported: boolean; platform: string; permissionStatus: DesktopEnvelope | null; targets: DesktopTarget[]; receipts: DesktopReceipt[]; inputOwner: string | null; error: string | null };
