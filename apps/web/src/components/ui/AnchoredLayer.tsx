import {
  useCallback, useContext, useEffect, useLayoutEffect, useRef, useState,
  type CSSProperties, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { AppearanceContext, lookStyle, NEUTRAL_LOOK } from "../../appearance.ts";
import { restoreSurfaceFocus } from "../controls/menu-navigation.ts";
import { insideLayer, registerLayer } from "./layers.ts";
import { place, pointRect, type Align, type Side, type Viewport } from "./overlay.ts";
import "../../styles/menu.css";

/** An element (or a ref to one) the layer opens beside, or a point (context menus). */
export type LayerAnchor = HTMLElement | RefObject<HTMLElement | null> | { x: number; y: number } | null;
/** "tab": Tab out of a menu; "blur": focus left the layer, or the window lost focus. */
export type LayerCloseReason = "select" | "escape" | "outside" | "tab" | "blur";

export type AnchoredLayerProps = {
  open: boolean;
  /** Close the layer (set `open` false). Focus returns to where it was when the layer opened. */
  onClose: (reason: LayerCloseReason) => void;
  anchor: LayerAnchor;
  children: ReactNode;
  /** Accessible name (of the dialog role; Menu/Select name their list instead). */
  label?: string;
  /** "dialog" for panels and forms; "none" when an inner element carries the role. Default "dialog". */
  role?: "dialog" | "none";
  /** Preferred side; flips when the other side has room and this one does not. Default "bottom". */
  side?: Side;
  /** Line up with the anchor's start or end edge. Default "start". */
  align?: Align;
  /** Distance from the anchor. Default 4 (0 for a point). */
  gap?: number;
  /** The area to stay inside (default: the window), e.g. to keep clear of a native webview. */
  viewport?: () => Viewport;
  /** At least the anchor's width, or a pixel width. */
  minWidth?: "anchor" | number;
  className?: string;
  /** What takes focus on open: a ref, the first focusable control ("first", default), or nothing. */
  initialFocus?: RefObject<HTMLElement | null> | "first" | "none";
  /** The element that scrolls when the layer is height-limited (default: the layer). */
  scrollRef?: RefObject<HTMLElement | null>;
  /** Called after the layer is placed and focused. */
  onOpen?: () => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  /**
   * The layer sits in the tab order where its trigger is: Tab past its last control goes on to what
   * follows the trigger, Shift+Tab before its first goes back to the trigger. Doing so closes it
   * (default true); false keeps it open.
   */
  closeOnTabOut?: boolean;
};

// The browser top layer draws above every z-index and every modal; feature-detected (jsdom lacks it).
const TOP_LAYER = typeof HTMLElement !== "undefined" && typeof HTMLElement.prototype.showPopover === "function";
const FOCUSABLE = 'input:not(:disabled):not([type="hidden"]), textarea:not(:disabled), select:not(:disabled), button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])';

/** Is the element actually drawn (not display:none, hidden, in a closed <details> or content-visibility skipped)? */
function rendered(element: HTMLElement) {
  if (typeof element.checkVisibility === "function") {
    return element.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true, contentVisibilityAuto: true } as CheckVisibilityOptions);
  }
  if (typeof getComputedStyle !== "function") return true;
  const own = getComputedStyle(element);
  if (own.visibility === "hidden" || own.visibility === "collapse") return false;
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (getComputedStyle(node).display === "none") return false;
    const details: HTMLElement | null = node.parentElement;
    // A closed <details> shows only its first <summary>.
    if (details instanceof HTMLDetailsElement && !details.open && details.querySelector(":scope > summary") !== node) return false;
  }
  return true;
}

const tabbables = (root: ParentNode) => Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
  .filter(element => element.tabIndex >= 0 && !element.closest("[hidden], [inert], [aria-hidden=\"true\"]") && rendered(element));

/** Tabbable controls after `reference` in document order (outside every layer). */
function tabbablesAfter(reference: Element) {
  const scope = reference.closest("dialog[open]") ?? document;
  return tabbables(scope).filter(element => !reference.contains(element) && !insideLayer(element)
    && Boolean(reference.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING));
}

/** Focus the first candidate that really takes focus, else `fallback`; focus is never left on the body. */
function focusFirst(candidates: HTMLElement[], fallback: HTMLElement) {
  for (const candidate of candidates) {
    candidate.focus();
    if (document.activeElement === candidate) return candidate;
  }
  fallback.focus();
  return fallback;
}

const isPoint = (anchor: LayerAnchor): anchor is { x: number; y: number } =>
  Boolean(anchor) && !(anchor instanceof HTMLElement) && "x" in anchor! && "y" in anchor!;
const anchorElement = (anchor: LayerAnchor): HTMLElement | null =>
  !anchor || isPoint(anchor) ? null : anchor instanceof HTMLElement ? anchor : anchor.current;

/** The running exit animation's length; 0 when there is none (tests, reduced motion). */
function exitDuration(element: HTMLElement | null) {
  if (!element || typeof getComputedStyle !== "function") return 0;
  const style = getComputedStyle(element);
  if (!style.animationName || style.animationName === "none") return 0;
  const seconds = (style.animationDuration || "0s").split(",")[0]!.trim();
  const ms = seconds.endsWith("ms") ? parseFloat(seconds) : parseFloat(seconds) * 1000;
  return ms >= 1 ? ms : 0;
}

const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();

/**
 * A floating layer beside an anchor: browser top layer (or a body portal), `place()` geometry,
 * open/close motion, Escape and outside-click through the shared layer stack, focus in and back.
 * No list keyboard: Tab and Space behave normally, so forms and custom panels live here.
 */
export function AnchoredLayer({
  open, onClose, anchor, children, label, role = "dialog", side = "bottom", align = "start", gap, viewport, minWidth,
  className = "", initialFocus = "first", scrollRef, onOpen, onKeyDown, closeOnTabOut = true,
}: AnchoredLayerProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [present, setPresent] = useState(open);
  if (open && !present) setPresent(true);
  const openerRef = useRef<Element | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const lockedSide = useRef<Side | null>(null);
  const appearance = useContext(AppearanceContext);
  const anchorEl = anchorElement(anchor);
  const point = isPoint(anchor) ? anchor : null;

  // Chosen once per opening, so the exit fade stays where the layer was (inside a modal dialog).
  const containerRef = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current && typeof document !== "undefined") {
    const from = anchorEl ?? document.activeElement;
    // A modal dialog makes the rest of the page inert, so a layer opened from one lives inside it.
    containerRef.current = from?.closest<HTMLElement>("dialog[open]") ?? document.body;
  }
  wasOpen.current = open;

  const close = useCallback((reason: LayerCloseReason) => closeRef.current(reason), []);

  const position = useCallback(() => {
    const surface = surfaceRef.current;
    if (!surface || (!anchorEl && !point)) return;
    const rect = anchorEl ? anchorEl.getBoundingClientRect() : pointRect(point!.x, point!.y);
    if (minWidth !== undefined) surface.style.setProperty("--ui-layer-min-width", `${minWidth === "anchor" ? Math.round(rect.right - rect.left) : minWidth}px`);
    const scroller = scrollRef?.current ?? surface;
    const height = surface.offsetHeight - scroller.clientHeight + scroller.scrollHeight;
    const width = surface.offsetWidth;
    const area = viewport?.() ?? { width: window.innerWidth, height: window.innerHeight };
    const spot = place(rect, { width, height }, area, { side: lockedSide.current ?? side, align, gap: gap ?? (point ? 0 : 4) });
    lockedSide.current = spot.side;
    surface.style.left = `${Math.round(spot.left)}px`;
    surface.style.top = `${Math.round(spot.top)}px`;
    surface.style.maxHeight = `${Math.floor(spot.maxHeight)}px`;
    surface.style.setProperty("--ui-layer-max-width", `${Math.floor(spot.maxWidth)}px`);
    // Grow out of the anchor: the origin is the anchor's nearest point on the layer's edge.
    const shown = Math.min(height, spot.maxHeight);
    const centerX = (rect.left + rect.right) / 2 - spot.left, centerY = (rect.top + rect.bottom) / 2 - spot.top;
    const originX = spot.side === "right" ? 0 : spot.side === "left" ? width : Math.max(0, Math.min(width, centerX));
    const originY = spot.side === "bottom" ? 0 : spot.side === "top" ? shown : Math.max(0, Math.min(shown, centerY));
    surface.style.transformOrigin = `${Math.round(originX)}px ${Math.round(originY)}px`;
    surface.dataset.side = spot.side;
    surface.dataset.placed = "";
  }, [anchorEl, point?.x, point?.y, side, align, gap, viewport, minWidth, scrollRef]);

  // Into the top layer first: a popover that is not shown has no box to measure.
  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!present || !surface || !TOP_LAYER || surface.matches(":popover-open")) return;
    surface.showPopover();
  }, [present]);
  // Placed before paint, after every render (content changes the height).
  useLayoutEffect(() => { if (present) position(); });

  // Escape and outside pointer-down come from the shared stack (only the top layer answers).
  // Registered before focus moves in, so the layer below sees the focus land in a layer.
  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!open || !surface) return;
    return registerLayer(surface, close, () => anchorEl);
  }, [open, anchorEl, close]);

  // Open: remember the opener, place, move focus in. Close: give focus back.
  useLayoutEffect(() => {
    if (!open) {
      // Not in a cleanup: React restores the pre-commit focus after cleanups, back into the fading layer.
      if (openerRef.current) restoreSurfaceFocus(openerRef.current, surfaceRef.current);
      openerRef.current = null;
      return;
    }
    openerRef.current = document.activeElement;
    lockedSide.current = null;
    // Placed first: an unplaced layer is hidden, and hidden controls cannot take focus.
    position();
    const surface = surfaceRef.current;
    const target = initialFocus === "none" ? null
      : initialFocus === "first" ? surface?.querySelector<HTMLElement>(FOCUSABLE) ?? surface
      : initialFocus.current;
    target?.focus({ preventScroll: true });
    onOpen?.();
  }, [open]);
  // Unmounted while open (the owner went away): still give focus back.
  useLayoutEffect(() => () => {
    if (openerRef.current) restoreSurfaceFocus(openerRef.current, surfaceRef.current);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onScroll = (event: Event) => { if (!surfaceRef.current?.contains(event.target as Node)) position(); };
    const onBlur = () => close("blur");
    window.addEventListener("resize", position);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("blur", onBlur);
    // Follow an anchor that moves without a scroll or resize (its container grows, a layout shifts).
    let frame = 0, last = "";
    const follow = () => {
      const box = anchorEl?.getBoundingClientRect();
      const now = box ? `${box.left},${box.top},${box.width},${box.height}` : "";
      if (last && now !== last) position();
      last = now;
      frame = window.requestAnimationFrame(follow);
    };
    if (anchorEl) frame = window.requestAnimationFrame(follow);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [open, position, close, anchorEl]);

  // Closing: play the short exit, then unmount.
  useEffect(() => {
    if (open || !present) return;
    const duration = exitDuration(surfaceRef.current);
    if (!duration) { setPresent(false); return; }
    const timer = window.setTimeout(() => setPresent(false), duration + 20);
    return () => window.clearTimeout(timer);
  }, [open, present]);

  // Focus moving somewhere that is neither this layer, a layer above it, nor its trigger closes it.
  // Tab order: the layer is portaled, so it is stitched in after its trigger by hand (no trap: not modal).
  const tabbedOut = useRef(false);
  const reference = () => (anchorEl ?? (openerRef.current instanceof HTMLElement ? openerRef.current : null));
  const onTab = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const surface = surfaceRef.current, from = reference();
    if (event.key !== "Tab" || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || !surface || !from) return;
    const inside = tabbables(surface);
    const target = event.target as HTMLElement;
    const leaving = event.shiftKey ? target === inside[0] || !inside.length : target === inside.at(-1) || !inside.length;
    if (!leaving) return;
    event.preventDefault();
    // Move focus first, close after: a move that fails must not strand focus in a closed layer.
    tabbedOut.current = true;
    focusFirst(event.shiftKey ? [] : tabbablesAfter(from), from);
    tabbedOut.current = false;
    if (closeOnTabOut) close("tab");
  };
  // Tab on the trigger while the layer is open enters the layer at its first control.
  useEffect(() => {
    const from = anchorEl;
    if (!open || !from) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || event.shiftKey || event.defaultPrevented) return;
      const first = surfaceRef.current ? tabbables(surfaceRef.current)[0] : undefined;
      if (!first) return;
      event.preventDefault();
      first.focus();
    };
    from.addEventListener("keydown", onKey);
    return () => from.removeEventListener("keydown", onKey);
  }, [open, anchorEl]);

  const onBlurWithin = (event: ReactFocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (!open || tabbedOut.current || !(next instanceof Node)) return;
    if (surfaceRef.current?.contains(next) || insideLayer(next) || anchorEl?.contains(next)) return;
    close("blur");
  };

  const container = containerRef.current;
  if (!present || !container) return null;
  const theme = appearance?.appTheme;
  const style: CSSProperties = theme ? lookStyle(NEUTRAL_LOOK[theme]) : {};
  return createPortal(
    <div ref={surfaceRef} className={`ui-layer${theme ? " look-scope" : ""} ${className}`} data-theme={theme} data-state={open ? "open" : "closed"}
      popover={TOP_LAYER ? "manual" : undefined} role={role === "none" ? undefined : role} aria-label={role === "dialog" ? label : undefined}
      aria-hidden={open ? undefined : true} tabIndex={-1} style={style} onBlur={onBlurWithin}
      onKeyDown={event => {
        onKeyDown?.(event);
        onTab(event);
        // Plain keys stay in the layer; shortcuts with modifiers still reach the app.
        if (!event.ctrlKey && !event.metaKey && !event.altKey) event.stopPropagation();
      }}
      // React bubbles portal events to the owner's ancestors (pane drag, row clicks, dialog keys); they are not theirs.
      onKeyUp={stop} onPointerDown={stop} onMouseDown={stop} onClick={stop} onDoubleClick={stop}
      onContextMenu={event => {
        event.stopPropagation();
        if (!(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) event.preventDefault();
      }}>
      {children}
    </div>,
    container,
  );
}
