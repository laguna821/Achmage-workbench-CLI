import { triggerBrowserDownload, sanitizeDownloadFileName } from "../../../vendor/paseo/mobile-web/download.ts";
import { resolveRasterImageMimeType } from "../../../vendor/paseo/mobile-web/file-types.ts";

/** A missing OS MIME is filled from the original helper; bytes and attachment identity are unchanged. */
export function pickedFiles(files: FileList | File[]): File[] {
  return Array.from(files).map(file => {
    const mime = resolveRasterImageMimeType({ mimeType: file.type, path: file.name });
    return mime && !file.type ? new File([file], file.name, { type: mime, lastModified: file.lastModified }) : file;
  });
}

/** Hands bytes to the browser to save under a name. They may be anything a conversation, document
 * or service holds (a web page, an SVG): the object URL is typed as plain bytes, so a browser that
 * opens it instead of saving it runs nothing on this app's address. The name keeps its extension. */
export function saveBlobAs(blob: Blob, name: string) {
  const url = URL.createObjectURL(new Blob([blob], { type: "application/octet-stream" }));
  triggerBrowserDownload(url, sanitizeDownloadFileName(name), target => window.open(target, "_blank", "noopener,noreferrer"));
  // Paseo keeps a save-prompt URL alive for a minute, independently of the source view.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function downloadAttachment(file: File) { saveBlobAs(file, file.name); }

export async function shareableFile(url: string, name: string, mime: string): Promise<File> {
  // Only a cache-owned blob URL, never a credential-bearing URL or a workspace path.
  if (!url.startsWith("blob:")) throw new Error("파일을 먼저 불러와 주세요.");
  const blob = await fetch(url).then(response => {
    if (!response.ok) throw new Error("파일을 읽지 못했습니다.");
    return response.blob();
  });
  return new File([blob], sanitizeDownloadFileName(name), { type: blob.type || mime || "application/octet-stream" });
}

export function canShareFile(file: File) {
  try { return typeof navigator.share === "function" && typeof navigator.canShare === "function" && navigator.canShare({ files: [file] }); }
  catch { return false; }
}

/** Called directly by a click after preparation so iOS keeps the share sheet's user gesture. */
export function shareFile(file: File) {
  return navigator.share({ files: [file], title: file.name });
}
