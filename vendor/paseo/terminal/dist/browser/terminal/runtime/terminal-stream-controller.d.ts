import type { TerminalClientPort as DaemonClient } from "../../../ports.js";
import type { SubscribeTerminalRequest } from "../../../ports.js";
import type { TerminalOutputData } from "./terminal-emulator-runtime.js";
export type TerminalStreamControllerClient = Pick<DaemonClient, "observeTerminal" | "sendTerminalInput">;
export interface TerminalStreamControllerSize {
    rows: number;
    cols: number;
}
export interface TerminalStreamControllerStatus {
    terminalId: string | null;
    isAttaching: boolean;
    error: string | null;
}
export interface TerminalStreamControllerOptions {
    client: TerminalStreamControllerClient;
    getPreferredSize: () => TerminalStreamControllerSize | null;
    onOutput: (input: {
        terminalId: string;
        data: TerminalOutputData;
    }) => void;
    onExit?: (terminalId: string) => void;
    onReplay?: (input: {
        terminalId: string;
        replay: import("../../../ports.js").TerminalReplayEvent;
    }) => void;
    getRestoreOptions?: () => SubscribeTerminalRequest["restore"] | undefined;
    onStatusChange?: (status: TerminalStreamControllerStatus) => void;
}
export declare class TerminalStreamController {
    private readonly options;
    private subscription;
    private terminalId;
    private disposed;
    constructor(options: TerminalStreamControllerOptions);
    private receive;
    setTerminal(input: {
        terminalId: string | null;
    }): void;
    private failAttach;
    handleTerminalExit(input: {
        terminalId: string;
    }): void;
    dispose(): void;
}
