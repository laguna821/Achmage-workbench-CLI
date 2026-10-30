/** A chapter may read assets from its own book only, including when opened directly. */
export function epubBookCsp(address: string, directAsset = false): string {
  const url = new URL(address);
  const path = /^\/epub-assets\/[a-f0-9]{48}\//.exec(url.pathname)?.[0];
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || !path) throw new Error("Invalid EPUB asset scope");
  const base = url.origin + path;
  return ["default-src 'none'", "script-src 'none'", "object-src 'none'", "frame-src 'none'", "child-src 'none'", "worker-src 'none'", "connect-src 'none'", "form-action 'none'",
    `img-src ${base} data:`, `style-src ${base} 'unsafe-inline'`, `font-src ${base} data:`, "media-src 'none'", `base-uri ${base}`, ...(directAsset ? ["sandbox"] : [])].join("; ");
}

/** WebKit #218086 blocks even trusted parent listeners in a script-sandboxed srcdoc.
 * Book code remains forbidden by the first script-src 'none' CSP and original sanitizer.
 * Other engines retain the original flags. Never use this for an unsanitized/unpolicied frame.
 */
export function epubFrameSandbox(userAgent: string): string {
  return /AppleWebKit\//.test(userAgent) && !/(?:Chrome|Chromium|Edg|OPR)\//.test(userAgent)
    ? "allow-same-origin allow-scripts" : "allow-same-origin";
}
