export interface TerminalParsedLink {
    path: TerminalLinkPartialRange;
    prefix?: TerminalLinkPartialRange;
    suffix?: TerminalLinkSuffix;
}
export interface TerminalLinkSuffix {
    row: number | undefined;
    col: number | undefined;
    rowEnd: number | undefined;
    colEnd: number | undefined;
    suffix: TerminalLinkPartialRange;
}
export interface TerminalLinkPartialRange {
    index: number;
    text: string;
}
export declare function getTerminalLinkSuffix(link: string): TerminalLinkSuffix | null;
export declare function detectTerminalLocalLinks(line: string): TerminalParsedLink[];
