// Mode changes that keep the same things in place (textfold's FLIP, rebuilt for React): before
// the change every `[data-flip]` element's box is measured; after it, each one still on screen
// starts where it was and slides to where it is now (Web Animations API), new ones fade in. The
// thing under the pointer, or at the reading line, keeps its place on screen (the reading position).
// With reduced motion nothing moves, but the reading position is still kept.

type Box = { left: number; top: number; width: number; height: number };

export type FlipFirst = { rects: Map<string, Box>; anchor: { id: string; top: number } | null };

/** Where the eye rests while reading a list: a bit above the middle (textfold uses 38%). */
const READING_LINE = 0.38;
const DURATION = 300;
const EASING = "cubic-bezier(0.2, 0, 0, 1)";
/** Animating more than this many boxes at once costs more than it shows. */
const MAX_MOVING = 160;

export const reducedMotion = () => typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

/** A motion token's length in ms (`--dur-fast` 120, `--dur-base` 220, `--dur-slow` 320), as styled. */
export function motionMs(token: "--dur-fast" | "--dur-base" | "--dur-slow") {
  const fallback = { "--dur-fast": 120, "--dur-base": 220, "--dur-slow": 320 }[token];
  const value = typeof document === "undefined" ? "" : getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  const ms = value.endsWith("ms") ? parseFloat(value) : value.endsWith("s") ? parseFloat(value) * 1000 : NaN;
  return Number.isFinite(ms) ? ms : fallback;
}

/** The app's --ease-out, for script-driven moves. */
export const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";

const moves = (element: HTMLElement) => typeof element.animate === "function" && !reducedMotion();

const restart = (element: HTMLElement) => {
  for (const animation of element.getAnimations?.() ?? []) animation.cancel();
};

/**
 * A box that has grown (a pane zoomed in) is laid out at its new size at once and revealed from
 * its old place: the clip opens from the old rectangle to the whole box. Nothing is scaled, so
 * text keeps its shape. Both boxes in the same coordinates.
 */
export function revealFrom(element: HTMLElement, before: Box, after: Box, duration = motionMs("--dur-base")) {
  if (!moves(element)) return null;
  const top = Math.max(0, before.top - after.top), left = Math.max(0, before.left - after.left);
  const right = Math.max(0, after.left + after.width - before.left - before.width), bottom = Math.max(0, after.top + after.height - before.top - before.height);
  if (top + left + right + bottom < 1) return null;
  restart(element);
  const round = getComputedStyle(element).borderRadius || "0px";
  return element.animate([
    { clipPath: `inset(${top}px ${right}px ${bottom}px ${left}px round ${round})` },
    { clipPath: `inset(0px 0px 0px 0px round ${round})` },
  ], { duration, easing: EASE_OUT });
}

/** How far a returning box travels: a short way, never the whole distance. */
const RETURN_TRAVEL = 24;

/**
 * A box that has shrunk back (a pane restored) takes its place at once and settles there: it
 * comes a short way from where the larger box was, fading up. No scale, so text keeps its shape.
 */
export function returnTo(element: HTMLElement, before: Box, after: Box, duration = motionMs("--dur-base")) {
  if (!moves(element)) return null;
  const x = before.left + before.width / 2 - (after.left + after.width / 2), y = before.top + before.height / 2 - (after.top + after.height / 2);
  const length = Math.hypot(x, y);
  const step = length < 1 ? 0 : Math.min(RETURN_TRAVEL, length) / length;
  restart(element);
  // Above its neighbours while it settles (they fade in around it).
  return element.animate([
    { zIndex: 1, opacity: 0.6, transform: `translate(${Math.round(x * step)}px, ${Math.round(y * step)}px)` },
    { zIndex: 1, opacity: 1, transform: "none" },
  ], { duration, easing: EASE_OUT });
}

/** Something that has just appeared in its place fades in. */
export function fadeIn(element: HTMLElement, duration = motionMs("--dur-fast")) {
  if (moves(element)) restart(element);
  return moves(element) ? element.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing: EASE_OUT }) : null;
}

/** Slide along x from `dx` back to where it is. */
export function slideX(element: HTMLElement, dx: number, duration = motionMs("--dur-fast")) {
  if (!moves(element) || Math.abs(dx) < 0.5) return null;
  return element.animate([{ transform: `translateX(${dx}px)` }, { transform: "none" }], { duration, easing: EASE_OUT });
}

/** Widen from nothing to its own width (a new tab). The one layout-property motion; keep it short. */
export function widenIn(element: HTMLElement, width: number, duration = motionMs("--dur-fast")) {
  if (!moves(element) || width < 1) return null;
  const overflow = element.style.overflow;
  element.style.overflow = "hidden";
  const animation = element.animate([{ width: "0px", opacity: 0 }, { width: `${width}px`, opacity: 1 }], { duration, easing: EASE_OUT });
  const done = () => { element.style.overflow = overflow; };
  animation.onfinish = done;
  animation.oncancel = done;
  return animation;
}

const boxOf = (element: Element): Box => {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
};

/** The box nearest the line (one that crosses it wins), among those inside the view. */
export function pickAnchor(rects: Map<string, Box>, view: { top: number; bottom: number }, line: number): string | null {
  let best: string | null = null;
  let distance = Infinity;
  for (const [id, box] of rects) {
    if (box.top + box.height < view.top || box.top > view.bottom) continue;
    const away = box.top <= line && box.top + box.height >= line ? 0 : Math.min(Math.abs(box.top - line), Math.abs(box.top + box.height - line));
    if (away < distance) {
      distance = away;
      best = id;
    }
  }
  return best;
}

/**
 * The first frame of a move: where the box was relative to where it is now. A box that holds
 * other moving boxes only slides (scaling it would distort them); inside a sliding box, the
 * child's own move is what remains after its parent's.
 */
export function startFrame(before: Box, after: Box, options: { holdsOthers: boolean; parent: { dx: number; dy: number } | null }) {
  const dx = before.left - after.left;
  const dy = before.top - after.top;
  const sx = options.holdsOthers ? 1 : before.width / Math.max(1, after.width);
  const sy = options.holdsOthers ? 1 : before.height / Math.max(1, after.height);
  return { dx, dy, ownDx: dx - (options.parent?.dx ?? 0), ownDy: dy - (options.parent?.dy ?? 0), sx, sy };
}

const flipElements = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLElement>("[data-flip]"));

/** Measure before a change. `scroller` is what scrolls the view; `pointer` where the mouse is, if over it. */
export function measure(root: HTMLElement, scroller: HTMLElement | null, pointer: { x: number; y: number } | null): FlipFirst {
  const rects = new Map<string, Box>();
  for (const element of flipElements(root)) {
    const id = element.dataset.flip!;
    if (rects.has(id)) continue;
    const box = boxOf(element);
    if (box.width || box.height) rects.set(id, box);
  }
  let anchor: FlipFirst["anchor"] = null;
  // At the top of the page the top stays the top; further down, what is being read stays put.
  if (scroller && scroller.scrollTop > 8) {
    const view = scroller.getBoundingClientRect();
    const over = pointer && pointer.y >= view.top && pointer.y <= view.bottom && pointer.x >= view.left && pointer.x <= view.right;
    const id = pickAnchor(rects, view, over ? pointer.y : view.top + view.height * READING_LINE);
    if (id) anchor = { id, top: rects.get(id)!.top };
  }
  return { rects, anchor };
}

/** Run after the change is in the DOM (a layout effect). */
export function play(root: HTMLElement, scroller: HTMLElement | null, first: FlipFirst) {
  const elements = flipElements(root);
  // A switch during the last one: start from where things are drawn now, not from mid-flight.
  for (const element of elements) for (const animation of element.getAnimations?.() ?? []) animation.cancel();
  if (first.anchor && scroller) {
    const element = elements.find((candidate) => candidate.dataset.flip === first.anchor!.id);
    if (element) scroller.scrollTop += element.getBoundingClientRect().top - first.anchor.top;
  }
  if (reducedMotion() || typeof root.animate !== "function") return;
  const view = (scroller ?? document.documentElement).getBoundingClientRect();
  const seen = new Set<string>();
  const moved = new Map<HTMLElement, { dx: number; dy: number }>();
  let moving = 0;
  for (const element of elements) {
    const id = element.dataset.flip!;
    if (seen.has(id)) continue;
    seen.add(id);
    const after = boxOf(element);
    if (after.top > view.bottom + 200 || after.top + after.height < view.top - 200) continue;
    if (++moving > MAX_MOVING) break;
    const parentElement = element.parentElement?.closest<HTMLElement>("[data-flip]") ?? null;
    const parent = parentElement && root.contains(parentElement) ? parentElement : null;
    const before = first.rects.get(id);
    if (!before) {
      // New here. Inside a new box the box fades for both; a new box around things that were
      // already on screen only appears, so they can be seen sliding into it.
      if (parent && !first.rects.has(parent.dataset.flip!)) continue;
      if (Array.from(element.querySelectorAll<HTMLElement>("[data-flip]")).some((child) => first.rects.has(child.dataset.flip!))) continue;
      element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DURATION * 0.8, delay: DURATION * 0.2, easing: "ease-out", fill: "backwards" });
      continue;
    }
    const frame = startFrame(before, after, { holdsOthers: element.querySelector("[data-flip]") !== null, parent: parent ? (moved.get(parent) ?? null) : null });
    moved.set(element, { dx: frame.dx, dy: frame.dy });
    if (Math.abs(frame.ownDx) < 0.5 && Math.abs(frame.ownDy) < 0.5 && Math.abs(frame.sx - 1) < 0.01 && Math.abs(frame.sy - 1) < 0.01) continue;
    element.animate([{ transform: `translate(${frame.ownDx}px, ${frame.ownDy}px) scale(${frame.sx}, ${frame.sy})` }, { transform: "none" }], { duration: DURATION, easing: EASING });
  }
}
