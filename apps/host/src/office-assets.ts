import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { writeImageIntoOwnedAssets } from "../../../third_party/ieumoffice/text-assets/asset-lifecycle.ts";
import { extensionlessAssetMime, PREVIEW_ASSET_EXTS, sniffBinaryAssetMime } from "../../../third_party/ieumoffice/text-assets/asset-mime.ts";
import { HttpError } from "./errors.ts";
import { imageType } from "./doc-images.ts";

export const OFFICE_IMAGE_MAX_BYTES = 50 * 1024 * 1024;
const MAX_ASSET_BYTES = 200 * 1024 * 1024;
const TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".avif": "image/avif", ".ico": "image/x-icon",
  ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav",
};
const within = (root: string, file: string) => { const rel = relative(root, file); return !!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
const hidden = (root: string, file: string) => relative(root, file).split(sep).some((part) => part.startsWith("."));
const denied = () => new HttpError(403, "asset_outside", "이 문서 폴더 안의 공개 자산만 읽을 수 있습니다.");

/** The URL path is decoded once by the caller. Never decode twice or follow an escaping link. */
export async function readOfficeAsset(documentPath: string, source: string, imageOnly: boolean, accept: string | null) {
  if (!source || source.includes("\0") || source.startsWith("//") || source.startsWith("\\\\") || (/^[a-z][a-z\d+.-]*:/i.test(source) && !/^[a-z]:[\\/]/i.test(source))) throw denied();
  const root = resolve(dirname(documentPath)), file = resolve(root, source.replace(/[\\/]/g, sep));
  if (!within(root, file) || hidden(root, file)) throw denied();
  const realRoot = await realpath(root), realFile = await realpath(file).catch(() => null);
  if (!realFile) throw new HttpError(404, "asset_missing", "문서 자산을 찾지 못했습니다.");
  if (!within(realRoot, realFile) || hidden(realRoot, realFile)) throw denied();
  const handle = await open(realFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw denied();
    if (info.size > (imageOnly ? OFFICE_IMAGE_MAX_BYTES : MAX_ASSET_BYTES)) throw new HttpError(413, "asset_large", "문서 자산의 크기 한도를 넘었습니다.");
    const head = Buffer.alloc(4096), { bytesRead } = await handle.read(head, 0, head.length, 0);
    const bytes = head.subarray(0, bytesRead), ext = extname(realFile).toLowerCase();
    const type = imageOnly ? (sniffBinaryAssetMime(bytes)?.startsWith("image/") ? sniffBinaryAssetMime(bytes) : imageType(bytes)?.mime) : PREVIEW_ASSET_EXTS.has(ext) ? TYPES[ext] : extensionlessAssetMime(realFile, bytes, accept);
    if (!type) throw new HttpError(415, "asset_type", "표시할 수 있는 문서 자산이 아닙니다.");
    // Fixed, bounded read from this descriptor; later growth cannot turn this into an unbounded read.
    const data = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < data.length) { const read = await handle.read(data, offset, data.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
    return { data: data.subarray(0, offset), type };
  } finally { await handle.close(); }
}

export async function saveOfficeImage(documentPath: string, bytes: Buffer, name: string | null) {
  const type = sniffBinaryAssetMime(bytes);
  const ext = type === "image/png" ? ".png" : type === "image/jpeg" ? ".jpg" : type === "image/gif" ? ".gif" : null;
  if (!ext) throw new HttpError(415, "image_type", "PNG·JPEG·GIF 그림만 삽입할 수 있습니다.");
  if (bytes.length > OFFICE_IMAGE_MAX_BYTES) throw new HttpError(413, "image_large", "그림이 너무 큽니다.");
  const stem = (name ?? "image").replace(/\.[^.]*$/, "");
  // One shared lock and the original ownership format for both editors. Retain all historical assets.
  return writeImageIntoOwnedAssets(documentPath, `${stem}${ext}`, bytes);
}
