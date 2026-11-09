import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
/** Noise spec §5.1 CipherState for ChaChaPoly. Nonce is 4 zero bytes then 64-bit little-endian n. */
export const NOISE_TAG_BYTES = 16;
export const NOISE_MAX_MESSAGE_BYTES = 65535;
const MAX_NONCE = (1n << 64n) - 1n;
export class NoiseProtocolError extends Error {
    constructor(message) {
        super(message);
        this.name = "NoiseProtocolError";
    }
}
export class CipherState {
    constructor() {
        this.k = null;
        this.n = 0n;
    }
    initializeKey(key, nonce = 0n) {
        this.k = key;
        this.n = nonce;
    }
    hasKey() {
        return this.k !== null;
    }
    nonce() {
        return this.n;
    }
    encryptWithAd(ad, plaintext) {
        if (this.k === null)
            return plaintext;
        const nonce = this.takeNonce();
        return chacha20poly1305(this.k, nonce, ad).encrypt(plaintext);
    }
    decryptWithAd(ad, ciphertext) {
        if (this.k === null)
            return ciphertext;
        if (this.n === MAX_NONCE)
            throw new NoiseProtocolError("nonce exhausted");
        let plaintext;
        try {
            plaintext = chacha20poly1305(this.k, encodeNonce(this.n), ad).decrypt(ciphertext);
        }
        catch {
            throw new NoiseProtocolError("authentication failed");
        }
        // Only a successful authentication advances the receive counter.
        this.n += 1n;
        return plaintext;
    }
    /** Reserves the next nonce synchronously so concurrent senders never share one. */
    takeNonce() {
        if (this.n === MAX_NONCE)
            throw new NoiseProtocolError("nonce exhausted");
        const nonce = encodeNonce(this.n);
        this.n += 1n;
        return nonce;
    }
    clear() {
        this.k?.fill(0);
        this.k = null;
        this.n = MAX_NONCE;
    }
}
function encodeNonce(n) {
    const nonce = new Uint8Array(12);
    let value = n;
    for (let i = 4; i < 12; i += 1) {
        nonce[i] = Number(value & 0xffn);
        value >>= 8n;
    }
    return nonce;
}
