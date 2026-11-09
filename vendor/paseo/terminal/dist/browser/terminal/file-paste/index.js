import { FILE_UPLOAD_MAX_BYTES } from "../../attachments/upload-limit.js";
import { prepareTerminalPath } from "../drop/terminal-path.js";
/** A file over the upload limit; the pane words it for the user. */
export class TerminalFileTooLargeError extends Error {
    fileName;
    constructor(fileName) {
        super(`${fileName} exceeds the upload limit`);
        this.fileName = fileName;
    }
}
/**
 * Turns a pane's file gestures into pasted host paths, one at a time and in
 * gesture order. Ordinary input never waits on it.
 */
export class TerminalFilePasteQueue {
    events;
    tail = Promise.resolve();
    generation = 0;
    pending = 0;
    uploading = false;
    constructor(events) {
        this.events = events;
    }
    /** Queues a gesture. `file` resolves to null when the gesture carried no file. */
    add(file, target) {
        const generation = this.generation;
        this.pending += 1;
        this.tail = this.tail.then(() => this.paste(file, target, generation));
    }
    /** Drops queued and in-flight gestures. Returns whether any were dropped. */
    cancel() {
        const dropped = this.pending > 0;
        this.generation += 1;
        this.pending = 0;
        // A cancelled upload can stay unsettled until its connection resolves.
        this.tail = Promise.resolve();
        this.setUploading(false);
        return dropped;
    }
    async paste(read, target, generation) {
        const isCurrent = () => generation === this.generation;
        try {
            const file = await read;
            if (!file || !isCurrent()) {
                return;
            }
            if (file.bytes.byteLength > FILE_UPLOAD_MAX_BYTES) {
                throw new TerminalFileTooLargeError(file.fileName);
            }
            this.setUploading(true);
            const path = await target.upload({ ...file, fileName: toShellSafeFileName(file.fileName) });
            if (isCurrent()) {
                target.paste(`${prepareTerminalPath(path)} `);
                this.events.onUploaded();
            }
        }
        catch (error) {
            if (isCurrent()) {
                this.events.onFailure(error);
            }
        }
        finally {
            if (isCurrent()) {
                this.pending -= 1;
                this.setUploading(false);
            }
        }
    }
    setUploading(uploading) {
        if (this.uploading === uploading) {
            return;
        }
        this.uploading = uploading;
        this.events.onUploadingChange(uploading);
    }
}
// The host path is pasted into a shell or TUI; keep its last segment unquotable.
function toShellSafeFileName(fileName) {
    return fileName.replace(/[^\w.-]/g, "_");
}
export async function readTerminalFile(file) {
    return {
        fileName: file.name,
        mimeType: file.type,
        bytes: new Uint8Array(await file.arrayBuffer()),
    };
}
export function terminalFileFromBase64(input) {
    const binary = atob(input.data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return { fileName: input.fileName, mimeType: input.mimeType, bytes };
}
/** File extension for a clipboard image, which arrives as bytes with only a MIME type. */
export function imageExtension(mimeType) {
    const subtype = mimeType.split("/")[1]?.split(/[+;]/)[0] ?? "";
    if (subtype === "jpeg") {
        return "jpg";
    }
    return subtype || "png";
}
