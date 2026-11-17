import { createContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { EditorPool } from "../editor-pool.ts";

/**
 * Where the editor pool's frames are drawn (apps/web/src/editor-pool.ts). An iframe cannot move between the tabs'
 * sections without reloading, so the frames of one window surface live in ONE layer inside `.panes`, after the sections,
 * never re-parented; a document's editor (OfficeEditor.tsx) leaves a slot where its iframe used to be and the frame it
 * holds is laid exactly over that slot. Dialogs of a pooled editor are drawn above the frames (`over`).
 */
/** `tab` / `paneActive`: the holder's tab and whether its pane is the focused one, mirrored on the frame (rigs and tools find "the editor on screen" there). */
export type FrameLook = { box: { left: number; top: number; width: number; height: number } | null; shown: boolean; covered: boolean; tab?: string; paneActive?: boolean };
type FrameState = { src: string | null; title: string; look: FrameLook; on: { focus(): void; leave(): void } | null };

export class PoolSurface {
  readonly pool: EditorPool;
  private readonly states = new Map<string, FrameState>();
  private readonly elements = new Map<string, HTMLIFrameElement>();
  private readonly watchers = new Map<string, Set<(element: HTMLIFrameElement | null) => void>>();
  private readonly listeners = new Set<() => void>();
  private version = 0;
  host: HTMLElement | null = null;
  over: HTMLElement | null = null;
  constructor(pool = new EditorPool()) {
    this.pool = pool;
    pool.subscribe(() => {
      const live = new Set(pool.frames().map((frame) => frame.id));
      for (const id of [...this.states.keys()]) if (!live.has(id)) this.states.delete(id);
      this.bump();
    });
  }
  private bump() { this.version += 1; for (const listener of [...this.listeners]) listener(); }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.version;
  frames() { return this.pool.frames().map((frame) => ({ ...frame, state: this.state(frame.id) })); }
  private state(id: string) {
    let state = this.states.get(id);
    if (!state) { state = { src: null, title: "", look: { box: null, shown: false, covered: false }, on: null }; this.states.set(id, state); }
    return state;
  }
  /** Give the frame a page address: a new page, or the same frame opened again (a reload). */
  load(frameId: string, src: string, title: string) {
    const state = this.state(frameId);
    if (state.src === src && state.title === title) return;
    state.src = src; state.title = title; this.bump();
  }
  /** Where and how the frame is drawn (set on the element directly: no render for a move). */
  place(frameId: string, look: FrameLook) {
    const state = this.state(frameId);
    state.look = look;
    const element = this.elements.get(frameId);
    if (element) drawLook(element, look);
  }
  /** What the frame's focus and pointer tell its holder. */
  handlers(frameId: string, on: FrameState["on"]) { this.state(frameId).on = on; }
  element(frameId: string) { return this.elements.get(frameId) ?? null; }
  /** Told when the frame's element is there (or gone). */
  watch(frameId: string, watcher: (element: HTMLIFrameElement | null) => void) {
    let set = this.watchers.get(frameId);
    if (!set) this.watchers.set(frameId, (set = new Set()));
    set.add(watcher);
    return () => { set!.delete(watcher); };
  }
  private readonly refs = new Map<string, (element: HTMLIFrameElement | null) => void>();
  /** The frame's ref callback, the same function every render (React calls a new one with null first). */
  refFor(frameId: string) {
    let ref = this.refs.get(frameId);
    if (!ref) { ref = (element) => { this.attachElement(frameId, element); if (!element) this.refs.delete(frameId); }; this.refs.set(frameId, ref); }
    return ref;
  }
  attachElement(frameId: string, element: HTMLIFrameElement | null) {
    if (element) { this.elements.set(frameId, element); drawLook(element, this.state(frameId).look); }
    else this.elements.delete(frameId);
    for (const watcher of [...(this.watchers.get(frameId) ?? [])]) watcher(element);
  }
  focus(frameId: string) { this.states.get(frameId)?.on?.focus(); }
  leave(frameId: string) { this.states.get(frameId)?.on?.leave(); }
}

function drawLook(element: HTMLIFrameElement, look: FrameLook) {
  const box = look.box;
  const shown = Boolean(box && look.shown && box.width > 0 && box.height > 0);
  element.style.left = `${box?.left ?? 0}px`; element.style.top = `${box?.top ?? 0}px`;
  element.style.width = `${box?.width ?? 0}px`; element.style.height = `${box?.height ?? 0}px`;
  // Off screen: not drawn (the page rests, page-rest.ts). Under the page picture (doc-cover) or while another document is
  // opened into it: drawn but transparent — it keeps laying out and painting, the picture under it shows.
  element.style.visibility = shown ? "visible" : "hidden";
  element.style.opacity = shown && !look.covered ? "1" : "0";
  element.style.pointerEvents = shown && !look.covered ? "auto" : "none";
  element.tabIndex = shown && !look.covered ? 0 : -1;
  element.dataset.poolShown = shown ? "true" : "false";
  if (look.tab) element.dataset.tab = look.tab; else delete element.dataset.tab;
  element.dataset.paneActive = look.paneActive ? "true" : "false";
}

export const EditorPoolContext = createContext<PoolSurface | null>(null);

/** One surface per PaneLayout (a window's panes). */
export function usePoolSurface() {
  const [surface] = useState(() => new PoolSurface());
  return surface;
}

export function EditorPoolLayer({ surface }: { surface: PoolSurface }) {
  useSyncExternalStore(surface.subscribe, surface.snapshot, surface.snapshot);
  const layer = useRef<HTMLDivElement>(null), over = useRef<HTMLDivElement>(null);
  useEffect(() => { surface.host = layer.current?.parentElement ?? null; surface.over = over.current; return () => { surface.host = null; surface.over = null; }; }, [surface]);
  return <>
    <div ref={layer} className="editor-pool">
      {surface.frames().filter((frame) => frame.state.src).map((frame) => (
        <iframe
          key={frame.id}
          ref={surface.refFor(frame.id)}
          data-pool-frame={frame.id}
          data-pool-kind={frame.kind}
          className="design-frame office-frame pooled"
          allow="fullscreen; clipboard-read; clipboard-write"
          src={frame.state.src!}
          title={frame.state.title}
          onFocus={() => surface.focus(frame.id)}
          onPointerLeave={() => surface.leave(frame.id)}
        />
      ))}
    </div>
    <div ref={over} className="editor-pool-over" />
  </>;
}
