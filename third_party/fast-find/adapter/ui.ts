// Adapted from ssp-data/obsidian-fast-find-10k 714548efd3e361a7011a5123f4ae928630a01614.
// MIT, copyright Simon Späti; see ../LICENSE. Pure preview/results/keys logic shared by
// Workbench's React view and host; Obsidian DOM classes are intentionally not imported.
const MIN_TERM = 2;
export const MAX_LINE_CHARS = 2000;
export const MAX_LINE_STYLES = 50;
export type LineKind = 'h1' | 'h2' | 'h3' | 'code' | 'text';

export interface Line {
	kind: LineKind;
	/** Display text: heading markers stripped, everything else verbatim. */
	text: string;
}

export interface Segment {
	text: string;
	style: 'link' | 'tag' | null;
	mark: boolean;
}

const HEADING = /^(#{1,3})[ \t]+(.*)$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const TAG_BODY = /[\p{L}\p{N}_\-/]+/uy;

/** Query input → highlight terms: whitespace split, filters (`-x`, `#x`, `path:x`) dropped,
 * quotes stripped, lower-cased, deduplicated. */
export function queryTerms(input: string): string[] {
	const out: string[] = [];
	for (const raw of input.split(/\s+/)) {
		if (!raw || raw.startsWith('-') || raw.startsWith('#') || raw.toLowerCase().startsWith('path:')) continue;
		const t = raw.replace(/["']/g, '').toLowerCase();
		if (t && !out.includes(t)) out.push(t);
	}
	return out;
}

/** Headings `#`–`###` (outside fenced code) get their kind and lose the markers; fence lines and
 * everything inside a fence are `code`. */
export function classifyLines(lines: string[]): Line[] {
	let fence: string | null = null;
	return lines.map((line) => {
		const f = FENCE.exec(line);
		if (fence !== null) {
			if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length && line.trim() === f[1]) fence = null;
			return { kind: 'code', text: line };
		}
		if (f) {
			fence = f[1]!;
			return { kind: 'code', text: line };
		}
		const h = HEADING.exec(line);
		if (h) return { kind: `h${h[1]!.length}` as LineKind, text: h[2]! };
		return { kind: 'text', text: line };
	});
}

/** Per-note caps on the work the preview renders. `marks`/`styles` are consumed across lines. */
export interface Budget {
	marks: number;
	styles: number;
}

/** Non-overlapping case-insensitive matches of the terms (≥ 2 chars), leftmost first, longest
 * term on ties; consumes `budget.marks`. Empty when lower-casing changes the line's length.
 * Each term's next occurrence is cached, so a term absent from the line is scanned once. */
function markRanges(text: string, terms: string[], budget: Budget): [number, number][] {
	const mapped = displayMap(text), lower = mapped.text;
	const usable = terms.map(normalizeDisplay).filter((t) => t.length >= MIN_TERM || /[\p{Script=Hangul}\p{Script=Han}]/u.test(t));
	if (usable.length === 0) return [];
	const next = usable.map((t) => lower.indexOf(t));
	const out: [number, number][] = [];
	let pos = 0;
	while (budget.marks > 0) {
		let best = -1;
		let len = 0;
		for (let k = 0; k < usable.length; k++) {
			if (next[k]! >= 0 && next[k]! < pos) next[k] = lower.indexOf(usable[k]!, pos);
			const at = next[k]!;
			if (at >= 0 && (best < 0 || at < best || (at === best && usable[k]!.length > len))) {
				best = at;
				len = usable[k]!.length;
			}
		}
		if (best < 0) break;
		out.push([mapped.starts[best]!, mapped.ends[best + len - 1]!]);
		budget.marks--;
		pos = best + len;
	}
	return out;
}

/** `[[link]]` / `![[embed]]` and `#tag` ranges, left to right, at most `cap`. One linear scan:
 * the next `[[` and `#` positions are cached, and an unclosed `[[` stops link search for the line. */
function styleRanges(text: string, cap: number): [number, number, 'link' | 'tag'][] {
	const out: [number, number, 'link' | 'tag'][] = [];
	let pos = 0;
	let link = text.indexOf('[[');
	let hash = text.indexOf('#');
	while (out.length < cap) {
		if (link >= 0 && link < pos) link = text.indexOf('[[', pos);
		if (hash >= 0 && hash < pos) hash = text.indexOf('#', pos);
		if (link < 0 && hash < 0) break;
		if (link >= 0 && (hash < 0 || link < hash)) {
			const close = text.indexOf(']]', link + 2);
			if (close < 0) {
				link = -1; // no closer left on this line
				continue;
			}
			if (close === link + 2) {
				pos = link + 2; // `[[]]` is not a link
				continue;
			}
			const s = link > pos && text[link - 1] === '!' ? link - 1 : link;
			out.push([s, close + 2, 'link']);
			pos = close + 2;
			continue;
		}
		pos = hash + 1;
		if (hash > 0 && !/[\s(]/.test(text[hash - 1]!)) continue;
		TAG_BODY.lastIndex = hash + 1;
		const m = TAG_BODY.exec(text);
		if (!m) continue;
		pos = hash + 1 + m[0]!.length;
		if (!/^\d+$/.test(m[0]!)) out.push([hash, pos, 'tag']);
	}
	return out;
}

/** Splits a line at every link/tag and mark boundary. `plain` (code) skips link/tag tinting.
 * Lines over MAX_LINE_CHARS are cut with a trailing `…`; at most MAX_LINE_STYLES styled ranges
 * per line, and both styles and marks draw from the per-note `budget`. Linear in the line. */
export function segmentLine(text: string, terms: string[], budget: Budget, plain: boolean): Segment[] {
	let cut = false;
	if (text.length > MAX_LINE_CHARS) {
		let n = MAX_LINE_CHARS;
		const c = text.charCodeAt(n - 1);
		if (c >= 0xd800 && c <= 0xdbff) n--; // do not split a surrogate pair
		text = text.slice(0, n);
		cut = true;
	}
	const styles = plain ? [] : styleRanges(text, Math.min(MAX_LINE_STYLES, budget.styles));
	budget.styles -= styles.length;
	const marks = markRanges(text, terms, budget);
	const points = [0, text.length];
	for (const [s, e] of styles) points.push(s, e);
	for (const [s, e] of marks) points.push(s, e);
	points.sort((a, b) => a - b);
	const out: Segment[] = [];
	let si = 0;
	let mi = 0;
	for (let i = 0; i + 1 < points.length; i++) {
		const s = points[i]!;
		const e = points[i + 1]!;
		if (s === e) continue;
		while (si < styles.length && styles[si]![1] <= s) si++;
		while (mi < marks.length && marks[mi]![1] <= s) mi++;
		const style = si < styles.length && styles[si]![0] <= s ? styles[si]![2] : null;
		const mark = mi < marks.length && marks[mi]![0] <= s;
		const last = out[out.length - 1];
		if (last && !mark && !last.mark && last.style === style) last.text += text.slice(s, e);
		else out.push({ text: text.slice(s, e), style, mark });
	}
	if (cut) {
		const last = out[out.length - 1];
		if (last && !last.mark && last.style === null) last.text += '…';
		else out.push({ text: '…', style: null, mark: false });
	}
	return out;
}


// Workbench adds a grapheme-to-UTF-16 map to the original display-range remapping. It keeps
// Korean NFC/NFD, full-width text and emoji boundaries without changing a source document.
function normalizeDisplay(value: string): string {
  return value.normalize("NFKC").toLowerCase().normalize("NFD").replace(/\p{Mn}/gu, mark => mark === "\u3099" || mark === "\u309a" ? mark : "").normalize("NFC");
}
function displayMap(value: string) {
  let text = ""; const starts: number[] = [], ends: number[] = [];
  for (const part of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)) {
    const normal = normalizeDisplay(part.segment);
    for (let n = 0; n < normal.length; n++) { starts.push(part.index); ends.push(part.index + part.segment.length); }
    text += normal;
  }
  return { text, starts, ends };
}
export function mapTitleRanges(display: string, norm: string, ranges: [number, number][]): [number, number][] {
  const mapped = displayMap(display), out: [number, number][] = []; let from = 0;
  for (const [s, e] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (!(s >= 0 && e > s && e <= norm.length)) continue;
    const sub = normalizeDisplay(norm.slice(s, e));
    const at = mapped.text.indexOf(sub, from);
    if (at < 0 || !sub) continue;
    out.push([mapped.starts[at]!, mapped.ends[at + sub.length - 1]!]); from = at + sub.length;
  }
  return out;
}

export function displayHeading(text: string): string {
	return text
		.replace(/!?\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_, target: string, alias?: string) => alias || target)
		.replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, (_, label: string, url: string) => {
			if (label.trim()) return label;
			const m = /^[a-z]+:\/\/([^/?#]+)/i.exec(url.trim());
			return ` ${m ? m[1] : url.trim()} `; // spaced: the link may touch the next word
		})
		.replace(/`/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}


type Modifier = "Mod" | "Ctrl" | "Meta" | "Shift" | "Alt";
type Keymap = Record<string, string>;
const MODIFIERS: readonly Modifier[] = ['Mod', 'Ctrl', 'Meta', 'Shift', 'Alt'];

/** A binding may list alternatives: `Alt+Shift+N | Alt+P`. */
export function splitSpecs(spec: string): string[] {
	return spec
		.split('|')
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/** `Mod+Alt+Enter` → `{ modifiers: ['Mod','Alt'], key: 'Enter' }`; single letters lower-cased.
 * Returns null for an empty spec or an unknown modifier. */
export function parseKeySpec(spec: string): { modifiers: Modifier[]; key: string } | null {
	const parts = spec.split('+');
	const key = parts.pop() ?? '';
	if (!key) return null;
	if (!parts.every((p) => (MODIFIERS as string[]).includes(p))) return null;
	return { modifiers: parts as Modifier[], key: key.length === 1 ? key.toLowerCase() : key };
}

/** Hint text: `Mod+Enter` → `⌘⏎` on macOS, `Ctrl+⏎` elsewhere; `Shift+/` → `?`. */
export function keyLabel(spec: string, isMac: boolean): string {
	if (spec.includes('|')) return splitSpecs(spec).map((s) => keyLabel(s, isMac)).join(' / ');
	const sym: Record<string, string> = isMac
		? { Mod: '⌘', Ctrl: '⌃', Meta: '⌘', Alt: '⌥', Shift: '⇧', Enter: '⏎' }
		: { Mod: 'Ctrl+', Ctrl: 'Ctrl+', Meta: 'Win+', Alt: 'Alt+', Shift: 'Shift+', Enter: '⏎' };
	const parts = spec.split('+');
	if (parts.length > 1 && parts[parts.length - 1] === '/' && parts.includes('Shift')) {
		parts.splice(parts.indexOf('Shift'), 1);
		parts[parts.length - 1] = '?';
	}
	return parts.map((p) => sym[p] ?? p).join('');
}

/** The key combination a spec stands for on this platform (`Mod` resolved, order-free). */
function canonical(spec: string, isMac: boolean): string | null {
	const k = parseKeySpec(spec);
	if (!k) return null;
	const mods = new Set(k.modifiers.map((m) => (m === 'Mod' ? (isMac ? 'Meta' : 'Ctrl') : m)));
	return [...[...mods].sort(), k.key.toLowerCase()].join('+');
}

/** Why `spec` cannot be the binding of `action` (unparseable, or the same keys as another
 * action on this platform); null when it can. */
export function validateBinding(km: Keymap, action: keyof Keymap, spec: string, isMac: boolean): string | null {
	const parts = splitSpecs(spec);
	if (parts.length === 0) return `invalid key "${spec}" (use e.g. Mod+Shift+Enter; modifiers Mod, Ctrl, Meta, Shift, Alt)`;
	const own = new Set<string>();
	for (const part of parts) {
		const c = canonical(part, isMac);
		if (!c) return `invalid key "${part}" (use e.g. Mod+Shift+Enter; modifiers Mod, Ctrl, Meta, Shift, Alt; alternatives with |)`;
		if (own.has(c)) return `"${part}" is listed twice`;
		own.add(c);
		for (const other of Object.keys(km) as (keyof Keymap)[]) {
			if (other !== action && splitSpecs(km[other]).some((o) => canonical(o, isMac) === c)) return `already used by ${other}`;
		}
	}
	return null;
}

/** Pairs of actions bound to the same keys on this platform. */
export function conflicts(km: Keymap, isMac: boolean): [keyof Keymap, keyof Keymap][] {
	const seen = new Map<string, keyof Keymap>();
	const out: [keyof Keymap, keyof Keymap][] = [];
	for (const a of Object.keys(km) as (keyof Keymap)[]) {
		for (const part of splitSpecs(km[a])) {
			const c = canonical(part, isMac);
			if (c === null) continue;
			const prev = seen.get(c);
			if (prev && prev !== a) out.push([prev, a]);
			else seen.set(c, a);
		}
	}
	return out;
}

