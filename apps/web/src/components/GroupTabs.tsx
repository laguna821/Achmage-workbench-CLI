import { Component, createRef, useState, type ReactNode } from "react";
import type { Pane } from "../panes.ts";
import { slideX, widenIn } from "../flip.ts";
import { activeTab, offScope, projectOfTab, tabsOf } from "../tabs.ts";
import { paneDrag, usePaneDragSlice } from "../panedrag.ts";
import { stripMark } from "../tab-drop.ts";
import type { PaneHead } from "./Panes.tsx";
import { Icon } from "./Icon.tsx";
import { StateMark } from "./StateMark.tsx";
import { Menu, MenuItem, useMenuTrigger } from "./ui/Menu.tsx";

type Placed = Map<string, number>;
/**
 * Per pane: where its tabs were last drawn by the copy of its bar on screen, and how many copies
 * are mounted. Each tab's view carries its own copy, and closing the shown tab unmounts the shown
 * copy, so the places live here, not in a copy.
 */
const panes = new Map<string, { places: Placed | null; copies: number }>();

/** Each tab's left edge within the strip's content (no scroll, no transforms, no screen offset); tabs listed under ⌄ are not on the strip. */
const placed = (list: HTMLElement): Placed => new Map(Array.from(list.querySelectorAll<HTMLElement>("[data-tab-id]:not([data-overflowed])")).map((row) => [row.dataset.tabId!, row.offsetLeft]));

/** A tab never measured yet (it was listed under ⌄ from the start) is taken at this width. */
const UNMEASURED_TAB = 160;

/**
 * Which tabs leave the strip for the ⌄ list (Hallmark U4: an overflow list, never a clipped last
 * tab). The active tab always stays; the others keep their order and stay while they fit whole.
 * `room` 0 (not measured, e.g. a hidden copy or jsdom) keeps every tab on the strip.
 */
export function overflowTabs(ids: string[], activeId: string, width: (id: string) => number, room: number, gap: number): string[] {
  if (room <= 0) return [];
  const total = ids.reduce((sum, id) => sum + width(id), 0) + gap * Math.max(0, ids.length - 1);
  if (total <= room) return [];
  let left = room - (ids.includes(activeId) ? width(activeId) : 0);
  const out: string[] = [];
  for (const id of ids) {
    if (id === activeId) continue;
    const need = width(id) + gap;
    if (!out.length && need <= left) left -= need;
    else out.push(id);
  }
  return out;
}
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
class TabStrip extends Component<{ paneId: string; activeId: string; onOverflow: (ids: string[]) => void; children: ReactNode }> {
  list = createRef<HTMLDivElement>();
  /** Last drawn width of each tab, so a tab listed under ⌄ is placed back when there is room again. */
  widths = new Map<string, number>();
  overflowed: string[] = [];
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
      this.resize = new ResizeObserver(() => requestAnimationFrame(() => { this.fit(); this.reveal(); }));
      this.resize.observe(this.list.current);
    }
    this.fit();
    this.reveal();
    this.play();
  }
  componentDidUpdate(previous: { activeId: string }) {
    this.fit();
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
  /** Tabs that do not fit whole leave the strip for the ⌄ list; the active one always stays. */
  fit() {
    const list = this.list.current;
    if (!shown(list)) return;
    const rows = Array.from(list.querySelectorAll<HTMLElement>("[data-tab-id]"));
    for (const row of rows) if (!row.hasAttribute("data-overflowed") && row.offsetWidth) this.widths.set(row.dataset.tabId!, row.offsetWidth);
    const gap = parseFloat(getComputedStyle(list).columnGap) || 0;
    const ids = rows.map((row) => row.dataset.tabId!);
    const out = overflowTabs(ids, this.props.activeId, (id) => this.widths.get(id) ?? UNMEASURED_TAB, list.clientWidth, gap);
    for (const row of rows) row.toggleAttribute("data-overflowed", out.includes(row.dataset.tabId!));
    if (out.join(" ") !== this.overflowed.join(" ")) {
      this.overflowed = out;
      this.props.onOverflow(out);
    }
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

/**
 * Project tabs: the strip shows the window's project's tabs and nothing else — no home tab, no other
 * project's tab; with no project chosen (`workId` null) it shows no tab at all. Everything else stays
 * open and running, one list away (⌄: home, then "다른 프로젝트"). The ⌄ key counts this project's
 * own overflow only. `all` shows every project's tabs, as before (a tab of another project then says
 * its project).
 */
export type TabScope = { workId: string | null; all: boolean; projectName: (workId: string) => string; onShowAll: (all: boolean) => void;
  /** Skin 2 · B: this pane's project, said before its tabs while panes show different projects. */
  label?: string | null };

export function GroupTabs<V>({ pane, head, onSelect, onClose, onReorder, onNew, scope }: {
  pane: Pane<V>; head: (pane: Pane<V>) => PaneHead;
  onSelect: (id: string) => void; onClose: (id: string) => void;
  onReorder: (id: string, index: number) => void; onNew: (anchor: HTMLButtonElement) => void;
  scope?: TabScope;
}) {
  const all = tabsOf(pane), activeId = activeTab(pane).id;
  const behind = new Set(scope ? offScope(pane, scope.workId, scope.all) : []);
  const tabs = all.filter((tab) => !behind.has(tab.id));
  const [overflowed, setOverflowed] = useState<string[]>([]);
  const list = useMenuTrigger();
  const shownOverflow = overflowed.filter((id) => tabs.some((tab) => tab.id === id));
  // Something held over this strip: an insertion mark between its tabs (nothing is laid over the panes).
  const dropAt = usePaneDragSlice((drag) => drag?.over?.kind === "zone" && drag.over.target.paneId === pane.id && drag.over.target.tabIndex !== undefined
    ? `${drag.item.kind === "tab" ? drag.item.id : ""}\n${drag.over.target.tabIndex}` : "");
  const dropMark = dropAt ? (() => { const [held, index] = dropAt.split("\n") as [string, string]; return stripMark(all.map((tab) => tab.id), held && all.some((tab) => tab.id === held) ? held : null, Number(index), (id) => tabs.some((tab) => tab.id === id)); })() : null;
  // The count is this project's own overflow; what is behind (home, other projects) is not announced.
  const listed = shownOverflow.length;
  const apart = all.filter((tab) => behind.has(tab.id) && projectOfTab(tab) === null), others = all.filter((tab) => behind.has(tab.id) && projectOfTab(tab) !== null);
  // Something to list beyond what the strip shows: the overflow, another project's tab, a second place (home behind a project; the archive beside home).
  const more = listed > 0 || others.length > 0 || apart.some((tab) => tab.id !== activeId) || Boolean(scope?.all && all.some((tab) => { const owner = projectOfTab(tab); return owner && owner !== scope.workId; }));
  return <nav className="group-tabs" data-pane-id={pane.id} aria-label={scope?.label ? `${scope.label} 탭` : "작업 폴더 탭"}>
    {scope?.label ? <span className="group-tabs-project" title={`이 칸의 프로젝트: ${scope.label}`}>{scope.label}</span> : null}
    <TabStrip paneId={pane.id} activeId={activeId} onOverflow={setOverflowed}>
      {tabs.map((tab, index) => {
        const title = head({ ...pane, view: tab.view, workId: tab.workId, sessionId: tab.sessionId });
        const kind = title.kindLabel ?? (title.item?.kind === "session" ? "대화" : title.item?.kind === "doc" ? "문서" : title.item?.kind === "project" || title.item?.kind === "work" ? "프로젝트" : null);
        // Format badges and chat/web icons already name those kinds. Retain the
        // project and child-agent labels where the distinction changes navigation.
        const showKind = kind === "프로젝트" || kind === "웹 AI" || kind === "문서 AI";
        // The tab's one state mark after its title (row-state.ts): what asks, fails, runs, waits; a new
        // answer only on tabs behind the one on screen; 완료 says nothing on a tab.
        const mark = title.state && title.state.id !== "done" && (title.state.id !== "unseen" || tab.id !== activeId) ? title.state : null;
        const unseen = (Boolean(title.unseen) && tab.id !== activeId) || mark?.id === "unseen";
        const owner = projectOfTab(tab);
        const elsewhere = scope && owner && scope.workId && owner !== scope.workId ? scope.projectName(owner) : null;
        return <div className={`group-tab${tab.id === activeId ? " active" : ""}`} data-tab-index={all.indexOf(tab)} data-tab-id={tab.id} data-tab-project={tab.workId ?? undefined} key={tab.id}>
          <button type="button" role="tab" aria-label={`${kind ? `${kind}, ` : ""}${title.title}${mark ? `, ${mark.word}` : unseen ? ", 새 답" : ""}`} aria-selected={tab.id === activeId} tabIndex={tab.id === activeId ? 0 : -1} title={`${kind ? `${kind} · ` : ""}${title.hint ?? title.title} · 끌어서 이동 · Ctrl+Shift+←→로 순서 변경`}
            onPointerDown={(event) => paneDrag.press({ item: { kind: "tab", id: tab.id }, label: title.title }, event)}
            onMouseDown={(event) => paneDrag.press({ item: { kind: "tab", id: tab.id }, label: title.title }, event)}
            onClick={() => { if (!paneDrag.justDragged()) onSelect(tab.id); }}
            onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); if (!(title.home && all.length === 1)) onClose(tab.id); } }}
            onKeyDown={(event) => {
              const step = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
              if (step && (event.ctrlKey || event.metaKey) && event.shiftKey) { event.preventDefault(); onReorder(tab.id, Math.max(0, Math.min(all.length - 1, all.indexOf(tab) + step))); return; }
              const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : step ? (index + step + tabs.length) % tabs.length : -1;
              if (next >= 0) {
                event.preventDefault();
                const list = event.currentTarget.closest('[role="tablist"]');
                list?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus({ preventScroll: true });
                onSelect(tabs[next]!.id);
                // A tab that was in the ⌄ list comes back onto the strip with the next frame: focus follows it there.
                const id = tabs[next]!.id;
                requestAnimationFrame(() => list?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(id)}"] [role="tab"]`)?.focus({ preventScroll: true }));
              }
              if (event.key === "Delete") { event.preventDefault(); if (!(title.home && all.length === 1)) onClose(tab.id); }
            }}><span className="badged" aria-hidden>{title.icon}{unseen && !mark ? <span className="new-badge" /> : null}</span>{elsewhere ? <span className="group-tab-project" title={`다른 프로젝트: ${elsewhere}`}>{elsewhere}</span> : null}{showKind ? <span className="group-tab-kind">{kind}</span> : null}<span className="group-tab-title">{title.title}</span>{mark ? <span className="group-tab-state" title={mark.word}><StateMark state={mark} size={14} /></span> : null}</button>
          {title.home && all.length === 1 ? null : <button type="button" className="group-tab-close" aria-label={`${title.title} 탭 닫기`} title="탭 닫기, 파일과 대화 기록은 남습니다" onClick={() => onClose(tab.id)}><Icon name="x" size={12} /></button>}
          {dropMark && ("before" in dropMark ? dropMark.before : dropMark.after) === tab.id ? <span className={`group-tab-drop ${"before" in dropMark ? "before" : "after"}`} aria-hidden /> : null}
        </div>;
      })}
    </TabStrip>
    {/* Tabs that do not fit are one list away: every open tab, the current one checked. */}
    {more ? <>
      <button type="button" ref={list.anchorRef} className="ghost-button small group-tab-more" aria-label={listed ? `열린 탭 목록, ${listed}개 더` : "열린 탭 목록"} title="열린 탭 모두 보기 (다른 프로젝트의 탭 포함)" {...list.triggerProps}>
        {/* One calm count (release unit A): "2개 더", no chevron beside a bare number. */}
        {listed ? <span className="group-tab-more-count">{listed}개 더</span> : <Icon name="chevronDown" size={14} />}
      </button>
      <Menu {...list.menuProps} label="열린 탭" align="end" className="group-tab-list">
        {tabs.map((tab) => {
          const title = head({ ...pane, view: tab.view, workId: tab.workId, sessionId: tab.sessionId });
          return <MenuItem key={tab.id} icon={<span className="badged" aria-hidden>{title.icon}{title.unseen && tab.id !== activeId ? <span className="new-badge" /> : null}</span>}
            checked={tab.id === activeId} type="radio" value={tab.id} textValue={title.title} onSelect={() => onSelect(tab.id)}>{title.title}</MenuItem>;
        })}
        {apart.map((tab) => {
          const title = head({ ...pane, view: tab.view, workId: tab.workId, sessionId: tab.sessionId });
          return <MenuItem key={tab.id} icon={<span className="badged" aria-hidden>{title.icon}</span>} checked={tab.id === activeId} type="radio" value={tab.id} textValue={title.title} onSelect={() => onSelect(tab.id)}>{title.title}</MenuItem>;
        })}
        {others.length ? <MenuItem key="other-head" disabled textValue="다른 프로젝트" onSelect={() => undefined}>다른 프로젝트 (열려 있고 계속 실행 중)</MenuItem> : null}
        {others.map((tab) => {
          const title = head({ ...pane, view: tab.view, workId: tab.workId, sessionId: tab.sessionId });
          const holder = projectOfTab(tab);
          const owner = holder && scope ? scope.projectName(holder) : "";
          return <MenuItem key={tab.id} icon={<span className="badged" aria-hidden>{title.icon}{title.unseen ? <span className="new-badge" /> : null}</span>}
            textValue={`${owner} ${title.title}`} onSelect={() => onSelect(tab.id)}>{owner ? `${owner} · ` : ""}{title.title}</MenuItem>;
        })}
        {scope ? <MenuItem key="scope-all" type="checkbox" checked={scope.all} textValue="모든 프로젝트의 탭 보기" onSelect={() => scope.onShowAll(!scope.all)}>모든 프로젝트의 탭 보기</MenuItem> : null}
      </Menu>
    </> : null}
    {/* One "새로 만들기" per screen carries the words (the sidebar's, or the top bar's); here it is the strip's quiet +. */}
    <button type="button" className="icon-button small group-tab-new" aria-label="새로 만들기" title="이 칸에 새 대화나 문서 만들기" aria-haspopup="menu" onClick={event => onNew(event.currentTarget)}><Icon name="plus" size={16} /></button>
  </nav>;
}
