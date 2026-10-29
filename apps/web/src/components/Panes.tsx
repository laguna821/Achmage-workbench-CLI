import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { DIVIDER, clampRatio, fitsTwo, nudgeRatio, sideAt, sideOf, type DropEffect, type Layout, type Pane, type PaneId, type PaneItem, type Side } from "../panes.ts";
import { paneDrag, useDropArea, usePaneDrag, usePaneDragSlice } from "../panedrag.ts";
import { Icon } from "./Icon.tsx";
import "../styles/panes.css";

// The main area as one pane or two side by side. Each pane is a sheet of the engine's paper with a
// small header (its name, swap, close) while there are two; the focused one is ruled underneath
// like the current tab. A divider between them resizes (drag, ←/→, double-click for half and half).
// Things dragged over the area show where they land; narrower than two usable panes, only the
// focused one shows (never overlapping) and its header offers the other.

export type PaneHead = {
  title: string;
  icon: ReactNode;
  /** The tooltip (a path, the work folder). */
  hint?: string;
  /** What the header drags (onto the other side: the two trade places; a note onto an input: attached). */
  item: PaneItem | null;
};

/** The look a pane is dressed in (its own engine's paper). */
export type PaneScope = { theme: string; bubble: string; frame: boolean; glow: string; style: CSSProperties };

const byId = <V,>(panes: Pane<V>[]) => [...panes].sort((a, b) => a.id.localeCompare(b.id));

export function PaneLayout<V>({
  layout,
  enabled,
  ratio,
  onRatio,
  onFocus,
  onClose,
  onSwap,
  onDrop,
  head,
  scope,
  effectOf,
  render,
  onNarrow,
}: {
  layout: Layout<V>;
  /** Panes can be split (not in a detached session window). */
  enabled: boolean;
  ratio: number;
  onRatio: (ratio: number) => void;
  onFocus: (id: PaneId) => void;
  onClose: (id: PaneId) => void;
  onSwap: () => void;
  onDrop: (item: PaneItem, side: Side) => void;
  head: (pane: Pane<V>) => PaneHead;
  scope: (pane: Pane<V>, focused: boolean) => PaneScope;
  /** What dropping an item on a side would do (shown before it is dropped). */
  effectOf: (item: PaneItem, side: Side) => DropEffect;
  render: (pane: Pane<V>, info: { focused: boolean; split: boolean }) => ReactNode;
  /** Two panes but room for one: the hidden one is not on screen (not "seen"). */
  onNarrow?: (narrow: boolean) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [live, setLive] = useState<number | null>(null);
  const split = layout.panes.length === 2;
  const narrow = split && width > 0 && !fitsTwo(width);
  const twoShown = split && !narrow;
  const shown = clampRatio(live ?? ratio, width);

  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const measure = () => setWidth(element.getBoundingClientRect().width);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, []);
  useEffect(() => onNarrow?.(narrow), [narrow, onNarrow]);

  useDropArea(
    enabled
      ? {
          element: () => host.current,
          sideAt: (x) => {
            const box = host.current?.getBoundingClientRect();
            return box ? sideAt(x, box.left, box.width, twoShown ? 2 : 1, shown) : null;
          },
          drop: (item, side) => {
            // A pane's own header dropped on the other side: the two trade places.
            if (item.kind === "pane") {
              if (split && sideOf(layout, item.id) !== side) onSwap();
              return;
            }
            onDrop(item, side);
          },
        }
      : null,
  );

  const dragDivider = (event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const box = host.current?.getBoundingClientRect();
    if (!box) return;
    let latest = shown;
    const onMove = (move: PointerEvent) => {
      latest = clampRatio((move.clientX - box.left - DIVIDER / 2) / (box.width - DIVIDER), box.width);
      setLive(latest);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.documentElement.classList.remove("pane-resizing");
      setLive(null);
      onRatio(latest);
    };
    document.documentElement.classList.add("pane-resizing");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  const keyDivider = (event: ReactKeyboardEvent) => {
    const next = event.key === "Enter" ? 0.5 : nudgeRatio(shown, event.key, event.shiftKey, width);
    if (next === null) return;
    event.preventDefault();
    onRatio(next);
  };

  const other = (pane: Pane<V>) => layout.panes.find((entry) => entry.id !== pane.id) ?? null;
  // Header tools act on the pane as it is; they do not move the focus first.
  const takesFocus = (target: EventTarget | null) => !(target instanceof Element && target.closest(".pane-head-tools"));

  return (
    <div
      ref={host}
      className={`panes${twoShown ? " two" : ""}${narrow ? " narrow" : ""}`}
      style={twoShown ? { gridTemplateColumns: `minmax(0, ${shown}fr) ${DIVIDER}px minmax(0, ${1 - shown}fr)` } : undefined}
    >
      {byId(layout.panes).map((pane) => {
        const focused = pane.id === layout.focus;
        const side = sideOf(layout, pane.id);
        const look = scope(pane, focused);
        const title = split ? head(pane) : null;
        const elsewhere = other(pane);
        return (
          <section
            key={pane.id}
            className={`pane look-scope${split ? ` ${side}` : ""}${focused ? " focused" : ""}`}
            data-pane={pane.id}
            data-pane-active={focused || !split ? "true" : "false"}
            data-theme={look.theme}
            data-bubble={look.bubble}
            data-frame={look.frame ? "on" : "off"}
            data-glow={look.glow}
            style={{ ...look.style, order: side === "left" ? 0 : 2 }}
            hidden={narrow && !focused}
            aria-label={title ? `${side === "left" ? "왼쪽" : "오른쪽"} 칸 · ${title.title}` : undefined}
            onPointerDownCapture={(event) => takesFocus(event.target) && onFocus(pane.id)}
            onFocusCapture={(event) => takesFocus(event.target) && onFocus(pane.id)}
          >
            {title ? (
              <header
                className="pane-head"
                title={title.hint ?? title.title}
                onPointerDown={(event) => {
                  if (!takesFocus(event.target)) return;
                  paneDrag.press({ item: title.item ?? { kind: "pane", id: pane.id }, label: title.title }, event);
                }}
              >
                <span className="pane-head-icon" aria-hidden>
                  {title.icon}
                </span>
                <span className="pane-head-title">{title.title}</span>
                {narrow && elsewhere ? (
                  <span className="pane-narrow" role="status">
                    창이 좁아 한 칸만 보입니다
                    <button type="button" className="link" onClick={() => onFocus(elsewhere.id)}>
                      {head(elsewhere).title} 보기
                    </button>
                  </span>
                ) : null}
                <span className="pane-head-tools">
                  {narrow ? null : (
                    <button type="button" className="icon-button small" title="자리 바꾸기" aria-label="두 칸 자리 바꾸기" onClick={onSwap}>
                      <Icon name="swap" size={14} />
                    </button>
                  )}
                  <button type="button" className="icon-button small" title="이 칸 닫기" aria-label={`${title.title} 칸 닫기`} onClick={() => onClose(pane.id)}>
                    <Icon name="x" size={14} />
                  </button>
                </span>
              </header>
            ) : null}
            {render(pane, { focused, split })}
          </section>
        );
      })}
      {twoShown ? (
        <div
          className={`pane-divider${live !== null ? " moving" : ""}`}
          style={{ order: 1 }}
          role="separator"
          aria-orientation="vertical"
          aria-label="두 칸 사이 · ←→로 너비 조절"
          aria-valuenow={Math.round(shown * 100)}
          aria-valuemin={Math.round(clampRatio(0, width) * 100)}
          aria-valuemax={Math.round(clampRatio(1, width) * 100)}
          tabIndex={0}
          title="끌어서 너비 조절 · 두 번 누르면 반반"
          onPointerDown={dragDivider}
          onKeyDown={keyDivider}
          onDoubleClick={() => onRatio(0.5)}
        />
      ) : null}
      {enabled ? <DropPreview layout={layout} ratio={twoShown ? shown : null} effectOf={effectOf} /> : null}
      {enabled ? <DragGhost /> : null}
    </div>
  );
}

const SIDE_LABEL: Record<Side, string> = { left: "왼쪽에 열기", right: "오른쪽에 열기" };

/** Where a held item lands: the half (or the pane) it would open in, tinted, with what happens. */
function DropPreview<V>({ layout, ratio, effectOf }: { layout: Layout<V>; ratio: number | null; effectOf: (item: PaneItem, side: Side) => DropEffect }) {
  const held = usePaneDragSlice((drag) => (drag?.over?.kind === "zone" ? JSON.stringify([drag.over.side, drag.item]) : ""));
  if (!held) return null;
  const [side, item] = JSON.parse(held) as [Side, PaneItem];
  const effect = item.kind === "pane" ? (sideOf(layout, item.id) === side || layout.panes.length < 2 ? "none" : "swap") : effectOf(item, side);
  if (effect === "none") return null;
  const share = ratio ?? 0.5;
  const box: CSSProperties = side === "left" ? { left: 0, width: `${share * 100}%` } : { right: 0, width: `${(1 - share) * 100}%` };
  return (
    <div className="pane-drop" aria-hidden>
      <div className={`pane-drop-zone ${side}`} style={box}>
        <span className="pane-drop-label">
          <Icon name={effect === "swap" ? "swap" : "columns"} size={14} />
          {effect === "swap" ? "자리 바꾸기" : SIDE_LABEL[side]}
        </span>
      </div>
    </div>
  );
}

/** The thing being dragged, next to the pointer (sources that follow the pointer themselves draw their own). */
function DragGhost() {
  const drag = usePaneDrag();
  if (!drag?.own) return null;
  const icon = drag.item.kind === "note" ? "book" : drag.item.kind === "doc" ? "file" : drag.item.kind === "session" ? "chat" : drag.item.kind === "vault" || drag.item.kind === "folder" ? "folder" : "project";
  return (
    <div className={`pane-drag-ghost${drag.over ? " over" : ""}`} style={{ left: drag.x + 12, top: drag.y + 10 }} aria-hidden>
      <Icon name={icon} size={13} /> {drag.label}
    </div>
  );
}
