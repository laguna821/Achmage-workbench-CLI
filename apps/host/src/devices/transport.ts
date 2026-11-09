import type { KeyPair } from "@getpaseo/relay/e2ee";
import { ServerInfoStatusPayloadSchema } from "@getpaseo/protocol/messages";
import {
  admitSecuredRelaySocket,
  type RelayIngressSocket,
  type SecureRelayIngressOptions,
} from "@workbench/paseo-server-transport/secure-relay-ingress";
import type { EncryptedRelaySocket } from "@workbench/paseo-server-transport/encrypted-relay-socket";
import {
  startRelayTransport,
  type RelayTransportController,
  type RelayTransportOptions,
} from "@workbench/paseo-server-transport/relay-transport";
import type { ExternalSocketMetadata } from "@workbench/paseo-server-transport/socket-metadata";
import { createConnectionOfferV2 } from "@workbench/paseo-server-transport/connection-offer";

export {
  loadOrCreateDaemonKeyPair as loadOrCreateKeyPair,
  type DaemonKeyPairBundle,
} from "@workbench/paseo-server-transport/daemon-keypair";
export {
  buildOfferEndpoints,
  encodeOfferToFragmentUrl,
} from "@workbench/paseo-server-transport/connection-offer";
export {
  ApplicationSocketLease,
  APPLICATION_SOCKET_LEASE_CHECK_INTERVAL_MS,
  sendBoundedPhysicalFrameAndWait,
} from "@workbench/paseo-server-transport/physical-socket";
export type { EncryptedRelaySocket as ProtectedSocket, RelayIngressSocket, ExternalSocketMetadata };

export interface ProtectedSocketOptions {
  keyPair: KeyPair;
  logger: SecureRelayIngressOptions["logger"];
}

/** Paseo owns the handshake, framing, pending-message delivery and socket limits.
 * The callback still has to admit the device before accepting Workbench requests. */
export function attachProtectedSocket(
  rawSocket: RelayIngressSocket,
  options: ProtectedSocketOptions,
  onSecured: (socket: EncryptedRelaySocket) => void | Promise<void>,
): Promise<void> {
  return admitSecuredRelaySocket(rawSocket, {
    daemonKeyPair: options.keyPair,
    logger: options.logger,
    requireProtectedMode: () => true,
  }, async ({ socket }) => {
    await onSecured(socket);
  });
}

export interface ProtectedServerInfo {
  serverId: string;
  hostname?: string;
  version?: string;
}

/** This first encrypted message uses the original schema and downgrade signal.
 * Only the endpoint security feature is advertised; Workbench has its own RPC. */
export function createProtectedServerInfo(info: ProtectedServerInfo) {
  return {
    type: "session" as const,
    message: {
      type: "status" as const,
      payload: ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: info.serverId,
        ...(info.hostname ? { hostname: info.hostname } : {}),
        ...(info.version ? { version: info.version } : {}),
        features: { relayProtectedSecurity: true },
      }),
    },
  };
}

export async function sendProtectedServerInfo(
  socket: EncryptedRelaySocket,
  info: ProtectedServerInfo,
): Promise<void> {
  await socket.send(JSON.stringify(createProtectedServerInfo(info)));
}

export type ProtectedRelayOptions = Omit<RelayTransportOptions, "attachSocket"> & {
  keyPair: KeyPair;
  onSecured: (socket: EncryptedRelaySocket, metadata?: ExternalSocketMetadata) => void | Promise<void>;
};

/** Original outgoing relay control/data sockets, keepalive, reconnect and stop.
 * Every incoming data socket crosses the same protected ingress as a direct WS. */
export function startProtectedRelayTransport(options: ProtectedRelayOptions): RelayTransportController {
  const { keyPair, onSecured, ...relay } = options;
  return startRelayTransport({
    ...relay,
    attachSocket: (socket, metadata) => attachProtectedSocket(socket, {
      keyPair,
      logger: relay.logger,
    }, (secured) => onSecured(secured, metadata)),
  });
}

export function createProtectedConnectionOffer(
  options: Omit<Parameters<typeof createConnectionOfferV2>[0], "minimumSecurityMode">,
) {
  return createConnectionOfferV2({ ...options, minimumSecurityMode: "protected" });
}
