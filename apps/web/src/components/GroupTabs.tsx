import { Component, createRef, type ReactNode } from "react";
import type { Pane } from "../panes.ts";
import { slideX, widenIn } from "../flip.ts";
import { activeTab, tabsOf } from "../tabs.ts";
import { paneDrag } from "../panedrag.ts";
import type { PaneHead } from "./Panes.tsx";
import { Icon } from "./Icon.tsx";

type Placed = Map<string, number>;
/**
 * Per pane: where its tabs were last drawn by the copy of its bar on screen, and how many copies
 * are mounted. Each tab's view carries its own copy, and closing the shown tab unmounts the shown
 * copy, so the places live here, not in a copy.
 */
const panes = new Map<string, { places: Placed | null; copies: number }>();

/** Each tab's left edge within the strip's content (no scroll, no transforms, no screen offset). */
const placed = (list: HTMLElement): Placed => new Map(Array.from(list.querySelectorAll<HTMLElement>("[data-tab-id]")).map((row) => [row.dataset.tabId!, row.offsetLeft]));
const shown = (list: HTMLElement | null): list is HTMLElement => Boolean(list && !list.closest("[hidden]"));
const sameTabs = (a: Placed, b: Placed) => a.size === b.size && [...a.keys()].every((id) => b.has(id));

/**
 * Where the strip must scroll to so a tab is fully in view (null: it already is). A tab wider than
 * the strip shows from its start.
 */
/**
 * The strip draws no scrollbar (a bar inside a 30px strip covers the tabs): an up-down wheel over
 * it moves it sideways by that much. A sideways wheel (touchpad) is left to the browser: 0.
 */
export const wheelAcross = (wheel: { deltaX: number; deltaY: number }): number => (Math.abs(wheel.deltaY) > Math.abs(wheel.deltaX) ? wheel.deltaY : 0);

export function revealScroll(strip: { scroll: number; width: number }, tab: { left: number; width: number }): number | null {
  const end = strip.scroll + strip.width;
  if (tab.left < strip.scroll || tab.width >= strip.width) return tab.left === strip.scroll ? null : tab.left;
  if (tab.left + tab.width > end) return tab.left + tab.width - strip.width;
  return null;
}

/**
 * The tab strip. When its pane's tabs change, a new tab widens in and, after a close, the tabs
 * whose place changed slide into the gap. The copy on screen records places after each commit and
 * again right before the DOM changes (an update, or its own removal when its tab closes); the copy
 * on screen after the change plays from them.
 */
class TabStrip extends Component<{ paneId: string; activeId: string; children: ReactNode }> {
  list = createRef<HTMLDivElement>();
  resize: ResizeObserver | null = null;
  /** The tab whose width is watched: the active one only. */
  watched: HTMLElement | null = null;
  wasShown = false;
  get entry() {
    let entry = panes.get(this.props.paneId);
    if (!entry) panes.set(this.props.paneId, (entry = { places: null, copies: 0 }));
    return entry;
  }
  record() {
    if (shown(this.list.current)) this.entry.places = placed(this.list.current);
  }
  getSnapshotBeforeUpdate() {
    this.record();
    return null;
  }
  componentDidMount() {
    this.entry.copies += 1;
    this.wasShown = shown(this.list.current);
    // The active tab stays in view when the strip narrows (a pane opened beside, the window resized)
    // or the tab itself widens.
    if (typeof ResizeObserver !== "undefined" && this.list.current) {
      // After the frame's layout: the strip may have just come into view.
      this.resize = new ResizeObserver(() => requestAnimationFrame(() => this.reveal()));
      this.resize.observe(this.list.current);
    }
    this.reveal();
    this.play();
  }
  componentDidUpdate(previous: { activeId: string }) {
    // When the active tab or the tabs change, or this copy comes into view (a hidden strip loses its
    // scroll): a strip the person scrolled stays put otherwise.
    const now = shown(this.list.current);
    if (now && (!this.wasShown || previous.activeId !== this.props.activeId || !sameTabs(this.entry.places ?? new Map(), placed(this.list.current!)))) this.reveal();
    this.wasShown = now;
    this.play();
  }
  componentWillUnmount() {
    this.resize?.disconnect();
    this.record();
    const paneId = this.props.paneId, entry = this.entry;
    entry.copies -= 1;
    // The pane is gone once no copy is left after this commit (a successor mounts in the same one).
    queueMicrotask(() => { if (panes.get(paneId)?.copies === 0) panes.delete(paneId); });
  }
  /** Scroll the strip so the active tab is fully in view, never under "새로 만들기". */
  reveal() {
    const list = this.list.current;
    if (!shown(list)) return;
    const tab = list.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(this.props.activeId)}"]`);
    if (!tab) return;
    // A tab's width changes after it is placed (its title arrives): watch the active one too — and
    // only that one, so a tab left behind cannot snap the strip back after the person scrolled it.
    if (this.watched !== tab) {
      if (this.watched) this.resize?.unobserve(this.watched);
      this.resize?.observe(tab);
      this.watched = tab;
    }
    const to = revealScroll({ scroll: list.scrollLeft, width: list.clientWidth }, { left: tab.offsetLeft, width: tab.offsetWidth });
    if (to !== null) list.scrollLeft = to;
  }
  play() {
    const list = this.list.current;
    if (!shown(list)) return;
    const last = this.entry.places, now = placed(list);
    this.entry.places = now;
    if (!last || sameTabs(last, now)) return;
    const closed = [...last.keys()].some((id) => !now.has(id));
    for (const row of list.querySelectorAll<HTMLElement>("[data-tab-id]")) {
      const was = last.get(row.dataset.tabId!);
      if (was === undefined) widenIn(row, row.offsetWidth);
      else if (closed) slideX(row, was - now.get(row.dataset.tabId!)!);
    }
  }
  render() {
    return <div ref={this.list} role="tablist" aria-label="열린 탭" onWheel={(event) => { event.currentTarget.scrollLeft += wheelAcross(event); }}>{this.props.children}</div>;
  }
}

export function GroupTabs<V>({ pane, head, onSelect, onClose, onReorder, onNew }: {
  pane: Pane<V>; head: (pane: Pane<V>) => PaneHead;
  onSelect: (id: string) => void; onClose: (id: string) => void;
  onReorder: (id: string, index: number) => void; onNew: (anchor: HTMLButtonElement) => void;
}) {
  const tabs = tabsOf(pane), activeId = activeTab(pane).id;
  return <nav className="group-tabs" data-pane-id={pane.id} aria-label="작업공간 탭">
    <TabStrip paneId={pane.id} activeId={activeId}>
      {tabs.map((tab, index) => {
        const title = head({ ...pane, view: tab.view, workId: tab.workId, sessionId: tab.sessionId });
        const kind = title.kindLabel ?? (title.item?.kind === "session" ? "대화" : title.item?.kind === "doc" ? "문서" : title.item?.kind === "project" || title.item?.kind === "work" ? "프로젝트" : null);
        // Format badges and chat/web icons already name those kinds. Retain the
        // project and child-agent labels where the distinction changes navigation.
        const showKind = kind === "프로젝트" || kind === "웹 AI" || kind === "문서 AI";
        // The tab on screen shows its answer; only tabs behind it carry the badge.
        const unseen = Boolean(title.unseen) && tab.id !== activeId;
        return <div className={`group-tab${tab.id === activeId ? " active" : ""}`} data-tab-index={index} data-tab-id={tab.id} key={tab.id}>
          <button type="button" role="tab" aria-label={`${kind ? `${kind} · ` : ""}${title.title}${unseen ? " · 새 답" : ""}`} aria-selected={tab.id === activeId} tabIndex={tab.id === activeId ? 0 : -1} title={`${kind ? `${kind} · ` : ""}${title.hint ?? title.title} · 끌어서 이동 · Ctrl+Shift+←→로 순서 변경`}
            onPointerDown={(event) => paneDrag.press({ item: { kind: "tab", id: tab.id }, label: title.title }, event)}
            onMouseDown={(event) => paneDrag.press({ item: { kind: "tab", id: tab.id }, label: title.title }, event)}
            onClick={() => { if (!paneDrag.justDragged()) onSelect(tab.id); }}
            onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); onClose(tab.id); } }}
            onKeyDown={(event) => {
              const step = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
              if (step && (event.ctrlKey || event.metaKey) && event.shiftKey) { event.preventDefault(); onReorder(tab.id, Math.max(0, Math.min(tabs.length - 1, index + step))); return; }
              const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : step ? (index + step + tabs.length) % tabs.length : -1;
              if (next >= 0) {
                event.preventDefault();
                event.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus({ preventScroll: true });
                onSelect(tabs[next]!.id);
              }
              if (event.key === "Delete") { event.preventDefault(); onClose(tab.id); }
            }}><span className="badged" aria-hidden>{title.icon}{unseen ? <span className="new-badge" /> : null}</span>{showKind ? <span className="group-tab-kind">{kind}</span> : null}<span className="group-tab-title">{title.title}</span></button>
          <button type="button" className="group-tab-close" aria-label={`${title.title} 탭 닫기`} title="탭 닫기 · 파일과 세션 기록은 유지" onClick={() => onClose(tab.id)}><Icon name="x" size={12} /></button>
        </div>;
      })}
    </TabStrip>
    <button type="button" className="ghost-button small group-tab-new" aria-label="새로 만들기" title="이 프로젝트에 새 문서·디자인·세션 만들기" aria-haspopup="menu" onClick={event => onNew(event.currentTarget)}><Icon name="plus" size={14} /><span>새로 만들기</span></button>
  </nav>;
}
