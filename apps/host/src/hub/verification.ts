import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { HttpError } from "../errors.ts";

export type VerifiedHubEvent = { deliveryId: string; eventType: string; source: string; payload: Record<string, unknown> };
export type VerifiedHubRequest = { event: VerifiedHubEvent | null; challenge?: string };
export type HubHeaders = Record<string, string | undefined>;
export const signatureError = () => new HttpError(401, "hub_signature", "외부 사건의 서명을 확인하지 못했습니다.");
export const payloadError = () => new HttpError(400, "hub_payload", "외부 사건의 형식이 올바르지 않습니다.");
export const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export function verifyHmac(secret: string, bytes: Uint8Array, actual: string | undefined, prefix: string) {
  const expected = prefix + createHmac("sha256", secret).update(bytes).digest("hex");
  if (!secret || !actual || actual.length !== expected.length || !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) throw signatureError();
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw payloadError();
  return value as Record<string, unknown>;
}
export function parse(bytes: Uint8Array): Record<string, unknown> {
  try { return object(JSON.parse(Buffer.from(bytes).toString("utf8"))); } catch { throw payloadError(); }
}
export function identity(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 256 || /[\u0000-\u001f]/.test(value)) throw payloadError();
  return value;
}
export function recentTimestamp(value: string | undefined, now: number): string {
  if (!value || !/^\d{9,13}$/.test(value) || Math.abs(now - Number(value) * 1000) > 300_000) throw signatureError();
  return value;
}
