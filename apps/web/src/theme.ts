import { useEffect, useState } from "react";

// Light / dark skin from the Achmage vault (Minimal style settings + CMDS Achmage skins).
// "system" follows the OS setting; the resolved theme lands on <html data-theme>.

export type ThemePref = "system" | "light" | "dark";
export type Theme = "light" | "dark";

const KEY = "workbench.theme";
const query = () => window.matchMedia("(prefers-color-scheme: dark)");

export function readThemePref(): ThemePref {
  const stored = localStorage.getItem(KEY);
  return stored === "light" || stored === "dark" ? stored : "system";
}

export function resolveTheme(pref: ThemePref): Theme {
  if (pref !== "system") return pref;
  return query().matches ? "dark" : "light";
}

export function applyTheme(pref: ThemePref) {
  const theme = resolveTheme(pref);
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(readThemePref);
  const [theme, setTheme] = useState<Theme>(() => resolveTheme(pref));

  useEffect(() => {
    applyTheme(pref);
    setTheme(resolveTheme(pref));
    if (pref !== "system") return;
    const media = query();
    const onChange = () => {
      applyTheme("system");
      setTheme(resolveTheme("system"));
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [pref]);

  const choose = (next: ThemePref) => {
    if (next === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
    setPref(next);
  };
  return { pref, theme, choose };
}
