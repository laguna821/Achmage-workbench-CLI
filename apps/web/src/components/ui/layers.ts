/**
 * One stack for every floating layer (menus, selects, anchored panels). Only the topmost layer
 * answers Escape and an outside pointer-down; a pointer-down inside any layer is never "outside"
 * for the layers beneath it. Legacy surfaces with their own listeners call `layerOwns(event)`
 * first and step aside when it is true.
 */

export type LayerCloseReason = "escape" | "outside";
type Layer = { element: HTMLElement; owner: () => Element | null; close: (reason: LayerCloseReason) => void };

const stack: Layer[] = [];
// When a layer last took an Escape: a dialog's `cancel` from that same key must not close the dialog.
let escapeTakenAt = -Infinity;
const now = () => (typeof performance === "undefined" ? Date.now() : performance.now());

const isComposing = (event: KeyboardEvent) => event.isComposing || event.keyCode === 229;

function onKey(event: KeyboardEvent) {
  const top = stack.at(-1);
  if (!top || event.key !== "Escape" || isComposing(event)) return;
  // Window capture runs before every dialog's own Escape listener; stop them all here.
  event.preventDefault();
  event.stopImmediatePropagation();
  escapeTakenAt = now();
  top.close("escape");
}

function onPointer(event: PointerEvent) {
  const top = stack.at(-1);
  if (!top || !(event.target instanceof Node)) return;
  const target = event.target;
  const index = stack.findIndex(layer => layer.element.contains(target));
  if (index === stack.length - 1 || top.owner()?.contains(target)) return;
  // Inside a lower layer: close only what is stacked above it; outside all: only the top.
  if (index >= 0) for (const layer of stack.slice(index + 1).reverse()) layer.close("outside");
  else top.close("outside");
}

let listening = false;
function listen() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("pointerdown", onPointer, true);
}
// Registered at import, so this capture listener runs before any dialog registered later.
listen();

/** Push a layer; `owner` is its trigger (a press there is not outside). Returns the removal. */
export function registerLayer(element: HTMLElement, close: (reason: LayerCloseReason) => void, owner: () => Element | null = () => null) {
  listen();
  const layer: Layer = { element, close, owner };
  stack.push(layer);
  return () => {
    const index = stack.indexOf(layer);
    if (index >= 0) stack.splice(index, 1);
  };
}

export const hasOpenLayer = () => stack.length > 0;

/** Is `node` inside any open layer? */
export const insideLayer = (node: EventTarget | null) => node instanceof Node && stack.some(layer => layer.element.contains(node));

/** Is `element` (a layer, or inside one) the topmost layer? */
export const isTopLayer = (element: Element | null) => Boolean(element && stack.at(-1)?.element.contains(element));

/**
 * The guard for legacy Escape / outside-click listeners: true when a layer handles this event —
 * Escape while a layer is open, a `<dialog>` cancel caused by such an Escape, or a pointer event
 * that lands inside a layer.
 */
export function layerOwns(event: Event) {
  if (event.type === "keydown") return (event as KeyboardEvent).key === "Escape" && hasOpenLayer();
  if (event.type === "cancel") return hasOpenLayer() || now() - escapeTakenAt < 250;
  return insideLayer(event.target);
}
