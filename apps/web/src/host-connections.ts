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
};

export type HostConnectionsSnapshot = {
  hosts: SavedHostConnection[];
  /** null selects the local API without replacing its authentication token. */
  activeHostId: string | null;
  phase: "local" | "connecting" | "awaiting-approval" | "connected" | "offline" | "error";
  message?: string;
  verificationCode?: string;
  credentialStorage: "native" | "session";
};

export interface HostConnectionsController {
  getSnapshot(): HostConnectionsSnapshot;
  subscribe(listener: () => void): () => void;
  connectOffer(url: string, label: string): Promise<unknown>;
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
  get(hostId: string): Promise<string | null>;
  set(hostId: string, value: string): Promise<void>;
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
    list,
    credential: (hostId: string) => credentials.get(hostId),
    async upsert(value: SavedHostConnection, credential?: string) {
      const host = publicHost(value);
      if (!host) throw new Error("호스트 연결 정보가 올바르지 않습니다.");
      if (credential !== undefined) await credentials.set(host.hostId, credential);
      save([...list().filter(item => item.hostId !== host.hostId), host]);
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
