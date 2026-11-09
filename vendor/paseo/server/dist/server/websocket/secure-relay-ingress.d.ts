import type pino from "pino";
import { type KeyPair, type SecurityMode } from "@getpaseo/relay/e2ee";
import { type EncryptedRelaySocket } from "./encrypted-relay-socket.js";
export interface RelayIngressSocket {
    readyState: number;
    bufferedAmount?: number;
    send: (data: string | Uint8Array | ArrayBuffer, callback?: (error?: Error) => void) => void;
    close: (code?: number, reason?: string) => void;
    terminate: () => void;
    on: (event: "message" | "close" | "error", listener: (...args: unknown[]) => void) => void;
}
export interface SecuredRelaySocket {
    socket: EncryptedRelaySocket;
    securityMode: SecurityMode;
}
export interface SecureRelayIngressOptions {
    daemonKeyPair: KeyPair;
    logger: pino.Logger;
    /**
     * Current policy, read when the peer's hello arrives so a flag flipped at
     * runtime applies to every admission from that moment on.
     */
    requireProtectedMode: () => boolean;
}
/**
 * Secures `socket` and admits it through `attach`. Messages the peer sends
 * before `attach` resolves are delivered once it has.
 *
 * A peer that never completes the handshake is terminated after
 * {@link HANDSHAKE_TIMEOUT_MS}; a failed handshake closes the socket.
 */
export declare function admitSecuredRelaySocket(socket: RelayIngressSocket, options: SecureRelayIngressOptions, attach: (secured: SecuredRelaySocket) => Promise<void>): Promise<void>;
