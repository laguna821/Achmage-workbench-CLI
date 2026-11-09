import type { Terminal as TerminalType } from "@xterm/headless";
import type { TerminalReplayOptions } from "../../ports.js";
/** Serialize the owned model; the PTY is a transport, not an ANSI parser oracle. */
export declare function createTerminalSerializer(terminal: TerminalType): (options?: TerminalReplayOptions) => Uint8Array;
