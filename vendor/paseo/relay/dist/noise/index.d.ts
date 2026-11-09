import { CipherState } from "./cipher-state.js";
export { CipherState, NoiseProtocolError, NOISE_MAX_MESSAGE_BYTES, NOISE_TAG_BYTES, } from "./cipher-state.js";
export declare const NOISE_NK_PROTOCOL_NAME = "Noise_NK_25519_ChaChaPoly_SHA256";
export declare const DH_BYTES = 32;
export interface NoiseKeyPair {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
}
export interface NoiseInitiatorOptions {
    /** Responder's static public key, trusted out of band. */
    remoteStatic: Uint8Array;
    prologue: Uint8Array;
    /** Test injection only; production generates a fresh ephemeral. */
    ephemeral?: NoiseKeyPair;
}
export interface NoiseResponderOptions {
    localStatic: NoiseKeyPair;
    prologue: Uint8Array;
    /** Test injection only; production generates a fresh ephemeral. */
    ephemeral?: NoiseKeyPair;
}
export interface TransportKeys {
    /** Initiator → responder. */
    send: CipherState;
    /** Responder → initiator. */
    receive: CipherState;
}
export interface NoiseHandshake {
    /** Builds the next handshake message this side is due to write. */
    writeMessage(payload: Uint8Array): Uint8Array;
    /** Consumes the next handshake message this side is due to read; returns its payload. */
    readMessage(message: Uint8Array): Uint8Array;
    /** True once both handshake messages have been processed. */
    isComplete(): boolean;
    handshakeHash(): Uint8Array;
    /** Derives transport keys, oriented for this side. Ends the handshake state. */
    split(): {
        send: CipherState;
        receive: CipherState;
    };
}
export declare function generateNoiseKeyPair(): NoiseKeyPair;
export declare function createNoiseInitiator(options: NoiseInitiatorOptions): NoiseHandshake;
export declare function createNoiseResponder(options: NoiseResponderOptions): NoiseHandshake;
