// Preserve the original book/session engine; this boundary keeps its Electron type graph out
// of Workbench's strict TS project, as with the other original editor engines.
import { EpubBookSession } from "../../../vendor/ieumoffice/apps/epub/src/main/book-session.ts";
import { serveEpubAsset } from "../../../vendor/ieumoffice/apps/epub/src/main/asset-protocol.ts";
import { createReadingState, readPositionOf } from "../../../vendor/ieumoffice/apps/epub/src/main/reading-state.ts";
import { atomicWriteFile } from "../../../third_party/ieumoffice/text-assets/atomic-write.ts";

export const EPUB_MAX_BYTES = 200_000_000;
export async function openEpubSession(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.length) return { ok: false, reason: "damaged" };
  if (bytes.byteLength > EPUB_MAX_BYTES) return { ok: false, reason: "too-large" };
  return EpubBookSession.open(bytes);
}
export async function epubText(bytes) {
  const opened = await openEpubSession(bytes);
  if (!opened.ok) throw new Error(`전자책을 읽지 못했습니다: ${opened.reason}`);
  return opened.session.readText();
}
export function epubAsset(session, token, path, method) {
  return serveEpubAsset({ url: `epub-asset://${token}/${path}`, method }, (candidate) => candidate === token ? session.book : null);
}
export function epubReadingState(dir) {
  return createReadingState({ dir: () => dir, write: (path, text) => atomicWriteFile(path, Buffer.from(text, "utf8")) });
}
export { readPositionOf };
