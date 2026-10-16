import { createContext, useContext, type CSSProperties, type MouseEvent } from "react";
import type { Provider } from "@workbench/contracts";
import type { Theme } from "./theme.ts";

// Per-engine looks. Every engine has its own light look and its own dark look (four in all), so a
// Claude conversation and a Codex conversation differ in color, type and frame, not only in a tab
// label. The look of the engine in focus covers the whole window.

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
export type Appearance = Record<Provider, EngineAppearance>;

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
  { id: "sametone", label: "Achmage SameTone", family: "Achmage SameTone", stack: '"Achmage SameTone", var(--font-fallback)' },
  { id: "serif", label: "명조 · 마루부리", family: "MaruBuri", stack: '"MaruBuri", "NanumMyeongjo", "Noto Serif CJK KR", "Noto Serif KR", "Batang", serif' },
  { id: "square", label: "나눔스퀘어 네오", family: "NanumSquare Neo", stack: '"NanumSquare Neo", "NanumSquare", var(--font-fallback)' },
  { id: "round", label: "나눔스퀘어 라운드", family: "NanumSquareRound", stack: '"NanumSquareRound", var(--font-fallback)' },
  { id: "gothic", label: "본고딕 · Noto Sans", family: "Noto Sans KR", stack: '"Noto Sans KR", "Noto Sans CJK KR", var(--font-fallback)' },
  { id: "mono", label: "고정폭", family: null, stack: "var(--mono)" },
];

// Achmage vault, Minimal style settings (light). Codex's default light look.
const ACHMAGE_LIGHT: Palette = {
  bg: "#ffffff",
  surface: "#ffffff",
  text: "#000000",
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

// New: Claude by day. Warm paper and clay.
const CLAUDE_PAPER: Palette = {
  bg: "#faf9f5",
  surface: "#ffffff",
  text: "#1f1e1b",
  muted: "#73705f",
  line: "#e6e1d6",
  accent: "#c96442",
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
  radius: 16,
  glow: "soft",
  frame: true,
  ...rest,
});

export const DEFAULT_APPEARANCE: Appearance = {
  claude: {
    mode: "follow",
    light: look(CLAUDE_PAPER, { bubble: "soft", radius: 20 }),
    dark: look(ACHMAGE_DARK, { bubble: "rail" }),
  },
  codex: {
    mode: "follow",
    light: look(ACHMAGE_LIGHT, { fontSize: 16, lineHeight: 1.7 }),
    dark: look(CODEX_MIDNIGHT, { fontSize: 16, lineHeight: 1.7, bubble: "rail", radius: 12 }),
  },
};

/** Quick choices for the right-click menu and the settings sheet. */
export const ACCENT_SWATCHES: Record<Theme, string[]> = {
  light: ["#005bac", "#c96442", "#0e8a6a", "#6b4fd8", "#c2410c", "#be185d", "#0891b2", "#1f2937"],
  dark: ["#f27aa4", "#5aa9f0", "#e08a6b", "#2bc48a", "#a78bfa", "#fb923c", "#22d3ee", "#e5e7eb"],
};

export const BG_SWATCHES: Record<Theme, string[]> = {
  light: ["#ffffff", "#faf9f5", "#f7f9fc", "#f3f8f6", "#f6f4fb", "#fbf3f6"],
  dark: ["#08090a", "#070b14", "#121212", "#09100e", "#100c17", "#14100d"],
};

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Stored preferences merged over the defaults, so new options get sane values. */
export function readAppearance(stored: unknown): Appearance {
  const source = isObject(stored) ? stored : {};
  const mergeLook = (base: Look, value: unknown): Look => {
    const given = isObject(value) ? (value as Partial<Look>) : {};
    return { ...base, ...given, palette: { ...base.palette, ...(isObject(given.palette) ? given.palette : {}) } };
  };
  const merge = (provider: Provider): EngineAppearance => {
    const base = DEFAULT_APPEARANCE[provider];
    const value = isObject(source[provider]) ? source[provider] : {};
    const mode = value.mode === "light" || value.mode === "dark" ? value.mode : "follow";
    return { mode, light: mergeLook(base.light, value.light), dark: mergeLook(base.dark, value.dark) };
  };
  return { claude: merge("claude"), codex: merge("codex") };
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
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
  return luminance > 0.42 ? "#0b0c0e" : "#ffffff";
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
    "--e-size": `${value.fontSize}px`,
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
