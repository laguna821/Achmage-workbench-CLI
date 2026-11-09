import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Attachment, MessageMedia } from "@workbench/contracts";
import { isImage, sniff, type Attachments } from "./attachments.ts";
import { physicalPath, withinDirectory } from "./directory-operations.ts";
import { HttpError } from "./errors.ts";

export type MediaContext = { hostId: string; workspaceId: string | null; cwd: string; sourceMessageId: string };
const MAX_IMAGE = 10 * 1024 * 1024;

/** Snapshot only a real image inside this execution workspace. Never fetch model-supplied URLs. */
export function resolveMediaReference(store: Attachments, context: MediaContext, source: string): Attachment {
  let path: string;
  try {
    const decoded = source.startsWith("file:") ? fileURLToPath(source) : decodeURIComponent(source);
    if (/^[a-z][a-z0-9+.-]*:/i.test(decoded) && !/^[a-z]:[\\/]/i.test(decoded)) throw Error("URL");
    if (/[\u0000-\u001f]/.test(decoded)) throw Error("control character");
    path = realpathSync(resolve(context.cwd, decoded));
  } catch { throw new HttpError(404, "media_missing", "그림 파일을 찾을 수 없습니다."); }
  if (!withinDirectory(physicalPath(context.cwd), physicalPath(path))) throw new HttpError(403, "media_outside_workspace", "작업공간 밖의 그림은 자동으로 읽지 않습니다.");
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > MAX_IMAGE) throw new HttpError(413, "media_size", "그림 미리보기는 10MB까지입니다.");
  const data = readFileSync(path), mime = sniff(data);
  if (!mime || !isImage(mime)) throw new HttpError(415, "media_type", "미리보기할 수 있는 그림이 아닙니다.");
  const saved = store.save(data, basename(path), mime, MAX_IMAGE);
  const hash = saved.id.split(".")[0]!;
  return { ...saved, reference: {
    hostId: context.hostId, workspaceId: context.workspaceId,
    artifactId: `media-${createHash("sha256").update(JSON.stringify([context.hostId, context.workspaceId, physicalPath(path)])).digest("hex").slice(0, 32)}`,
    canonicalPath: path, revision: hash, hash, MIME: mime, sourceMessageId: context.sourceMessageId,
  } };
}

/** Capture completed Markdown replies, never on each streaming token. Existing captures win. */
export function captureMessageMedia(store: Attachments, context: MediaContext, text: string, previous: MessageMedia[] = []): MessageMedia[] {
  const kept = [...previous], known = new Set(kept.map(entry => entry.source));
  for (const match of text.matchAll(/!\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+["'][^\n]*?["'])?\s*\)/g)) {
    const source = (match[1] ?? match[2])!;
    if (known.has(source) || /^[a-z][a-z0-9+.-]*:\/\//i.test(source) && !source.startsWith("file:")) continue;
    if (kept.length >= 12) break;
    try { kept.push({ source, attachment: resolveMediaReference(store, context, source) }); known.add(source); }
    catch { /* The reply remains readable; no fabricated preview for absent or out-of-scope media. */ }
  }
  return kept;
}
