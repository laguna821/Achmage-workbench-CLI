/** File bytes from a paste or drop gesture, before they become a file on the host. */
export interface TerminalFile {
    fileName: string;
    mimeType: string;
    bytes: Uint8Array;
}
/** A file over the upload limit; the pane words it for the user. */
export declare class TerminalFileTooLargeError extends Error {
    readonly fileName: string;
    constructor(fileName: string);
}
/** The pane's host and terminal: where a file is stored and where its path is pasted. */
export interface TerminalFilePasteTarget {
    /** Stores the file on the host and returns its host path. */
    upload(file: TerminalFile): Promise<string>;
    paste(text: string): void;
}
interface TerminalFilePasteEvents {
    onUploadingChange(uploading: boolean): void;
    onUploaded(): void;
    onFailure(error: unknown): void;
}
/**
 * Turns a pane's file gestures into pasted host paths, one at a time and in
 * gesture order. Ordinary input never waits on it.
 */
export declare class TerminalFilePasteQueue {
    private readonly events;
    private tail;
    private generation;
    private pending;
    private uploading;
    constructor(events: TerminalFilePasteEvents);
    /** Queues a gesture. `file` resolves to null when the gesture carried no file. */
    add(file: Promise<TerminalFile | null>, target: TerminalFilePasteTarget): void;
    /** Drops queued and in-flight gestures. Returns whether any were dropped. */
    cancel(): boolean;
    private paste;
    private setUploading;
}
export declare function readTerminalFile(file: File): Promise<TerminalFile>;
export declare function terminalFileFromBase64(input: {
    fileName: string;
    mimeType: string;
    data: string;
}): TerminalFile;
/** File extension for a clipboard image, which arrives as bytes with only a MIME type. */
export declare function imageExtension(mimeType: string): string;
export {};
