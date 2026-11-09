import type { Terminal } from "@xterm/headless";
export declare function attachTerminalQueryHandlers(terminal: Terminal, ptyProcess: {
    write(data: string): void;
}): void;
