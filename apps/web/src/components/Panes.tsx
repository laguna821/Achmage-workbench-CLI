import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { DIVIDER, MAX_PANES, minimumSize, paneGeometry, resizeSplit, treeOf, type PaneNeed, type DividerRect, type DropEffect, type Layout, type Pane, type PaneId, type PaneItem, type PaneRect, type PaneTab, type PaneTarget, type Side } from "../panes.ts";
import { paneDrag, useDropArea, usePaneDrag, usePaneDragSlice } from "../panedrag.ts";
import { stripDropIndex } from "../tab-drop.ts";
import { Icon } from "./Icon.tsx";
import { Select } from "./ui/Select.tsx";
import { paneShort } from "../pane-width.ts";
import { activeTab, contentKey, setTabIdReuse, tabsOf } from "../tabs.ts";
import { SleepTab, TabClosed, heldAwake, keptOnClose, onKeptOnClose, sleepPlan, tabSleepAfter } from "../tab-sleep.ts";
import { fadeIn, returnTo, revealFrom } from "../flip.ts";
import { EditorPoolContext, EditorPoolLayer, usePoolSurface } from "./EditorPoolLayer.tsx";
import { markWarmTabs } from "../editor-pool.ts";
import "../styles/panes.css";

/** `unseen`: an answer arrived there while it was off screen. */
export type PaneHead = { title: string; icon: ReactNode; hint?: string; kindLabel?: string; project?: string; status?: string; unseen?: boolean; /** The one state of the conversation the tab holds (row-state.ts), for the tab's mark. */ state?: import("../row-state.ts").RowStateInfo | null; item: PaneItem | null; /** Home 지금: its tab never closes into an empty centre (no close key while it is the pane's only tab). */ home?: boolean };
export type PaneScope = { theme: string; bubble: string; frame: boolean; glow: string; style: CSSProperties };
const SIDE_LABEL = { left: "왼쪽으로 분할", right: "오른쪽으로 분할", top: "위로 분할", bottom: "아래로 분할", center: "이 칸에 열기" };

/**
 * Tab sleep (tab-sleep.ts): what the app knows of its tabs. `unsaved`: the keeper — the tab holds unsaved edits, or its
 * editor cannot tell. `atWork`: something is at work in it (unsure: true). `before`: what is done before the view is
 * taken down (null: there is no way to — the tab stays awake). Unsaved edits: the tab's save-on-leave path (its leave
 * guard) — resolves once its editor says saved, rejects when it could not save or would need the person. A web page:
 * its native page is released — rejects while it is in use. It must open nothing.
 */
export type TabSleep<V> = { unsaved: (tab: PaneTab<V>) => boolean; atWork: (tab: PaneTab<V>) => boolean; before: (tab: PaneTab<V>) => (() => Promise<void>) | null };

/** Under memory pressure a tab off screen this long sleeps (instead of ten minutes), for PRESSURE_SOON_MS after the gateway said so. */
export const PRESSURE_SLEEP_MS = 30_000;
export const PRESSURE_SOON_MS = 10 * 60_000;

/** The tree determines geometry; editors retain the same parent and React key when moved. */
export function PaneLayout<V>({ layout, drawn: drawnPanes, enabled, recentFrames = 2, warm, maximized = false, onMaximize, onPresent, onResize, onFocus, onClose, onMove, onSplit, onDrop, head, scope, effectOf, render, onNarrow, tabBar, minWidthOf, foot, sleep, sleepNow = 0, onSleeping }: {
  layout: Layout<V>; enabled: boolean;
  /** The editor pool's recent frames per kind (editor-pool.ts recentFramesFor: 2 with room, fewer when memory is short). */
  recentFrames?: number;
  /** Tabs mounted behind once, at restore, to warm their kind's editor (editor-pool.ts warmTabsFor). */
  warm?: string[];
  /**
   * Given: a view that has been off screen for ten minutes is unmounted (its tab stays; shown again, it is mounted
   * again), by tab-sleep.ts `sleepPlan`. Not given: a view stays mounted until its tab closes.
   */
  sleep?: TabSleep<V>;
  /**
   * Rises when the gateway says memory is short (0.5.3, the resource manager): tabs off screen for
   * PRESSURE_SLEEP_MS or more sleep now, by the same plan (recent tabs, unsaved edits and AI at work are kept).
   */
  sleepNow?: number;
  /** Told the number of tabs asleep right now — views this window took down that are neither shown again nor closed — at the start and whenever it changes. */
  onSleeping?: (count: number) => void;
  /**
   * Project tabs: the layout as drawn (tabs.ts `drawnLayout`) — the panes of the window's project,
   * their neighbours taking the room of the others. A pane of `layout` that is not in it stays where
   * it is, mounted and hidden exactly as a tab behind another is (its view is told `active: false`),
   * so its editor, its page and its conversation are as they were when its project comes back.
   * Not given: every pane is drawn.
   */
  drawn?: Layout<V>;
  /**
   * The width a pane's content reads at (a document page), beyond a pane's own. Side by side the
   * divider gives it that width first, the other pane giving way down to its own minimum; where the
   * window cannot hold both, the panes fold to one at a time (the pane picker) instead of squeezing
   * the page. Not used in the 4- and 9-pane grids. App.tsx counts it too, so the right sidebar lies
   * over the work rather than docking into that width.
   */
  minWidthOf?: (pane: Pane<V>) => number;
  /** A line under the panes (the launch's attribution, LaunchCredit): it sets the room it takes, the panes measure what is left. */
  foot?: ReactNode;
  maximized?: boolean;
  onMaximize?: (id: PaneId) => void;
  /** Re-place native web views now that zoom or restore has moved the panes. */
  onPresent?: () => void;
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
  // The editor pool of this window surface (editor-pool.ts): documents of one kind share their editor frames.
  const pool = usePoolSurface();
  // `workbench.pool.recent` (the rigs' knob) sets N outright.
  useEffect(() => {
    let forced: string | null = null;
    try { forced = localStorage.getItem("workbench.pool.recent"); } catch { /* storage unavailable */ }
    pool.pool.setRecent(forced !== null && Number.isFinite(Number(forced)) ? Number(forced) : recentFrames);
  }, [pool, recentFrames]);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [live, setLive] = useState<{ id: string; ratio: number } | null>(null);
  const cancelResize = useRef<(() => void) | null>(null);
  const mountedTabs = useRef(new Set<string>());
  const shown = drawnPanes ?? layout, onScreen = new Set(shown.panes.map((pane) => pane.id));
  for (const pane of shown.panes) mountedTabs.current.add(activeTab(pane).id);
  // Warm at restore: mounted behind once (they sleep as any hidden tab does).
  const warmedOnce = useRef(false);
  if (warm && !warmedOnce.current) {
    warmedOnce.current = true; markWarmTabs(warm);
    const open = new Set(layout.panes.flatMap(tabsOf).map((tab) => tab.id));
    for (const id of warm) if (open.has(id)) mountedTabs.current.add(id);
  }
  // Tab sleep: when each tab was last on screen — now for those in front, and for those that have just left.
  const rest = useRef({ shownAt: new Map<string, number>(), askedAt: new Map<string, number>(), front: new Set<string>(), asleep: new Set<string>() });
  {
    const front = new Set(shown.panes.map((pane) => activeTab(pane).id)), now = Date.now();
    for (const id of [...rest.current.front, ...front]) rest.current.shownAt.set(id, now);
    rest.current.front = front;
    // Asleep: taken down here, and neither shown again (it is mounted again) nor closed.
    const open = new Set(layout.panes.flatMap(tabsOf).map((tab) => tab.id));
    for (const id of [...rest.current.asleep]) if (front.has(id) || !open.has(id)) rest.current.asleep.delete(id);
  }
  // Closed tabs whose view must outlive the closing for now (a 문서 AI turn running live in its editor): kept
  // mounted, hidden, in the same place among the views (same key, same order: its frame is not reloaded) until the
  // view lets go; opened again meanwhile (the same tab id, tabs.ts `setTabIdReuse`), it is that same view again.
  const [, keptTick] = useState(0);
  const known = useRef(new Map<string, { group: Pane<V>; tab: PaneTab<V> }>());
  const lingering = useRef(new Map<string, { group: Pane<V>; tab: PaneTab<V> }>());
  {
    const open = new Map(layout.panes.flatMap((group) => tabsOf(group).map((tab) => [tab.id, { group, tab }] as const)));
    for (const [id, entry] of known.current) if (!open.has(id) && mountedTabs.current.has(id) && keptOnClose(id)) lingering.current.set(id, entry);
    for (const id of [...lingering.current.keys()]) {
      if (open.has(id)) { lingering.current.delete(id); mountedTabs.current.add(id); }
      else if (!keptOnClose(id)) { lingering.current.delete(id); mountedTabs.current.delete(id); }
    }
    known.current = open;
  }
  useEffect(() => onKeptOnClose(() => keptTick((count) => count + 1)), []);
  useEffect(() => {
    setTabIdReuse((key) => [...lingering.current.values()].find((entry) => contentKey(entry.tab) === key)?.tab.id ?? null);
    return () => setTabIdReuse(null);
  }, []);
  const sleeping = rest.current.asleep.size;
  useEffect(() => onSleeping?.(sleeping), [sleeping, onSleeping]);
  const [, slept] = useState(0);
  const kick = useRef<(() => void) | null>(null);
  const soonUntil = useRef(0);
  const latest = useRef({ layout, shown, sleep });
  latest.current = { layout, shown, sleep };
  const sleeps = Boolean(sleep);
  useEffect(() => {
    if (!sleeps) return;
    const after = tabSleepAfter();
    /** The plan as things are now; `saved`: a tab whose editor has just answered saved, or whose web page was just released. Its sleepers are unmounted. */
    const settle = (saved?: string) => {
      const { layout, shown, sleep } = latest.current, { shownAt, askedAt, front } = rest.current, now = Date.now();
      if (!sleep) return [];
      const open = new Set(layout.panes.flatMap(tabsOf).map((tab) => tab.id));
      for (const known of [mountedTabs.current, shownAt, askedAt]) for (const id of [...known.keys()]) if (!open.has(id) && !lingering.current.has(id)) known.delete(id);
      for (const id of front) shownAt.set(id, now);
      const plan = sleepPlan({ layout, drawn: shown, mounted: mountedTabs.current, now, shownAt, askedAt, after: now < soonUntil.current ? Math.min(after, PRESSURE_SLEEP_MS) : after, unsaved: sleep.unsaved,
        atWork: (tab) => heldAwake(tab.id) || sleep.atWork(tab), saved: saved ? new Set([saved]) : undefined });
      const down = saved ? plan.sleep.filter((id) => id === saved) : plan.sleep;
      for (const id of down) { mountedTabs.current.delete(id); rest.current.asleep.add(id); }
      if (down.length) slept((count) => count + 1);
      return saved ? [] : plan.ask;
    };
    const tick = () => {
      for (const id of settle()) {
        // Unsaved edits: the editor saves through its tab's leave path first; a web page: its native page is released
        // first. Done: decided again, as things are then. Refused, failed or no way to: the view stays, and is asked
        // again one interval from now.
        rest.current.askedAt.set(id, Date.now());
        const tab = latest.current.layout.panes.flatMap(tabsOf).find((entry) => entry.id === id);
        const before = tab && latest.current.sleep?.before(tab);
        if (before) void before().then(() => { settle(id); }, () => undefined);
      }
    };
    kick.current = tick;
    const timer = window.setInterval(tick, Math.min(30_000, Math.max(250, after / 4)));
    return () => { window.clearInterval(timer); kick.current = null; };
  }, [sleeps]);
  // Memory is short: off-screen tabs sleep sooner, starting now; the usual time again once it is back.
  const pressed = useRef(sleepNow);
  useEffect(() => {
    if (sleepNow === pressed.current) return;
    pressed.current = sleepNow;
    soonUntil.current = Date.now() + PRESSURE_SOON_MS;
    kick.current?.();
  }, [sleepNow]);
  const split = shown.panes.length > 1;
  const tree = treeOf(live ? resizeSplit(shown, live.id, live.ratio) : shown);
  const need: PaneNeed | undefined = minWidthOf && split && !layout.grid ? (id) => { const pane = layout.panes.find((entry) => entry.id === id); return pane ? minWidthOf(pane) : 0; } : undefined;
  const minimum = minimumSize(tree, !!layout.grid, need);
  const narrow = split && size.width > 0 && (size.width < minimum.width || size.height < minimum.height);
  const geometry = paneGeometry(tree, size.width, size.height, !!layout.grid, need);
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
  // Zoom and restore: the focused pane opens out from its cell and settles back into it; the others fade in.
  const drawn = useRef<{ boxes: Record<string, PaneRect>; maximized: boolean } | null>(null);
  useLayoutEffect(() => {
    const last = drawn.current;
    drawn.current = { boxes, maximized };
    if (!last || last.maximized === maximized || !host.current) return;
    for (const element of host.current.querySelectorAll<HTMLElement>(':scope > .pane[data-tab-active="true"]:not([hidden])')) {
      // A native web view paints above the page and is placed by present(), not by CSS: its pane
      // snaps. Moving the view with its pane belongs to the panel-snapshot work.
      if (element.querySelector(".browser-viewport")) continue;
      const before = last.boxes[element.dataset.pane!], after = boxes[element.dataset.pane!];
      if (!before || !after) fadeIn(element);
      else if (maximized) revealFrom(element, before, after);
      else returnTo(element, before, after);
    }
    onPresent?.();
  });
  useEffect(() => onNarrow?.(collapsed), [collapsed, onNarrow]);
  useEffect(() => () => cancelResize.current?.(), []);
  useDropArea(enabled ? {
    element: () => host.current,
    targetAt: (x, y, item) => {
      const origin = host.current?.getBoundingClientRect();
      if (!origin) return null;
      const bar = document.elementFromPoint(x, y)?.closest<HTMLElement>(".group-tabs");
      if (bar?.dataset.paneId) {
        // Over a strip: a place between its tabs (its insertion mark), never a zone over the panes.
        const rows = Array.from(bar.querySelectorAll<HTMLElement>("[data-tab-index]"));
        const held = item.kind === "tab" ? rows.find((row) => row.dataset.tabId === item.id) : undefined;
        const tabIndex = stripDropIndex(rows.map((row) => { const box = row.getBoundingClientRect(); return { index: Number(row.dataset.tabIndex), left: box.left, width: box.width }; }), x, held ? Number(held.dataset.tabIndex) : undefined);
        return { paneId: bar.dataset.paneId, side: "center", tabIndex };
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
  return <EditorPoolContext.Provider value={pool}><div ref={host} data-grid={layout.grid} data-dense={layout.grid && !collapsed ? "true" : undefined} className={`panes recursive${split && !narrow ? " two" : ""}${narrow ? " narrow" : ""}`}>
    {[...layout.panes.flatMap((group) => tabsOf(group).filter((tab) => mountedTabs.current.has(tab.id)).map((tab) => ({ group, tab, closed: false }))),
      ...[...lingering.current.values()].map((entry) => ({ ...entry, closed: true }))].sort((a, b) => a.tab.id.localeCompare(b.tab.id)).map(({ group, tab, closed }) => {
      const pane = { ...group, view: tab.view, workId: tab.workId, sessionId: tab.sessionId };
      // The same element shape open or kept (header slot, bar slot, view): the view is never remounted by the change.
      if (closed) return <section key={tab.id} className="pane look-scope" data-tab={tab.id} data-tab-kept="closed" data-tab-active="false" data-pane-active="false" hidden aria-hidden>
        {null}
        {null}
        <SleepTab.Provider value={tab.id}><TabClosed.Provider value>{render(pane, { focused: false, split, tabId: tab.id, active: false })}</TabClosed.Provider></SleepTab.Provider>
      </section>;
      const active = onScreen.has(group.id) && activeTab(group).id === tab.id;
      const focused = active && pane.id === layout.focus, look = scope(pane, focused), title = head(pane);
      // A tab behind this one holds an unseen answer.
      const waiting = split && tabsOf(group).some((other) => other.id !== tab.id && head({ ...group, view: other.view, workId: other.workId, sessionId: other.sessionId }).unseen);
      const next = shown.panes[(shown.panes.findIndex((entry) => entry.id === group.id) + 1) % shown.panes.length]!;
      return <section key={tab.id} className={`pane look-scope${focused ? " focused" : ""}`} data-pane={pane.id} data-tab={tab.id} data-tab-active={active ? "true" : "false"} data-pane-active={focused ? "true" : "false"}
        data-theme={look.theme} data-bubble={look.bubble} data-frame={look.frame ? "on" : "off"} data-glow={look.glow}
        data-short={paneShort((boxes[pane.id] ?? whole).height) ? "true" : undefined}
        style={{ ...look.style, ...(boxes[pane.id] ?? whole) }} hidden={!active || (collapsed && !focused)} aria-label={split ? `${title.title} 칸` : undefined}
        onPointerDownCapture={(event) => takesFocus(event.target) && onFocus(pane.id)} onFocusCapture={(event) => takesFocus(event.target) && onFocus(pane.id)}>
        {split ? <header className="pane-head" title={title.hint ?? title.title} onMouseDown={(event) => {
          if (takesFocus(event.target)) paneDrag.press({ item: { kind: "pane", id: pane.id }, label: title.title }, event);
        }} onPointerDown={(event) => {
          if (takesFocus(event.target)) paneDrag.press({ item: { kind: "pane", id: pane.id }, label: title.title }, event);
        }}>
          <span className="pane-head-icon badged" aria-hidden>{title.icon}{waiting ? <span className="new-badge" /> : null}</span><span className="pane-head-title">{title.project ? <small>{title.project}</small> : null}{title.title}</span>
          {/* No state word here (release unit A): the active tab's own mark says it, one calm strip. */}
          {collapsed ? <span className="pane-narrow"><Select className="plain" label="표시할 칸" value={layout.focus} onChange={onFocus}
            options={shown.panes.map((entry, index) => { const shown = head(entry); return { value: entry.id, label: shown.title, icon: shown.icon, hint: String(index + 1) }; })} /></span> : null}
          <span className="pane-head-tools">
            {onMaximize ? <button type="button" className="icon-button small" aria-label={maximized ? "전체 칸 보기" : "이 칸 확대"} title={maximized ? "전체 칸 보기" : "이 칸 확대"} onClick={() => onMaximize(pane.id)}><Icon name={maximized ? "grid" : "expandAll"} size={14} /></button> : null}
            {enabled ? <>
              <button type="button" className="icon-button small" disabled={layout.panes.length >= MAX_PANES} aria-label="오른쪽으로 분할" title="오른쪽으로 분할" onClick={() => onSplit(pane.id, "right")}><Icon name="columns" size={14} /></button>
              <button type="button" className="icon-button small" disabled={layout.panes.length >= MAX_PANES} aria-label="아래로 분할" title="아래로 분할" onClick={() => onSplit(pane.id, "bottom")}><Icon name="rows" size={14} /></button>
            </> : null}
            <button type="button" className="icon-button small" title="다음 칸과 자리 바꾸기" aria-label="다음 칸과 자리 바꾸기" onClick={() => onMove(pane.id, { paneId: next.id, side: "center" })}><Icon name="swap" size={14} /></button>
            <button type="button" className="icon-button small" title="이 칸 닫기" aria-label={`${title.title} 칸 닫기`} onClick={() => onClose(pane.id)}><Icon name="x" size={14} /></button>
          </span>
        </header> : null}
        {tabBar?.(group)}
        <SleepTab.Provider value={tab.id}><TabClosed.Provider value={false}>{render(pane, { focused, split, tabId: tab.id, active })}</TabClosed.Provider></SleepTab.Provider>
      </section>;
    })}
    <EditorPoolLayer surface={pool} />
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
    {enabled ? <><DropPreview boxes={boxes} effectOf={effectOf} panes={layout.panes} /><DragGhost /></> : null}
    {foot}
  </div></EditorPoolContext.Provider>;
}

/**
 * Where a held item lands on a pane's body: a quiet tint of the half it would take (or of THAT pane, for a
 * move into it). Over a tab strip nothing is laid over the panes (the strip draws its insertion mark), and a
 * tab held over the middle of its own pane shows nothing (it is there already).
 */
function DropPreview<V>({ boxes, effectOf, panes }: { boxes: Record<string, PaneRect>; effectOf: (item: PaneItem, target: PaneTarget) => DropEffect; panes: Pane<V>[] }) {
  const held = usePaneDragSlice((drag) => drag?.over?.kind === "zone" && drag.over.target.tabIndex === undefined ? JSON.stringify([drag.over.target, drag.item]) : "");
  if (!held) return null;
  const [target, item] = JSON.parse(held) as [PaneTarget, PaneItem];
  const rect = boxes[target.paneId];
  if (!rect) return null;
  if (item.kind === "tab") {
    const own = panes.find((pane) => tabsOf(pane).some((tab) => tab.id === item.id));
    if (target.side === "center" && own?.id === target.paneId) return null;
    if (target.side !== "center" && own?.id === target.paneId && tabsOf(own).length === 1) return null;
    return <Zone rect={rect} side={target.side} icon={target.side === "center" ? "swap" : "columns"} label={target.side === "center" ? "이 칸으로 옮기기" : SIDE_LABEL[target.side]} />;
  }
  const effect = item.kind === "pane" ? item.id === target.paneId ? "none" : "swap" : effectOf(item, target);
  if (effect === "none") return null;
  return <Zone rect={rect} side={target.side} icon={effect === "swap" ? "swap" : "columns"} label={effect === "swap" ? target.side === "center" ? "자리 바꾸기" : "이쪽으로 옮기기" : SIDE_LABEL[target.side]} />;
}

function Zone({ rect, side, icon, label }: { rect: PaneRect; side: PaneTarget["side"]; icon: "swap" | "columns"; label: string }) {
  const box = { ...rect };
  if (side === "left" || side === "right") box.width /= 2;
  if (side === "top" || side === "bottom") box.height /= 2;
  if (side === "right") box.left += box.width;
  if (side === "bottom") box.top += box.height;
  return <div className="pane-drop" aria-hidden><div className="pane-drop-zone" style={box}><span className="pane-drop-label">
    <Icon name={icon} size={14} />{label}
  </span></div></div>;
}

function DragGhost() {
  const drag = usePaneDrag();
  if (!drag?.own) return null;
  const icon = drag.item.kind === "note" ? "book" : drag.item.kind === "doc" ? "file" : drag.item.kind === "session" ? "chat" : drag.item.kind === "vault" || drag.item.kind === "folder" ? "folder" : "project";
  return <div className={`pane-drag-ghost${drag.over ? " over" : ""}`} style={{ left: drag.x + 12, top: drag.y + 10 }} aria-hidden><Icon name={icon} size={13} /> {drag.label}</div>;
}
