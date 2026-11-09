/** Receives a plugin subscription's events once its owner attached. */
export interface PluginSubscriptionSink {
    event(event: unknown): void;
    /** The plugin ended the subscription, or stopped. Not called after `release()`. */
    closed(error?: string): void;
}
/** A started plugin subscription, from the daemon's side of the subprocess. */
export interface PluginRuntimeSubscription {
    /** Resolves when the plugin acknowledged; rejects when it refused. */
    readonly ready: Promise<void>;
    /** Delivers what arrived so far, then everything that follows. */
    attach(sink: PluginSubscriptionSink): void;
    release(): void;
}
/**
 * Holds events until the owner attaches, so the owner can answer the subscribe request before
 * the first event goes out.
 */
export declare class BufferedPluginSubscription {
    private sink;
    private pending;
    private ended;
    attach(sink: PluginSubscriptionSink): void;
    event(event: unknown): void;
    closed(error?: string): void;
    released(): void;
}
