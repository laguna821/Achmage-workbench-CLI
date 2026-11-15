// Test helpers: the app's own tokens (apps/web/src/styles/tokens.css) as the editor origin sees them.
// The editors run on their own origin and cannot read the app's custom properties, so chrome.css carries
// sRGB hex mirrors of them; these helpers read the app's sheet and turn its OKLCH values into the same hex.

/** The custom properties a document's root ends up with from the style sheets that match it, var() resolved. */
export function rootTokens(doc: Document): Map<string, string> {
  const raw = new Map<string, string>();
  for (const sheet of Array.from(doc.styleSheets)) for (const rule of Array.from(sheet.cssRules)) {
    // @media blocks (coarse pointer, more contrast, forced colours) are not the default screen.
    if (!("selectorText" in rule)) continue;
    const style = (rule as CSSStyleRule).style;
    let matches = false;
    try { matches = doc.documentElement.matches((rule as CSSStyleRule).selectorText); } catch { /* selector jsdom cannot read */ }
    if (!matches) continue;
    for (let i = 0; i < style.length; i++) if (style[i].startsWith("--")) raw.set(style[i], style.getPropertyValue(style[i]).trim());
  }
  const resolve = (value: string, depth = 0): string => depth > 8 ? value : value.replace(/var\((--[\w-]+)\)/g, (_, name: string) => resolve(raw.get(name) ?? `var(${name})`, depth + 1));
  return new Map([...raw].map(([name, value]) => [name, resolve(value)]));
}

/** The app's tokens in one theme (and colour combination), read from tokens.css in a document of its own (jsdom). */
export async function appTokens(theme: "light" | "dark", palette: "workbench" | "atlas" = "workbench"): Promise<Map<string, string>> {
  const { readFileSync } = await import("node:fs");
  // A document with a browsing context, so its style sheet is parsed (as the app's is).
  const frame = document.createElement("iframe"); document.body.append(frame);
  const doc = frame.contentDocument!;
  doc.documentElement.setAttribute("data-theme", theme);
  if (palette === "atlas") doc.documentElement.setAttribute("data-palette", "atlas");
  const style = doc.createElement("style"); style.textContent = readFileSync("apps/web/src/styles/tokens.css", "utf8"); doc.head.append(style);
  const tokens = rootTokens(doc); frame.remove();
  return tokens;
}

// The app's token as sRGB hex: #hex, oklch(L% C H) or color-mix(in oklab, a p%, b) (tokens.css writes these).
type Oklab = [number, number, number];
function oklabOf(value: string): Oklab {
  const v = value.trim();
  const ok = /^oklch\(\s*([\d.]+)%\s*([\d.]+)\s+([\d.]+)\s*\)$/.exec(v);
  if (ok) { const h = Number(ok[3]) * Math.PI / 180; return [Number(ok[1]) / 100, Number(ok[2]) * Math.cos(h), Number(ok[2]) * Math.sin(h)]; }
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const [r, g, b] = [0, 2, 4].map(at => { const c = parseInt(hex[1].slice(at, at + 2), 16) / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
  }
  const mix = /^color-mix\(in oklab,\s*(.+)\)$/.exec(v);
  if (!mix) throw new Error(`not an app colour: ${v}`);
  let depth = 0, cut = -1;
  for (let i = 0; i < mix[1].length; i++) { const c = mix[1][i]; if (c === "(") depth++; else if (c === ")") depth--; else if (c === "," && depth === 0) { cut = i; break; } }
  const part = (text: string) => { const m = /^(.*?)(?:\s+(\d+(?:\.\d+)?)%)?$/.exec(text.trim())!; return { c: oklabOf(m[1]), p: m[2] === undefined ? undefined : Number(m[2]) / 100 }; };
  const a = part(mix[1].slice(0, cut)), b = part(mix[1].slice(cut + 1));
  const pa = a.p ?? (b.p === undefined ? .5 : 1 - b.p);
  return [0, 1, 2].map(i => a.c[i] * pa + b.c[i] * (1 - pa)) as Oklab;
}
export function srgbHex(value: string): string {
  const [L, A, B] = oklabOf(value);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3, m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3, s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return "#" + [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]
    .map(c => { c = Math.min(1, Math.max(0, c)); return Math.round((c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * 255).toString(16).padStart(2, "0"); }).join("");
}

/**
 * Every hex mirror in chrome.css and the app token it copies (light and dark). The editor chrome's colours
 * come only from these; chrome.test.ts fails when a mirror differs from its token or has no token here.
 */
export const CHROME_MIRRORS: Record<string, string> = {
  "--wb-ui-bg": "--surface",
  "--wb-ui-group": "--chrome-bg",
  "--wb-ui-text": "--text",
  "--wb-ui-muted": "--muted",
  "--wb-ui-line": "--line",
  "--wb-ui-focus": "--accent",
  "--wb-ui-on-accent": "--on-action",
  "--wb-ui-hover": "--surface-muted",
  "--wb-ui-selected": "--accent-soft",
  "--wb-ui-danger": "--danger",
  "--wb-ui-key": "--key-primary",
  "--wb-ui-on-key": "--on-key-primary",
};

/** The `--wb-ui-*: #hex` declarations of chrome.css's root block for one theme (and colour combination). */
export function chromeMirrors(css: string, theme: "light" | "dark", palette: "workbench" | "atlas" = "workbench"): Map<string, string> {
  const atlas = palette === "atlas" ? '[data-wb-office-palette="atlas"]' : "";
  const head = theme === "light" ? `__WB_ROOT__${atlas} {` : `__WB_ROOT__${atlas}[data-wb-office-theme="dark"] {`;
  const at = css.indexOf(head);
  if (at < 0) throw new Error(`chrome.css has no ${theme} root block`);
  const body = css.slice(at + head.length, css.indexOf("}", at));
  return new Map([...body.matchAll(/(--wb-ui-[\w-]+):\s*(#[0-9a-f]{3,8})\s*;/gi)].map(([, name, hex]) => [name, hex.toLowerCase()]));
}
