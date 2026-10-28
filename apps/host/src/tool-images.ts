import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import type { Attachment } from "@workbench/contracts";
import { isImage, sniff, type Attachments } from "./attachments.ts";
import type { ToolImage } from "./providers/types.ts";

// Pictures an engine produced or looked at during a step (a browser screenshot, an image it read,
// a picture an MCP tool returned): kept like attachments and shown in the conversation under the
// step, as the Codex app does.

/** Larger pictures are left out (a preview, not an archive). */
const MAX_IMAGE = 10 * 1024 * 1024;
/** Per step: a command that writes a hundred frames shows the first few. */
const MAX_PER_STEP = 6;

const IMAGE_PATH = /\.(png|jpe?g|webp|gif)$/i;

/**
 * Image files a command names in its command line or output: Markdown links (Playwright CLI prints
 * `[Screenshot](.playwright-cli/page.png)`), quoted paths and bare tokens. Relative ones are taken
 * from the work folder. Only files that changed since `since` count, so a listing of old pictures
 * shows nothing.
 */
export function imagesNamed(text: string, cwd: string, since: number): string[] {
  const candidates = new Set<string>();
  for (const match of text.matchAll(/\]\(([^)\n]+)\)/g)) candidates.add(match[1]!.trim());
  for (const match of text.matchAll(/["'`]([^"'`\n]+)["'`]/g)) candidates.add(match[1]!.trim());
  for (const token of text.split(/\s+/)) candidates.add(token.replace(/^[(<[]+|[)>\],.;:]+$/g, ""));
  const found: string[] = [];
  for (const candidate of candidates) {
    if (!IMAGE_PATH.test(candidate) || /^[a-z]+:\/\//i.test(candidate)) continue;
    const path = candidate.startsWith("~/") ? join(homedir(), candidate.slice(2)) : isAbsolute(candidate) ? candidate : join(cwd, candidate);
    if (found.includes(path) || !existsSync(path)) continue;
    const stats = statSync(path);
    if (!stats.isFile() || stats.size > MAX_IMAGE || stats.mtimeMs < since) continue;
    found.push(path);
    if (found.length === MAX_PER_STEP) break;
  }
  return found;
}

/** Keep a picture in the attachment store; null for anything that is not a picture or too large. */
export function keepImage(store: Attachments, image: ToolImage): Attachment | null {
  try {
    const data = "path" in image ? (statSync(image.path).size <= MAX_IMAGE ? readFileSync(image.path) : null) : Buffer.from(image.data, "base64");
    if (!data || !data.length || data.length > MAX_IMAGE) return null;
    const mime = sniff(data);
    if (!mime || !isImage(mime)) return null;
    return store.save(data, "path" in image ? basename(image.path) : (image.name ?? "그림.png"), mime);
  } catch {
    return null;
  }
}

/** Pictures of a step, added to those it has (each once). */
export function withImages(current: Attachment[] | undefined, added: Attachment[]) {
  const all = [...(current ?? [])];
  for (const image of added) if (!all.some((entry) => entry.id === image.id)) all.push(image);
  return all.slice(0, MAX_PER_STEP);
}
