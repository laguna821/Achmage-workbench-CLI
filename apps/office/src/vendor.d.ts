// IeumOffice's source (vendor/ieumoffice) is built, not type-checked here: its modules are untyped
// for this project, apart from the few names Workbench's own code uses.
declare module "@ieum/*";

declare module "@genoffice/pptx-engine" {
  export type OpenedPptx = unknown;
  export interface EmbeddedFontFace {
    typeface: string;
    style: "regular" | "bold" | "italic" | "boldItalic";
    sfnt: Uint8Array;
  }
  export function savePptx(opened: OpenedPptx): Promise<Uint8Array>;
}

declare module "@genoffice/pptx-render" {
  export interface RunStyle {
    fontFamily: string;
    fontSizePx: number;
    bold: boolean;
    italic: boolean;
    kerning?: boolean;
    substScript?: "ja" | "ko" | "sc" | "tc";
    latinOnly?: boolean;
  }
  export interface FontMetrics {
    ascent: number;
    descent: number;
    lineHeight: number;
    externalLeading?: number;
  }
  export interface FontMetricsProvider {
    metrics(style: RunStyle): FontMetrics;
    measure(text: string, style: RunStyle): number;
    displayFamily?(style: RunStyle, text?: string): string;
    substituted?(style: RunStyle): boolean;
  }
  export interface OpentypeFontLike {
    unitsPerEm: number;
    ascender: number;
    descender: number;
    lineGap?: number;
    getAdvanceWidth(text: string, fontSize: number, options?: { kerning?: boolean }): number;
    charToGlyphIndex?(char: string): number;
  }
  export class HeuristicMetrics implements FontMetricsProvider {
    metrics(style: RunStyle): FontMetrics;
    measure(text: string, style: RunStyle): number;
  }
  export class OpentypeMetrics implements FontMetricsProvider {
    constructor(resolve: (style: RunStyle) => OpentypeFontLike | undefined, fallback?: FontMetricsProvider);
    metrics(style: RunStyle): FontMetrics;
    measure(text: string, style: RunStyle): number;
  }
}

declare module "@genoffice/i18n" {
  export function setUiLang(lang: string): void;
}

declare module "opentype.js" {
  export interface Font {
    unitsPerEm: number;
    ascender: number;
    descender: number;
    tables: Record<string, unknown>;
    getAdvanceWidth(text: string, fontSize: number, options?: { kerning?: boolean }): number;
    charToGlyphIndex(char: string): number;
    charToGlyph(char: string): { advanceWidth?: number };
  }
  export function parse(buffer: ArrayBuffer): Font;
}
