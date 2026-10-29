import { useCallback, useMemo, useRef, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import type { NavShortcut, Work } from "@workbench/contracts";
import { paneDrag, type DragSource } from "../../panedrag.ts";
import type { Row } from "../../tree.ts";

// Dragging in the sidebar with pointer events (HTML drag and drop is unreliable in the desktop
// app's WebKitGTK). One controller for every pane: tree rows, the navigator's folders, projects
// (one or many) from the list, shortcuts and tags. Where a drop would land is marked with a class
// on that one element, and only the ghost follows the pointer as React state, so a list of
// hundreds of projects is never drawn again while something is dragged.

export type DragPayload =
  | { kind: "row"; row: Row }
  | { kind: "projects"; works: Work[] }
  | { kind: "shortcut"; index: number; entry: NavShortcut; label: string }
  | { kind: "tag"; tag: string };

export type DropTarget = {
  /** The element that shows where the drop lands, and how ("drop-inside", "drop-before"…). */
  element: HTMLElement | null;
  mark: string | null;
  /** Said after the dragged name in the ghost ("→ 강의"). */
  hint?: string;
  /** Said instead of the dragged name ("⇄ 세션 잇기: …"). */
  text?: string;
  linking?: boolean;
  /** What the drop does; null where it is refused. */
  run: (() => void) | null;
};

export type DragHandlers = {
  resolve: (payload: DragPayload, x: number, y: number) => DropTarget | null;
  /** What opens in a pane when the drag goes out over the main area (null: nothing). */
  paneSource: (payload: DragPayload) => DragSource | null;
  label: (payload: DragPayload) => string;
  /** The elements being dragged (dimmed while the drag lasts). */
  sources: (payload: DragPayload) => HTMLElement[];
};

export type Ghost = { x: number; y: number; text: string; tone: "ok" | "refused" | "linking" | "pane" };

function ghostStore() {
  let current: Ghost | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set(next: Ghost | null) {
      current = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
export type GhostStore = ReturnType<typeof ghostStore>;

export const useGhost = (store: GhostStore) => useSyncExternalStore(store.subscribe, store.get, () => null);

/** `press` on a row's pointerdown; the drag starts once the pointer moves 6px. */
export function useDragController(handlers: DragHandlers) {
  const latest = useRef(handlers);
  latest.current = handlers;
  const store = useMemo(ghostStore, []);
  const blockClick = useRef(false);

  const press = useCallback(
    (payload: DragPayload, event: ReactPointerEvent | PointerEvent) => {
      if (event.button !== 0) return;
      const x0 = event.clientX;
      const y0 = event.clientY;
      let active = false;
      let target: DropTarget | null = null;
      let marked: { element: HTMLElement; mark: string } | null = null;
      let dimmed: HTMLElement[] = [];
      const unmark = () => {
        marked?.element.classList.remove(marked.mark);
        marked = null;
      };
      const move = (pointer: PointerEvent) => {
        if (!active && Math.hypot(pointer.clientX - x0, pointer.clientY - y0) < 6) return;
        const current = latest.current;
        if (!active) {
          active = true;
          dimmed = current.sources(payload);
          for (const element of dimmed) element.classList.add("dragging");
          document.documentElement.classList.add("nav-dragging");
          window.getSelection()?.removeAllRanges();
        }
        // Out over the main area the dragged thing opens in a pane; inside the sidebar it moves.
        const source = current.paneSource(payload);
        const outside = source ? paneDrag.track(source, pointer.clientX, pointer.clientY) : false;
        target = outside ? null : current.resolve(payload, pointer.clientX, pointer.clientY);
        const element = target?.element ?? null;
        const mark = target?.mark ?? null;
        if (!element || !mark) unmark();
        else if (marked?.element !== element || marked.mark !== mark) {
          unmark();
          marked = { element, mark };
        }
        // Added again each move: a row drawn again meanwhile (a session's status) loses the class.
        if (marked) marked.element.classList.add(marked.mark);
        store.set({
          x: pointer.clientX,
          y: pointer.clientY,
          text: target?.text ?? `${current.label(payload)}${target?.hint ?? ""}`,
          tone: outside ? "pane" : target?.linking ? "linking" : target?.run ? "ok" : "refused",
        });
      };
      const end = (commit: boolean) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("blur", cancel);
        window.removeEventListener("keydown", key, true);
        unmark();
        for (const element of dimmed) element.classList.remove("dragging");
        document.documentElement.classList.remove("nav-dragging");
        store.set(null);
        if (!active) return;
        blockClick.current = true;
        window.setTimeout(() => (blockClick.current = false), 0);
        if (paneDrag.release(commit)) return;
        if (commit) target?.run?.();
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
      window.addEventListener("blur", cancel);
      window.addEventListener("keydown", key, true);
    },
    [store],
  );

  /** A click right after a drag ended on the dragged row is part of the drag. */
  const justDragged = useCallback(() => blockClick.current || paneDrag.justDragged(), []);
  return { press, justDragged, store };
}

/** Where a pointer is on a row: the top quarter before it, the bottom quarter after, else inside. */
export function zoneOf(element: HTMLElement, y: number, canHoldInside: boolean): "before" | "inside" | "after" {
  const box = element.getBoundingClientRect();
  const ratio = box.height > 0 ? (y - box.top) / box.height : 0.5;
  if (!canHoldInside) return ratio < 0.5 ? "before" : "after";
  return ratio < 0.25 ? "before" : ratio > 0.75 ? "after" : "inside";
}
