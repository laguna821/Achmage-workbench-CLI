import { createContext, useCallback, useContext, useEffect, useId, useRef, useSyncExternalStore } from "react";
import type { PaneItem, PaneTarget } from "./panes.ts";

// Dragging things into the panes with pointer events (HTML drag and drop is unreliable in the
// desktop app's WebKitGTK, as the sidebar and the card list already found). Sources press here and
// the pointer is followed on the window; over the main area the pane layout shows where the item
// lands (left or right). A vault note over an input that takes notes goes to that input instead, so
// the drop zones never take a drop aimed at a composer.

export type DragSource = { item: PaneItem; label: string };

type Over = { kind: "zone"; target: PaneTarget } | { kind: "note"; id: string } | null;

/** The drag in progress: `own` when followed here (its ghost is drawn here, not by the source). */
export type PaneDrag = DragSource & { x: number; y: number; over: Over; own: boolean };

/** Where pane drops land: the pane layout registers itself. */
export type DropArea = {
  element: () => HTMLElement | null;
  targetAt: (x: number, y: number) => PaneTarget | null;
  drop: (item: PaneItem, target: PaneTarget) => void;
};

type NoteTarget = { take: (note: { path: string; title: string }) => void };

let current: PaneDrag | null = null;
const listeners = new Set<() => void>();
let area: DropArea | null = null;
const noteTargets = new Map<string, NoteTarget>();
let blockClick = false;

function publish(next: PaneDrag | null) {
  current = next;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** What is under the pointer: an input taking notes (for a note), else a side of the panes. */
function overAt(item: PaneItem, x: number, y: number): Over {
  const element = document.elementFromPoint(x, y);
  if (!element) return null;
  if (item.kind === "note") {
    const input = element.closest<HTMLElement>("[data-note-drop]");
    const id = input?.dataset.noteDrop;
    if (id && noteTargets.has(id)) return { kind: "note", id };
  }
  const host = area?.element();
  if (!area || !host || !host.contains(element)) return null;
  const target = area.targetAt(x, y);
  return target ? { kind: "zone", target } : null;
}

function finish(commit: boolean): boolean {
  const ended = current;
  if (ended) publish(null);
  document.documentElement.classList.remove("pane-dragging");
  if (!commit || !ended?.over) return false;
  if (ended.over.kind === "note") {
    const target = noteTargets.get(ended.over.id);
    if (!target || ended.item.kind !== "note") return false;
    target.take({ path: ended.item.path, title: ended.label });
    return true;
  }
  area?.drop(ended.item, ended.over.target);
  return true;
}

function suppressClick() {
  blockClick = true;
  window.setTimeout(() => (blockClick = false), 0);
}

export const paneDrag = {
  /** A press on something that opens in a pane: it becomes a drag once the pointer moves a little. */
  press(source: DragSource, event: { clientX: number; clientY: number; button: number }) {
    // A note can still go to an input where there are no panes to open things in.
    if (event.button !== 0 || (!area && source.item.kind !== "note")) return;
    const x0 = event.clientX;
    const y0 = event.clientY;
    let active = false;
    const move = (pointer: PointerEvent) => {
      if (!active && Math.hypot(pointer.clientX - x0, pointer.clientY - y0) < 6) return;
      if (!active) {
        active = true;
        document.documentElement.classList.add("pane-dragging");
        window.getSelection()?.removeAllRanges();
      }
      publish({ ...source, x: pointer.clientX, y: pointer.clientY, over: overAt(source.item, pointer.clientX, pointer.clientY), own: true });
    };
    const end = (commit: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", key, true);
      if (!active) return;
      suppressClick();
      finish(commit);
    };
    const up = () => end(true);
    const cancel = () => end(false);
    const key = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== "Escape" || !active) return;
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      end(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    // Released outside the window, or the window left: nothing is dropped.
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", key, true);
  },
  /**
   * For a source that follows the pointer itself (the sidebar's tree, which also moves rows): where
   * the pointer is now. True while it is over a pane side or an input, where the source's own drop
   * targets do not apply.
   */
  track(source: DragSource | null, x: number, y: number): boolean {
    const over = source && area ? overAt(source.item, x, y) : null;
    if (!over || !source) {
      if (current) publish(null);
      return false;
    }
    publish({ ...source, x, y, over, own: false });
    return true;
  },
  /** The end of such a drag: true when it landed in a pane or an input (the source does nothing else). */
  release: (commit: boolean) => finish(commit),
  /** A click right after a drag ended on what was dragged is part of the drag, not a click. */
  justDragged: () => blockClick,
  /** Panes can be opened here (false in a detached session window, or before the layout is there). */
  ready: () => area !== null,
};

/** The drag in progress, for the ghost (every move). */
export const usePaneDrag = () => useSyncExternalStore(subscribe, () => current, () => null);

/** A slice of the drag that changes rarely (the layout's overlay re-renders only when it changes). */
export function usePaneDragSlice<T>(select: (drag: PaneDrag | null) => T): T {
  return useSyncExternalStore(subscribe, () => select(current), () => select(null));
}

/** The pane layout's drop area (one at a time). */
export function useDropArea(next: DropArea | null) {
  const latest = useRef(next);
  latest.current = next;
  const enabled = next !== null;
  useEffect(() => {
    if (!enabled) return;
    const registered: DropArea = {
      element: () => latest.current?.element() ?? null,
      targetAt: (x, y) => latest.current?.targetAt(x, y) ?? null,
      drop: (item, target) => latest.current?.drop(item, target),
    };
    area = registered;
    return () => {
      if (area === registered) area = null;
    };
  }, [enabled]);
}

/**
 * An input that takes vault notes dropped on it (read-only references for its next request). Spread
 * `props` on the element that counts as the input; `over` is true while a note is held over it.
 */
export function useNoteDrop(take: ((note: { path: string; title: string }) => void) | null) {
  const id = useId();
  const latest = useRef(take);
  latest.current = take;
  const enabled = take !== null;
  useEffect(() => {
    if (!enabled) return;
    noteTargets.set(id, { take: (note) => latest.current?.(note) });
    return () => {
      noteTargets.delete(id);
    };
  }, [id, enabled]);
  const over = usePaneDragSlice(useCallback((drag: PaneDrag | null) => drag?.over?.kind === "note" && drag.over.id === id, [id]));
  return { over, props: enabled ? { "data-note-drop": id } : {} };
}

/** "오른쪽에 열기" for menus and Ctrl+clicks deep in the screen (null where there are no panes). */
export type PaneActions = { openBeside: (item: PaneItem) => void };
export const PaneActionsContext = createContext<PaneActions | null>(null);
export const usePaneActions = () => useContext(PaneActionsContext);
