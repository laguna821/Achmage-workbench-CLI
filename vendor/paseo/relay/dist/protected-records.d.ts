/**
 * Authenticated application-frame framing over Noise transport messages.
 *
 * One application frame becomes one wire record. Every Noise transport message
 * (chunk) carries, inside its authenticated plaintext, the frame kind, FIRST
 * and FINAL flags, and the total frame length, so a relay cannot merge two
 * records, split one across WebSocket messages, truncate a final chunk, or
 * re-chunk a frame without an authentication failure or a framing violation.
 * Transport AD is always empty, as in Noise §5.
 *
 *   chunk plaintext = kind(1) || flags(1) || totalLength(u32 BE) || data
 *   wire record     = for each chunk: ciphertextLength(u16 BE) || ciphertext
 */
import { CipherState } from "./noise/index.js";
export type FrameKind = "text" | "binary";
/** Largest data payload a single chunk carries. */
export declare const MAX_CHUNK_DATA_BYTES: number;
/** Largest application frame a record may carry; bounds allocation before decryption. */
export declare const MAX_FRAME_BYTES = 4294967295;
export declare function chunkCount(frameBytes: number): number;
/** Wire bytes a frame of `frameBytes` occupies once protected. */
export declare function protectedRecordByteLength(frameBytes: number): number;
export declare function encodeProtectedRecord(kind: FrameKind, frame: Uint8Array, sender: CipherState): Uint8Array;
export interface DecodedFrame {
    kind: FrameKind;
    data: Uint8Array;
}
/**
 * Decodes one wire record. Chunks are authenticated in order and the receive
 * counter advances per authenticated chunk; any framing violation throws and
 * nothing partial is returned. The caller must close the channel on error.
 */
export declare function decodeProtectedRecord(record: Uint8Array, receiver: CipherState): DecodedFrame;
