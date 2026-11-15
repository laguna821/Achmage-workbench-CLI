// From Achmage HOP @ d533eb4360db034cd45d87b0751c0d742c6d6ca6 (apps/studio-host/src/core/font-authoring-policy.ts). MIT; see LICENSE.
// Adapted for Workbench: the really-installed families are passed in (from the gateway's font
// catalogue) as a lookup of name keys made once per catalogue, with the Korean / English names of
// the same face treated as one (aliases from HOP's font-catalog.ts), instead of module state.
/**
 * Hancom's bundled HY / 휴먼 / HCI faces are not offered for authoring unless the PC really has
 * them: a document keeps such a name, but new text gets 함초롬바탕 (명조·바탕·궁서) or 함초롬돋움.
 */
const SANS_FALLBACK = "함초롬돋움";
const SERIF_FALLBACK = "함초롬바탕";

const BLOCKED_FONT_KEYS = new Set([
  "hy헤드라인m",
  "hyheadlinem",
  "hyheadlinemedium",
  "hy견고딕",
  "hygothicextra",
  "hy그래픽",
  "hy그래픽m",
  "hygraphicmedium",
  "hy견명조",
  "hymyeongjoextra",
  "hy신명조",
  "hy중고딕",
  "휴먼명조",
  "휴먼고딕",
  "휴먼옛체",
  "휴먼매직체",
  "휴먼편지체",
  "휴먼둥근헤드라인",
  "hcipoppy",
]);

/** The same face under its Korean and English names (HOP's font-catalog.ts pairs, plus 휴먼명조). */
const ALIAS_GROUPS = [
  ["hy헤드라인m", "hyheadlinem", "hyheadlinemedium"],
  ["hy견고딕", "hygothicextra"],
  ["hy그래픽", "hy그래픽m", "hygraphicmedium"],
  ["hy견명조", "hymyeongjoextra"],
  ["휴먼명조", "humanmyeongjo"],
];
const ALIASES = new Map(ALIAS_GROUPS.flatMap(group => group.map(key => [key, group] as const)));

/** Installed family names as keys (with their aliases), made once per catalogue by installedFontKeys. */
export type InstalledFamilies = ReadonlySet<string>;

export function installedFontKeys(families: Iterable<string>): InstalledFamilies {
  const keys = new Set<string>();
  for (const family of families) {
    const key = fontFamilyKey(family);
    if (key) for (const name of ALIASES.get(key) ?? [key]) keys.add(name);
  }
  return keys;
}

export function isAuthoringBlockedFontFamily(family: string | null | undefined, installed: InstalledFamilies = new Set()): boolean {
  const key = fontFamilyKey(family);
  if (!key) return false;
  const pattern = BLOCKED_FONT_KEYS.has(key) || key.startsWith("휴먼") || key.startsWith("hci") || /^hy(?:[가-힣]|headline|gothic|graphic|myeong|mj|gt|gp|sn|sm)/i.test(key);
  return pattern && !installed.has(key);
}

/** 함초롬바탕 for 명조 / 바탕 / 궁서 / serif names, else 함초롬돋움 (also what a missing font is drawn like). */
export function authoringFallbackForFontFamily(family: string | null | undefined): string {
  const key = fontFamilyKey(family);
  if (key.includes("명조") || key.includes("바탕") || key.includes("궁서") || key.includes("myeong") || key.includes("serif")) return SERIF_FALLBACK;
  return SANS_FALLBACK;
}

export function sanitizeAuthoringFontFamily(family: string, installed?: InstalledFamilies): string {
  const trimmed = family.trim();
  if (!trimmed) return trimmed;
  return isAuthoringBlockedFontFamily(trimmed, installed) ? authoringFallbackForFontFamily(trimmed) : trimmed;
}

export function filterAuthoringFontFamilies(families: Iterable<string>, installed?: InstalledFamilies): string[] {
  return Array.from(families).map(family => family.trim()).filter(family => family && !isAuthoringBlockedFontFamily(family, installed));
}

export function fontFamilyKey(family: string | null | undefined): string {
  return (family ?? "").trim().replace(/["']/g, "").replace(/[\s_-]+/g, "").toLocaleLowerCase("ko-KR");
}
