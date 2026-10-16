import { useEffect, useState } from "react";

// Screen theme. The choice lives in the gateway's screen preferences; a local copy of the last
// resolved theme only paints the first frame before the app has loaded them.

export type ThemePref = "system" | "light" | "dark";
export type Theme = "light" | "dark";

const FIRST_PAINT_KEY = "workbench.firstPaintTheme";
const media = () => window.matchMedia("(prefers-color-scheme: dark)");

export const isThemePref = (value: unknown): value is ThemePref => value === "system" || value === "light" || value === "dark";

export function resolveTheme(pref: ThemePref, system: Theme): Theme {
  return pref === "system" ? system : pref;
}

/** Before React renders: last theme the window showed, else the system's. */
export function applyFirstPaintTheme() {
  const stored = localStorage.getItem(FIRST_PAINT_KEY);
  const theme: Theme = stored === "light" || stored === "dark" ? stored : media().matches ? "dark" : "light";
  setRootTheme(theme);
}

export function setRootTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  localStorage.setItem(FIRST_PAINT_KEY, theme);
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
