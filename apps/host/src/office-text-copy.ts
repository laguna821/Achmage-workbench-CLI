import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { extractMarkdownImageSources, prepareAssetsForSaveAs, rollbackPreparedSaveAsAssets } from "../../../third_party/ieumoffice/text-assets/asset-lifecycle.ts";
import { scanCssUrls } from "../../../third_party/ieumoffice/text-assets/css-urls.ts";
import { HttpError } from "./errors.ts";
import { readOfficeAsset } from "./office-assets.ts";

type Prepared = { text: string; rollback: () => Promise<void> };
type Patch = { start: number; end: number; text: string };
type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const external = (ref: string) => !ref.trim() || ref.trim().startsWith("#") || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(ref.trim());
const assetError = (source: string) => new HttpError(422, "copy_asset_missing", `사본에 필요한 자산을 읽지 못했습니다: ${source}. 원본은 보존했습니다.`);
const patchText = (text: string, patches: Patch[]) => patches.sort((a, b) => b.start - a.start).reduce((value, patch) => value.slice(0, patch.start) + patch.text + value.slice(patch.end), text);
function* elements(node: Node): Generator<Element> {
  if ("tagName" in node) yield node;
  if ("childNodes" in node) for (const child of node.childNodes) yield* elements(child);
  if ("content" in node) yield* elements(node.content);
}
const attribute = (node: Element, name: string) => node.attrs.find((item) => item.name === name)?.value;
const htmlEscape = (text: string, quote: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(quote, quote === '"' ? "&quot;" : "&#39;");

/** Save As preserves source spelling. Only resource URL spans change; never serialize a DOM. */
export async function prepareTextCopy(source: string, target: string, text: string, kind: "markdown" | "html"): Promise<Prepared> {
  if (realpathSync(dirname(source)) === dirname(target)) return { text, rollback: async () => {} };
  if (kind === "html") return prepareHtmlCopy(source, target, text);
  const sources = extractMarkdownImageSources(text);
  let total = 0;
  for (const ref of new Set(sources)) {
    if (external(ref)) continue;
    // The upstream copier does not relocate query/fragment URLs. Fail before publication,
    // instead of leaving a relative reference that now points at the wrong directory.
    if (/[?#]/.test(ref)) throw assetError(ref);
    let decoded: string;
    try { decoded = decodeURIComponent(ref); } catch { throw assetError(ref); }
    const asset = await readOfficeAsset(source, decoded, false, null);
    if (!asset.type.startsWith("image/")) throw assetError(ref);
    total += asset.data.length;
    if (total > 200_000_000) throw new HttpError(413, "copy_assets_large", "사본의 자산 합계가 200MB를 넘습니다.");
  }
  const plan = await prepareAssetsForSaveAs(source, target, text, sources);
  return { text: plan.text, rollback: () => rollbackPreparedSaveAsAssets(plan) };
}

async function prepareHtmlCopy(source: string, target: string, text: string): Promise<Prepared> {
  const tree = [...elements(parse(text, { sourceCodeLocationInfo: true }))];
  const authoredBase = tree.find((node) => node.tagName === "base" && attribute(node, "href") !== undefined);
  const base = authoredBase ? attribute(authoredBase, "href")! : "";
  const sourceBase = new URL(base, pathToFileURL(source));
  const targetBase = new URL(base, pathToFileURL(target));
  const root = dirname(resolve(source)), targetDir = dirname(target);
  const assetsDir = join(targetDir, "assets"), copyDir = join(assetsDir, `copy-${randomUUID()}`);
  const copied = new Map<string, string>(), created: { path: string; hash: string }[] = [];
  const directories = new Set<string>();
  let total = 0, allocated = false;
  const rollback = async () => {
    // Remove only this attempt's unchanged files; source assets and prior copies are untouched.
    if (!allocated || !existsSync(copyDir) || realpathSync(copyDir) !== copyDir) return;
    for (const item of created) {
      if (existsSync(item.path) && realpathSync(item.path) === item.path && digest(readFileSync(item.path)) === item.hash) unlinkSync(item.path);
    }
    for (const dir of [...directories].sort((a, b) => b.length - a.length)) { try { rmdirSync(dir); } catch { /* nonempty or changed: preserve */ } }
  };
  const allocate = () => {
    if (allocated) return;
    if (!existsSync(assetsDir)) mkdirSync(assetsDir);
    if (!lstatSync(assetsDir).isDirectory() || realpathSync(assetsDir) !== assetsDir) throw new HttpError(403, "copy_assets_path", "자산 폴더가 실제 폴더인지 확인해 주세요.");
    mkdirSync(copyDir); directories.add(copyDir); allocated = true;
  };
  const copy = async (url: URL): Promise<string> => {
    const file = fileURLToPath(url), key = file;
    const known = copied.get(key); if (known) return known;
    if (copied.size >= 1000) throw new HttpError(413, "copy_assets_many", "사본의 자산이 1,000개를 넘습니다.");
    const local = relative(root, file);
    const asset = await readOfficeAsset(source, local, false, null);
    total += asset.data.length;
    if (total > 200_000_000) throw new HttpError(413, "copy_assets_large", "사본의 자산 합계가 200MB를 넘습니다.");
    allocate();
    const destination = join(copyDir, local);
    copied.set(key, destination); // CSS import cycles terminate here.
    mkdirSync(dirname(destination), { recursive: true });
    for (let dir = dirname(destination); dir.startsWith(copyDir); dir = dirname(dir)) directories.add(dir);
    writeFileSync(destination, asset.data, { flag: "wx" });
    created.push({ path: destination, hash: digest(asset.data) });
    // Keep the CSS directory structure and bytes, including imports, fonts and media.
    if (extname(file).toLowerCase() === ".css") {
      const css = asset.data.toString("utf8");
      const refs = [...scanCssUrls(css).map((match) => match.source), ...[...css.matchAll(/@import\s+["']([^"']+)["']/gi)].map((match) => match[1]!)];
      for (const ref of new Set(refs)) {
        if (external(ref)) continue;
        const dep = new URL(ref, url);
        if (dep.protocol === "file:") await copy(dep);
      }
    }
    return destination;
  };
  const relocate = async (ref: string): Promise<string> => {
    if (external(ref)) return ref;
    const url = new URL(ref, sourceBase);
    if (url.protocol !== "file:") return ref; // authored remote base: no network access or rewriting
    const destination = await copy(url);
    const outputBase = fileURLToPath(new URL(".", targetBase));
    return relative(outputBase, destination).split(sep).map(encodeURIComponent).join("/") + url.search + url.hash;
  };
  const cssRewrite = async (value: string): Promise<string> => {
    const patches: Patch[] = [];
    for (const match of scanCssUrls(value)) {
      const next = await relocate(match.source);
      if (next !== match.source) patches.push({ start: match.start, end: match.end, text: `url(${match.quote}${next}${match.quote})` });
    }
    return patchText(value, patches);
  };
  const srcsetRewrite = async (value: string) => {
    const patches: Patch[] = [];
    // URL tokens can contain commas (data URLs). A descriptor or trailing comma ends one.
    const tokens = /(?:^|,)\s*(\S+?)(?=\s|$)(?:\s+[^,]*)?/g;
    for (const match of value.matchAll(tokens)) {
      const ref = match[1]!.replace(/,+$/, ""), start = match.index + match[0].indexOf(match[1]!);
      const next = await relocate(ref);
      if (next !== ref) patches.push({ start, end: start + ref.length, text: next });
    }
    return patchText(value, patches);
  };
  try {
    const patches: Patch[] = [];
    for (const node of tree) {
      for (const attr of node.attrs) {
        const name = attr.name, tag = node.tagName;
        const resource = (name === "src" && ["img", "script", "audio", "video", "source", "track", "embed", "input"].includes(tag))
          || (name === "poster" && tag === "video") || (name === "data" && tag === "object")
          || (name === "href" && tag === "link" && /(?:^|\s)(?:stylesheet|icon|preload|modulepreload)(?:\s|$)/i.test(attribute(node, "rel") ?? ""));
        const srcset = name === "srcset" && ["img", "source"].includes(tag);
        if (!resource && !srcset && name !== "style") continue;
        const next = name === "style" ? await cssRewrite(attr.value) : srcset ? await srcsetRewrite(attr.value) : await relocate(attr.value);
        if (next === attr.value) continue;
        const span = node.sourceCodeLocation?.attrs?.[name];
        if (!span) throw assetError(attr.value);
        const raw = text.slice(span.startOffset, span.endOffset), equals = raw.indexOf("=");
        if (equals < 0) throw assetError(attr.value);
        const prefix = raw.slice(0, equals + 1) + (raw.slice(equals + 1).match(/^\s*/)?.[0] ?? "");
        const delimiter = raw[prefix.length], quote = delimiter === "'" ? "'" : '"';
        patches.push({ start: span.startOffset, end: span.endOffset, text: prefix + quote + htmlEscape(next, quote) + quote });
      }
      if (node.tagName === "style") {
        for (const child of node.childNodes) if (child.nodeName === "#text" && child.sourceCodeLocation) {
          const span = child.sourceCodeLocation, css = text.slice(span.startOffset, span.endOffset), next = await cssRewrite(css);
          if (next !== css) patches.push({ start: span.startOffset, end: span.endOffset, text: next });
        }
      }
    }
    return { text: patchText(text, patches), rollback };
  } catch (error) { await rollback(); throw error; }
}
