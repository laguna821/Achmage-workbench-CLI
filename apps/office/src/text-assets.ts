// Only display URLs contain the read-only capability. Authored paths stay in the document model.
let assetBase = "";
let documentDir = "";
export function configureTextAssets(baseUrl: string, documentPath: string) {
  assetBase = new URL(baseUrl, location.href).href;
  const normalized = documentPath.replace(/\\/g, "/"), at = normalized.lastIndexOf("/");
  documentDir = at === 0 ? "/" : normalized.slice(0, at);
}
export function resolveTextImage(src: string) {
  if (!src || !assetBase || src.startsWith("//") || (/^[a-z][a-z\d+.-]*:/i.test(src) && !/^[a-z]:[\\/]/i.test(src))) return src;
  return `${assetBase}__image?src=${encodeURIComponent(src)}&dir=${encodeURIComponent(documentDir)}`;
}
export function unresolveTextImage(src: string) {
  if (!assetBase) return src;
  try {
    const url = new URL(src, location.href);
    if (!["127.0.0.1", "localhost"].includes(url.hostname) || !/^\/preview\/[A-Za-z0-9_-]{32}\/__image$/.test(url.pathname)) return src;
    const authored = url.searchParams.get("src"), from = url.searchParams.get("dir");
    if (authored === null) return src;
    // Clipboard HTML can outlive a grant or come from another document. Never persist its token.
    if (!from || from === documentDir || authored.startsWith("/") || /^[a-z]:[\\/]/i.test(authored)) return authored;
    return `${from.replace(/\/$/, "")}/${authored}`;
  }
  catch { return src; }
}
