/** Noise spec §5.1 CipherState for ChaChaPoly. Nonce is 4 zero bytes then 64-bit little-endian n. */
export declare const NOISE_TAG_BYTES = 16;
export declare const NOISE_MAX_MESSAGE_BYTES = 65535;
export declare class NoiseProtocolError extends Error {
    constructor(message: string);
}
export declare class CipherState {
    private k;
    private n;
    initializeKey(key: Uint8Array | null, nonce?: bigint): void;
    hasKey(): boolean;
    nonce(): bigint;
    encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array;
    decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array;
    /** Reserves the next nonce synchronously so concurrent senders never share one. */
    private takeNonce;
    clear(): void;
}
