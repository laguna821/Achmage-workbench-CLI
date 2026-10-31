import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { DIVIDER, MAX_PANES, minimumSize, paneGeometry, resizeSplit, treeOf, type DividerRect, type DropEffect, type Layout, type Pane, type PaneId, type PaneItem, type PaneRect, type PaneTarget, type Side } from "../panes.ts";
import { paneDrag, useDropArea, usePaneDrag, usePaneDragSlice } from "../panedrag.ts";
import { Icon } from "./Icon.tsx";
import { activeTab, tabsOf } from "../tabs.ts";
import "../styles/panes.css";

export type PaneHead = { title: string; icon: ReactNode; hint?: string; item: PaneItem | null };
export type PaneScope = { theme: string; bubble: string; frame: boolean; glow: string; style: CSSProperties };
const SIDE_LABEL = { left: "왼쪽으로 분할", right: "오른쪽으로 분할", top: "위로 분할", bottom: "아래로 분할", center: "이 칸에 열기" };

/** The tree determines geometry; editors retain the same parent and React key when moved. */
export function PaneLayout<V>({ layout, enabled, maximized = false, onResize, onFocus, onClose, onMove, onSplit, onDrop, head, scope, effectOf, render, onNarrow, tabBar }: {
  layout: Layout<V>; enabled: boolean;
  maximized?: boolean;
  onResize: (id: string, ratio: number) => void;
  onFocus: (id: PaneId) => void;
  onClose: (id: PaneId) => void;
  onMove: (id: PaneId, target: PaneTarget) => void;
  onSplit: (id: PaneId, side: Side) => void;
  onDrop: (item: PaneItem, target: PaneTarget) => void;
  head: (pane: Pane<V>) => PaneHead;
  scope: (pane: Pane<V>, focused: boolean) => PaneScope;
  effectOf: (item: PaneItem, target: PaneTarget) => DropEffect;
  render: (pane: Pane<V>, info: { focused: boolean; split: boolean; tabId: string; active: boolean }) => ReactNode;
  tabBar?: (pane: Pane<V>) => ReactNode;
  onNarrow?: (narrow: boolean) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [live, setLive] = useState<{ id: string; ratio: number } | null>(null);
  const cancelResize = useRef<(() => void) | null>(null);
  const mountedTabs = useRef(new Set<string>());
  for (const pane of layout.panes) mountedTabs.current.add(activeTab(pane).id);
  const split = layout.panes.length > 1;
  const tree = treeOf(live ? resizeSplit(layout, live.id, live.ratio) : layout);
  const minimum = minimumSize(tree);
  const narrow = split && size.width > 0 && (size.width < minimum.width || size.height < minimum.height);
  const geometry = paneGeometry(tree, size.width, size.height);
  const whole = { left: 0, top: 0, ...size };
  const collapsed = narrow || maximized;
  const boxes = collapsed ? { [layout.focus]: whole } : geometry.panes;
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, []);
  useEffect(() => onNarrow?.(narrow), [narrow, onNarrow]);
  useEffect(() => () => cancelResize.current?.(), []);
  useDropArea(enabled ? {
    element: () => host.current,
    targetAt: (x, y) => {
      const origin = host.current?.getBoundingClientRect();
      if (!origin) return null;
      const bar = document.elementFromPoint(x, y)?.closest<HTMLElement>(".group-tabs");
      if (bar?.dataset.paneId) {
        const rows = Array.from(bar.querySelectorAll<HTMLElement>("[data-tab-index]"));
        const before = rows.find((row) => x < row.getBoundingClientRect().left + row.getBoundingClientRect().width / 2);
        return { paneId: bar.dataset.paneId, side: "center", tabIndex: before ? Number(before.dataset.tabIndex) : rows.length };
      }
      for (const [paneId, box] of Object.entries(boxes)) {
        const px = (x - origin.left - box.left) / box.width, py = (y - origin.top - box.top) / box.height;
        if (px < 0 || px > 1 || py < 0 || py > 1) continue;
        const edges: [Side, number][] = [["left", px], ["right", 1 - px], ["top", py], ["bottom", 1 - py]];
        const closest = edges.sort((a, b) => a[1] - b[1])[0]!;
        return { paneId, side: closest[1] < 0.25 ? closest[0] : "center" };
      }
      return null;
    },
    drop: (item, target) => item.kind === "pane" ? onMove(item.id, target) : onDrop(item, target),
  } : null);

  const dragDivider = (event: ReactPointerEvent, divider: DividerRect) => {
    if (event.button !== 0) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).focus();
    cancelResize.current?.();
    const origin = host.current?.getBoundingClientRect();
    if (!origin) return;
    let latest = divider.ratio;
    const horizontal = divider.axis === "horizontal";
    const move = (pointer: PointerEvent) => {
      const offset = horizontal ? pointer.clientX - origin.left - divider.parent.left : pointer.clientY - origin.top - divider.parent.top;
      latest = Math.max(divider.min, Math.min(divider.max, (offset - DIVIDER / 2) / ((horizontal ? divider.parent.width : divider.parent.height) - DIVIDER)));
      setLive({ id: divider.id, ratio: latest });
    };
    const finish = (save: boolean) => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel); window.removeEventListener("blur", cancel);
      document.documentElement.classList.remove("pane-resizing", "pane-resizing-vertical");
      cancelResize.current = null; setLive(null);
      if (save) onResize(divider.id, latest);
    };
    const up = () => finish(true), cancel = () => finish(false);
    cancelResize.current = cancel;
    document.documentElement.classList.add(horizontal ? "pane-resizing" : "pane-resizing-vertical");
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel); window.addEventListener("blur", cancel);
  };
  const takesFocus = (target: EventTarget | null) => !(target instanceof Element && target.closest(".pane-head-tools,.pane-narrow"));
  return <div ref={host} className={`panes recursive${split && !narrow ? " two" : ""}${narrow ? " narrow" : ""}`}>
    {layout.panes.flatMap((group) => tabsOf(group).filter((tab) => mountedTabs.current.has(tab.id)).map((tab) => ({ group, tab }))).sort((a, b) => a.tab.id.localeCompare(b.tab.id)).map(({ group, tab }) => {
      const pane = { ...group, view: tab.view, workId: tab.workId, sessionId: tab.sessionId };
      const active = activeTab(group).id === tab.id;
      const focused = active && pane.id === layout.focus, look = scope(pane, focused), title = head(pane);
      const next = layout.panes[(layout.panes.indexOf(group) + 1) % layout.panes.length]!;
      return <section key={tab.id} className={`pane look-scope${focused ? " focused" : ""}`} data-pane={pane.id} data-tab={tab.id} data-tab-active={active ? "true" : "false"} data-pane-active={focused ? "true" : "false"}
        data-theme={look.theme} data-bubble={look.bubble} data-frame={look.frame ? "on" : "off"} data-glow={look.glow}
        style={{ ...look.style, ...(boxes[pane.id] ?? whole) }} hidden={!active || (collapsed && !focused)} aria-label={split ? `${title.title} 칸` : undefined}
        onPointerDownCapture={(event) => takesFocus(event.target) && onFocus(pane.id)} onFocusCapture={(event) => takesFocus(event.target) && onFocus(pane.id)}>
        {split ? <header className="pane-head" title={title.hint ?? title.title} onMouseDown={(event) => {
          if (takesFocus(event.target)) paneDrag.press({ item: { kind: "pane", id: pane.id }, label: title.title }, event);
        }} onPointerDown={(event) => {
          if (takesFocus(event.target)) paneDrag.press({ item: { kind: "pane", id: pane.id }, label: title.title }, event);
        }}>
          <span className="pane-head-icon" aria-hidden>{title.icon}</span><span className="pane-head-title">{title.title}</span>
          {collapsed ? <span className="pane-narrow"><select aria-label="표시할 칸" value={layout.focus} onChange={(event) => onFocus(event.target.value)}>
            {layout.panes.map((entry, index) => <option key={entry.id} value={entry.id}>{index + 1}. {head(entry).title}</option>)}
          </select></span> : null}
          <span className="pane-head-tools">
            {enabled ? <>
              <button type="button" className="icon-button small" disabled={layout.panes.length >= MAX_PANES} aria-label="오른쪽으로 분할" title="오른쪽으로 분할" onClick={() => onSplit(pane.id, "right")}><Icon name="columns" size={14} /></button>
              <button type="button" className="icon-button small" disabled={layout.panes.length >= MAX_PANES} aria-label="아래로 분할" title="아래로 분할" onClick={() => onSplit(pane.id, "bottom")}><Icon name="rows" size={14} /></button>
            </> : null}
            <button type="button" className="icon-button small" title="다음 칸과 자리 바꾸기" aria-label="다음 칸과 자리 바꾸기" onClick={() => onMove(pane.id, { paneId: next.id, side: "center" })}><Icon name="swap" size={14} /></button>
            <button type="button" className="icon-button small" title="이 칸 닫기" aria-label={`${title.title} 칸 닫기`} onClick={() => onClose(pane.id)}><Icon name="x" size={14} /></button>
          </span>
        </header> : null}
        {tabBar?.(group)}
        {render(pane, { focused, split, tabId: tab.id, active })}
      </section>;
    })}
    {split && !collapsed ? geometry.dividers.map((divider) => {
      const vertical = divider.axis === "vertical", { left, top, width, height } = divider;
      return <div key={divider.id} className={`pane-divider${vertical ? " vertical" : ""}${live?.id === divider.id ? " moving" : ""}`} style={{ left, top, width, height }}
        role="separator" aria-orientation={vertical ? "horizontal" : "vertical"} aria-label={`칸 사이 · ${vertical ? "↑↓로 높이" : "←→로 너비"} 조절`}
        aria-valuenow={Math.round(divider.ratio * 100)} aria-valuemin={Math.round(divider.min * 100)} aria-valuemax={Math.round(divider.max * 100)} tabIndex={0}
        title="끌어서 크기 조절 · 두 번 누르면 반반" onPointerDown={(event) => dragDivider(event, divider)} onDoubleClick={() => onResize(divider.id, 0.5)}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 0.1 : 0.02;
          const next = event.key === "Enter" ? 0.5 : event.key === "Home" ? divider.min : event.key === "End" ? divider.max : event.key === (vertical ? "ArrowUp" : "ArrowLeft") ? divider.ratio - step : event.key === (vertical ? "ArrowDown" : "ArrowRight") ? divider.ratio + step : null;
          if (next === null) return;
          event.preventDefault(); onResize(divider.id, Math.max(divider.min, Math.min(divider.max, next)));
        }} />;
    }) : null}
    {enabled ? <><DropPreview boxes={boxes} effectOf={effectOf} /><DragGhost /></> : null}
  </div>;
}

function DropPreview({ boxes, effectOf }: { boxes: Record<string, PaneRect>; effectOf: (item: PaneItem, target: PaneTarget) => DropEffect }) {
  const held = usePaneDragSlice((drag) => drag?.over?.kind === "zone" ? JSON.stringify([drag.over.target, drag.item]) : "");
  if (!held) return null;
  const [target, item] = JSON.parse(held) as [PaneTarget, PaneItem];
  const effect = item.kind === "pane" ? item.id === target.paneId ? "none" : "swap" : effectOf(item, target);
  const rect = boxes[target.paneId];
  if (effect === "none" || !rect) return null;
  const box = { ...rect };
  if (target.side === "left" || target.side === "right") box.width /= 2;
  if (target.side === "top" || target.side === "bottom") box.height /= 2;
  if (target.side === "right") box.left += box.width;
  if (target.side === "bottom") box.top += box.height;
  return <div className="pane-drop" aria-hidden><div className="pane-drop-zone" style={box}><span className="pane-drop-label">
    <Icon name={effect === "swap" ? "swap" : "columns"} size={14} />{effect === "swap" ? target.side === "center" ? "자리 바꾸기" : "이쪽으로 옮기기" : SIDE_LABEL[target.side]}
  </span></div></div>;
}

function DragGhost() {
  const drag = usePaneDrag();
  if (!drag?.own) return null;
  const icon = drag.item.kind === "note" ? "book" : drag.item.kind === "doc" ? "file" : drag.item.kind === "session" ? "chat" : drag.item.kind === "vault" || drag.item.kind === "folder" ? "folder" : "project";
  return <div className={`pane-drag-ghost${drag.over ? " over" : ""}`} style={{ left: drag.x + 12, top: drag.y + 10 }} aria-hidden><Icon name={icon} size={13} /> {drag.label}</div>;
}
