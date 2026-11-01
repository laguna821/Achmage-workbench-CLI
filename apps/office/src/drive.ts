import type { OfficeDriveAttachments } from "../../../packages/contracts/src/office-drive.ts";

/** The original composeWithDrive/DriveAttachButton consume this exact bridge. */
export function createDriveBridge(state: () => Promise<{ connected: boolean; enabled: boolean }>, tool: (name: string, ...args: unknown[]) => Promise<unknown>, pick: () => Promise<OfficeDriveAttachments>) {
  let current = { connected: false, enabled: false }, pending = false, stopped = false;
  const aiListeners = new Set<(on: boolean) => void>(), connectedListeners = new Set<(on: boolean) => void>();
  const refresh = async () => {
    if (pending || stopped) return current;
    pending = true;
    try {
      const next = await state();
      if (next.enabled !== current.enabled) for (const listener of aiListeners) listener(next.enabled);
      if (next.connected !== current.connected) for (const listener of connectedListeners) listener(next.connected);
      current = next;
    } catch { /* The next focus/poll rechecks the document's live capability. */ }
    finally { pending = false; }
    return current;
  };
  const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 2500);
  window.addEventListener("focus", () => void refresh());
  window.addEventListener("pagehide", () => { stopped = true; clearInterval(timer); aiListeners.clear(); connectedListeners.clear(); });
  return {
    driveAiEnabled: async () => (await refresh()).enabled,
    driveConnected: async () => (await refresh()).connected,
    driveSearch: (query: string, limit: number) => tool("drive-search", query, limit),
    driveRead: (id: string, offset: number) => tool("drive-read", id, offset),
    drivePickAttachments: () => pick().catch(() => ({ ok: false as const, reason: "cancelled" as const })),
    onDriveAiChanged: (listener: (on: boolean) => void) => { aiListeners.add(listener); return () => { aiListeners.delete(listener); }; },
    onDriveConnectedChanged: (listener: (on: boolean) => void) => { connectedListeners.add(listener); return () => { connectedListeners.delete(listener); }; },
  };
}
