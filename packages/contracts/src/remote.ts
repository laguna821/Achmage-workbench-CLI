import type { EventCursor, SequencedEvent } from "./index.ts";
import type { DeviceGrant, PairingCredentialResult, PairingRequestTicket } from "./devices.ts";

/** Workbench HTTP and event semantics carried inside Paseo's protected endpoint channel. */
export type RemoteOffer = {
  v: 2; serverId: string; daemonPublicKeyB64: string;
  relay: { endpoint: string; useTls?: boolean }; minimumSecurityMode: "protected";
  workbench: { version: 1; endpoint: string; offerId: string; token: string; expiresAt: number; label: string };
};
export type RemoteRequest = { id: string; method: string; path: string; headers: Record<string, string>; bytes: number };
export type RemoteFrame = { type: "workbench"; id?: string; op: string; [key: string]: unknown };
export type RemoteEventMessage =
  | { op: "event"; event: SequencedEvent }
  | { op: "cursor"; cursor: EventCursor }
  | { op: "resync" };
export type RemoteAuthentication = { grant: DeviceGrant; hostId: string; cursor: EventCursor; compatibility?: import("./protocol.ts").ProtocolHandshake };
export type RemotePairingResult = PairingRequestTicket | PairingCredentialResult;
export const REMOTE_CHUNK_BYTES = 192 * 1024;
export const REMOTE_BODY_LIMIT = 32 * 1024 * 1024;
