import { identity, object, parse, recentTimestamp, verifyHmac, type HubHeaders, type VerifiedHubRequest } from "./verification.ts";

/** https://docs.slack.dev/authentication/verifying-requests-from-slack/ */
export function verifySlack(rawBody: Uint8Array, headers: HubHeaders, secret: string, now = Date.now()): VerifiedHubRequest {
  const timestamp = recentTimestamp(headers["x-slack-request-timestamp"], now);
  verifyHmac(secret, Buffer.concat([Buffer.from("v0:" + timestamp + ":"), Buffer.from(rawBody)]), headers["x-slack-signature"], "v0=");
  const payload = parse(rawBody);
  if (payload.type === "url_verification") return { event: null, challenge: identity(payload.challenge) };
  if (payload.type !== "event_callback") return { event: null };
  const event = object(payload.event);
  // Only Events API events with an explicit channel can enter a workflow.
  // Slash-command form bodies and arbitrary response_url callbacks are not used.
  return { event: { deliveryId: identity(payload.event_id), eventType: identity(event.type),
    source: identity(payload.team_id) + "/" + identity(event.channel), payload } };
}
