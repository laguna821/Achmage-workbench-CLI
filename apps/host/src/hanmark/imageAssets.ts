// Ported from HanMark 2.7.0 src/io/imageAssets.ts @ 3db078d (MIT © 2026 laguna821, ./LICENSE-HANMARK). Workbench: hydrateKordocImages and its BinData/size helpers are dropped — the core's generate embeds and sizes pictures.
import { errorMessage, resolveOutputLocale, t, tOut, type Locale } from "./i18n.ts";
import { transformMarkdownImageTokens } from "./markdownImageTokens.ts";

export interface LoadedImage {
  data: Uint8Array | ArrayBuffer;
  contentType?: string;
}

export type ImageLoader = (source: string) => Promise<LoadedImage>;

export interface ImageProgress {
  completed: number;
  total: number;
  source: string;
  status: "embedded" | "failed";
}

export interface ImagePipelineOptions {
  loader: ImageLoader;
  concurrency?: number;
  maxImages?: number;
  maxImageBytes?: number;
  maxTotalBytes?: number;
  maxDisplayWidthHu?: number;
  onProgress?: (progress: ImageProgress) => void;
}

export interface ImageReference {
  source: string;
  alt: string;
  occurrences: number;
}

export interface ResolvedImageAsset extends ImageReference {
  safeName: string;
  itemId: string;
  mimeType: string;
  data: Uint8Array;
  pixelWidth: number;
  pixelHeight: number;
  displayWidthHu: number;
  displayHeightHu: number;
}

export interface ImageFailure extends ImageReference {
  stage: "resolve" | "place";
  message: string;
}

export interface ImageResolutionResult {
  references: ImageReference[];
  assets: ResolvedImageAsset[];
  failures: ImageFailure[];
}

const DEFAULT_MAX_IMAGES = 100;
const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const MAX_BODY_WIDTH_HU = 42_520;
const MAX_BODY_HEIGHT_HU = 60_000;
const PIXEL_TO_HWPUNIT_AT_96_DPI = 75;
const FENCE = /^\s*(`{3,}|~{3,})/;

interface ImageToken {
  source: string;
  alt: string;
  raw: string;
  kind: "markdown" | "html";
}

type TokenTransform = (token: ImageToken) => string;

/** `defaultAlt` names an image that has no alt text. */
function transformImageTokens(markdown: string, transform: TokenTransform, defaultAlt: string): string {
  const output: string[] = [];
  let fenceMarker = "";
  for (let line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const fence = line.match(FENCE)?.[1] ?? "";
    if (fence) {
      if (!fenceMarker) fenceMarker = fence[0];
      else if (fence[0] === fenceMarker) fenceMarker = "";
      output.push(line);
      continue;
    }
    if (fenceMarker) {
      output.push(line);
      continue;
    }

    line = transformMarkdownImageTokens(
      line,
      ({ raw, alt, source }) =>
        transform({ raw, alt: alt || defaultAlt, source, kind: "markdown" })
    );
    line = line.replace(/<img\b[^>]*>/gi, (raw) => {
      const source = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(raw)?.[1];
      if (!source) return raw;
      const alt = /\balt\s*=\s*["']([^"']*)["']/i.exec(raw)?.[1] || defaultAlt;
      return transform({ raw, alt, source, kind: "html" });
    });
    output.push(line);
  }
  return output.join("\n");
}

/** References feed image failure reports only, so an unnamed image is labeled in the interface language. */
export function collectImageReferences(markdown: string): ImageReference[] {
  const references = new Map<string, ImageReference>();
  transformImageTokens(markdown, (token) => {
    const current = references.get(token.source);
    if (current) current.occurrences++;
    else references.set(token.source, { source: token.source, alt: token.alt, occurrences: 1 });
    return token.raw;
  }, t("save.imageFailure.image"));
  return [...references.values()];
}

function toBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new Uint8Array(value);
}

function u16be(data: Uint8Array, offset: number): number {
  return (data[offset] << 8) | data[offset + 1];
}

function u16le(data: Uint8Array, offset: number): number {
  return data[offset] | (data[offset + 1] << 8);
}

function u32be(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, false);
}

function i32le(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset + offset, 4).getInt32(0, true);
}

function jpegDimensions(data: Uint8Array): { width: number; height: number } | null {
  let offset = 2;
  const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset + 8 < data.length) {
    if (data[offset] !== 0xff) {
      offset++;
      continue;
    }
    while (offset < data.length && data[offset] === 0xff) offset++;
    const marker = data[offset++];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > data.length) break;
    const length = u16be(data, offset);
    if (length < 2 || offset + length > data.length) break;
    if (sofMarkers.has(marker) && length >= 7) {
      return { height: u16be(data, offset + 3), width: u16be(data, offset + 5) };
    }
    offset += length;
  }
  return null;
}

export function inspectImage(data: Uint8Array): {
  mimeType: string;
  extension: "png" | "jpg" | "gif" | "bmp";
  width: number;
  height: number;
} {
  let result: { mimeType: string; extension: "png" | "jpg" | "gif" | "bmp"; width: number; height: number } | null = null;
  if (
    data.length >= 24 &&
    data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 &&
    data[12] === 0x49 && data[13] === 0x48 && data[14] === 0x44 && data[15] === 0x52
  ) {
    result = { mimeType: "image/png", extension: "png", width: u32be(data, 16), height: u32be(data, 20) };
  } else if (data.length >= 10 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
    result = { mimeType: "image/gif", extension: "gif", width: u16le(data, 6), height: u16le(data, 8) };
  } else if (data.length >= 26 && data[0] === 0x42 && data[1] === 0x4d) {
    result = { mimeType: "image/bmp", extension: "bmp", width: i32le(data, 18), height: Math.abs(i32le(data, 22)) };
  } else if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    const dimensions = jpegDimensions(data);
    if (dimensions) result = { mimeType: "image/jpeg", extension: "jpg", ...dimensions };
  }

  if (!result) throw new Error(t("image.unsupported"));
  if (!Number.isFinite(result.width) || !Number.isFinite(result.height) || result.width <= 0 || result.height <= 0) {
    throw new Error(t("image.noDimensions"));
  }
  if (result.width > 50_000 || result.height > 50_000 || result.width * result.height > 100_000_000) {
    throw new Error(t("image.tooManyPixels", { width: result.width, height: result.height }));
  }
  return result;
}

export function imageDisplaySize(
  pixelWidth: number,
  pixelHeight: number,
  maxDisplayWidthHu = MAX_BODY_WIDTH_HU
): { widthHu: number; heightHu: number } {
  const maximumWidth = Math.max(1, Math.min(100_000, Math.round(maxDisplayWidthHu)));
  let widthHu = Math.min(Math.round(pixelWidth * PIXEL_TO_HWPUNIT_AT_96_DPI), maximumWidth);
  let heightHu = Math.max(1, Math.round((widthHu * pixelHeight) / pixelWidth));
  if (heightHu > MAX_BODY_HEIGHT_HU) {
    const ratio = MAX_BODY_HEIGHT_HU / heightHu;
    widthHu = Math.max(1, Math.round(widthHu * ratio));
    heightHu = MAX_BODY_HEIGHT_HU;
  }
  return { widthHu, heightHu };
}

export async function resolveMarkdownImages(
  markdown: string,
  options: ImagePipelineOptions
): Promise<ImageResolutionResult> {
  const references = collectImageReferences(markdown);
  const maxImages = options.maxImages ?? DEFAULT_MAX_IMAGES;
  const maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const concurrency = Math.max(1, Math.min(8, options.concurrency ?? 4));
  const assets: ResolvedImageAsset[] = [];
  const failures: ImageFailure[] = [];
  const queued = references.slice(0, maxImages);
  for (const reference of references.slice(maxImages)) {
    failures.push({ ...reference, stage: "resolve", message: t("image.tooMany", { limit: maxImages }) });
  }

  let next = 0;
  let completed = references.length - queued.length;
  let totalBytes = 0;
  const run = async (): Promise<void> => {
    while (next < queued.length) {
      const index = next++;
      const reference = queued[index];
      try {
        const loaded = await options.loader(reference.source);
        const data = toBytes(loaded.data);
        if (!data.byteLength) throw new Error(t("image.empty"));
        if (data.byteLength > maxImageBytes) {
          throw new Error(t("image.fileTooLarge", { limit: Math.round(maxImageBytes / 1024 / 1024) }));
        }
        if (totalBytes + data.byteLength > maxTotalBytes) {
          throw new Error(t("image.totalTooLarge", { limit: Math.round(maxTotalBytes / 1024 / 1024) }));
        }
        const inspected = inspectImage(data);
        totalBytes += data.byteLength;
        const ordinal = index + 1;
        const base = `hanmark_image_${String(ordinal).padStart(3, "0")}`;
        const display = imageDisplaySize(inspected.width, inspected.height, options.maxDisplayWidthHu);
        assets.push({
          ...reference,
          safeName: `${base}.${inspected.extension}`,
          itemId: base,
          mimeType: inspected.mimeType,
          data,
          pixelWidth: inspected.width,
          pixelHeight: inspected.height,
          displayWidthHu: display.widthHu,
          displayHeightHu: display.heightHu
        });
        completed++;
        options.onProgress?.({ completed, total: references.length, source: reference.source, status: "embedded" });
      } catch (error: unknown) {
        failures.push({
          ...reference,
          stage: "resolve",
          message: errorMessage(error)
        });
        completed++;
        options.onProgress?.({ completed, total: references.length, source: reference.source, status: "failed" });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queued.length || 1) }, run));

  assets.sort((a, b) => references.findIndex((item) => item.source === a.source) - references.findIndex((item) => item.source === b.source));
  failures.sort((a, b) => references.findIndex((item) => item.source === a.source) - references.findIndex((item) => item.source === b.source));
  return { references, assets, failures };
}

function missingLabel(token: ImageToken, locale: Locale): string {
  const defaultAlt = tOut(locale, "image.output.defaultAlt");
  const clean = (token.alt || token.source.split("/").pop() || defaultAlt)
    .replace(/\[/g, " ").replace(/\]/g, " ").replace(/[\r\n]/g, " ").trim();
  return tOut(locale, "image.output.missing", { name: clean || defaultAlt });
}

/**
 * `locale` is the language of the labels written into the document (default alt text,
 * missing-image placeholders). Without one, the document itself decides ("auto").
 */
export function rewriteMarkdownForResolvedImages(
  markdown: string,
  assets: ResolvedImageAsset[],
  failedSources: Set<string>,
  locale: Locale = resolveOutputLocale("auto", markdown)
): string {
  const defaultAlt = tOut(locale, "image.output.defaultAlt");
  const bySource = new Map(assets.map((asset) => [asset.source, asset]));
  return transformImageTokens(markdown, (token) => {
    const asset = bySource.get(token.source);
    if (asset) {
      if (token.kind === "markdown") return token.raw.replace(token.source, asset.safeName);
      const alt = (token.alt || defaultAlt)
        .replace(/\[/g, " ").replace(/\]/g, " ").replace(/[\r\n]/g, " ").trim() || defaultAlt;
      return `![${alt}](${asset.safeName})`;
    }
    return failedSources.has(token.source) ? missingLabel(token, locale) : token.raw;
  }, defaultAlt);
}

export class ImageResolutionError extends Error {
  readonly failures: ImageFailure[];
  readonly resolvedCount: number;
  readonly totalCount: number;
  constructor(failures: ImageFailure[], resolvedCount: number, totalCount: number) {
    const first = failures.slice(0, 3).map((failure) => `${failure.alt}: ${failure.message}`).join(" / ");
    super(`${t("image.resolutionFailed", { count: failures.length })}${first ? ` ${first}` : ""}`);
    this.name = "ImageResolutionError";
    this.failures = failures;
    this.resolvedCount = resolvedCount;
    this.totalCount = totalCount;
  }
}
