/** A process incarnation, separate from the durable host and its sessions. */
export type HostInstance = {
  hostId: string;
  instanceId: string;
  ownerPid: number;
  ownerStartedAt: string;
  protocolVersion: number;
  mode: "service" | "shell";
  version: string;
  buildId: string;
};
export type EventCursor = { epoch: string; seq: number };
export type HostStatus = { instance: HostInstance; cursor: EventCursor; state: "running" | "stopping"; activeTasks: number };
export type StopReceipt = { instanceId: string; state: "stopping" | "stopped"; requestedAt: number };
