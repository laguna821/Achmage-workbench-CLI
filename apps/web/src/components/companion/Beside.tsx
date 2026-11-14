import { useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { CHAT_MIN, COLUMN_GAP, besideFit, clampRatio } from "../../companion.ts";
import "../../styles/companion.css";

// What the arrangements on screen ask the right sidebar to leave them: for each one that is side
// by side now, the width its two columns need beyond a pane's own minimum. The sidebar docks only
// while the panes keep their minimum plus this; otherwise it lies over (components/right).
const rooms = new Map<symbol, number>();
const watchers = new Set<() => void>();
const watchRooms = (changed: () => void) => { watchers.add(changed); return () => { watchers.delete(changed); }; };
export const besideRoom = () => [...rooms.values()].reduce((sum, room) => sum + room, 0);
export const useBesideRoom = () => useSyncExternalStore(watchRooms, besideRoom);

/**
 * 곁 화면: a conversation column on the left, what it is about (a document, a web page) on the
 * right — the one arrangement for a conversation with its document, a document with its AI and a
 * web page with its AI. Either side may be absent; a side that stays keeps its identity (it is
 * never remounted when the other comes or goes).
 *
 * Side by side only while both keep their minimum width (measured). Otherwise `over` lies over
 * the other, which is never squeezed: a conversation as a sheet from the left (over a scrim that
 * closes it), a document or page filling the tab.
 */
export function Beside({ chat, content, over, chatMin = CHAT_MIN, contentMin = CHAT_MIN, ratio, onRatio, resetRatio = 0.4, chatLabel, contentLabel, onDismiss, onCovered }: {
  chat: ReactNode | null;
  content: ReactNode | null;
  /** Which side is the companion: the one that lies over the other when both do not fit. */
  over: "chat" | "content";
  chatMin?: number;
  contentMin?: number;
  /** The conversation's share of the width, and where a new one is kept. */
  ratio: number;
  onRatio: (ratio: number) => void;
  /** The share a double press on the handle goes back to. */
  resetRatio?: number;
  chatLabel: string;
  contentLabel: string;
  /** Close the companion (the scrim under a conversation laid over). */
  onDismiss?: () => void;
  /** The conversation is covered by what lies over it (true), or back on screen (false). */
  onCovered?: (covered: boolean) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [live, setLive] = useState<number | null>(null);
  const both = chat !== null && content !== null;
  useLayoutEffect(() => {
    const element = host.current;
    if (!element || !both) return;
    const measure = () => setWidth(element.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [both]);
  // The last decision, so the arrangement does not flip at the threshold.
  const was = useRef<"beside" | "over">("beside");
  const shown = clampRatio(live ?? ratio);
  // A tab sent behind another measures 0: the last measured width stands while it is hidden, so it
  // keeps its arrangement and the app still knows whether its conversation is covered. A pane never
  // measured is taken as side by side (nothing said covered).
  const measured = useRef(0);
  if (width > 0) measured.current = width;
  const fit = both ? besideFit({ width: width || measured.current, chatMin, contentMin, ratio: shown, was: was.current }) : null;
  if (fit) was.current = fit.mode;
  const laidOver = fit?.mode === "over";
  // Side by side and measured (a tab behind has no width): the two minimums are this pane's need.
  const room = fit?.mode === "beside" && width > 0 ? chatMin + COLUMN_GAP + contentMin - CHAT_MIN : 0;
  const [self] = useState(() => Symbol("beside"));
  useLayoutEffect(() => {
    if (!room) return;
    rooms.set(self, room);
    watchers.forEach((changed) => changed());
    return () => { rooms.delete(self); watchers.forEach((changed) => changed()); };
  }, [self, room]);
  const covered = laidOver ? (over === "chat" ? "content" : "chat") : null;

  // A conversation under its companion is not on screen: the app is told (and told again when it is back).
  const chatCovered = covered === "chat";
  const tellCovered = useRef(onCovered);
  tellCovered.current = onCovered;
  useLayoutEffect(() => {
    if (!chatCovered) return;
    tellCovered.current?.(true);
    return () => tellCovered.current?.(false);
  }, [chatCovered]);

  const drag = (event: ReactPointerEvent) => {
    event.preventDefault();
    const box = host.current?.getBoundingClientRect();
    if (!box || box.width <= COLUMN_GAP) return;
    let latest = shown;
    const onMove = (move: PointerEvent) => {
      latest = clampRatio((move.clientX - box.left) / (box.width - COLUMN_GAP));
      setLive(latest);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setLive(null);
      onRatio(latest);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  const nudge = (event: ReactKeyboardEvent) => {
    const step = event.key === "ArrowLeft" ? -0.02 : event.key === "ArrowRight" ? 0.02 : 0;
    if (!step) return;
    event.preventDefault();
    onRatio(clampRatio(shown + step));
  };

  // Keyed children of one parent: a side keeps its place in the tree while the other comes and goes.
  return (
    <div ref={host} className="beside" data-fit={fit ? fit.mode : "single"} data-over={over}>
      {chat !== null ? (
        <section key="chat" className="beside-chat" aria-label={chatLabel} inert={covered === "chat"} aria-hidden={covered === "chat" ? true : undefined}
          data-covers-web={laidOver && over === "chat" ? "" : undefined}
          style={fit?.mode === "beside" ? (fit.chat === null ? { flex: `0 0 ${Math.round(shown * 100)}%` } : { flex: `0 0 ${fit.chat}px` }) : undefined}>
          {chat}
        </section>
      ) : null}
      {fit?.mode === "beside" ? (
        <div key="divider" className="beside-divider" role="separator" aria-orientation="vertical" aria-label={`${chatLabel}와 ${contentLabel} 사이`} aria-valuenow={Math.round(shown * 100)} aria-valuemin={20} aria-valuemax={70}
          tabIndex={0} onPointerDown={drag} onKeyDown={nudge} onDoubleClick={() => onRatio(resetRatio)} title="끌어서 너비 조절 · 두 번 누르면 처음 너비" />
      ) : null}
      {laidOver && over === "chat" ? <button key="scrim" type="button" className="beside-scrim" data-covers-web="" aria-label={`${chatLabel} 닫기`} onClick={onDismiss} /> : null}
      {content !== null ? (
        <section key="content" className="beside-content" aria-label={contentLabel} inert={covered === "content"} aria-hidden={covered === "content" ? true : undefined}>
          {content}
        </section>
      ) : null}
    </div>
  );
}

/** A column width kept on this device (a document's or a web page's AI beside it). */
export function useStoredRatio(key: string, fallback: number): [number, (ratio: number) => void] {
  const [ratio, setRatio] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(key));
      return saved > 0 && saved < 1 ? saved : fallback;
    } catch { return fallback; }
  });
  return [ratio, (next: number) => {
    setRatio(next);
    try { localStorage.setItem(key, String(next)); } catch { /* kept for this view only */ }
  }];
}
