import { parseConnectionOfferFromUrl } from "@getpaseo/protocol/connection-offer";
import { parseRelayConnectionUri } from "@getpaseo/protocol/daemon-endpoints";
import type { DeviceApproval, DeviceGrant, DevicePermission, PairingOffer, PairingRequest } from "../../../packages/contracts/src/devices.ts";

export type SavedHostConnection = {
  hostId: string;
  label: string;
  endpoint: string;
  daemonPublicKeyB64: string;
  deviceId: string;
  createdAt: number;
  lastConnectedAt: number | null;
  /** The credential for this PC is kept in this browser after the tab or app closes. */
  remembered?: boolean;
};

export type HostConnectionsSnapshot = {
  hosts: SavedHostConnection[];
  /** null selects the local API without replacing its authentication token. */
  activeHostId: string | null;
  phase: "local" | "connecting" | "awaiting-approval" | "connected" | "offline" | "error";
  message?: string;
  verificationCode?: string;
  credentialStorage: "native" | "session";
  /** A browser can keep a credential after its tab closes when the person asks for it. */
  canRemember?: boolean;
};

export interface HostConnectionsController {
  getSnapshot(): HostConnectionsSnapshot;
  subscribe(listener: () => void): () => void;
  /** remember: keep the approval on this device after its tab or app closes. Off unless asked. */
  connectOffer(url: string, label: string, options?: { remember?: boolean }): Promise<unknown>;
  selectHost(hostId: string): Promise<unknown>;
  disconnect(): Promise<unknown>;
  remove(hostId: string): Promise<unknown>;
  /** A native scanner may supply a URL; the same explicit connect action follows. */
  scan?(): Promise<string | null>;
}

export type LocalDeviceConfig = {
  enabled: boolean;
  label?: string;
  relayUrl?: string;
  publicUrl?: string;
  listenHost?: string;
  port?: number;
};
export type DeviceManagementState = {
  config: LocalDeviceConfig;
  hostId: string;
  hostFingerprint: string;
  pending: PairingRequest[];
  devices: DeviceGrant[];
  workspaces: { workId: string; label: string }[];
  status: string;
  error?: string;
  /** The port devices connect to while remote access is listening. */
  port?: number | null;
  /** The page address a phone can open, or null when this PC cannot be reached from one yet. */
  phoneUrl?: string | null;
};
export type HostPairingOffer = PairingOffer & { url: string; qrDataUrl?: string | null; hostFingerprint?: string };
export type DeviceApprovalInput = DeviceApproval;
export interface LocalDeviceApi {
  state(): Promise<DeviceManagementState>;
  configure(input: LocalDeviceConfig): Promise<DeviceManagementState>;
  createOffer(): Promise<HostPairingOffer>;
  approve(requestId: string, input: DeviceApprovalInput): Promise<unknown>;
  reject(requestId: string): Promise<unknown>;
  revoke(deviceId: string): Promise<unknown>;
  /** Takes a device off the list; its access ends with it. */
  remove(deviceId: string): Promise<unknown>;
  /** Local rotation revokes this device and returns a new single-use pairing offer. */
  rotate(deviceId: string): Promise<HostPairingOffer>;
}

/** Reuse Paseo's parser. Single-use Workbench enrollment is validated by the controller. */
export function pairingHostPreview(input: string) {
  try {
    const value = input.trim();
    const offer = value.startsWith("relay://") || value.includes("#connect=")
      ? parseRelayConnectionUri(value).offer : parseConnectionOfferFromUrl(value);
    return offer ? { hostId: offer.serverId, daemonPublicKeyB64: offer.daemonPublicKeyB64, endpoint: offer.relay.endpoint } : null;
  } catch { return null; }
}

export const DEVICE_PERMISSION_LABELS: Record<DevicePermission, string> = {
  read: "대화·파일 읽기", send: "메시지 보내기", approve: "AI 요청 승인", cancel: "작업 취소", terminal: "터미널 사용",
};

export interface HostCredentialStore {
  readonly mode: "native" | "session";
  /** A session store that can also keep a credential after the tab closes, when asked. */
  readonly canRemember?: boolean;
  get(hostId: string): Promise<string | null>;
  set(hostId: string, value: string, options?: { remember?: boolean }): Promise<void>;
  delete(hostId: string): Promise<void>;
}

/** Native keychain adapters implement this port; there is no implicit native bridge. */
export function createMemoryHostCredentialStore(): HostCredentialStore {
  const values = new Map<string, string>();
  return {
    mode: "session",
    async get(hostId) { return values.get(hostId) ?? null; },
    async set(hostId, value) { values.set(hostId, value); },
    async delete(hostId) { values.delete(hostId); },
  };
}

/** Optional browser tab persistence, explicitly distinct from a native keychain. */
export function createSessionHostCredentialStore(storage: Storage = window.sessionStorage): HostCredentialStore {
  const key = (hostId: string) => `workbench.remote-credential.v1:${encodeURIComponent(hostId)}`;
  return {
    mode: "session",
    async get(hostId) { return storage.getItem(key(hostId)); },
    async set(hostId, value) { storage.setItem(key(hostId), value); },
    async delete(hostId) { storage.removeItem(key(hostId)); },
  };
}

/** Why this page may not keep a connection after its tab closes, or null when it may.
 * "http": the page's code can be replaced on the way. "loopback": the address is this PC's own,
 * shared with whatever program holds that port (the desktop app has its keychain instead).
 * The page decides this; the PC cannot see how a page was opened. */
export function rememberLimit(page: { isSecureContext?: boolean; location: { hostname: string } } = window): "http" | "loopback" | null {
  if (page.isSecureContext === false) return "http";
  const host = page.location.hostname;
  return host === "localhost" || host.endsWith(".localhost") || /^127\./.test(host) || host === "[::1]" || host === "::1" ? "loopback" : null;
}

/** A browser's two places for a device credential. By default it lives in the tab and ends with it.
 * Only when the person asked this device to remember the PC is it kept in the profile's lasting
 * storage instead. What is kept is the device credential the PC issued (revocable there, expiring
 * with the approval), never the pairing link's token. It is in one place at a time. */
export function createBrowserHostCredentialStore(session: Storage, lasting: Storage | null): HostCredentialStore {
  const key = (hostId: string) => `workbench.remote-credential.v1:${encodeURIComponent(hostId)}`;
  return {
    mode: "session",
    canRemember: lasting !== null,
    async get(hostId) { return session.getItem(key(hostId)) ?? lasting?.getItem(key(hostId)) ?? null; },
    async set(hostId, value, options) {
      if (options?.remember && lasting) { lasting.setItem(key(hostId), value); session.removeItem(key(hostId)); }
      else { session.setItem(key(hostId), value); lasting?.removeItem(key(hostId)); }
    },
    async delete(hostId) { session.removeItem(key(hostId)); lasting?.removeItem(key(hostId)); },
  };
}

const HOSTS_KEY = "workbench.host-connections.v1";
type MetadataStorage = Pick<Storage, "getItem" | "setItem">;

function publicHost(value: unknown): SavedHostConnection | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (!["hostId", "label", "endpoint", "daemonPublicKeyB64", "deviceId"].every(key => typeof row[key] === "string" && row[key])) return null;
  if (typeof row.createdAt !== "number" || !Number.isFinite(row.createdAt)) return null;
  // Pick only public fields, even when the caller supplies an enrollment result with credentials.
  return {
    hostId: row.hostId as string, label: row.label as string, endpoint: row.endpoint as string,
    daemonPublicKeyB64: row.daemonPublicKeyB64 as string, deviceId: row.deviceId as string,
    createdAt: row.createdAt, lastConnectedAt: typeof row.lastConnectedAt === "number" && Number.isFinite(row.lastConnectedAt) ? row.lastConnectedAt : null,
    remembered: row.remembered === true,
  };
}

export function createHostConnectionStorage(options: { metadata?: MetadataStorage | null; credentials?: HostCredentialStore } = {}) {
  let metadata = options.metadata;
  if (metadata === undefined) { try { metadata = window.localStorage; } catch { metadata = null; } }
  const credentials = options.credentials ?? createMemoryHostCredentialStore();
  let inMemory: SavedHostConnection[] = [];
  const list = (): SavedHostConnection[] => {
    if (!metadata) return inMemory.map(host => ({ ...host }));
    try {
      const rows: unknown = JSON.parse(metadata.getItem(HOSTS_KEY) ?? "[]");
      if (!Array.isArray(rows)) return [];
      return [...new Map(rows.map(publicHost).filter((host): host is SavedHostConnection => host !== null).map(host => [host.hostId, host])).values()];
    } catch { return []; }
  };
  const save = (hosts: SavedHostConnection[]) => {
    if (metadata) metadata.setItem(HOSTS_KEY, JSON.stringify(hosts));
    else inMemory = hosts;
  };
  return {
    credentialStorage: credentials.mode,
    canRemember: credentials.mode === "session" && credentials.canRemember === true,
    list,
    credential: (hostId: string) => credentials.get(hostId),
    async upsert(value: SavedHostConnection, credential?: string) {
      const host = publicHost(value);
      if (!host) throw new Error("호스트 연결 정보가 올바르지 않습니다.");
      if (credential !== undefined) await credentials.set(host.hostId, credential, { remember: host.remembered === true });
      save([...list().filter(item => item.hostId !== host.hostId), host]);
    },
    /** The PC ended this approval: drop the dead credential, keep the PC in the list. */
    async forgetCredential(hostId: string) {
      await credentials.delete(hostId);
      save(list().map(host => host.hostId === hostId ? { ...host, remembered: false } : host));
    },
    touch(hostId: string, at = Date.now()) {
      save(list().map(host => host.hostId === hostId ? { ...host, lastConnectedAt: at } : host));
    },
    async remove(hostId: string) {
      await credentials.delete(hostId);
      save(list().filter(host => host.hostId !== hostId));
    },
  };
}
export type HostConnectionStorage = ReturnType<typeof createHostConnectionStorage>;
