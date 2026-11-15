import { createContext, useContext, type CSSProperties, type MouseEvent } from "react";
import type { Provider } from "@workbench/contracts";
import type { Theme } from "./theme.ts";

// HIG defaults share one visual system across providers. Explicit per-engine customization
// remains available; old bundled defaults migrate without overwriting deliberate custom values.

export type Bubble = "filled" | "soft" | "rail";
export type Glow = "off" | "soft" | "neon";
export type EngineMode = "follow" | Theme;

export type Palette = {
  bg: string;
  surface: string;
  text: string;
  muted: string;
  line: string;
  accent: string;
  motion: string;
  heading: string;
  headingAlt: string;
  strong: string;
  link: string;
  codeBg: string;
  codeText: string;
};

export type Look = {
  palette: Palette;
  /** Font preset id, or "custom:<family>". */
  font: string;
  fontSize: number;
  lineHeight: number;
  fontWeight: number;
  /** User bubble: filled (Conversation Studio), soft, or rail cards (Operator Console). */
  bubble: Bubble;
  borderWidth: number;
  radius: number;
  glow: Glow;
  /** Paint the engine color around the input box even while idle. */
  frame: boolean;
};

export type EngineAppearance = { mode: EngineMode; light: Look; dark: Look };
/** Versioned defaults let installed clients receive the current design without losing custom looks. */
export type Appearance = Record<Provider, EngineAppearance> & { v?: number };

/** What the engine colour affects now (S9): said where it is chosen. */
export const ENGINE_COLOR_HINT = "엔진 표시 색은 이 엔진의 표시(마크)에만 쓰입니다. 탭, 칸, 선, 입력창 테두리는 앱의 색을 따릅니다.";

export const PALETTE_FIELDS: { key: keyof Palette; label: string }[] = [
  { key: "bg", label: "화면 배경" },
  { key: "surface", label: "입력창 · 카드" },
  { key: "text", label: "본문 글자" },
  { key: "muted", label: "보조 글자" },
  { key: "line", label: "선" },
  { key: "accent", label: "엔진 표시 색" },
  { key: "motion", label: "빛 궤적 보조색" },
  { key: "heading", label: "제목" },
  { key: "headingAlt", label: "작은 제목 · 기울임" },
  { key: "strong", label: "굵은 글씨" },
  { key: "link", label: "링크" },
  { key: "codeBg", label: "코드 배경" },
  { key: "codeText", label: "코드 글자" },
];

export const FONT_PRESETS: { id: string; label: string; family: string | null; stack: string }[] = [
  { id: "pretendard", label: "Pretendard Variable · 기본", family: "Pretendard Variable", stack: '"Pretendard Variable", var(--font-fallback)' },
  { id: "sametone", label: "Achmage SameTone", family: "Achmage SameTone", stack: '"Achmage SameTone", var(--font-fallback)' },
  { id: "serif", label: "명조 · 마루부리", family: "MaruBuri", stack: '"MaruBuri", "NanumMyeongjo", "Noto Serif CJK KR", "Noto Serif KR", "Batang", serif' },
  { id: "square", label: "나눔스퀘어 네오", family: "NanumSquare Neo", stack: '"NanumSquare Neo", "NanumSquare", var(--font-fallback)' },
  { id: "round", label: "나눔스퀘어 라운드", family: "NanumSquareRound", stack: '"NanumSquareRound", var(--font-fallback)' },
  { id: "gothic", label: "본고딕 · Noto Sans", family: "Noto Sans KR", stack: '"Noto Sans KR", "Noto Sans CJK KR", var(--font-fallback)' },
  { id: "mono", label: "고정폭", family: null, stack: "var(--mono)" },
];

// Achmage vault, Minimal style settings (light). Codex's default light look. Body text is an ink
// tinted toward the vault's navy rather than pure black.
const ACHMAGE_LIGHT: Palette = {
  bg: "#ffffff",
  surface: "#ffffff",
  text: "#0e1726",
  muted: "#526174",
  line: "#d7e1ec",
  accent: "#005bac",
  motion: "#00ada9",
  heading: "#00102e",
  headingAlt: "#00328d",
  strong: "#002870",
  link: "#005bac",
  codeBg: "#193664",
  codeText: "#ffffff",
};

// Achmage vault, Minimal style settings (dark) with the CMDS Operator Console. Claude's default dark look.
const ACHMAGE_DARK: Palette = {
  bg: "#08090a",
  surface: "#121317",
  text: "#d7d7dc",
  muted: "#888991",
  line: "#2a2b30",
  accent: "#f27aa4",
  motion: "#00ada9",
  heading: "#f27aa4",
  headingAlt: "#ff9fbe",
  strong: "#f27aa4",
  link: "#f27aa4",
  codeBg: "#111216",
  codeText: "#ff9fbe",
};

// New: Codex at night. Keeps the light look's blue and teal on a navy-black base.
const CODEX_MIDNIGHT: Palette = {
  bg: "#070b14",
  surface: "#0e1522",
  text: "#d6deeb",
  muted: "#8a96a8",
  line: "#1f2a3c",
  accent: "#5aa9f0",
  motion: "#00ada9",
  heading: "#8cc4ff",
  headingAlt: "#6fd3cf",
  strong: "#a9d1ff",
  link: "#5aa9f0",
  codeBg: "#0a1220",
  codeText: "#7fd4cf",
};

// New: Claude by day. Warm paper and clay (a deeper clay, so white on it and it on paper read at AA).
const CLAUDE_PAPER: Palette = {
  bg: "#faf9f5",
  surface: "#ffffff",
  text: "#1f1e1b",
  muted: "#73705f",
  line: "#e6e1d6",
  accent: "#b5532f",
  motion: "#d9a05b",
  heading: "#3d2a1e",
  headingAlt: "#a4502f",
  strong: "#8a3c1f",
  link: "#b5532f",
  codeBg: "#f1ede3",
  codeText: "#7a3a1f",
};

const look = (palette: Palette, rest: Partial<Look> = {}): Look => ({
  palette,
  font: "sametone",
  fontSize: 17,
  lineHeight: 1.75,
  fontWeight: 400,
  bubble: "filled",
  borderWidth: 1,
  radius: 12,
  glow: "off",
  frame: true,
  ...rest,
});

export const APPEARANCE_VERSION = 8;

const V2_DEFAULT_APPEARANCE: Appearance = {
  claude: {
    mode: "follow",
    light: look(CLAUDE_PAPER, { bubble: "soft" }),
    dark: look(ACHMAGE_DARK, { bubble: "rail" }),
  },
  codex: {
    mode: "follow",
    light: look(ACHMAGE_LIGHT, { fontSize: 16, lineHeight: 1.7, bubble: "soft" }),
    dark: look(CODEX_MIDNIGHT, { fontSize: 16, lineHeight: 1.7, bubble: "rail" }),
  },
  v: 2,
};

// Keep the shipped v3 palette as a migration baseline, not the current brand contract.
const HIG_LIGHT: Palette = {
  bg: "#ffffff", surface: "#ffffff", text: "#000000", muted: "#6c6c70", line: "#d1d1d6",
  accent: "#1e6ef4", motion: "#008932", heading: "#000000", headingAlt: "#000000", strong: "#000000",
  link: "#1e6ef4", codeBg: "#f2f2f7", codeText: "#000000",
};
const HIG_DARK: Palette = {
  bg: "#1c1c1e", surface: "#2c2c2e", text: "#ffffff", muted: "#aeaeb2", line: "#3a3a3c",
  accent: "#5cb8ff", motion: "#4ad968", heading: "#ffffff", headingAlt: "#ffffff", strong: "#ffffff",
  link: "#5cb8ff", codeBg: "#2c2c2e", codeText: "#ffffff",
};
// v4: the Achmage 0.3 color roles on Apple system greys. Kept as the v5 migration baseline.
const V4_LIGHT: Palette = {
  ...HIG_LIGHT,
  accent: ACHMAGE_LIGHT.accent, motion: ACHMAGE_LIGHT.motion,
  heading: ACHMAGE_LIGHT.heading, headingAlt: ACHMAGE_LIGHT.headingAlt,
  strong: ACHMAGE_LIGHT.strong, link: ACHMAGE_LIGHT.link,
};
const V4_DARK: Palette = {
  ...HIG_DARK,
  accent: "#7db2f0", motion: CODEX_MIDNIGHT.motion,
  heading: CODEX_MIDNIGHT.heading, headingAlt: CODEX_MIDNIGHT.headingAlt,
  strong: CODEX_MIDNIGHT.strong, link: "#7db2f0",
};
// v5 "떠 있는 작업면": the same roles on navy-tinted neutrals, so the reading surface shares the
// navigation's colour temperature. Both engines read alike; the engine shows only as a mark.
const BRAND_LIGHT: Palette = {
  ...V4_LIGHT,
  text: "#151b27", muted: "#566173", line: "#dce1e8", codeBg: "#f1f4f8", codeText: "#151b27",
};
const V5_DARK: Palette = {
  ...V4_DARK,
  bg: "#131820", surface: "#1b222c", text: "#e8ecf2", muted: "#a3adba", line: "#2c3541", codeBg: "#1b222c", codeText: "#e8ecf2",
};
// v6: headings, small ones too, are ink in dark as they are in light (v5 drew them link blue and teal).
const BRAND_DARK: Palette = { ...V5_DARK, heading: V5_DARK.text, headingAlt: V5_DARK.text };
const higLook = (palette: Palette): Look => look(palette, {
  font: "pretendard", fontSize: 17, lineHeight: 1.75, bubble: "soft", frame: false,
});
// v7 (Hallmark U1, "Furrow"): the reading sheet on warm paper, navy ink, Achmage blue as the one
// signal, teal for "working". These are the hex mirrors of styles/tokens.css (--color-paper-2,
// --color-field, --color-ink, --color-muted, --color-rule, --color-accent, --color-teal,
// --color-paper-3); tokens.test.ts keeps them equal. A look stays hex: the colour fields edit it.
const FURROW_LIGHT: Palette = {
  bg: "#fffdf8", surface: "#fffdf8", text: "#121a2b", muted: "#5a544d", line: "#d3cbbe",
  accent: "#005bac", motion: "#00a8a3", heading: "#121a2b", headingAlt: "#121a2b", strong: "#121a2b",
  link: "#005bac", codeBg: "#f6f2ea", codeText: "#121a2b",
};
const FURROW_DARK: Palette = {
  bg: "#201c17", surface: "#26221c", text: "#ebe7e0", muted: "#ada79e", line: "#39352d",
  accent: "#76afee", motion: "#39bab4", heading: "#ebe7e0", headingAlt: "#ebe7e0", strong: "#ebe7e0",
  link: "#76afee", codeBg: "#2d2821", codeText: "#ebe7e0",
};
// v8 (Hallmark N1, the owner's direction): white work surfaces, cool neutral greys, navy ink, the
// brand teal set for marks on white; dark is a neutral dark. Hex mirrors of styles/tokens.css as above.
const N1_LIGHT: Palette = {
  bg: "#ffffff", surface: "#ffffff", text: "#131b29", muted: "#585e68", line: "#e1e4e8",
  accent: "#005bac", motion: "#008683", heading: "#131b29", headingAlt: "#131b29", strong: "#131b29",
  link: "#005bac", codeBg: "#f3f5f7", codeText: "#131b29",
};
const N1_DARK: Palette = {
  bg: "#18191b", surface: "#1c1d20", text: "#e8e9ec", muted: "#a0a5ac", line: "#2b2d30",
  accent: "#76afee", motion: "#39bab4", heading: "#e8e9ec", headingAlt: "#e8e9ec", strong: "#e8e9ec",
  link: "#76afee", codeBg: "#202225", codeText: "#e8e9ec",
};
/** Radius of a look before v7 (the cards now take the system's 10px). */
const V6_RADIUS = 12;
const furrowLook = (palette: Palette): Look => ({ ...higLook(palette), radius: 10 });
export const DEFAULT_APPEARANCE: Appearance = {
  claude: { mode: "follow", light: furrowLook(N1_LIGHT), dark: furrowLook(N1_DARK) },
  codex: { mode: "follow", light: furrowLook(N1_LIGHT), dark: furrowLook(N1_DARK) },
  v: APPEARANCE_VERSION,
};
/** The frame's look (menus opened on the frame): the paper (--color-paper) under the sheet. */
export const NEUTRAL_LOOK: Record<Theme, Look> = {
  light: furrowLook({ ...N1_LIGHT, bg: "#ffffff" }),
  dark: furrowLook({ ...N1_DARK, bg: "#101113", surface: "#18191b" }),
};

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * Defaults before the design pass. Saving any one change stores every look whole, so a stored look
 * from then carries these values even where the user chose nothing; such a value takes today's
 * default. A value the user changed stays. Only looks stored before `v` 2 are read this way.
 */
const LEGACY_DEFAULTS: Record<Provider, Record<Theme, { glow: Glow; radius: number; bubble?: Bubble; palette: Partial<Palette> }>> = {
  claude: {
    light: { glow: "soft", radius: 20, palette: { accent: "#c96442" } },
    dark: { glow: "soft", radius: 16, palette: {} },
  },
  codex: {
    // A filled accent bubble per request read as a chat app; a tinted slip reads as a request.
    light: { glow: "soft", radius: 16, bubble: "filled", palette: { text: "#000000" } },
    dark: { glow: "soft", radius: 12, palette: {} },
  },
};

const sameValue = (a: unknown, b: unknown) => (typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : a === b);

function upgradeLook(stored: Partial<Look>, base: Look, legacy: (typeof LEGACY_DEFAULTS)[Provider][Theme]): Partial<Look> {
  const next: Partial<Look> = { ...stored };
  if (sameValue(stored.glow, legacy.glow)) next.glow = base.glow;
  if (sameValue(stored.radius, legacy.radius)) next.radius = base.radius;
  if (legacy.bubble && sameValue(stored.bubble, legacy.bubble)) next.bubble = base.bubble;
  if (isObject(stored.palette)) {
    const palette: Partial<Palette> = { ...stored.palette };
    for (const [key, value] of Object.entries(legacy.palette) as [keyof Palette, string][]) {
      if (sameValue(palette[key], value)) palette[key] = base.palette[key];
    }
    next.palette = palette as Palette;
  }
  return next;
}

/** Quick choices for the right-click menu and the settings sheet. */
export const ACCENT_SWATCHES: Record<Theme, string[]> = {
  light: ["#005bac", "#b5532f", "#0e8a6a", "#6b4fd8", "#c2410c", "#be185d", "#0891b2", "#1f2937"],
  dark: ["#7db2f0", "#f27aa4", "#e08a6b", "#2bc48a", "#a78bfa", "#fb923c", "#22d3ee", "#e5e7eb"],
};

export const BG_SWATCHES: Record<Theme, string[]> = {
  light: ["#ffffff", "#faf9f5", "#f7f9fc", "#f3f8f6", "#f6f4fb", "#fbf3f6"],
  dark: ["#08090a", "#070b14", "#121212", "#09100e", "#100c17", "#14100d"],
};

/** Stored preferences merged over the defaults, so new options get sane values. */
export function readAppearance(stored: unknown): Appearance {
  const source = isObject(stored) ? stored : {};
  const version = typeof source.v === "number" ? source.v : 1;
  const mergeLook = (provider: Provider, theme: Theme, value: unknown): Look => {
    const base = DEFAULT_APPEARANCE[provider][theme];
    let given = isObject(value) ? (value as Partial<Look>) : {};
    const previous = V2_DEFAULT_APPEARANCE[provider][theme];
    if (version < 2) given = upgradeLook(given, previous, LEGACY_DEFAULTS[provider][theme]);
    if (version < 3) {
      const migrated: Partial<Look> = { ...given };
      for (const key of Object.keys(previous) as (keyof Look)[]) {
        if (key !== "palette" && sameValue(given[key], previous[key])) Object.assign(migrated, { [key]: base[key] });
      }
      if (isObject(given.palette)) {
        const palette = { ...given.palette };
        for (const key of Object.keys(previous.palette) as (keyof Palette)[]) {
          if (sameValue(palette[key], previous.palette[key])) palette[key] = base.palette[key];
        }
        migrated.palette = palette;
      }
      given = migrated;
    }
    // A stored value moves only if it equals the default of the version it was saved under.
    if ((version === 3 || version === 4) && isObject(given.palette)) {
      const prior = version === 3 ? (theme === "dark" ? HIG_DARK : HIG_LIGHT) : (theme === "dark" ? V4_DARK : V4_LIGHT);
      const palette = { ...given.palette };
      for (const key of Object.keys(prior) as (keyof Palette)[]) {
        if (sameValue(palette[key], prior[key])) palette[key] = base.palette[key];
      }
      given = { ...given, palette };
    }
    if (version === 5 && theme === "dark" && isObject(given.palette)) {
      const palette = { ...given.palette };
      for (const key of ["heading", "headingAlt"] as const) if (sameValue(palette[key], V5_DARK[key])) palette[key] = base.palette[key];
      given = { ...given, palette: palette as Palette };
    }
    // v7: a colour still at the v5/v6 default takes the Furrow paper and ink; a colour the user
    // chose stays. The v6 card radius (12) takes the system's 10.
    if ((version === 5 || version === 6) && isObject(given.palette)) {
      const prior = theme === "dark" ? (version === 5 ? V5_DARK : BRAND_DARK) : BRAND_LIGHT;
      const palette = { ...given.palette };
      for (const key of Object.keys(prior) as (keyof Palette)[]) if (sameValue(palette[key], prior[key])) palette[key] = base.palette[key];
      given = { ...given, palette: palette as Palette };
    }
    if (version >= 3 && version < 7 && sameValue(given.radius, V6_RADIUS)) given = { ...given, radius: base.radius };
    // v8: a colour still at the v7 (Furrow) default takes the N1 white and grey; one the user chose stays.
    if (version === 7 && isObject(given.palette)) {
      const prior = theme === "dark" ? FURROW_DARK : FURROW_LIGHT;
      const palette = { ...given.palette };
      for (const key of Object.keys(prior) as (keyof Palette)[]) if (sameValue(palette[key], prior[key])) palette[key] = base.palette[key];
      given = { ...given, palette: palette as Palette };
    }
    return { ...base, ...given, palette: { ...base.palette, ...(isObject(given.palette) ? given.palette : {}) } };
  };
  const merge = (provider: Provider): EngineAppearance => {
    const value = isObject(source[provider]) ? source[provider] : {};
    const mode = value.mode === "light" || value.mode === "dark" ? value.mode : "follow";
    return { mode, light: mergeLook(provider, "light", value.light), dark: mergeLook(provider, "dark", value.dark) };
  };
  return { claude: merge("claude"), codex: merge("codex"), v: APPEARANCE_VERSION };
}

export const engineTheme = (engine: EngineAppearance, appTheme: Theme): Theme => (engine.mode === "follow" ? appTheme : engine.mode);

export function fontStack(font: string) {
  if (font.startsWith("custom:")) return `"${font.slice(7).replace(/"/g, "")}", var(--font-fallback)`;
  return (FONT_PRESETS.find((preset) => preset.id === font) ?? FONT_PRESETS[0]).stack;
}

/** Readable text color on top of a color (WCAG relative luminance). */
export function onColor(hex: string) {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return "#ffffff";
  const value = parseInt(match[1], 16);
  const channel = (shift: number) => {
    const c = ((value >> shift) & 255) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
  // Compare the actual contrast pairs. A brightness cutoff left bright blue
  // controls with white text below 3:1 in dark mode.
  const whiteContrast = 1.05 / (luminance + 0.05);
  const blackContrast = (luminance + 0.05) / 0.05;
  return blackContrast >= whiteContrast ? "#000000" : "#ffffff";
}

const GLOW: Record<Glow, string> = { off: "0", soft: "var(--theme-glow)", neon: "1.7" };

/**
 * Skin 2 (S9): an engine's colour ("엔진 색", `palette.accent`) is drawn ONLY on that engine's own
 * mark (EngineMark, and so the message's small author mark). It never paints a scope's accent, a
 * tab, a chip, a rule or a frame. The stored value is kept as it was; only where it applies changed.
 * The look scope's accent is the app's own interaction accent (tokens.css: the deep teal, per theme).
 */
const SCOPE_ACCENT = { "--accent": "var(--color-teal-ink)", "--on-accent": "var(--color-accent-ink)" } as const;

/** The default engine colours of every version a look could carry unchanged (no colour of the person's own). */
const DEFAULT_ACCENTS = new Set(
  [N1_LIGHT, N1_DARK, FURROW_LIGHT, FURROW_DARK, BRAND_LIGHT, V5_DARK, V4_LIGHT, V4_DARK, HIG_LIGHT, HIG_DARK].map((palette) => palette.accent.toLowerCase()),
);

/** The default link colours of every look version (the person never chose these). */
const DEFAULT_LINKS = new Set(
  [N1_LIGHT, N1_DARK, FURROW_LIGHT, FURROW_DARK, BRAND_LIGHT, V5_DARK, V4_LIGHT, V4_DARK, HIG_LIGHT, HIG_DARK].map((palette) => palette.link.toLowerCase()),
);

/** The link colour a person gave a look, or null while it keeps a stored default. */
export function ownLinkColor(value: Look): string | null {
  const link = value.palette.link;
  return typeof link === "string" && link.trim() && !DEFAULT_LINKS.has(link.trim().toLowerCase()) ? link : null;
}

/** The colour a person gave an engine (its mark takes it), or null while the look keeps a default. */
export function ownEngineColor(value: Look): string | null {
  const accent = value.palette.accent;
  return typeof accent === "string" && accent.trim() && !DEFAULT_ACCENTS.has(accent.trim().toLowerCase()) ? accent : null;
}

/**
 * 색 조합: a look colour still at today's default (the N1 hex mirrors, and the frame's look) names its role,
 * so the Atlas combination (tokens.css `--palette-look-*`) can give it Atlas's value; a colour the person
 * chose stays. Under Workbench the names are not set and the same hex is the fallback (nothing changes).
 * White is white in both combinations and is not named.
 */
const PALETTE_FOLLOW = new Map<string, string>([
  [N1_LIGHT.text, "light-ink"], [N1_LIGHT.muted, "light-muted"], [N1_LIGHT.line, "light-rule"], [N1_LIGHT.codeBg, "light-well"],
  [NEUTRAL_LOOK.dark.palette.bg, "dark-paper"], [N1_DARK.bg, "dark-sheet"], [N1_DARK.surface, "dark-field"], [N1_DARK.text, "dark-ink"],
  [N1_DARK.muted, "dark-muted"], [N1_DARK.line, "dark-rule"], [N1_DARK.codeBg, "dark-well"],
]);
const follow = (hex: string) => {
  const role = typeof hex === "string" ? PALETTE_FOLLOW.get(hex.trim().toLowerCase()) : undefined;
  return role ? `var(--palette-look-${role}, ${hex})` : hex;
};

/** Base tokens of one look. The stylesheet derives the rest on `.look-scope`. */
export function lookStyle(value: Look): CSSProperties {
  const { palette } = value;
  return {
    "--bg": follow(palette.bg),
    "--surface": follow(palette.surface),
    "--text": follow(palette.text),
    "--muted": follow(palette.muted),
    "--line": follow(palette.line),
    ...SCOPE_ACCENT,
    "--motion": palette.motion,
    "--heading": follow(palette.heading),
    "--heading-alt": follow(palette.headingAlt),
    "--strong": follow(palette.strong),
    // A link colour the person chose is kept; the stored defaults (Achmage blue) give way to the app's link teal.
    "--link": ownLinkColor(value) ?? "var(--link-default)",
    "--code-bg": follow(palette.codeBg),
    "--code-text": follow(palette.codeText),
    "--e-font": fontStack(value.font),
    "--e-size": `${value.fontSize / 16}rem`,
    "--e-line": String(value.lineHeight),
    "--e-weight": String(value.fontWeight),
    "--e-border": `${value.borderWidth}px`,
    "--e-radius": `${value.radius}px`,
    "--glow": GLOW[value.glow],
  } as CSSProperties;
}

/**
 * Formerly an engine's colour for whatever it wrapped (tabs, chips, rows, menus). Since S9 the
 * engine's colour is drawn only by its own mark (EngineMark reads it itself), so this paints
 * nothing on chrome: it only hands a mark inside the person's own engine colour, the same one the
 * mark would take anyway. Kept so callers in other units' files keep working until they drop it.
 */
export function accentStyle(value: Look): CSSProperties {
  const own = ownEngineColor(value);
  return (own ? { "--engine-own": own } : {}) as CSSProperties;
}

/** The style an engine's mark carries: the person's own engine colour, or nothing (the stylesheet's engine colour). */
export function engineMarkStyle(value: Look | null | undefined): CSSProperties | undefined {
  const own = value ? ownEngineColor(value) : null;
  return own ? ({ "--engine-own": own } as CSSProperties) : undefined;
}

/** True when a font family is actually installed or loaded (canvas width test against two fallbacks). */
export function fontAvailable(family: string) {
  const canvas = document.createElement("canvas").getContext("2d");
  if (!canvas) return true;
  const sample = "가나다라 Achmage 0123";
  return ["monospace", "serif"].some((fallback) => {
    canvas.font = `20px ${fallback}`;
    const base = canvas.measureText(sample).width;
    canvas.font = `20px "${family}", ${fallback}`;
    return canvas.measureText(sample).width !== base;
  });
}

export type LookPatch = Omit<Partial<Look>, "palette"> & { palette?: Partial<Palette> };

export type AppearanceApi = {
  appearance: Appearance;
  /** Screen theme chosen for the app (system resolved). */
  appTheme: Theme;
  /** The look an engine uses right now. */
  lookOf: (provider: Provider) => Look;
  themeOf: (provider: Provider) => Theme;
  updateLook: (provider: Provider, theme: Theme, patch: LookPatch) => void;
  setMode: (provider: Provider, mode: EngineMode) => void;
  resetLook: (provider: Provider, theme: Theme) => void;
  openMenu: (event: MouseEvent, provider: Provider) => void;
  openSettings: (provider?: Provider, theme?: Theme) => void;
};

export const AppearanceContext = createContext<AppearanceApi | null>(null);

export function useAppearance() {
  const value = useContext(AppearanceContext);
  if (!value) throw new Error("AppearanceContext missing");
  return value;
}
