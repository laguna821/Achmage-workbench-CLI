/**
 * Endpoint security for relay-carried daemon sessions.
 *
 * This is the one entrypoint both endpoints use to secure a transport. It owns
 * the handshake, record protection, counters, retries, termination, and the
 * negotiated security mode. Relay adapters own routing and physical I/O;
 * daemon admission owns credentials and authorization.
 *
 * Two modes exist during migration:
 *
 * - "protected": conforming Noise_NK_25519_ChaChaPoly_SHA256 bound to the
 *   daemon's static key, with authenticated record framing. Handshake
 *   messages travel byte-exact (base64) inside the existing `e2ee_hello` /
 *   `e2ee_ready` JSON envelopes under `protected`.
 * - "legacy": the pre-existing ephemeral-static box construction in
 *   `encrypted-channel.ts`. It has no replay protection. Chosen only when the
 *   peer omits `protected` (an older peer) and policy allows it.
 *
 * A present but invalid `protected` field never falls back to legacy.
 *
 * See docs/relay-endpoint-security.md for the byte-level mapping.
 */
import { type EncryptedChannelEvents, type Transport } from "./encrypted-channel.js";
import { type KeyPair } from "./crypto.js";
export type SecurityMode = "legacy" | "protected";
export type SecureChannelEvents = EncryptedChannelEvents;
export interface SecureChannel {
    send(data: string | ArrayBuffer): Promise<void>;
    close(code?: number, reason?: string): void;
    isOpen(): boolean;
    securityMode(): SecurityMode;
    /** Bytes the transport will carry for `data`, including protection overhead. */
    outboundWireByteLength(data: string | ArrayBuffer): number;
    onTransitionToOpen(cb: () => void): void;
    onClose(cb: () => void): void;
}
export interface ClientSecureChannelOptions {
    daemonPublicKeyB64: string;
    /** Lowest mode this client accepts. "protected" refuses a daemon that only offers legacy. */
    minimumMode?: SecurityMode;
    events?: SecureChannelEvents;
}
export interface DaemonSecureChannelOptions {
    daemonKeyPair: KeyPair;
    /**
     * Lowest mode this daemon admits. "protected" refuses a client that only
     * offers legacy. A function is evaluated when the hello arrives so a policy
     * change applies to every admission from that moment on.
     */
    minimumMode?: SecurityMode | (() => SecurityMode);
    events?: SecureChannelEvents;
}
/** Thrown by {@link openDaemonSecureChannel} when the handshake is refused; carries the close to send. */
export declare class SecureChannelRejectedError extends Error {
    readonly closeCode: number;
    readonly closeReason: string;
    constructor(message: string, closeCode: number, closeReason: string);
}
export declare const PROTECTED_MODE_REQUIRED_CLOSE_CODE = 1008;
export declare const PROTECTED_MODE_REQUIRED_CLOSE_REASON = "protected endpoint security required";
/** Client-side close when a protected handshake fails. Browser-safe (4000-4999). */
export declare const PROTECTED_HANDSHAKE_FAILED_CLOSE_CODE = 4002;
/**
 * Client-side close when an inbound record fails authentication or framing.
 * Browser WebSocket.close accepts only 1000 or 3000-4999, so a client must
 * never try to send a 1011.
 */
export declare const PROTECTED_RECORD_FAILED_CLOSE_CODE = 4003;
/**
 * Secures a transport as the initiator. Resolves once the hello has been sent;
 * `events.onopen` fires when the channel is usable. Sends queued before open
 * are flushed in order after the handshake, capped at {@link MAX_PENDING_SENDS}.
 */
export declare function openClientSecureChannel(transport: Transport, options: ClientSecureChannelOptions): Promise<SecureChannel>;
/**
 * Secures a transport as the responder. Resolves once the peer's hello has
 * been accepted and the ready sent. Rejects with
 * {@link SecureChannelRejectedError} when policy refuses the peer, and with a
 * plain error for malformed or failed handshakes; the caller closes the socket.
 */
export declare function openDaemonSecureChannel(transport: Transport, options: DaemonSecureChannelOptions): Promise<SecureChannel>;
/**
 * Largest plaintext that fits in `wireBytes` as a base64 text frame in either
 * mode. Callers size payloads before the mode is known, so take the tighter bound.
 */
export declare function maxSecuredPlaintextByteLength(wireBytes: number): number;
