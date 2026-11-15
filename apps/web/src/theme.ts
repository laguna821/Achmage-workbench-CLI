import { useEffect, useState } from "react";
import { ATLAS_SETS, DEFAULT_SET, WORKBENCH_SET } from "./styles/atlas-sets.ts";

// Screen theme. The choice lives in the gateway's screen preferences; a local copy of the last
// resolved theme only paints the first frame before the app has loaded them.

export type ThemePref = "system" | "light" | "dark";
export type Theme = "light" | "dark";
/**
 * 색 조합 (설정 › 화면): a person keeps ONE light set and ONE dark set. A set is one of Atlas File Manager's
 * colour sets (styles/atlas-sets.ts; each has a mode) or Workbench (navy rail, teal; both modes).
 */
export type PaletteChoice = { light: string; dark: string };
export type PaletteSet = { id: string; name: string; mode: Theme };
/** The sets of each mode in the order they are offered: the default first, Workbench last. */
export const PALETTE_SETS: Record<Theme, PaletteSet[]> = {
  light: [...ATLAS_SETS.filter((set) => set.mode === "light").map(({ id, name, mode }) => ({ id, name, mode })), { id: WORKBENCH_SET, name: "Workbench", mode: "light" }],
  dark: [...ATLAS_SETS.filter((set) => set.mode === "dark").map(({ id, name, mode }) => ({ id, name, mode })), { id: WORKBENCH_SET, name: "Workbench", mode: "dark" }],
};
const isSetOf = (mode: Theme, value: unknown): value is string => PALETTE_SETS[mode].some((set) => set.id === value);

const FIRST_PAINT_KEY = "workbench.firstPaintTheme";
const FIRST_PAINT_PALETTE_KEY = "workbench.firstPaintPalette";
const FIRST_PAINT_FONT_KEY = "workbench.firstPaintFont";
const media = () => window.matchMedia("(prefers-color-scheme: dark)");

export const isThemePref = (value: unknown): value is ThemePref => value === "system" || value === "light" || value === "dark";
/**
 * The stored choice (this PC's screen preferences: `paletteLight`, `paletteDark`). A mode without its field
 * reads the record of before the sets (`palette`): "workbench" was Workbench for both modes; anything else,
 * or nothing, is the default pair (Atlas Light and Graphite), as it always looked.
 */
export function readPalettes(prefs: { palette?: unknown; paletteLight?: unknown; paletteDark?: unknown } | null | undefined): PaletteChoice {
  const old = prefs?.palette === WORKBENCH_SET;
  return {
    light: isSetOf("light", prefs?.paletteLight) ? prefs.paletteLight : old ? WORKBENCH_SET : DEFAULT_SET.light,
    dark: isSetOf("dark", prefs?.paletteDark) ? prefs.paletteDark : old ? WORKBENCH_SET : DEFAULT_SET.dark,
  };
}
/** The first paint's copy: "<light> <dark>"; a copy of before the sets ("atlas" or "workbench") reads as the old record did. */
function readFirstPaintPalette(stored: string | null): PaletteChoice {
  const [light, dark] = (stored ?? "").split(" ");
  return dark === undefined ? readPalettes({ palette: stored }) : readPalettes({ paletteLight: light, paletteDark: dark });
}

export function resolveTheme(pref: ThemePref, system: Theme): Theme {
  return pref === "system" ? system : pref;
}

/** Before React renders: last theme the window showed, else the system's. */
export function applyFirstPaintTheme() {
  const stored = localStorage.getItem(FIRST_PAINT_KEY);
  const theme: Theme = stored === "light" || stored === "dark" ? stored : media().matches ? "dark" : "light";
  setRootTheme(theme);
  setRootPalette(readFirstPaintPalette(localStorage.getItem(FIRST_PAINT_PALETTE_KEY)));
  setRootUiFont(readUiFont(localStorage.getItem(FIRST_PAINT_FONT_KEY)));
}

export function setRootTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  localStorage.setItem(FIRST_PAINT_KEY, theme);
}

/**
 * The chosen sets on <html>: `data-palette-light` and `data-palette-dark` (tokens.css's set blocks; each applies
 * in its own mode, also to a pane that keeps the other mode); Workbench sets nothing for its mode.
 */
export function setRootPalette(choice: PaletteChoice) {
  const root = document.documentElement;
  if (choice.light === WORKBENCH_SET) delete root.dataset.paletteLight; else root.dataset.paletteLight = choice.light;
  if (choice.dark === WORKBENCH_SET) delete root.dataset.paletteDark; else root.dataset.paletteDark = choice.dark;
  localStorage.setItem(FIRST_PAINT_PALETTE_KEY, `${choice.light} ${choice.dark}`);
}
/** The set an element is drawn in: the chosen set of its own mode (none for Workbench). The editors' chrome is sent this. */
export function paletteOf(theme: Theme): string | undefined {
  return document.documentElement.dataset[theme === "dark" ? "paletteDark" : "paletteLight"];
}

/** 사용 한도 표시 (설정 › 화면): 목록 칸 아래 (the default; old records), 창 아래 줄, 숨기기. */
export type UsagePlace = "list" | "bottom" | "hidden";
export const readUsagePlace = (value: unknown): UsagePlace => (value === "bottom" || value === "hidden" ? value : "list");

/** 글꼴 (설정 › 화면): "pretendard" (the default; old records), "system", or "custom:<family>". */
export type UiFont = string;
export const readUiFont = (value: unknown): UiFont =>
  value === "system" || (typeof value === "string" && /^custom:.+/.test(value.trim())) ? (value as string).trim() : "pretendard";
/** The stack the choice puts on <html> (none for Pretendard); a named face falls back to Pretendard. */
export function uiFontStack(font: UiFont): string | null {
  if (font === "system") return "var(--font-system)";
  if (font.startsWith("custom:")) return `"${font.slice(7).replace(/["\\]/g, "")}", var(--font-pretendard)`;
  return null;
}
export function setRootUiFont(font: UiFont) {
  const stack = uiFontStack(font);
  if (stack) document.documentElement.style.setProperty("--font-choice", stack);
  else document.documentElement.style.removeProperty("--font-choice");
  localStorage.setItem(FIRST_PAINT_FONT_KEY, font);
}

export function useSystemTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(() => (media().matches ? "dark" : "light"));
  useEffect(() => {
    const query = media();
    const onChange = () => setTheme(query.matches ? "dark" : "light");
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return theme;
}
