/**
 * The light conversation view (0.5.4, perf-audit C2): a FINISHED turn is drawn once by the app's own turn renderer
 * (React's renderToString of the same components the live view uses, so the same escaping and the same Markdown and
 * link rules) and kept as static markup; no component of it stays mounted. The markup is kept here, in memory,
 * bounded, under a key made of the renderer's version, the turn's items (their content, so a refetched transcript
 * finds it again) and the few outside facts the drawing reads (a document's name on a chip, …): a different key draws
 * it again. Nothing is stored on disk: the markup is never read back from anywhere but this page's own renderer.
 *
 * A static turn wakes into components (React hydrates the same DOM: no node is replaced, a selection and the focus
 * stay) on the first event a person aims at it (pointer, key, focus), or — for turns with pictures, diagrams, a
 * document preview or a long request, whose drawing finishes after it is mounted — when it comes near the view.
 * A woken turn goes back to markup when it is far out of view again and waking changed nothing a person would lose.
 */
import type { TranscriptItem } from "@workbench/contracts";

/** Part of every key: raised whenever the turn renderer draws the same items differently (components, Markdown rules, classes). */
export const TURN_RENDERER_VERSION = 1;

/** Off: every turn is drawn as components, as in 0.5.3 (the tests compare the two drawings with it). */
export const lightView = { on: true };

/** The markup kept for turns not on screen, in characters (UTF-16: about twice that in bytes). */
export const STATIC_CACHE_CHARS = 4_000_000;

/** What the static path did (tests and the rig read it; nothing reacts to it). */
export const staticTurnStats = { drawn: 0, reused: 0, drawMs: 0, woken: 0, slept: 0, mismatches: 0, failed: 0 };
// A measuring rig that sets window.__workbenchPerf before the page loads reads these numbers there (as __workbenchTabSleepMs).
if (typeof window !== "undefined") { const perf = (window as unknown as { __workbenchPerf?: Record<string, unknown> }).__workbenchPerf; if (perf && typeof perf === "object") perf.lightView = staticTurnStats; }

const revisions = new WeakMap<object, string>();

/** Two independent 32-bit FNV-1a hashes and the length: a turn's content in 20-odd characters. */
function digest(text: string) {
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x5bd1e995) ^ (b >>> 15);
  }
  return `${text.length.toString(36)}.${(a >>> 0).toString(36)}.${(b >>> 0).toString(36)}`;
}

/** An item's revision: its content (the transcript keeps an unchanged item as the same object, so this is computed once per item). */
export function itemRevision(item: TranscriptItem): string {
  let revision = revisions.get(item);
  if (revision === undefined) { revision = `${item.id}:${digest(JSON.stringify(item))}`; revisions.set(item, revision); }
  return revision;
}

/** The key of one turn's markup: renderer version, its items' revisions, then whatever else the drawing reads (`facts`). */
export function turnKey(items: TranscriptItem[], facts: readonly unknown[]): string {
  return `v${TURN_RENDERER_VERSION}|${items.map(itemRevision).join(",")}|${digest(JSON.stringify(facts))}`;
}

const kept = new Map<string, string>();
let keptChars = 0;

/** The markup for `key`: kept, or drawn now by `draw` (null: this turn cannot be drawn statically; it stays live). */
export function staticMarkup(key: string, draw: () => string | null): string | null {
  const found = kept.get(key);
  if (found !== undefined) {
    kept.delete(key); kept.set(key, found);
    staticTurnStats.reused += 1;
    return found;
  }
  const start = performance.now();
  let html: string | null;
  try { html = draw(); } catch { html = null; }
  staticTurnStats.drawMs += performance.now() - start;
  if (html === null) { staticTurnStats.failed += 1; return null; }
  staticTurnStats.drawn += 1;
  kept.set(key, html); keptChars += key.length + html.length;
  for (const [oldKey, oldHtml] of kept) {
    if (keptChars <= STATIC_CACHE_CHARS || oldKey === key) break;
    kept.delete(oldKey); keptChars -= oldKey.length + oldHtml.length;
  }
  return html;
}

/** Forget every kept markup (tests). */
export function forgetStaticMarkup() { kept.clear(); keptChars = 0; for (const key of Object.keys(staticTurnStats) as (keyof typeof staticTurnStats)[]) staticTurnStats[key] = 0; }
export const staticMarkupSize = () => ({ turns: kept.size, chars: keptChars });

// ── waking on a person's first event ──

/** A static turn's section → its wake. */
const wakers = new WeakMap<Element, () => void>();
export const STATIC_SELECTOR = "section.turn[data-static]:not([data-woken])";
export function registerWake(section: Element, wake: () => void) { wakers.set(section, wake); return () => { if (wakers.get(section) === wake) wakers.delete(section); }; }

/**
 * Events a person aims at a turn: the turn wakes before the event reaches it, so React (which hydrates a root at its
 * first discrete event) handles that very event. Pointer moves are not among them: hovering is drawn by CSS alone.
 */
export const WAKE_EVENTS = ["pointerdown", "mousedown", "touchstart", "click", "dblclick", "auxclick", "contextmenu", "keydown", "focusin"] as const;

/** Wake the static turn an event is aimed at (capture listener on the conversation's scroller). */
export function wakeTarget(event: Event) {
  const target = event.target;
  const section = target instanceof Element ? target.closest(STATIC_SELECTOR) : null;
  if (section) wakers.get(section)?.();
}

// ── going back to markup ──

/** Parts whose drawing finishes after mount (a picture loading, a diagram, a document preview): compared by their place only. */
const SETTLING = ".attach-preview, figure.diagram, .design-card-thumb";

function normalise(root: Element) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
  const comments: Node[] = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  for (const comment of comments) comment.parentNode?.removeChild(comment);
  for (const part of root.querySelectorAll(SETTLING)) { part.replaceChildren(); for (const name of part.getAttributeNames()) if (name !== "class") part.removeAttribute(name); }
  for (const marked of root.querySelectorAll(".flash")) marked.classList.remove("flash");
  root.normalize();
  return root.innerHTML;
}

/** Does the woken (or live) turn look as its markup does, apart from parts still settling? Then nothing is lost by drawing it from markup again. */
export function looksAsMarkup(section: Element, html: string) {
  const live = section.cloneNode(true) as Element;
  const fresh = section.cloneNode(false) as Element;
  fresh.innerHTML = html;
  return normalise(live) === normalise(fresh);
}

/** A person is in it: the focus, or a selection that starts or ends inside. */
export function inUse(section: Element) {
  if (section.contains(document.activeElement)) return true;
  const selection = typeof window.getSelection === "function" ? window.getSelection() : null;
  return Boolean(selection && !selection.isCollapsed && ((selection.anchorNode && section.contains(selection.anchorNode)) || (selection.focusNode && section.contains(selection.focusNode))));
}
