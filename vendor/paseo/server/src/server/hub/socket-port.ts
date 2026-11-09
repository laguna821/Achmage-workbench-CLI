// Type-only extraction from the pinned websocket-server.ts.
export interface WebSocketLike {
  maxFrameBytes?: number;
  supportsConcurrentWrites?: boolean;
  readyState: number;
  bufferedAmount?: number;
  send: (
    data: string | Uint8Array | ArrayBuffer,
    callback?: (error?: Error) => void,
  ) => void | Promise<void>;
  close: (code?: number, reason?: string) => void;
  terminate?: () => void;
  on: (event: "message" | "close" | "error", listener: (...args: unknown[]) => void) => void;
  once: (event: "close" | "error", listener: (...args: unknown[]) => void) => void;
}

