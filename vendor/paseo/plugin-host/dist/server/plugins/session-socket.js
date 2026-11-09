import { Buffer } from "node:buffer";
function normalizeBinaryFrame(data) {
    if (data instanceof Uint8Array) {
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    return new Uint8Array(data);
}
function frameByteLength(data) {
    return typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
}
export class PluginSessionSocket {
    child;
    readyState = 1;
    bufferedAmount = 0;
    listeners = new Map();
    onceListeners = new Map();
    constructor(child) {
        this.child = child;
    }
    send(data, callback) {
        if (this.readyState !== 1) {
            callback?.(new Error("Plugin session socket is closed"));
            return;
        }
        const frame = typeof data === "string" ? data : normalizeBinaryFrame(data);
        const byteLength = frameByteLength(frame);
        this.bufferedAmount += byteLength;
        try {
            this.child.send({ type: "paseo_frame", data: frame, isBinary: typeof frame !== "string" }, (error) => {
                this.bufferedAmount = Math.max(0, this.bufferedAmount - byteLength);
                callback?.(error ?? undefined);
            });
        }
        catch (error) {
            this.bufferedAmount = Math.max(0, this.bufferedAmount - byteLength);
            callback?.(error instanceof Error ? error : new Error(String(error)));
        }
    }
    receive(data, isBinary) {
        if (this.readyState !== 1)
            return;
        this.emit("message", data, isBinary);
    }
    close(code, reason) {
        if (this.readyState === 3)
            return;
        this.readyState = 3;
        try {
            this.child.send({ type: "paseo_close" });
        }
        catch {
            // The child has already gone; local session cleanup still has to run.
        }
        this.emit("close", code, reason);
    }
    peerClosed() {
        if (this.readyState === 3)
            return;
        this.readyState = 3;
        this.emit("close");
    }
    on(event, listener) {
        const listeners = this.listeners.get(event) ?? new Set();
        listeners.add(listener);
        this.listeners.set(event, listeners);
    }
    once(event, listener) {
        const listeners = this.onceListeners.get(event) ?? new Set();
        listeners.add(listener);
        this.onceListeners.set(event, listeners);
    }
    emit(event, ...args) {
        for (const listener of this.listeners.get(event) ?? [])
            listener(...args);
        const once = this.onceListeners.get(event);
        if (!once)
            return;
        this.onceListeners.delete(event);
        for (const listener of once)
            listener(...args);
    }
}
