import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { Attachment } from "@workbench/contracts";
import { HttpError } from "./errors.ts";

// Files the user pastes or drops into the input: kept by content (sha256) in the gateway's data
// dir, so the same picture pasted twice is stored once, and handed to the engine with the request.

export const MAX_ATTACHMENT = 25 * 1024 * 1024;

const EXTENSION: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/csv": ".csv",
};

/** Pictures the engines take as images (Claude image blocks, Codex local images). */
export const isImage = (mime: string) => /^image\/(png|jpeg|webp|gif)$/.test(mime);

/** What the bytes are, for the kinds an engine takes as content; null for anything else. */
export function sniff(data: Buffer): string | null {
  const ascii = (start: number, end: number) => data.subarray(start, end).toString("latin1");
  if (data[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (ascii(0, 4) === "GIF8") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(0, 5) === "%PDF-") return "application/pdf";
  return null;
}

const cleanName = (name: string) => name.replace(/[\u0000-\u001f\\/:*?"<>|]/g, "_").trim().slice(0, 120) || "첨부";

export const attachmentsDir = (dataDir: string) => join(dataDir, "attachments");

export class Attachments {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = attachmentsDir(dataDir);
    // Made now: Claude Code is given this folder to read from when it starts.
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  save(data: Buffer, rawName: string, rawMime: string): Attachment {
    if (!data.length) throw new HttpError(400, "attachment_empty", "빈 파일입니다.");
    if (data.length > MAX_ATTACHMENT) throw new HttpError(413, "attachment_too_large", "첨부는 25MB까지입니다.");
    const name = cleanName(rawName);
    // The bytes decide for pictures and PDFs (an engine rejects an image that is not one).
    const claimed = /^[\w.+-]+\/[\w.+-]+$/.test(rawMime) ? rawMime.toLowerCase() : "application/octet-stream";
    const mime = sniff(data) ?? (isImage(claimed) || claimed === "application/pdf" ? "application/octet-stream" : claimed);
    const id = createHash("sha256").update(data).digest("hex");
    const own = extname(name).toLowerCase();
    const extension = EXTENSION[mime] ?? (/^\.[a-z0-9]{1,10}$/.test(own) ? own : ".bin");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const path = join(this.dir, id + extension);
    if (!existsSync(path)) writeFileSync(path, data, { mode: 0o600 });
    return { id: id + extension, name, mime, size: data.length };
  }

  /** The stored file of an attachment id (`<sha256><ext>`), or an error for anything else. */
  path(id: string) {
    if (!/^[0-9a-f]{64}\.[a-z0-9]{1,10}$/.test(id)) throw new HttpError(400, "attachment_id", "첨부 이름이 올바르지 않습니다.");
    const path = join(this.dir, id);
    if (!existsSync(path)) throw new HttpError(404, "attachment_missing", "첨부 파일이 없습니다.");
    return path;
  }

  /** What the engine gets: where the file is, and what it is. */
  resolve(attachments: Attachment[]) {
    return attachments.map((attachment) => ({ ...attachment, path: this.path(attachment.id) }));
  }

  count() {
    return existsSync(this.dir) ? readdirSync(this.dir).length : 0;
  }
}

/** Files an engine cannot take as content are named by path, for it to open with its own tools. */
export function mentionFiles(text: string, files: { name: string; path: string }[]) {
  if (!files.length) return text;
  return `${text}\n\n첨부한 파일:\n${files.map((file) => `- ${file.name}: ${file.path}`).join("\n")}`;
}
