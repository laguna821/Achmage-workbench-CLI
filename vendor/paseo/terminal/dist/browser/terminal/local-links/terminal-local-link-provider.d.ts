import type { ILinkProvider, Terminal } from "@xterm/xterm";
export interface TerminalLocalFileLinkSource {
    text: string;
    path: string;
    lineStart?: number;
    lineEnd?: number;
}
export interface TerminalLocalFileLinkTarget {
    path: string;
    lineStart?: number;
    lineEnd?: number;
}
export interface TerminalLocalFileLinkProviderOptions {
    resolveLink: (source: TerminalLocalFileLinkSource) => Promise<TerminalLocalFileLinkTarget | null>;
    openLink: (target: TerminalLocalFileLinkTarget, disposition: "main" | "side", event: MouseEvent) => void;
}
export declare function createTerminalLocalFileLinkProvider(terminal: Terminal, options: TerminalLocalFileLinkProviderOptions): ILinkProvider;
