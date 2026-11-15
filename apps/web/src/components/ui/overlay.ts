/** Geometry and matching shared by every floating choice surface (Menu, Select). Pure functions. */

export type Side = "bottom" | "top" | "right" | "left";
export type Align = "start" | "end";
/** A DOMRect satisfies this; a point is a zero-size rect (see `pointRect`). */
export type AnchorRect = { left: number; top: number; right: number; bottom: number };
/** The area the surface must stay in: the window, or a part of it (e.g. leaving out a native webview). */
export type Viewport = { width: number; height: number; left?: number; top?: number };
export type PlaceOptions = { side?: Side; align?: Align; gap?: number; margin?: number };
export type Placement = { left: number; top: number; maxHeight: number; maxWidth: number; side: Side };

const OPPOSITE: Record<Side, Side> = { bottom: "top", top: "bottom", right: "left", left: "right" };

export const pointRect = (x: number, y: number): AnchorRect => ({ left: x, top: y, right: x, bottom: y });

/**
 * Where a surface of `size` goes beside `anchor`: on the preferred side if it fits, else the
 * opposite side if that fits, else whichever side has more room with the height limited to it.
 * Along the other axis it starts at the anchor's start (or end) edge and is pushed back inside.
 */
export function place(anchor: AnchorRect, size: { width: number; height: number }, viewport: Viewport, options: PlaceOptions = {}): Placement {
  const { side: preferred = "bottom", align = "start", gap = 4, margin = 8 } = options;
  const minX = (viewport.left ?? 0) + margin, maxX = (viewport.left ?? 0) + viewport.width - margin;
  const minY = (viewport.top ?? 0) + margin, maxY = (viewport.top ?? 0) + viewport.height - margin;
  const room: Record<Side, number> = {
    bottom: maxY - (anchor.bottom + gap),
    top: anchor.top - gap - minY,
    right: maxX - (anchor.right + gap),
    left: anchor.left - gap - minX,
  };
  const vertical = preferred === "bottom" || preferred === "top";
  const need = vertical ? size.height : size.width;
  const other = OPPOSITE[preferred];
  const side = room[preferred] >= need ? preferred : room[other] >= need ? other : room[preferred] >= room[other] ? preferred : other;
  const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high));
  const maxWidth = Math.max(0, maxX - minX);
  if (vertical) {
    // No room on either side (the anchor fills the viewport): lie over it instead of vanishing.
    const covered = room[side] < Math.min(need, 1);
    const maxHeight = covered ? Math.max(0, maxY - minY) : Math.max(0, room[side]);
    const height = Math.min(size.height, maxHeight), width = Math.min(size.width, maxWidth);
    const wanted = covered ? anchor.top : side === "bottom" ? anchor.bottom + gap : anchor.top - gap - height;
    // Pushed back inside when the anchor itself has scrolled out of view.
    const top = clamp(wanted, minY, Math.max(minY, maxY - height));
    const start = align === "start" ? anchor.left : anchor.right - width;
    return { left: clamp(start, minX, maxX - width), top, maxHeight, maxWidth, side };
  }
  const maxHeight = Math.max(0, maxY - minY);
  const height = Math.min(size.height, maxHeight), width = Math.min(size.width, Math.max(0, room[side]));
  const left = side === "right" ? anchor.right + gap : anchor.left - gap - width;
  const start = align === "start" ? anchor.top : anchor.bottom - height;
  return { left: Math.max(minX, left), top: clamp(start, minY, maxY - height), maxHeight, maxWidth: Math.max(0, room[side]), side };
}

// ── type-ahead ──────────────────────────────────────────────────────────────────────────────
const SYLLABLE_FIRST = 0xac00, SYLLABLE_LAST = 0xd7a3;
// Compatibility jamo (what an IME shows while composing) for the 19 initial consonants.
const INITIALS = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";

const syllable = (char: string) => {
  const code = char.codePointAt(0) ?? 0;
  if (code < SYLLABLE_FIRST || code > SYLLABLE_LAST) return null;
  const offset = code - SYLLABLE_FIRST;
  return { initial: Math.floor(offset / 588), medial: Math.floor((offset % 588) / 28), final: offset % 28 };
};

/** Does the last typed character start `char`? Hangul being composed counts: "모" → "목", "ㅁ" → "모". */
function charStarts(typed: string, char: string) {
  if (typed === char) return true;
  const target = syllable(char);
  if (!target) return false;
  const initial = INITIALS.indexOf(typed);
  if (initial >= 0) return initial === target.initial;
  const partial = syllable(typed);
  return Boolean(partial && partial.final === 0 && partial.initial === target.initial && partial.medial === target.medial);
}

const normal = (text: string) => text.normalize("NFC").toLocaleLowerCase().trimStart();

function startsWith(label: string, query: string) {
  const chars = [...label], typed = [...query];
  if (!typed.length || typed.length > chars.length) return false;
  for (let i = 0; i < typed.length - 1; i++) if (chars[i] !== typed[i]) return false;
  return charStarts(typed.at(-1)!, chars[typed.length - 1]!);
}

/** Whether `label` begins with what was typed. */
export function matchesTypeahead(label: string, query: string) {
  return startsWith(normal(label), normal(query));
}

/** Whether any word of `label` begins with what was typed (search filters, numbered labels). */
export function matchesWord(label: string, query: string) {
  const typed = normal(query);
  return normal(label).split(/[\s·./_-]+/).some((word) => startsWith(word, typed));
}

/**
 * The first label at or after `from` (wrapping) that begins with `query`; failing that, the first
 * with a word that does. -1 when nothing matches.
 */
export function findTypeahead(labels: readonly string[], query: string, from: number) {
  const count = labels.length;
  for (const test of [matchesTypeahead, matchesWord]) {
    for (let step = 0; step < count; step++) {
      const index = (((from + step) % count) + count) % count;
      if (test(labels[index]!, query)) return index;
    }
  }
  return -1;
}
