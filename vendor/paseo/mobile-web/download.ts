// Extracted from Paseo 1fff127f45b11c1c9c573fbbd12791673004c912, Apache-2.0.
// Original modules and their hashes are preserved in upstream/ and source.json.
export function triggerBrowserDownload(url: string, fileName: string, openExternalUrl: (url: string) => unknown) {
  if (typeof document === "undefined") {
    if (typeof window !== "undefined") {
      void openExternalUrl(url);
    }
    return;
  }

  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export function sanitizeDownloadFileName(fileName: string): string {
  const trimmed = fileName.trim();
  if (!trimmed) {
    return "download";
  }
  return trimmed.replace(/[\\/:*?"<>|]+/g, "_");
}
