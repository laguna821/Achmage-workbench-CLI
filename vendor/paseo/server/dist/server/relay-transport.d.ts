import type pino from "pino";
import type { ExternalSocketMetadata } from "./socket-metadata.js";
export interface RelayTransportOptions {
    logger: pino.Logger;
    attachSocket: (ws: RelaySocketLike, metadata?: ExternalSocketMetadata) => Promise<void>;
    relayEndpoint: string;
    relayUseTls: boolean;
    serverId: string;
    createWebSocket?: RelayWebSocketFactory;
}
export interface RelayTransportController {
    stop: () => Promise<void>;
}
export interface RelaySocketLike {
    readyState: number;
    bufferedAmount?: number;
    send: (data: string | Uint8Array | ArrayBuffer, callback?: (error?: Error) => void) => void;
    close: (code?: number, reason?: string) => void;
    terminate: () => void;
    on: (event: "message" | "close" | "error", listener: (...args: unknown[]) => void) => void;
    once: (event: "close" | "error", listener: (...args: unknown[]) => void) => void;
}
interface RelayWebSocketLike extends RelaySocketLike {
    ping: () => void;
    on: (event: "open" | "message" | "close" | "error" | "pong", listener: (...args: unknown[]) => void) => void;
}
type RelayWebSocketFactory = (url: string) => RelayWebSocketLike;
export declare function startRelayTransport({ logger, attachSocket, relayEndpoint, relayUseTls, serverId, createWebSocket, }: RelayTransportOptions): RelayTransportController;
export {};
