import interLatin from "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url";
import jakartaLatin from "@fontsource-variable/plus-jakarta-sans/files/plus-jakarta-sans-latin-wght-normal.woff2?url";
import type { FontFamily, FontQuery, Page } from "@/types/api";
import type { Gateway } from "./gateway";

// Fonts without a font server: the user's SameTone (shipped with Workbench) and the families
// installed on this computer. Installed families have no files (`variants: []`): the browser draws
// them from the system.

export const SAMETONE = "Achmage SameTone";

/** A variable font file offered at every weight (the face's weight picks the axis position). */
function variable(id: string, family: string, url: string, scripts: string[], popularity: number): FontFamily {
  const weights = [300, 400, 500, 600, 700, 800, 900];
  return {
    id,
    family,
    category: "sans-serif",
    scripts,
    is_variable: true,
    is_user_font: false,
    variants: weights.map((weight) => ({ weight, style: "normal" as const, url })),
    popularity,
  };
}

const sametone = variable("achmage-sametone", SAMETONE, "/fonts/sametone/fonts/AchmageSameTone%5Bwght%5D.woff2", ["korean", "latin"], 1);
/** The families doory's own presets use, shipped with the editor so older designs look the same offline. */
const bundled = [variable("doory-jakarta", "Plus Jakarta Sans", jakartaLatin, ["latin"], 2), variable("doory-inter", "Inter", interLatin, ["latin"], 3)];

export async function loadFonts(gateway: Gateway): Promise<FontFamily[]> {
  const installed = await gateway.fonts().catch(() => ({ fonts: [] }));
  const families = installed.fonts
    .filter((font) => font.family !== SAMETONE && !bundled.some((entry) => entry.family === font.family))
    .map(
      (font, index): FontFamily => ({
        id: `system-${index}`,
        family: font.family,
        category: font.category,
        scripts: font.korean ? ["korean", "latin"] : ["latin"],
        is_variable: false,
        is_user_font: false,
        variants: [],
        popularity: index + 10,
      }),
    );
  return [sametone, ...bundled, ...families];
}

export function fontLister(fonts: FontFamily[]) {
  return {
    async list(q: FontQuery): Promise<Page<FontFamily>> {
      const needle = q.q?.toLowerCase().trim();
      const filtered = fonts.filter(
        (font) => (!needle || font.family.toLowerCase().includes(needle)) && (!q.category || font.category === q.category) && (!q.script || font.scripts.includes(q.script)),
      );
      const size = q.page_size ?? 50;
      const start = ((q.page ?? 1) - 1) * size;
      return { count: filtered.length, next: start + size < filtered.length ? String((q.page ?? 1) + 1) : null, previous: null, results: filtered.slice(start, start + size) };
    },
  };
}
