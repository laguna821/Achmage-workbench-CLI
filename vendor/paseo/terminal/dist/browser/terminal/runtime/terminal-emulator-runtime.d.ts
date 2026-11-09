import { Terminal, type ITheme } from "@xterm/xterm";
import type { TerminalCharacterWidths } from "../character-widths.js";
import { type TerminalInputModeState } from "@getpaseo/protocol/terminal-input-mode";
import { type PendingTerminalModifiers } from "../../utils/terminal-keys.js";
import { type TerminalLocalFileLinkSource, type TerminalLocalFileLinkTarget } from "../local-links/terminal-local-link-provider.js";
import { type FindShortcutPlatform } from "../../pane-find/find-shortcut.js";
import { type TerminalFile } from "../file-paste/index.js";
export type TerminalOutputData = Uint8Array;
export interface TerminalFindHandle {
    setWidgetSize(size: {
        width: number;
        height: number;
    }): void;
    search(query: string, direction?: "next" | "previous", options?: {
        regex?: boolean;
        caseSensitive?: boolean;
    }): void;
    clear(): void;
}
export interface TerminalFindResult {
    resultIndex: number;
    resultCount: number;
    limited: boolean;
    placement: "top" | "bottom";
}
export interface TerminalEmulatorRuntimeMountInput {
    root: HTMLDivElement;
    host: HTMLDivElement;
    scrollback: number;
    theme: ITheme;
    fontFamily?: string;
    fontSize?: number;
    /** Workbench embeds several panes in one document. */
    embedded?: boolean;
}
export interface TerminalEmulatorRuntimeCallbacks {
    onFindRequest?: () => void;
    onFindResult?: (result: TerminalFindResult) => void;
    onInput?: (data: string) => Promise<void> | void;
    onResize?: (input: TerminalResizeEvent) => Promise<void> | void;
    onTerminalKey?: (input: {
        key: string;
        ctrl: boolean;
        shift: boolean;
        alt: boolean;
        meta: boolean;
    }) => Promise<void> | void;
    onPendingModifiersConsumed?: () => Promise<void> | void;
    onOpenExternalUrl?: (url: string) => Promise<void> | void;
    onResolveLocalFileLink?: (source: TerminalLocalFileLinkSource) => Promise<TerminalLocalFileLinkTarget | null> | TerminalLocalFileLinkTarget | null;
    onOpenLocalFileLink?: (target: TerminalLocalFileLinkTarget, disposition: "main" | "side") => Promise<void> | void;
    onInputModeChange?: (state: TerminalInputModeState) => Promise<void> | void;
    /** A paste gesture that can carry a file; resolves to null when it carried none. */
    onFilePaste?: (file: Promise<TerminalFile | null>) => void;
}
export interface TerminalResizeEvent {
    rows: number;
    cols: number;
    shouldClaim: boolean;
    forceClaim?: boolean;
}
export interface TerminalResizeRequest {
    forceRefresh?: boolean;
    shouldClaim?: boolean;
    forceClaim?: boolean;
}
export declare function createTerminalResizeEvent(input: {
    rows: number;
    cols: number;
    shouldClaim: boolean;
    forceClaim: boolean;
}): TerminalResizeEvent;
declare global {
    interface Window {
        __paseoTerminal?: Terminal;
    }
}
export declare function encodeTerminalOutput(text: string): TerminalOutputData;
export interface TerminalClipboard {
    /** Whether the async Clipboard API is usable. Browsers omit it outside secure contexts. */
    isAvailable?(): boolean;
    readText(): Promise<string>;
    read(): Promise<readonly Pick<ClipboardItem, "types" | "getType">[]>;
    writeText(text: string): Promise<void>;
}
export declare class TerminalEmulatorRuntime {
    private readonly options;
    private readonly clipboard;
    constructor(options?: FindShortcutPlatform, clipboard?: TerminalClipboard);
    private callbacks;
    private pendingModifiers;
    private characterWidths;
    private terminal;
    private fitAddon;
    private searchAddon;
    private findResult;
    private findQuery;
    private findOutputAnchor;
    private findWidgetSize;
    readonly find: TerminalFindHandle;
    private replayResize;
    private fitAndEmitResize;
    private lastSize;
    private cleanup;
    private outputOperations;
    private inFlightOutputOperation;
    private inFlightOutputOperationTimeout;
    private pendingWriteCommits;
    private hasUngatedWrites;
    private readonly inputModeDecoder;
    private suppressInput;
    private readonly inputModeTracker;
    private lastInputModeState;
    private themeBackgroundElements;
    private handleVisibilityRestore;
    /** Workbench pane state, selection and accessibility adapter. */
    getTerminal(): Terminal | null;
    setCallbacks(input: {
        callbacks: TerminalEmulatorRuntimeCallbacks;
    }): void;
    setPendingModifiers(input: {
        pendingModifiers: PendingTerminalModifiers;
    }): void;
    setCharacterWidths(input: {
        widths: TerminalCharacterWidths;
    }): void;
    private loadSearchAddon;
    private releaseFindOutputAnchor;
    private preserveFindViewport;
    attachKeyEventHandler(terminal: Pick<Terminal, "attachCustomKeyEventHandler" | "hasSelection" | "getSelection" | "paste" | "input" | "scrollToBottom">): void;
    /** Returns true when a non-Mac Ctrl+C / Ctrl+V clipboard shortcut was handled. */
    private handleCtrlClipboardShortcut;
    private handleFindShortcut;
    private findWidgetCoversSelection;
    private emitFindResult;
    getInputModeState(): TerminalInputModeState;
    private maybeSendMacEditingShortcut;
    mount(input: TerminalEmulatorRuntimeMountInput): void;
    write(input: {
        data: TerminalOutputData;
        suppressInput?: boolean;
        onCommitted?: () => void;
    }): void;
    clear(input?: {
        onCommitted?: () => void;
    }): void;
    paste(text: string): void;
    private pasteClipboard;
    replay(event: import("../../../ports.js").TerminalReplayEvent, onCommitted?: () => void): void;
    private restoreOutput;
    private deferReplayResize;
    resize(input?: TerminalResizeRequest): void;
    setTheme(input: {
        theme: ITheme;
    }): void;
    setScrollback(input: {
        lines: number;
    }): void;
    setFont(input: {
        fontFamily?: string;
        fontSize?: number;
    }): void;
    focus(input?: {
        forceRefocus?: boolean;
    }): void;
    blur(): void;
    private refreshVisibleRows;
    private collectThemeBackgroundElements;
    private applyThemeBackground;
    unmount(): void;
    private isBarrierOperation;
    private processOutputQueue;
    private submitWrite;
    private startBarrierOperation;
    private clearInFlightOutputTimeout;
    private emitInputModeChange;
    private applyDocumentBoundsStyles;
    private applyViewportTouchStyles;
}
