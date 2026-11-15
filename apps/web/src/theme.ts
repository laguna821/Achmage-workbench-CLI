import { useEffect, useState } from "react";

// Screen theme. The choice lives in the gateway's screen preferences; a local copy of the last
// resolved theme only paints the first frame before the app has loaded them.

export type ThemePref = "system" | "light" | "dark";
export type Theme = "light" | "dark";
/** 색 조합 (설정 › 화면): Atlas (the default, Atlas File Manager's colours, tokens.css) or Workbench (navy rail, teal). */
export type PaletteId = "workbench" | "atlas";

const FIRST_PAINT_KEY = "workbench.firstPaintTheme";
const FIRST_PAINT_PALETTE_KEY = "workbench.firstPaintPalette";
const FIRST_PAINT_FONT_KEY = "workbench.firstPaintFont";
const media = () => window.matchMedia("(prefers-color-scheme: dark)");

export const isThemePref = (value: unknown): value is ThemePref => value === "system" || value === "light" || value === "dark";
/** The owner (2026-11-15): Atlas is the default — a record without the field (or with anything else) is Atlas; only an explicit "workbench" is Workbench. */
export const readPalette = (value: unknown): PaletteId => (value === "workbench" ? "workbench" : "atlas");

export function resolveTheme(pref: ThemePref, system: Theme): Theme {
  return pref === "system" ? system : pref;
}

/** Before React renders: last theme the window showed, else the system's. */
export function applyFirstPaintTheme() {
  const stored = localStorage.getItem(FIRST_PAINT_KEY);
  const theme: Theme = stored === "light" || stored === "dark" ? stored : media().matches ? "dark" : "light";
  setRootTheme(theme);
  setRootPalette(readPalette(localStorage.getItem(FIRST_PAINT_PALETTE_KEY)));
  setRootUiFont(readUiFont(localStorage.getItem(FIRST_PAINT_FONT_KEY)));
}

export function setRootTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  localStorage.setItem(FIRST_PAINT_KEY, theme);
}

/** The colour combination on <html>: tokens.css's `[data-palette="atlas"]` blocks; Workbench sets nothing. */
export function setRootPalette(palette: PaletteId) {
  if (palette === "atlas") document.documentElement.dataset.palette = "atlas";
  else delete document.documentElement.dataset.palette;
  localStorage.setItem(FIRST_PAINT_PALETTE_KEY, palette);
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
