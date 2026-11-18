// Ported from HanMark 2.7.0 src/io/documentStylePresets.ts @ 3db078d (MIT © 2026 laguna821, ./LICENSE-HANMARK). Workbench: the profile type named locally; the core normalizes and applies it.
/**
 * A DocumentStyleProfile (schemaVersion 3) as HanMark's documentStyle.ts defines it; the kordoc core
 * (its vendored documentStyle.mjs) normalizes and applies it, so only the shape is named here.
 */
export type DocumentStyleProfile = {
  schemaVersion: 3;
  name: string;
  sourceName?: string;
  roles: Record<string, { styleName?: string; character?: Record<string, unknown>; paragraph?: Record<string, unknown> }>;
  page?: Record<string, unknown>;
};
const normalizeDocumentStyleProfile = (profile: DocumentStyleProfile): DocumentStyleProfile => structuredClone(profile);

export type HanmarkDocumentStylePresetId =
  | "kordoc-default"
  | "korean-communication"
  | "youth-studies"
  | "custom";

// i18n-data-begin: built-in template names; templateLibrary also uses them for duplicate-name checks and stored names
export const DOCUMENT_STYLE_PRESET_LABELS: Record<HanmarkDocumentStylePresetId, string> = {
  "kordoc-default": "Kordoc 기본",
  "korean-communication": "한국언론학회",
  "youth-studies": "청소년학",
  custom: "사용자 문서 스타일"
};
// i18n-data-end

const PAGE = {
  widthHu: 59_530,
  heightHu: 84_190,
  landscape: "WIDELY" as const,
  gutterType: "LEFT_ONLY",
  margins: { top: 4_255, bottom: 4_960, left: 7_200, right: 7_200, header: 4_250, footer: 2_240, gutter: 0 }
};

function character(
  fontFamily: string,
  fontSizePt: number,
  bold: boolean,
  widthPercent: number,
  letterSpacingPercent: number
) {
  return {
    fontFamily,
    latinFontFamily: fontFamily,
    fontSizePt,
    bold,
    italic: false,
    underline: false,
    color: "#000000",
    widthPercent,
    letterSpacingPercent
  };
}

function paragraph(
  alignment: "LEFT" | "CENTER" | "JUSTIFY",
  lineSpacingPercent: number,
  firstLineIndentHu = 0,
  spaceBeforeHu = 0,
  keepWithNext = true
) {
  return {
    alignment,
    lineSpacingPercent,
    firstLineIndentHu,
    marginLeftHu: 0,
    marginRightHu: 0,
    spaceBeforeHu,
    spaceAfterHu: 0,
    keepWithNext
  };
}

// i18n-data-begin: preset names (same as the built-in template names), source file names, HWPX style names, fonts
const KOREAN_COMMUNICATION: DocumentStyleProfile = {
  schemaVersion: 3,
  name: "한국언론학회",
  sourceName: "한국언론학회 템플릿.hwpx",
  roles: {
    body: {
      styleName: "바탕글",
      character: character("신명조", 10, false, 95, -10),
      paragraph: paragraph("JUSTIFY", 160, 1_000, 0, false)
    },
    h1: { styleName: "제목 1", character: character("맑은 고딕", 14, true, 95, -10), paragraph: paragraph("CENTER", 160) },
    h2: { styleName: "제목 2", character: character("HY견고딕", 10, false, 95, -10), paragraph: paragraph("JUSTIFY", 160) },
    h3: { styleName: "제목 3", character: character("맑은 고딕", 10, true, 100, 0), paragraph: paragraph("JUSTIFY", 160) },
    h4: { styleName: "제목 4", character: character("신명조", 10, true, 100, 0), paragraph: paragraph("JUSTIFY", 160) },
    h5: { styleName: "제목 5", character: character("휴먼명조", 13, true, 100, 0), paragraph: paragraph("LEFT", 180) },
    h6: { styleName: "제목 6", character: character("맑은 고딕", 10, true, 100, 0), paragraph: paragraph("LEFT", 180, 0, 1_000) }
  },
  page: PAGE
};

const YOUTH_STUDIES: DocumentStyleProfile = {
  schemaVersion: 3,
  name: "청소년학",
  sourceName: "청소년학 템플릿.hwpx",
  roles: {
    body: {
      styleName: "바탕글",
      character: character("휴먼명조", 10, false, 95, 0),
      paragraph: paragraph("JUSTIFY", 170, 1_000, 0, false)
    },
    h1: { styleName: "제목 1", character: character("휴먼명조", 15, true, 95, 0), paragraph: paragraph("CENTER", 170) },
    h2: { styleName: "제목 2", character: character("휴먼명조", 12, true, 95, 0), paragraph: paragraph("CENTER", 170) },
    h3: { styleName: "제목 3", character: character("휴먼명조", 11, true, 95, 0), paragraph: paragraph("LEFT", 170) },
    h4: { styleName: "제목 4", character: character("휴먼명조", 11, true, 100, 0), paragraph: paragraph("LEFT", 170) },
    h5: { styleName: "제목 5", character: character("휴먼명조", 13, true, 100, 0), paragraph: paragraph("LEFT", 180) },
    h6: { styleName: "제목 6", character: character("맑은 고딕", 10, true, 100, 0), paragraph: paragraph("LEFT", 180, 0, 1_000) }
  },
  page: PAGE
};
// i18n-data-end

export function isDocumentStylePresetId(value: unknown): value is HanmarkDocumentStylePresetId {
  return typeof value === "string" && value in DOCUMENT_STYLE_PRESET_LABELS;
}

export function builtInDocumentStyleProfile(
  preset: HanmarkDocumentStylePresetId
): DocumentStyleProfile | undefined {
  const source = preset === "korean-communication"
    ? KOREAN_COMMUNICATION
    : preset === "youth-studies"
      ? YOUTH_STUDIES
      : undefined;
  return source ? normalizeDocumentStyleProfile(source) : undefined;
}
