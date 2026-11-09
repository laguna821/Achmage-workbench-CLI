type Frame = string | Uint8Array;
/** A malformed wire frame, distinct from a consumer delivery failure. */
export declare class ChunkedTransportProtocolError extends Error {
}
/** Connection-scoped ordered framing, below serialization and routing, above encryption. */
export declare class ChunkedTransport {
    private readonly io;
    enabled: boolean;
    private assembly;
    private size;
    private kind;
    private closed;
    private pending;
    private queuedBytes;
    private activeBytes;
    constructor(io: {
        frameBytes: number;
        supportsDrain?: boolean;
        /** Writes are admitted synchronously in order; promises track only their drain. */
        supportsConcurrentWrites?: boolean;
        send: (frame: Frame, waitForDrain: boolean) => void | Promise<void>;
        deliver: (frame: Frame) => void;
        onActivity?: () => void;
        onFailure?: (error: unknown) => void;
    });
    /** Bytes waiting behind the active write; physical buffering owns the active frame. */
    get queuedByteLength(): number;
    get isWriting(): boolean;
    send(frame: Frame, options?: {
        waitForDrain?: boolean;
        byteLength?: number;
    }): Promise<void>;
    private sendChunks;
    receive(frame: Frame): void;
    private assemble;
    private fail;
    close(): void;
}
export {};
