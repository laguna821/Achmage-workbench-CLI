import { useEffect } from "react";
// "내비게이터로" (⋯ › 단축키, Ctrl+Shift+E by default): the focus goes to the navigator's list (or the
// tree). The sidebar may not be there yet when asked (it was hidden), so the request waits for it.

let wanted = false;
const listeners = new Set<() => void>();

export function requestNavigatorFocus() {
  wanted = true;
  for (const listener of listeners) listener();
}

/** The sidebar takes a waiting request (true once, then the request is gone). */
export function takeNavigatorFocus(): boolean {
  const was = wanted;
  wanted = false;
  return was;
}

export function onNavigatorFocus(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// A dialog opened from a menu gives the focus back to where the menu came from (a sidebar row, a ⋯
// button). Left on the page instead, Enter and Esc would answer a waiting approval.
let origin: { element: HTMLElement; at: number } | null = null;

/** Where the menu being used came from, noted when one of its items is chosen (or when it opens). */
export function markMenuOrigin(element: Element | null | undefined) {
  origin = element instanceof HTMLElement ? { element, at: Date.now() } : null;
}

/** That origin, once, while it is still recent and on the page. */
export function takeMenuOrigin(maxAgeMs = 60_000): HTMLElement | null {
  const taken = origin;
  origin = null;
  return taken && Date.now() - taken.at <= maxAgeMs && taken.element.isConnected ? taken.element : null;
}

/** The row a menu's anchor belongs to: the anchor's own row, or at a point (right-click) the row under it. */
export function rowOfAnchor(anchor: Element | { x: number; y: number } | null | undefined): HTMLElement | null {
  if (!anchor) return null;
  const element = anchor instanceof Element ? anchor : typeof document.elementFromPoint === "function" ? document.elementFromPoint(anchor.x, anchor.y) : null;
  return element?.closest<HTMLElement>("[data-row-id]") ?? (anchor instanceof HTMLElement ? anchor : null);
}

/** For a dialog opened from a menu: on closing, the focus returns to the menu's origin unless it already went somewhere. */
export function useReturnFocus() {
  useEffect(() => {
    const to = takeMenuOrigin();
    return () => {
      if (!to) return;
      // After the dialog is gone from the page (its own focused control goes with it).
      window.setTimeout(() => {
        const active = document.activeElement;
        if (to.isConnected && (!active || active === document.body)) to.focus({ preventScroll: true });
      }, 0);
    };
  }, []);
}

// ── type-ahead (b14, n2): letters typed on a list row move to the next row whose name starts with
// them (Hangul included: a syllable, or its first consonant ㄱ…ㅎ as some keyboards report it). ──
const INITIALS = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
/** The first consonant of a Hangul syllable ("논" → "ㄴ"), else the character itself. */
export const initialOf = (char: string) => {
  const code = char.charCodeAt(0) - 0xac00;
  return code >= 0 && code < 11172 ? INITIALS[Math.floor(code / 588)]! : char;
};
/** Does a row's name start with what was typed (letters, syllables, or first consonants)? */
export function namePrefix(name: string, typed: string): boolean {
  const text = name.trim().toLocaleLowerCase("ko");
  const want = typed.toLocaleLowerCase("ko");
  if (text.startsWith(want)) return true;
  return [...want].every((char, index) => INITIALS.includes(char) && text[index] !== undefined && initialOf(text[index]!) === char);
}
let typed = "";
let typedAt = 0;
/** Handles a printable key on a list row; true when it moved the focus (the caller stops the event). */
export function typeAhead(event: { key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean; currentTarget: EventTarget | null; isComposing?: boolean }, now = Date.now()): boolean {
  if (event.ctrlKey || event.altKey || event.metaKey || event.isComposing || [...event.key].length !== 1 || event.key === " ") return false;
  const from = event.currentTarget as HTMLElement | null;
  const rows = [...(from?.closest(".nav-level")?.querySelectorAll<HTMLElement>("[data-list-row]") ?? [])];
  if (!from || !rows.length) return false;
  typed = now - typedAt > 700 ? event.key : typed + event.key;
  typedAt = now;
  const nameOf = (row: HTMLElement) => row.querySelector(".side-row-label")?.textContent ?? row.textContent ?? "";
  const at = rows.indexOf(from);
  // The same letter again walks through the rows that start with it; a longer prefix stays on a match.
  const start = typed.length === 1 ? at + 1 : Math.max(at, 0);
  const order = [...rows.slice(start), ...rows.slice(0, start)];
  let hit = order.find((row) => namePrefix(nameOf(row), typed));
  // What was typed before matches nothing with this key: start again from this key alone.
  if (!hit && typed.length > 1) {
    typed = event.key;
    const fresh = [...rows.slice(at + 1), ...rows.slice(0, at + 1)];
    hit = fresh.find((row) => namePrefix(nameOf(row), typed));
  }
  if (!hit) return false;
  hit.focus();
  hit.scrollIntoView?.({ block: "nearest" });
  return true;
}

/** What ↑↓ Home End stop on in a list column: its rows and the "N개 더 보기" key under a list cut short. */
export const LIST_STOP = "[data-list-row], [data-list-more]";
