// Workbench compatibility extraction: unchanged ExternalSocketMetadata interface from upstream websocket-server.ts. See source.json.
import type { SecurityMode } from "@getpaseo/relay/e2ee";

export interface ExternalSocketMetadata {
  transport: "relay" | "hub";
  externalSessionKey?: string;
  relayConnectionId?: string;
  /** Negotiated endpoint security for relay-carried sockets. */
  securityMode?: SecurityMode;
  hubDaemonId?: string;
}
