/**
 * Holds events until the owner attaches, so the owner can answer the subscribe request before
 * the first event goes out.
 */
export class BufferedPluginSubscription {
    sink = null;
    pending = [];
    ended = false;
    attach(sink) {
        if (this.sink)
            throw new Error("Plugin subscription is already attached");
        this.sink = sink;
        const pending = this.pending;
        this.pending = [];
        for (const entry of pending) {
            if (entry.type === "event")
                sink.event(entry.event);
            else
                sink.closed(entry.error);
        }
    }
    event(event) {
        if (this.ended)
            return;
        if (this.sink)
            this.sink.event(event);
        else
            this.pending.push({ type: "event", event });
    }
    closed(error) {
        if (this.ended)
            return;
        this.ended = true;
        if (this.sink)
            this.sink.closed(error);
        else
            this.pending.push({ type: "closed", ...(error === undefined ? {} : { error }) });
    }
    released() {
        this.ended = true;
        this.pending = [];
    }
}
