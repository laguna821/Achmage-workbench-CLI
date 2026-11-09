import {
  createRelayE2eeTransportFactory,
  createRelayUpgradeTransportFactory,
} from "@getpaseo/client/internal/daemon-client-relay-e2ee-transport";
import {
  createWebSocketTransportFactory,
  defaultWebSocketFactory,
} from "@getpaseo/client/internal/daemon-client-websocket-transport";
import type {
  DaemonTransport,
  DaemonTransportFactory,
  TransportLogger,
  WebSocketFactory,
} from "@getpaseo/client/internal/daemon-client-transport-types";
import type { SecurityMode } from "@getpaseo/relay/e2ee";

export type { DaemonTransport, DaemonTransportFactory, TransportLogger, WebSocketFactory };
export {
  describeEndpointSecurityClose,
} from "@getpaseo/client/internal/daemon-client-relay-e2ee-transport";
export {
  decodeMessageData,
  describeTransportClose,
  describeTransportError,
} from "@getpaseo/client/internal/daemon-client-transport-utils";
export { paseoReconnectDelay } from "@getpaseo/client/internal/compat/reconnect-delay";
export {
  ConnectionOfferSchema,
  decodeOfferFragmentPayload,
  parseConnectionOfferFromUrl,
  type ConnectionOffer,
} from "@getpaseo/protocol/connection-offer";
export {
  buildRelayWebSocketUrl,
  parseRelayConnectionUri,
  serializeRelayConnectionUri,
} from "@getpaseo/protocol/daemon-endpoints";

const quietLogger: TransportLogger = { warn: () => {} };

export interface ProtectedTransportOptions {
  daemonPublicKeyB64: string;
  logger?: TransportLogger;
  webSocketFactory?: WebSocketFactory;
  onSecurityMode?: (mode: SecurityMode) => void;
}

/** Original WebSocket drain handling and secure transport; credentials belong
 * in encrypted Workbench messages, never relay upgrade headers or subprotocols.
 * onOpen means the protected channel opened, not that a device is authorized. */
export function createProtectedTransportFactory(options: ProtectedTransportOptions): DaemonTransportFactory {
  const websocket = createWebSocketTransportFactory(options.webSocketFactory ?? defaultWebSocketFactory);
  return createRelayE2eeTransportFactory({
    baseFactory: createRelayUpgradeTransportFactory(websocket),
    daemonPublicKeyB64: options.daemonPublicKeyB64,
    minimumMode: "protected",
    logger: options.logger ?? quietLogger,
    onSecurityMode: options.onSecurityMode,
  });
}

export interface OpenProtectedTransportOptions extends ProtectedTransportOptions {
  url: string;
  onOpen?: () => void;
  onMessage?: Parameters<DaemonTransport["onMessage"]>[0];
  onClose?: Parameters<DaemonTransport["onClose"]>[0];
  onError?: Parameters<DaemonTransport["onError"]>[0];
}

/** Workbench's RPC/reconnection owner consumes the original transport events.
 * The original E2EE adapter checks server_info; this does not instantiate the
 * full Paseo DaemonClient or claim compatibility with its application protocol. */
export function openProtectedTransport(options: OpenProtectedTransportOptions): DaemonTransport {
  const transport = createProtectedTransportFactory(options)({ url: options.url });
  if (options.onOpen) transport.onOpen(options.onOpen);
  if (options.onMessage) transport.onMessage(options.onMessage);
  if (options.onClose) transport.onClose(options.onClose);
  if (options.onError) transport.onError(options.onError);
  return transport;
}
