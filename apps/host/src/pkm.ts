import type { PkmScope, PkmState } from "@workbench/contracts";
import type { EventBus } from "./bus.ts";
import { HttpError } from "./errors.ts";
import type { SessionManager } from "./sessions.ts";
import type { Store } from "./store.ts";
import { VaultMirror } from "./vault.ts";

// The PKM layer of the gateway (design 워크스테이션-다음설계 §4): the read-only vault mirror and,
// on top of it, what ties notes to works and sessions. Small state lives in the meta table under
// `pkm.*` keys; every change is announced as one `pkm.changed` event so screens fetch it again.

export type PkmOptions = { vaultDebounceMs?: number };

export class Pkm {
  readonly vault: VaultMirror;
  protected readonly store: Store;
  protected readonly bus: EventBus;
  protected readonly manager: SessionManager;

  constructor(store: Store, bus: EventBus, manager: SessionManager, options: PkmOptions = {}) {
    this.store = store;
    this.bus = bus;
    this.manager = manager;
    this.vault = new VaultMirror((version) => this.publish("vault", version), { debounceMs: options.vaultDebounceMs });
    const saved = store.getMeta("pkm.vault");
    if (saved) this.vault.restore(saved);
  }

  protected publish(scope: PkmScope, version = Date.now()) {
    this.bus.publish({ type: "pkm.changed", scope, version });
  }

  state(): PkmState {
    return { vault: this.vault.status() };
  }

  /** Attach a vault folder (or none). Only the path is remembered; the vault itself is never written. */
  attachVault(path: string | null) {
    const wanted = path?.trim() || null;
    try {
      this.vault.attach(wanted);
    } catch (error) {
      throw new HttpError(400, "invalid_vault", error instanceof Error ? error.message : String(error));
    }
    this.store.setMeta("pkm.vault", this.vault.root ?? "");
    return this.vault.status();
  }

  close() {
    this.vault.close();
  }
}
