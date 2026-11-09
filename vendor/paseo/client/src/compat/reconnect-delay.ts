// Workbench compatibility extraction from Paseo daemon-client.ts (same pinned revision).
// This exports only the unchanged delay calculation and defaults from armReconnectTimer;
// the original connection state machine and Paseo protocol facade remain in daemon-client.ts.
// See source.json for source hash/line provenance.
const DEFAULT_RECONNECT_BASE_DELAY_MS = 1500;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30000;

export function paseoReconnectDelay(
  attempt: number,
  reconnect?: { baseDelayMs?: number; maxDelayMs?: number },
): number {
  const baseDelay = reconnect?.baseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS;
  const maxDelay = reconnect?.maxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
  const delay = Math.min(baseDelay * 2 ** attempt, maxDelay);
  return delay;
}
