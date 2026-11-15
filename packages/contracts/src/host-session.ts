export * from "./protocol.ts";
import type { ProtocolDescriptor, ProtocolHandshake } from "./protocol.ts";
/** A process incarnation, separate from the durable host and its sessions. */
export type HostInstance = {
  hostId: string;
  instanceId: string;
  ownerPid: number;
  ownerStartedAt: string;
  protocolVersion: number;
  protocol?: ProtocolDescriptor;
  mode: "service" | "shell";
  version: string;
  buildId: string;
};
export type EventCursor = { epoch: string; seq: number };
/** The gateway's vault as the OS vault helper answered it (sec-vault round 2): `message` says why and what to do; never a secret. */
export type HostVaultStatus = { state: "unknown" | "open" | "refused"; reason: string | null; message: string | null };
export type HostStatus = { instance: HostInstance; cursor: EventCursor; state: "running" | "stopping"; activeTasks: number; compatibility?: ProtocolHandshake; update?: HostUpdateStatus; vault?: HostVaultStatus };
export type StopReceipt = { instanceId: string; state: "stopping" | "stopped"; requestedAt: number };

export type HostUpdateBlocker = { kind: "task" | "office" | "terminal"; id: string; label: string };
export type HostUpdateStatus = { state: "running" | "draining" | "ready" | "stopping"; requestedAt: number | null; blockers: HostUpdateBlocker[]; backupPath: string | null; schemaVersion: number };
