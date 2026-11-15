import { invoke, isTauri } from "@tauri-apps/api/core";
import { createBrowserHostCredentialStore, createMemoryHostCredentialStore, createSessionHostCredentialStore, rememberLimit, type HostCredentialStore } from "./host-connections.ts";

/** A native vault failure is visible; it never silently downgrades to browser storage. */
export function platformHostCredentials(): HostCredentialStore {
  let legacy: HostCredentialStore;
  try { legacy = createSessionHostCredentialStore(window.sessionStorage); }
  catch { legacy = createMemoryHostCredentialStore(); }
  if (!isTauri()) {
    // A browser (the phone): the tab by default, the profile's lasting storage only when asked.
    // Not on a page opened over plain http (its code can be replaced on the way, so no credential
    // is left there for a later page load to hand over), nor by this PC's own address.
    try {
      let lasting: Storage | null = null;
      if (rememberLimit() === null) try { lasting = window.localStorage; } catch { /* Lasting storage is blocked: nothing can be remembered. */ }
      return createBrowserHostCredentialStore(window.sessionStorage, lasting);
    } catch { return legacy; }
  }
  const command = (hostId: string, action: "get" | "set" | "delete", credential?: string) =>
    invoke<string | null>("host_credential", { hostId, action, credential });
  return {
    mode: "native",
    async get(hostId) {
      const saved = await command(hostId, "get");
      if (saved !== null) { await legacy.delete(hostId); return saved; }
      const previous = await legacy.get(hostId);
      if (previous !== null) { await command(hostId, "set", previous); await legacy.delete(hostId); }
      return previous;
    },
    async set(hostId, value) { await command(hostId, "set", value); await legacy.delete(hostId); },
    async delete(hostId) { await command(hostId, "delete"); await legacy.delete(hostId); },
  };
}
