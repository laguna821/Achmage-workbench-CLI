import { CipherState } from "./cipher-state.js";
export declare class SymmetricState {
    readonly cipher: CipherState;
    private ck;
    private h;
    constructor(protocolName: string);
    mixKey(inputKeyMaterial: Uint8Array): void;
    mixHash(data: Uint8Array): void;
    handshakeHash(): Uint8Array;
    encryptAndHash(plaintext: Uint8Array): Uint8Array;
    decryptAndHash(ciphertext: Uint8Array): Uint8Array;
    split(): [CipherState, CipherState];
}
export declare function concat(...parts: Uint8Array[]): Uint8Array;
