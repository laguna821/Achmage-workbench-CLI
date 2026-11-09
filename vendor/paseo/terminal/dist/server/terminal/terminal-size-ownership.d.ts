import type { TerminalSizePort as TerminalSession } from "../../ports.js";
interface TerminalSizeRequest {
    rows: number;
    cols: number;
    intent?: "claim" | "update";
}
export declare function applyTerminalSize(terminal: TerminalSession, owner: object, request: TerminalSizeRequest): boolean;
export {};
