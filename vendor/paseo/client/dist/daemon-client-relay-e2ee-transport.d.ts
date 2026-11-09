import { type SecurityMode } from "@getpaseo/relay/e2ee";
import type { DaemonTransport, DaemonTransportFactory, TransportLogger } from "./daemon-client-transport-types.js";
export interface RelayE2eeTransportOptions {
    daemonPublicKeyB64: string;
    logger: TransportLogger;
    assertOutboundCapacity?: (wireBytes: number) => void;
    /** Refuse to open unless the daemon negotiates at least this endpoint security mode. */
    minimumMode?: SecurityMode;
    /** Reports the negotiated mode once the daemon has authenticated the handshake. */
    onSecurityMode?: (mode: SecurityMode) => void;
}
export declare function createRelayE2eeTransportFactory(args: RelayE2eeTransportOptions & {
    baseFactory: DaemonTransportFactory;
}): DaemonTransportFactory;
/**
 * Returns a user-facing message when this client closed the session itself
 * because endpoint security could not be established, so reconnecting cannot help.
 *
 * The daemon's own policy close never reaches the client: both relays replace a
 * daemon-side close with their own code (1012 on the wrangler relay).
 */
export declare function describeEndpointSecurityClose(event: unknown): string | null;
/**
 * Relay upgrades carry routing only. Daemon credentials and subprotocols must
 * never reach the relay; they travel inside the encrypted hello.
 */
export declare function createRelayUpgradeTransportFactory(baseFactory: DaemonTransportFactory): DaemonTransportFactory;
export declare function createEncryptedTransport(base: DaemonTransport, options: RelayE2eeTransportOptions): DaemonTransport;
