import { createPublicKey, verify } from "node:crypto";
import { digest, identity, object, parse, recentTimestamp, payloadError, signatureError, type HubHeaders, type VerifiedHubRequest } from "./verification.ts";

/** Discord Webhook Events (not bot Gateway or outgoing channel webhooks).
 * PING and accepted deliveries receive an empty 204; no message is posted.
 * https://docs.discord.com/developers/events/webhook-events
 */
export function verifyDiscord(rawBody: Uint8Array, headers: HubHeaders, publicKey: string, now = Date.now()): VerifiedHubRequest {
  const timestamp = recentTimestamp(headers["x-signature-timestamp"], now), signature = headers["x-signature-ed25519"];
  if (!/^[a-f0-9]{64}$/i.test(publicKey) || !signature || !/^[a-f0-9]{128}$/i.test(signature)) throw signatureError();
  const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKey, "hex")]), format: "der", type: "spki" });
  if (!verify(null, Buffer.concat([Buffer.from(timestamp), Buffer.from(rawBody)]), key, Buffer.from(signature, "hex"))) throw signatureError();
  const payload = parse(rawBody);
  if (payload.type === 0) return { event: null };
  if (payload.type !== 1 || payload.version !== 1) throw payloadError();
  const event = object(payload.event), data = event.data === undefined ? {} : object(event.data);
  const app = identity(payload.application_id), eventType = identity(event.type);
  const guild = data.guild && typeof data.guild === "object" ? (data.guild as Record<string, unknown>).id : data.guild_id;
  const scope = data.channel_id ?? data.lobby_id ?? guild ?? "app";
  // Discord's webhook event envelope has no globally unique event ID. Keep the
  // signed body digest as delivery identity; do not invent exactly-once semantics.
  return { event: { deliveryId: "body-" + digest(rawBody), eventType, source: app + "/" + identity(String(scope)), payload } };
}
