import { scanCssUrls } from "../../../third_party/ieumoffice/text-assets/css-urls.ts";
import type { HtmlJob } from "../../../packages/contracts/src/office-output.ts";

/** Prepare the original print HTML for an isolated system WebView. Resource
 * reads use the current document's existing grant or the installed Office UI. */
export async function preparePrintHtml(html: string, options: {
  baseUrl?: string; imageUrl?: (src: string) => string;
  widthIn?: number; heightIn?: number; margin?: number;
} = {}): Promise<HtmlJob> {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const resourceBase = new URL(options.baseUrl ?? document.baseURI, document.baseURI).href;
  const base = new URL(doc.querySelector("base[href]")?.getAttribute("href") ?? resourceBase, resourceBase).href;
  const permittedBase = options.baseUrl ? new URL(options.baseUrl, location.href) : null;
  let total = new TextEncoder().encode(html).length;
  const cache = new Map<string, Promise<Blob>>();
  const assets: { mime: string; base64: string }[] = [], assetIds = new Map<string, number>();
  const asset = (url: string) => {
    const comma = url.indexOf(","), header = url.slice(0, comma);
    if (!/^data:[^,]*;base64$/i.test(header)) return url;
    if (!assetIds.has(url)) { assetIds.set(url, assets.length); assets.push({ mime: header.slice(5).replace(/;base64$/i, "") || "application/octet-stream", base64: url.slice(comma + 1) }); }
    return `workbench-print-asset:${assetIds.get(url)}:`;
  };
  const read = (source: string, from: string) => {
    const url = new URL(source, from);
    const local = (url.origin === location.origin && url.pathname.startsWith("/office/")) ||
      (permittedBase && url.origin === permittedBase.origin && url.pathname.startsWith(permittedBase.pathname));
    if (!local && url.protocol !== "blob:" && url.protocol !== "data:") throw new Error(`출력 자산을 현재 문서에서 읽을 수 없습니다: ${source.slice(0,120)}`);
    if (!cache.has(url.href)) cache.set(url.href, (async () => {
      const response = await fetch(url, { credentials: "omit", redirect: "error" });
      if (!response.ok) throw new Error(`출력 자산을 불러오지 못했습니다 (${response.status}): ${source.slice(0,120)}`);
      const blob = await response.blob(); total += blob.size;
      if (total > 48 * 1024 * 1024) throw new Error("출력할 그림·글꼴의 합계가 너무 큽니다.");
      return blob;
    })());
    return cache.get(url.href)!;
  };
  const data = async (source: string, from: string) => {
    if (source.startsWith("data:")) return asset(source);
    if (source.startsWith("#") || source.startsWith("workbench-print-asset:")) return source;
    const blob = await read(source, from);
    return new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(asset(String(reader.result))); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });
  };
  const css = async (text: string, from: string, depth = 0): Promise<string> => {
    if (depth > 8) throw new Error("스타일시트의 순환 참조를 확인해 주세요.");
    // Expand imports first, retaining their media condition and source base.
    const imports = [...text.matchAll(/@import\s+(?:url\(\s*(?:"([^"]+)"|'([^']+)'|([^\s)]+))\s*\)|"([^"]+)"|'([^']+)')\s*([^;]*);/gi)];
    for (const match of imports.reverse()) {
      const source = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5]!;
      const nested = await css(await (await read(source, from)).text(), new URL(source, from).href, depth + 1);
      text = text.slice(0, match.index) + (match[6]?.trim() ? `@media ${match[6]}{${nested}}` : nested) + text.slice(match.index! + match[0].length);
    }
    for (const match of scanCssUrls(text).reverse()) {
      const value = await data(match.source, from);
      text = text.slice(0, match.start) + `url("${value.replace(/"/g, "%22")}")` + text.slice(match.end);
    }
    return text;
  };
  for (const link of doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]')) {
    const url = new URL(link.getAttribute("href")!, base).href, style = doc.createElement("style");
    style.textContent = await css(await (await read(url, base)).text(), url);
    if (link.media) style.media = link.media;
    link.replaceWith(style);
  }
  for (const style of doc.querySelectorAll("style")) style.textContent = await css(style.textContent ?? "", base);
  for (const element of doc.querySelectorAll<HTMLElement>("[style]")) element.setAttribute("style", await css(element.getAttribute("style")!, base));
  for (const element of doc.querySelectorAll("img[src],image[href],image[xlink\\:href]")) {
    const attr = element.hasAttribute("src") ? "src" : element.hasAttribute("href") ? "href" : "xlink:href";
    const src = element.getAttribute(attr)!;
    element.setAttribute(attr, await data(options.imageUrl?.(src) ?? src, base));
    element.removeAttribute("srcset");
  }
  for (const node of doc.querySelectorAll('script,base,iframe,object,embed,meta[http-equiv],link:not([rel="stylesheet"])')) node.remove();
  const margin = options.margin ?? 0.6;
  return { html: `<!doctype html>\n${doc.documentElement.outerHTML}`, assets, widthIn: options.widthIn ?? 210 / 25.4, heightIn: options.heightIn ?? 297 / 25.4,
    margins: { top: margin, right: margin, bottom: margin, left: margin }, scale: 1 };
}
