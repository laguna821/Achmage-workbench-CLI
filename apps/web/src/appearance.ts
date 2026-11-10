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

export const PALETTE_FIELDS: { key: keyof Palette; label: string }[] = [
  { key: "bg", label: "화면 배경" },
  { key: "surface", label: "입력창 · 카드" },
  { key: "text", label: "본문 글자" },
  { key: "muted", label: "보조 글자" },
  { key: "line", label: "선" },
  { key: "accent", label: "엔진 색" },
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

export const APPEARANCE_VERSION = 3;

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
  v: APPEARANCE_VERSION,
};

// Neutral HIG roles. These match foundation.css; provider identity is carried by its label/icon.
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
const higLook = (palette: Palette): Look => look(palette, {
  font: "pretendard", fontSize: 17, lineHeight: 1.75, bubble: "soft", frame: false,
});
export const DEFAULT_APPEARANCE: Appearance = {
  claude: { mode: "follow", light: higLook(HIG_LIGHT), dark: higLook(HIG_DARK) },
  codex: { mode: "follow", light: higLook(HIG_LIGHT), dark: higLook(HIG_DARK) },
  v: APPEARANCE_VERSION,
};
export const NEUTRAL_LOOK: Record<Theme, Look> = {
  light: higLook({ ...HIG_LIGHT, bg: "#f2f2f7" }),
  dark: higLook(HIG_DARK),
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
  light: ["#1e6ef4", "#b5532f", "#0e8a6a", "#6b4fd8", "#c2410c", "#be185d", "#0891b2", "#1f2937"],
  dark: ["#5cb8ff", "#f27aa4", "#e08a6b", "#2bc48a", "#a78bfa", "#fb923c", "#22d3ee", "#e5e7eb"],
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

/** Base tokens of one look. The stylesheet derives the rest on `.look-scope`. */
export function lookStyle(value: Look): CSSProperties {
  const { palette } = value;
  return {
    "--bg": palette.bg,
    "--surface": palette.surface,
    "--text": palette.text,
    "--muted": palette.muted,
    "--line": palette.line,
    "--accent": palette.accent,
    "--on-accent": onColor(palette.accent),
    "--motion": palette.motion,
    "--heading": palette.heading,
    "--heading-alt": palette.headingAlt,
    "--strong": palette.strong,
    "--link": palette.link,
    "--code-bg": palette.codeBg,
    "--code-text": palette.codeText,
    "--e-font": fontStack(value.font),
    "--e-size": `${value.fontSize / 16}rem`,
    "--e-line": String(value.lineHeight),
    "--e-weight": String(value.fontWeight),
    "--e-border": `${value.borderWidth}px`,
    "--e-radius": `${value.radius}px`,
    "--glow": GLOW[value.glow],
  } as CSSProperties;
}

/** Only an engine's color, for marks and tabs of an engine that is not in focus. */
export function accentStyle(value: Look): CSSProperties {
  return { "--accent": value.palette.accent, "--on-accent": onColor(value.palette.accent) } as CSSProperties;
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
