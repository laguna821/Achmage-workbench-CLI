import { identity, object, parse, verifyHmac, type HubHeaders, type VerifiedHubRequest } from "./verification.ts";

/** GitHub signs the exact body. Delivery headers are not part of that signature;
 * the consumer also deduplicates the signed body hash so a changed ID cannot replay it.
 * https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
 */
export function verifyGitHub(rawBody: Uint8Array, headers: HubHeaders, secret: string): VerifiedHubRequest {
  verifyHmac(secret, rawBody, headers["x-hub-signature-256"], "sha256=");
  const payload = parse(rawBody), eventType = identity(headers["x-github-event"]);
  if (eventType === "ping") return { event: null };
  const repository = object(payload.repository);
  return { event: { deliveryId: identity(headers["x-github-delivery"]), eventType,
    source: identity(repository.full_name).toLowerCase(), payload } };
}
