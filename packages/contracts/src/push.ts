import type { AttentionTarget } from "./attention.ts";

export type WebPushSubscription = { endpoint: string; expirationTime?: number | null; keys: { p256dh: string; auth: string } };
export type PushConfiguration = { enabled: boolean; subject: string };
export type PushDeviceState = {
  deviceId: string; enabled: boolean; updatedAt: number; expiresAt: number; credentialVersion: number;
  lastDeliveryAt: number | null; lastDelivery: "sent" | "unknown" | "rejected" | null; error: string | null;
};
export type PushStatus = {
  hostId: string; enabled: boolean; configured: boolean; publicKey: string | null; keyVersion: number;
  leaseHours: 48; device: PushDeviceState | null; verification: "NOT_RUN_DEVICE";
};
export type PushSettings = PushStatus & { config: PushConfiguration; devices: PushDeviceState[] };
export type PushSubscriptionInput = { subscription: WebPushSubscription; appUrl: string; keyVersion: number };
/** The link alone never grants access; the protected channel resolves it with the current credential. */
export type PushOpenResult = { attentionId: string; target: AttentionTarget };
