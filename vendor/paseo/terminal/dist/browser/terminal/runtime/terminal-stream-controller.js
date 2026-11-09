import { i18n } from "../../../ports.js";
const TERMINAL_EXITED_ERROR = "Terminal exited";
export class TerminalStreamController {
    options;
    subscription = null;
    terminalId = null;
    disposed = false;
    constructor(options) {
        this.options = options;
    }
    receive = (event) => {
        if (this.disposed || event.terminalId !== this.terminalId) {
            return;
        }
        if (event.type === "replay") {
            this.options.onReplay?.({ terminalId: event.terminalId, replay: event.replay });
            return;
        }
        if (event.type === "output" && event.data.length > 0) {
            this.options.onOutput({ terminalId: event.terminalId, data: event.data });
        }
    };
    setTerminal(input) {
        if (this.disposed || input.terminalId === this.terminalId) {
            return;
        }
        const nextTerminalId = input.terminalId;
        this.terminalId = nextTerminalId;
        void this.subscription?.release().catch(console.error);
        this.subscription = null;
        if (!nextTerminalId) {
            this.options.onStatusChange?.({ terminalId: null, isAttaching: false, error: null });
            return;
        }
        this.options.onStatusChange?.({ terminalId: nextTerminalId, isAttaching: true, error: null });
        let subscription;
        try {
            const restore = this.options.getRestoreOptions?.();
            const preferredSize = restore?.size ?? this.options.getPreferredSize();
            if (preferredSize)
                this.options.client.sendTerminalInput(nextTerminalId, {
                    type: "resize",
                    ...preferredSize,
                    intent: "claim",
                });
            subscription = this.options.client.observeTerminal(nextTerminalId, this.receive, restore ? { restore } : undefined);
        }
        catch (error) {
            this.failAttach(nextTerminalId, error);
            return;
        }
        this.subscription = subscription;
        subscription.subscribe({
            snapshot: () => { },
            update: (message) => {
                if (message.type !== "terminal_stream_exit" || this.subscription !== subscription)
                    return;
                if (message.payload.error)
                    this.failAttach(nextTerminalId, new Error(message.payload.error));
                else
                    this.handleTerminalExit({ terminalId: nextTerminalId });
            },
        });
        void subscription.ready
            .then((payload) => {
            if (this.disposed || this.subscription !== subscription) {
                return;
            }
            if (payload.error) {
                this.terminalId = null;
                this.options.onStatusChange?.({
                    terminalId: nextTerminalId,
                    isAttaching: false,
                    error: payload.error,
                });
                return;
            }
            this.options.onStatusChange?.({
                terminalId: nextTerminalId,
                isAttaching: false,
                error: null,
            });
            return;
        })
            .catch((error) => {
            if (this.disposed || this.subscription !== subscription) {
                return;
            }
            this.failAttach(nextTerminalId, error);
        });
    }
    failAttach(terminalId, error) {
        this.terminalId = null;
        void this.subscription?.release().catch(console.error);
        this.subscription = null;
        this.options.onStatusChange?.({
            terminalId,
            isAttaching: false,
            error: error instanceof Error ? error.message : i18n.t("workspace.terminal.unableToSubscribe"),
        });
    }
    handleTerminalExit(input) {
        if (this.disposed || input.terminalId !== this.terminalId) {
            return;
        }
        this.options.onExit?.(input.terminalId);
        this.terminalId = null;
        void this.subscription?.release().catch(console.error);
        this.subscription = null;
        this.options.onStatusChange?.({
            terminalId: input.terminalId,
            isAttaching: false,
            error: TERMINAL_EXITED_ERROR,
        });
    }
    dispose() {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.terminalId = null;
        void this.subscription?.release().catch(console.error);
        this.subscription = null;
        this.options.onStatusChange?.({ terminalId: null, isAttaching: false, error: null });
    }
}
