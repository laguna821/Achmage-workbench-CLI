// Text measurement for the slides editor inside Workbench, in place of IeumOffice's fonts.ts (which
// scans the disk from Electron's main process). Calibri and Aptos measure with the bundled Carlito
// (metric-compatible, PowerPoint's line pitch); other families with the face the system draws them
// with (fontconfig, through the gateway); a deck's embedded fonts with their own bytes. The page
// draws each run with the family returned here, so measuring and drawing use the same face.
import type { EmbeddedFontFace } from "@genoffice/pptx-engine";
import { HeuristicMetrics, OpentypeMetrics, type FontMetricsProvider, type OpentypeFontLike, type RunStyle } from "@genoffice/pptx-render";
import { parse, type Font } from "opentype.js";
import carlitoBold from "@ieum/packages/ui/src/fonts/Carlito-Bold.ttf?url";
import carlitoBoldItalic from "@ieum/packages/ui/src/fonts/Carlito-BoldItalic.ttf?url";
import carlitoItalic from "@ieum/packages/ui/src/fonts/Carlito-Italic.ttf?url";
import carlitoRegular from "@ieum/packages/ui/src/fonts/Carlito-Regular.ttf?url";
import { templateFaces } from "./template-fonts.ts";

type Face = { font: OpentypeFontLike; family: string; substituted: boolean };
type Match = { id: string; family: string; installed: boolean } | null;

let token = "";
/** The page's grant: the gateway serves fonts to open editor pages only. */
export function setFontToken(value: string) {
  token = value;
}

const norm = (family: string) => family.toLowerCase().replace(/[\s_-]+/g, "");

/** Office families measured with the bundled Carlito (the page's styles load it as "Carlito"). */
const CARLITO = new Set(["calibri", "calibrilight", "aptos", "aptosdisplay", "aptosnarrow", "carlito", "carlitogo"].map(norm));
const CARLITO_FILES = [carlitoRegular, carlitoBold, carlitoItalic, carlitoBoldItalic];

/** Families the system may draw with a metric-compatible stand-in (not a substitution in PowerPoint's sense). */
const METRIC_ALIASES: Record<string, string[]> = {
  arial: ["liberationsans", "arimo", "albany"],
  helvetica: ["liberationsans", "arimo", "nimbussans"],
  timesnewroman: ["liberationserif", "tinos", "thorndale"],
  times: ["liberationserif", "tinos", "nimbusroman"],
  couriernew: ["liberationmono", "cousine", "cumberland"],
  courier: ["liberationmono", "cousine", "nimbusmonops"],
  cambria: ["caladea"],
};

/** Synchronous request from the worker (layout asks for widths synchronously). */
function get(path: string, binary: true): ArrayBuffer | null;
function get(path: string, binary: false): string | null;
function get(path: string, binary: boolean): ArrayBuffer | string | null {
  try {
    const request = new XMLHttpRequest();
    request.open("GET", path, false);
    if (token && path.startsWith("/api/")) request.setRequestHeader("authorization", `Bearer ${token}`);
    if (binary) request.responseType = "arraybuffer";
    request.send();
    if (request.status !== 200) return null;
    return binary ? (request.response as ArrayBuffer) : request.responseText;
  } catch {
    return null;
  }
}

/** The measurement view of a parsed face; Carlito takes PowerPoint's Calibri line pitch from its OS/2 win metrics. */
function measured(font: Font, carlito: boolean): OpentypeFontLike {
  const os2 = font.tables.os2 as { usWinAscent?: number; usWinDescent?: number } | undefined;
  const hhea = font.tables.hhea as { lineGap?: number } | undefined;
  const win = carlito && os2?.usWinAscent && os2.usWinDescent != null;
  const advance = (text: string, size: number, options?: { kerning?: boolean }) => {
    try {
      return font.getAdvanceWidth(text, size, options);
    } catch {
      // A face whose layout tables trip the parser: plain advances, no kerning.
      let units = 0;
      for (const char of text) units += font.charToGlyph(char).advanceWidth ?? 0;
      return (units / font.unitsPerEm) * size;
    }
  };
  return {
    unitsPerEm: font.unitsPerEm,
    ascender: win ? os2!.usWinAscent! : font.ascender,
    descender: win ? -Math.abs(os2!.usWinDescent!) : font.descender,
    lineGap: win ? 0 : (hhea?.lineGap ?? 0),
    getAdvanceWidth: advance,
    charToGlyphIndex: (char: string) => font.charToGlyphIndex(char),
  };
}

const parsed = new Map<string, OpentypeFontLike | null>();
function faceFrom(cacheKey: string, load: () => ArrayBuffer | null, carlito = false) {
  if (parsed.has(cacheKey)) return parsed.get(cacheKey)!;
  let font: OpentypeFontLike | null = null;
  const bytes = load();
  if (bytes) {
    try {
      font = measured(parse(bytes), carlito);
    } catch {
      font = null;
    }
  }
  parsed.set(cacheKey, font);
  return font;
}

// ── embedded fonts (a deck's own faces) ──────────────────────────────────
const embedded = new Map<string, { id: string; family: string; bold: boolean; italic: boolean; bytes: Uint8Array }>();

export function registerEmbeddedFonts(faces: EmbeddedFontFace[]): boolean {
  let added = false;
  for (const face of faces) {
    const bold = face.style === "bold" || face.style === "boldItalic";
    const italic = face.style === "italic" || face.style === "boldItalic";
    const key = `${norm(face.typeface)}|${bold ? 1 : 0}${italic ? 1 : 0}`;
    if (!norm(face.typeface) || embedded.has(key)) continue;
    embedded.set(key, { id: `embedded-${embedded.size + 1}`, family: face.typeface, bold, italic, bytes: face.sfnt });
    added = true;
  }
  if (added) resetFontRegistry();
  return added;
}

/** Faces the page must register to draw what was measured (a deck's embedded fonts). */
export function listPrivateFontFaces() {
  return [
    ...templateFaces.map(({ id, family, bold, italic, weight }) => ({ id, family, bold, italic, weight })),
    ...[...embedded.values()].map(({ id, family, bold, italic }) => ({ id, family, bold, italic })),
  ];
}

export function getPrivateFontData(id: string): ArrayBuffer | null {
  const template = templateFaces.find((face) => face.id === id);
  if (template) return get(template.url, true);
  const face = [...embedded.values()].find((entry) => entry.id === id);
  return face ? (face.bytes.buffer.slice(face.bytes.byteOffset, face.bytes.byteOffset + face.bytes.byteLength) as ArrayBuffer) : null;
}

// ── resolution ───────────────────────────────────────────────────────────
const LANG: Record<string, string> = { ko: "ko", ja: "ja", sc: "zh-cn", tc: "zh-tw" };
const resolved = new Map<string, Face | undefined>();
const matches = new Map<string, Match>();

function match(family: string, bold: boolean, italic: boolean, lang?: string): Match {
  const key = `${family}|${bold ? 1 : 0}${italic ? 1 : 0}|${lang ?? ""}`;
  if (!matches.has(key)) {
    const query = new URLSearchParams({ family, bold: bold ? "1" : "0", italic: italic ? "1" : "0", ...(lang ? { lang } : {}) });
    const text = get(`/api/fonts/match?${query}`, false);
    let found: Match = null;
    try {
      found = text ? (JSON.parse(text) as Match) : null;
    } catch {
      found = null;
    }
    matches.set(key, found);
  }
  return matches.get(key)!;
}

function resolve(style: RunStyle, langOverride?: string): Face | undefined {
  const lang = langOverride ?? (style.substScript && !style.latinOnly ? LANG[style.substScript] : undefined);
  const key = `${style.fontFamily}|${style.bold ? 1 : 0}${style.italic ? 1 : 0}|${lang ?? ""}`;
  if (resolved.has(key)) return resolved.get(key);
  let face: Face | undefined;
  const wanted = norm(style.fontFamily);
  const bundled = templateFaces.filter((face) => norm(face.family) === wanted);
  const own = embedded.get(`${wanted}|${style.bold ? 1 : 0}${style.italic ? 1 : 0}`) ?? embedded.get(`${wanted}|00`);
  if (own) {
    const font = faceFrom(own.id, () => own.bytes.buffer.slice(own.bytes.byteOffset, own.bytes.byteOffset + own.bytes.byteLength) as ArrayBuffer);
    if (font) face = { font, family: own.family, substituted: false };
  } else if (bundled.length) {
    const selected = bundled.find((face) => face.bold === Boolean(style.bold)) ?? bundled[0]!;
    const font = faceFrom(selected.id, () => get(selected.url, true));
    if (font) face = { font, family: selected.family, substituted: false };
  } else if (CARLITO.has(wanted)) {
    const file = CARLITO_FILES[(style.bold ? 1 : 0) + (style.italic ? 2 : 0)]!;
    const font = faceFrom(file, () => get(file, true), true);
    if (font) face = { font, family: "Carlito", substituted: false };
  } else {
    const found = match(style.fontFamily, style.bold, style.italic, lang);
    if (found) {
      const font = faceFrom(found.id, () => get(`/api/fonts/face/${found.id}`, true));
      const alias = (METRIC_ALIASES[wanted] ?? []).includes(norm(found.family));
      if (font) face = { font, family: found.family, substituted: !found.installed && !alias && norm(found.family) !== wanted };
    }
  }
  resolved.set(key, face);
  return face;
}

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힣]/;
const KANA = /[぀-ヿ]/;

/**
 * Hangul (or kana) in a face without those letters: measured and drawn with the system's face
 * for that script, as the page would otherwise fall back to some other face per glyph.
 */
function scriptFallback(text: string, face: Face | undefined, style: RunStyle): Face | undefined {
  const lacks = (probe: string) => !face || face.font.charToGlyphIndex?.(probe) === 0;
  if (HANGUL.test(text) && lacks("가")) return resolve({ ...style, fontFamily: "Malgun Gothic" }, "ko");
  if (KANA.test(text) && lacks("あ")) return resolve({ ...style, fontFamily: "Yu Gothic" }, "ja");
  return undefined;
}

export function resetFontRegistry() {
  resolved.clear();
}

export function createSystemFontMetrics(): FontMetricsProvider {
  const inner = new OpentypeMetrics((style) => resolve(style)?.font, new HeuristicMetrics());
  return {
    metrics: (style) => inner.metrics(style),
    measure: (text, style) => {
      const fallback = scriptFallback(text, resolve(style), style);
      if (fallback) return new OpentypeMetrics(() => fallback.font, new HeuristicMetrics()).measure(text, style);
      return inner.measure(text, style);
    },
    displayFamily: (style, text) => {
      const face = resolve(style);
      const fallback = text ? scriptFallback(text, face, style) : undefined;
      return fallback?.family ?? face?.family ?? style.fontFamily;
    },
    substituted: (style) => resolve(style)?.substituted === true,
  };
}
