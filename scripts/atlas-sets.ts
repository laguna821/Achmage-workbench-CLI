// 색 조합: the ONE generator of the Atlas colour sets' token blocks. It reads the table of source values
// (apps/web/src/styles/atlas-sets.ts) and writes, by one rule for every set,
//   - the role tokens, the look defaults and the swatch chips into apps/web/src/styles/tokens.css,
//   - the editors' mirrors into apps/office/src/ui-adapters/chrome.css,
// each between its `generated:atlas-sets` markers. Run by hand; the output is committed;
// apps/web/src/styles/palette-atlas.test.ts fails when a committed region is not what this gives.
//
//   node scripts/atlas-sets.ts            rewrite both regions
//   node scripts/atlas-sets.ts --check    exit 1 when a committed region differs
//   node scripts/atlas-sets.ts --table    print the contrast table (markdown)
//
// The role mapping is the approved one of the default pair (tokens.css, "Atlas Light" and "Graphite", which
// stay hand-written): their values on our roles; where a value is WORDS it is mixed toward the set's ink (in
// OKLab, 1% at a time) until it reads; a filled key takes the label (white, or the set's dark) that reads better.

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ATLAS_SETS, DEFAULT_SET, type AtlasSet } from "../apps/web/src/styles/atlas-sets.ts";

// ── colour arithmetic: sRGB hex, OKLab mixing (as CSS `color-mix(in oklab, …)`), WCAG contrast ──
type Rgb = [number, number, number];
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const channels = (hex: string): Rgb => [0, 2, 4].map((at) => parseInt(hex.slice(1 + at, 3 + at), 16) / 255) as Rgb;
const toHex = (rgb: Rgb) => "#" + rgb.map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, "0")).join("");
const linear = (hex: string): Rgb => channels(hex).map(lin) as Rgb;
function oklab([r, g, b]: Rgb): Rgb {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function fromOklab([L, A, B]: Rgb): Rgb {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3, m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3, s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}
/** `color-mix(in oklab, a p%, b)` as hex. */
export function mix(a: string, percent: number, b: string): string {
  const p = percent / 100, x = oklab(linear(a)), y = oklab(linear(b));
  return toHex(fromOklab(x.map((v, i) => v * p + y[i]! * (1 - p)) as Rgb).map((c) => gam(Math.min(1, Math.max(0, c)))) as Rgb);
}
/** WCAG contrast of two opaque colours, two decimals. */
export function ratio(a: string, b: string): number {
  const y = (hex: string) => { const [r, g, b2] = linear(hex); return 0.2126 * r + 0.7152 * g + 0.0722 * b2; };
  const [hi, lo] = [y(a), y(b)].sort((p, q) => q - p);
  return Math.round(((hi! + 0.05) / (lo! + 0.05)) * 100) / 100;
}
/**
 * The 8-digit rule: our window is opaque, so a see-through value is laid over the set's own ground (source-over
 * in sRGB). The ground is the set's `background` with its alpha dropped.
 */
export function opaque(value: string, ground: string): string {
  if (value.length !== 9) return value.toLowerCase();
  const a = parseInt(value.slice(7, 9), 16) / 255, fg = channels(value.slice(0, 7)), bg = channels(ground);
  return toHex(fg.map((c, i) => c * a + bg[i]! * (1 - a)) as Rgb);
}
/** `oklch(L% C H)` (how tokens.css writes its own constants) as hex. */
function oklchHex(value: string): string {
  const m = /^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value.trim());
  if (!m) throw new Error(`not an oklch colour: ${value}`);
  const h = (Number(m[3]) * Math.PI) / 180;
  return toHex(fromOklab([Number(m[1]) / 100, Number(m[2]) * Math.cos(h), Number(m[2]) * Math.sin(h)]).map((c) => gam(Math.min(1, Math.max(0, c)))) as Rgb);
}
/** `color-mix(in srgb, a p%, b)` as hex. */
function mixSrgb(a: string, percent: number, b: string): string {
  const p = percent / 100, x = channels(a), y = channels(b);
  return toHex(x.map((v, i) => v * p + y[i]! * (1 - p)) as Rgb);
}
/** `start`, mixed toward `toward` 1% at a time until it reads `need`:1 on every ground. */
function reads(start: string, toward: string, grounds: string[], need: number): string {
  for (let p = 0; p <= 100; p++) {
    const colour = p === 0 ? start : mix(toward, p, start);
    if (grounds.every((ground) => ratio(colour, ground) >= need)) return colour;
  }
  throw new Error(`${start} never reads ${need}:1 on ${grounds.join(", ")}`);
}

// ── the rule: one set's source values → our roles ──
/**
 * A wash: `colour` at `share`% over `ground` (OKLab), taking 1% more until it stands `off`:1 from the ground.
 * `off` is how far the default pair's own wash of that role stands off (measured, a little under); on a
 * near-black ground a small share vanishes, and the selected row, the rail's current item or a hairline with it.
 */
function tint(colour: string, share: number, ground: string, off: number): { colour: string; share: number } {
  for (let p = share; p <= 100; p++) {
    const mixed = mix(colour, p, ground);
    if (ratio(mixed, ground) >= off) return { colour: mixed, share: p };
  }
  throw new Error(`${colour} never stands ${off}:1 off ${ground}`);
}
const OFF = { wash: 1.09, washIdle: 1.08, soft: 1.12, railCurrent: 1.13, railHover: 1.12, state: 1.05, ruleInk: 1.3, rule: 1.15, ruleOnField: 1.12, railRule: 1.13 };

// The makers' colours of the format badges (DOCX, PPTX, XLSX): the app's own constants, read from tokens.css.
// A badge is the colour as a word on its own 14% tint over a field (styles.css `.format-docx`); on a ground
// that is neither white nor near-black the word sinks, so in a set it goes toward the ink until it reads.
const FORMATS = ["--color-format-docx", "--color-format-pptx", "--color-format-xlsx"];
const constant = (name: string) => {
  const m = new RegExp(`${name}:\\s*(oklch\\([^)]*\\))`).exec(readFileSync("apps/web/src/styles/tokens.css", "utf8"));
  if (!m) throw new Error(`tokens.css has no ${name}`);
  return oklchHex(m[1]!);
};
export const badgeGround = (word: string, field: string) => mixSrgb(word, 14, field);
function badgeWord(start: string, ink: string, field: string): string {
  for (let p = 0; p <= 100; p++) {
    const colour = p === 0 ? start : mix(ink, p, start);
    if (ratio(colour, badgeGround(colour, field)) >= 4.5) return colour;
  }
  throw new Error(`${start} never reads as a badge on ${field}`);
}

export type Roles = Record<string, string>;
/** The tokens a set's block declares, in order. */
export function rolesOf(set: AtlasSet): Roles {
  const light = set.mode === "light", s = set.from;
  const ground = s.background.slice(0, 7).toLowerCase();
  const o = (value: string) => opaque(value, ground);
  const paper = o(s.list), paper2 = ground, paper3 = o(s.well);
  // Fields: on light they are the list's white; on dark one step up from the ground (their list head).
  const field = light ? paper : o(s.listHead);
  const ink = o(s.ink), accent = o(s.accent);
  // The accent as a mark or fill (3:1 on the ground); the selection wash is that mark over the ground.
  const teal = reads(accent, ink, [paper, paper2], 3);
  const wash = tint(teal, light ? 8 : 12, paper2, OFF.wash);
  // The list column's current row while the keyboard is elsewhere (navigator.css): one step lighter (7% light, 10% dark).
  const washIdle = tint(teal, light ? 7 : 10, paper2, OFF.washIdle);
  // The accent as WORDS: their pressed key on light, their bright link on dark, toward the ink until it reads;
  // muted words likewise. `--accent-soft` (the chosen chip, a marked row) is those words' colour over a field,
  // so the words and that wash are settled together.
  const surfaces = [paper, paper2, paper3, field, wash.colour];
  let tealInk = reads(o(light ? s.accentDeep : s.linkBright), ink, surfaces, 4.5), soft = tint(tealInk, 10, field, OFF.soft);
  for (let round = 0; round < 8; round++) {
    const next = reads(tealInk, ink, [...surfaces, soft.colour], 4.5);
    if (next === tealInk) break;
    tealInk = next; soft = tint(tealInk, 10, field, OFF.soft);
  }
  const muted = reads(o(s.mutedInk), ink, [...surfaces, soft.colour], 4.5);
  // A state colour is their fill; as words it goes toward the ink until it reads on the ground and on its own soft ground.
  const state = (colour: string, share: number) => {
    const softGround = tint(colour, share, paper2, OFF.state).colour;
    return { soft: softGround, text: reads(colour, ink, [paper, paper2, field, softGround], 4.5) };
  };
  const warning = o(s.warning), attention = state(warning, light ? 10 : 12), done = state(o(s.success), light ? 8 : 12), error = state(o(s.danger), light ? 8 : 12);
  // The set's dark for a label on a pale fill: the ink on light, the ground on dark.
  const dark = light ? ink : paper2;
  // The filled key: the accent's word step on light, their pressed key on dark, with the label (white or the
  // set's dark) that reads better on it; if neither reads, the key moves away from that label until it does.
  let key = light ? tealInk : o(s.accentDeep);
  const onKey = ratio("#ffffff", key) >= ratio(dark, key) ? "#ffffff" : dark;
  key = reads(key, onKey === "#ffffff" ? dark : "#ffffff", [onKey], 4.5);
  // The rail: their sidebar; where that is the list's own ground (the two could not be told apart), their muted ground.
  const sidebar = o(s.sidebar);
  const rail = ratio(sidebar, paper) >= 1.05 ? sidebar : paper3;
  const railCurrent = tint(accent, light ? 12 : 15, rail, OFF.railCurrent).colour, railHover = tint(o(s.sidebarInk), 8, rail, OFF.railHover).colour;
  const railInk = reads(o(s.sidebarInk), light ? "#000000" : "#ffffff", [rail, railCurrent, railHover], 4.5);
  // Hairlines: their border; where it cannot be told from the ground it parts (the see-through Windows set's is a
  // black line over glass; a rail drawn in their muted ground has their border's own colour), it goes toward the ink.
  const rule = reads(reads(o(s.border), ink, [paper, paper2], OFF.rule), ink, [field], OFF.ruleOnField), railRule = reads(o(s.border), railInk, [rail], OFF.railRule);
  return {
    "--color-paper": paper,
    "--color-paper-2": paper2,
    "--color-paper-3": paper3,
    "--color-field": field,
    "--color-ink": ink,
    "--color-ink-2": mix(ink, 85, paper2),
    "--color-muted": muted,
    "--color-faint": muted,
    "--color-rule": rule,
    "--color-edge": reads(o(s.inputBorder), ink, [field, paper, paper2], 3),
    "--rule-ink": tint(ink, light ? 14 : 12, paper, OFF.ruleInk).colour,
    "--color-teal": teal,
    "--color-teal-ink": tealInk,
    "--color-attention": warning,
    "--color-attention-ink": reads(dark, "#000000", [warning], 4.5),
    "--color-attention-text": attention.text,
    "--color-attention-soft": attention.soft,
    "--color-done": done.text,
    "--color-done-soft": done.soft,
    "--color-error": error.text,
    "--color-error-soft": error.soft,
    "--color-scrim": s.overlay.toLowerCase(),
    "--color-rail": rail,
    "--color-rail-ink": railInk,
    "--color-rail-muted": reads(muted, railInk, [rail], 4.5),
    "--color-rail-hover": railHover,
    "--color-rail-current": railCurrent,
    "--color-rail-mark": reads(accent, railInk, [rail, railCurrent], 3),
    "--color-rail-rule": railRule,
    "--color-rail-focus": reads(tealInk, railInk, [rail], 3),
    "--key-primary": key,
    "--on-key-primary": onKey,
    "--color-current-soft": wash.colour,
    "--active-bg": "var(--color-current-soft)",
    "--accent-soft": `color-mix(in oklab, var(--accent) ${soft.share}%, var(--surface))`,
    ...Object.fromEntries(FORMATS.map((name) => [name, badgeWord(constant(name), ink, field)])),
    // Handed down to the look scopes inside (tokens.css, the block after this region): they re-derive these roles.
    "--palette-key": key,
    "--palette-on-key": onKey,
    "--palette-wash-share": `${wash.share}%`,
    "--palette-wash-idle-share": `${washIdle.share}%`,
    "--palette-soft-share": `${soft.share}%`,
  };
}
/** The roles as colours: what the two derived ones (the wash's alias and --accent-soft) come to. */
export function coloursOf(set: AtlasSet): Roles {
  const r = rolesOf(set);
  return { ...r, "--active-bg": r["--color-current-soft"]!, "--accent-soft": mix(r["--color-teal-ink"]!, parseInt(r["--palette-soft-share"]!, 10), r["--color-field"]!) };
}

// ── what is written ──
const GENERATED = ATLAS_SETS.filter((set) => set.id !== DEFAULT_SET.light && set.id !== DEFAULT_SET.dark);
const selector = (set: AtlasSet) => set.mode === "light"
  ? `:root[data-palette-light="${set.id}"]:not([data-theme="dark"]),\n[data-palette-light="${set.id}"] .look-scope[data-theme="light"]`
  : `:root[data-palette-dark="${set.id}"][data-theme="dark"],\n[data-palette-dark="${set.id}"] .look-scope[data-theme="dark"]`;
/** The four chips of a swatch (설정 › 화면): the set's ground, rail, accent and ink. */
const chips = (set: AtlasSet, r: Roles) => `[data-set-chips="${set.id}"] { --chip-ground: ${r["--color-paper-2"]}; --chip-rail: ${r["--color-rail"]}; --chip-accent: ${r["--color-teal"]}; --chip-ink: ${r["--color-ink"]}; }`;
/** A pane's look colour still at its default follows the set (appearance.ts lookStyle). */
const look = (set: AtlasSet, r: Roles) => {
  const m = set.mode, names = { ...(m === "dark" ? { paper: "--color-paper" } : {}), sheet: "--color-paper-2", field: "--color-field", ink: "--color-ink", muted: "--color-muted", rule: "--color-rule", well: "--color-paper-3" };
  return `:root[data-palette-${m}="${set.id}"] { ${Object.entries(names).map(([name, role]) => `--palette-look-${m}-${name}: ${r[role]};`).join(" ")} }`;
};

export function tokenBlocks(): string {
  const blocks = GENERATED.map((set) => {
    const r = rolesOf(set);
    return [`/* ${set.name}: their "${set.theirs}" (${set.mode}). */`, `${selector(set)} {`, ...Object.entries(r).map(([name, value]) => `  ${name}: ${value};`), "}", look(set, r), chips(set, r)].join("\n");
  });
  const defaults = ATLAS_SETS.filter((set) => !GENERATED.includes(set)).map((set) => chips(set, rolesOf(set)));
  return [...blocks, "/* The default pair's chips (their blocks are the hand-written ones above). */", ...defaults].join("\n") + "\n";
}

/** The editors' mirrors (chrome.css): the app token each `--wb-ui-*` copies, as this rule resolves it. */
export function chromeBlocks(): string {
  return GENERATED.map((set) => {
    const r = coloursOf(set), dark = set.mode === "dark";
    const mirrors: [string, string][] = [
      ["bg", r["--color-field"]!], ["group", r["--color-paper"]!], ["text", r["--color-ink"]!], ["muted", r["--color-muted"]!], ["line", r["--color-rule"]!],
      ["focus", r["--color-teal-ink"]!], ["on-accent", dark ? "#101113" : "#ffffff"], ["hover", r["--color-paper-3"]!],
      ["selected", r["--accent-soft"]!], ["danger", r["--color-error"]!], ["key", r["--key-primary"]!], ["on-key", r["--on-key-primary"]!],
    ];
    return [`__WB_ROOT__[data-wb-office-palette="${set.id}"] {`, ...mirrors.map(([name, value]) => `  --wb-ui-${name}: ${value};`), "}"].join("\n");
  }).join("\n") + "\n";
}

const MARK = { begin: "/* generated:atlas-sets begin (scripts/atlas-sets.ts; do not edit by hand) */\n", end: "/* generated:atlas-sets end */" };
export const FILES = [
  { path: "apps/web/src/styles/tokens.css", body: tokenBlocks },
  { path: "apps/office/src/ui-adapters/chrome.css", body: chromeBlocks },
] as const;
/** The text between a file's markers. */
export function region(text: string): string {
  const from = text.indexOf(MARK.begin), to = text.indexOf(MARK.end);
  if (from < 0 || to < from) throw new Error("no generated:atlas-sets region");
  return text.slice(from + MARK.begin.length, to);
}
const withRegion = (text: string, body: string) => text.slice(0, text.indexOf(MARK.begin) + MARK.begin.length) + body + text.slice(text.indexOf(MARK.end));

// ── the contrast table (every pair the rule answers for) ──
export const PAIRS: [fg: string, bg: string, need: number][] = [
  ["--color-ink", "--color-paper-2", 4.5], ["--color-ink", "--color-field", 4.5], ["--color-ink", "--color-paper-3", 4.5], ["--color-ink-2", "--color-paper-2", 4.5],
  ["--color-muted", "--color-paper-2", 4.5], ["--color-muted", "--color-field", 4.5], ["--color-muted", "--color-paper-3", 4.5], ["--color-muted", "--color-current-soft", 4.5],
  ["--color-teal-ink", "--color-paper-2", 4.5], ["--color-teal-ink", "--color-field", 4.5], ["--color-teal-ink", "--color-current-soft", 4.5],
  ["--color-ink", "--accent-soft", 4.5], ["--color-muted", "--accent-soft", 4.5], ["--color-teal-ink", "--accent-soft", 4.5],
  ["--on-key-primary", "--key-primary", 4.5], ["--color-attention-ink", "--color-attention", 4.5],
  ["--color-attention-text", "--color-paper-2", 4.5], ["--color-attention-text", "--color-attention-soft", 4.5],
  ["--color-done", "--color-paper-2", 4.5], ["--color-done", "--color-done-soft", 4.5],
  ["--color-error", "--color-paper-2", 4.5], ["--color-error", "--color-field", 4.5], ["--color-error", "--color-error-soft", 4.5],
  ["--color-rail-ink", "--color-rail", 4.5], ["--color-rail-muted", "--color-rail", 4.5], ["--color-rail-ink", "--color-rail-current", 4.5], ["--color-rail-ink", "--color-rail-hover", 4.5],
  ["--color-edge", "--color-field", 3], ["--color-teal", "--color-paper-2", 3], ["--color-rail-mark", "--color-rail", 3], ["--color-rail-focus", "--color-rail", 3],
];
const short = (name: string) => name.replace(/^--(color-)?/, "");
export function contrastTable(): string {
  const rows = GENERATED.map((set) => {
    const r = coloursOf(set);
    const worst = (need: number) => PAIRS.filter((pair) => pair[2] === need).map(([fg, bg]) => [`${short(fg)} on ${short(bg)}`, ratio(r[fg]!, r[bg]!)] as const).sort((a, b) => a[1] - b[1])[0]!;
    const [words, marks] = [worst(4.5), worst(3)];
    return `| ${set.name} | ${set.mode} | ${words[0]} ${words[1].toFixed(2)} | ${marks[0]} ${marks[1].toFixed(2)} | ${r["--on-key-primary"]} on ${r["--key-primary"]} ${ratio(r["--on-key-primary"]!, r["--key-primary"]!).toFixed(2)} |`;
  });
  return ["| set | mode | worst words pair (need 4.5) | worst edge or mark pair (need 3) | filled key: label on key |", "|---|---|---|---|---|", ...rows].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--table")) console.log(contrastTable());
  else {
    let stale = 0;
    for (const file of FILES) {
      const text = readFileSync(file.path, "utf8"), body = file.body();
      if (region(text) === body) continue;
      stale++;
      if (process.argv.includes("--check")) console.error(`${file.path}: the generated region is not what scripts/atlas-sets.ts gives`);
      else { writeFileSync(file.path, withRegion(text, body)); console.log(`wrote ${file.path}`); }
    }
    if (process.argv.includes("--check") && stale) process.exit(1);
  }
}
