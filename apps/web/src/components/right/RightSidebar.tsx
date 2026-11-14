import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import type { Artifact, BrowserPage, Session } from "@workbench/contracts";
import { headingsOf, jumpInNote } from "../../conversation/outline.ts";
import { turnRunning, type State } from "../../state.ts";
import { ago } from "../../format.ts";
import { Segmented } from "../ui/Hig.tsx";
import { Icon, type IconName } from "../Icon.tsx";
import { docIcon } from "../nav/rows.tsx";
import { OutlineList, useRequestOutline, type OutlineEntry } from "./OutlineList.tsx";
import { linksOf } from "./links.ts";
import "../../styles/right-sidebar.css";

// The window's right sidebar (Obsidian's): the note in the focused pane, as an outline (개요) and as
// what it is connected to (연결). Closed by default; a sheet of the frame beside the panes, laid
// over the work in a narrow window.

export type RightTab = "outline" | "links";
/** The note in the focused pane: a conversation, a document, something else (a web tab…), or none. */
export type SideNote = { kind: "chat"; session: Session } | { kind: "document"; artifact: Artifact } | { kind: "other" } | null;

export const RIGHT_WIDTH = { min: 240, max: 440, fallback: 280 } as const;
const clampWidth = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.round(Math.min(RIGHT_WIDTH.max, Math.max(RIGHT_WIDTH.min, value))) : RIGHT_WIDTH.fallback;

/** What the sidebar follows: the conversation of a chat (or of "나란히"), a document, or nothing. */
export function sideNoteOf(view: { kind: string; artifactId?: string }, session: Session | null | undefined, artifacts: State["artifacts"]): SideNote {
  if (view.kind === "work" && session) return { kind: "chat", session };
  if (view.kind === "document" && view.artifactId && artifacts[view.artifactId]) return { kind: "document", artifact: artifacts[view.artifactId]! };
  if (view.kind === "browser" || view.kind === "document" || view.kind === "terminal" || view.kind === "presentation") return { kind: "other" };
  return null;
}

/** The gap the sidebar keeps from the panes, and the room more it needs to dock again once laid over. */
const GAP = 8;
const HYSTERESIS = 16;

/**
 * Docked only while every pane keeps its minimum width beside it. `area`: the panes' width without
 * the sidebar; `minimum`: the layout's least width (panes.ts `minimumSize`); `docked`: the last
 * decision (a margin keeps it from flipping at the threshold). Unmeasured (0): docked.
 */
export function sidebarDocks(area: number, minimum: number, width: number, docked: boolean): boolean {
  if (!area) return true;
  const left = area - width - GAP;
  return docked ? left >= minimum : left >= minimum + HYSTERESIS;
}

/** The panes' width without a docked sidebar: what the panes have now, plus the sidebar's place. */
function measurePaneArea() {
  const panes = document.querySelector<HTMLElement>(".body > .panes");
  if (!panes) return 0;
  const docked = document.querySelector<HTMLElement>(".body > .right-sidebar:not([data-overlay])");
  return panes.getBoundingClientRect().width + (docked ? docked.getBoundingClientRect().width + GAP : 0);
}

/**
 * Open state, tab and width, kept in the prefs per window (the main window and a session's own
 * window apart). In a narrow window it lays over the work and is not remembered.
 */
export function useRightSidebar({ prefs, savePrefs, scope, compact, minimum, ready = true, measure = measurePaneArea }: {
  prefs: Record<string, unknown>; savePrefs: (patch: Record<string, unknown>) => void; scope: "main" | "window"; compact: boolean;
  /** The pane layout's least width (one pane: 360). */
  minimum: number;
  /** The panes are drawn (the layout is ready): decided again then, so a saved-open sidebar never squeezes them at boot. */
  ready?: boolean;
  /** The panes' width without the sidebar (default: measured in the window). */
  measure?: () => number;
}) {
  const key = scope === "window" ? "rightSidebarWindow" : "rightSidebar";
  const saved = (prefs[key] && typeof prefs[key] === "object" ? prefs[key] : {}) as { open?: unknown; width?: unknown; tab?: unknown };
  const width = clampWidth(saved.width);
  const tab: RightTab = saved.tab === "links" ? "links" : "outline";
  // Laid over the work in a narrow window, or when docking would squeeze the panes; decided from
  // the measured pane area, again whenever the window, the layout or the width changes.
  const [fits, setFits] = useState(true);
  const measured = useRef(measure);
  measured.current = measure;
  useLayoutEffect(() => {
    // The window's body (window size) and the panes (the left sidebar, a layout change).
    let panes: Element | null = null;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => decide());
    const decide = () => {
      const now = document.querySelector(".body > .panes");
      if (now !== panes) { if (panes) observer?.unobserve(panes); panes = now; if (now) observer?.observe(now); }
      setFits((docked) => sidebarDocks(measured.current(), minimum, width, docked));
    };
    const body = document.querySelector(".body");
    if (body) observer?.observe(body);
    decide();
    window.addEventListener("resize", decide);
    return () => { observer?.disconnect(); window.removeEventListener("resize", decide); };
  }, [minimum, width, ready]);
  const overlay = compact || !fits;
  const [laidOver, setLaidOver] = useState(false);
  useEffect(() => setLaidOver(false), [overlay]);
  const open = overlay ? laidOver : saved.open === true;
  const latest = useRef({ open: saved.open === true, width, tab });
  latest.current = { open: saved.open === true, width, tab };
  const save = (patch: Partial<{ open: boolean; width: number; tab: RightTab }>) => savePrefs({ [key]: { ...latest.current, ...patch } });

  // Shown while open, and while it slides out after closing.
  const [shown, setShown] = useState(open);
  const closing = shown && !open;
  useEffect(() => { if (open) setShown(true); }, [open]);
  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(() => setShown(false), 400);
    return () => window.clearTimeout(timer);
  }, [closing]);

  const id = useId();
  const aside = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const [focusOnOpen, setFocusOnOpen] = useState(false);
  const setOpen = (next: boolean) => (overlay ? setLaidOver(next) : save({ open: next }));
  const close = () => {
    if (aside.current?.contains(document.activeElement)) {
      const back = returnTo.current?.isConnected ? returnTo.current : toggleRef.current;
      back?.focus();
    }
    setOpen(false);
  };
  /** `keyboard`: opened with a key, so the focus goes in (and comes back on close). */
  const toggle = (keyboard: boolean) => {
    if (open) return close();
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setFocusOnOpen(keyboard);
    setOpen(true);
  };
  return {
    open, shown, toggle, close,
    toggleProps: { ref: toggleRef, "aria-expanded": open, "aria-controls": id, onClick: (event: { detail: number }) => toggle(event.detail === 0) },
    sidebarProps: {
      id, asideRef: aside, width, tab, overlay, closing, autoFocus: focusOnOpen && open,
      onTab: (next: RightTab) => save({ tab: next }),
      onWidth: (next: number) => save({ width: clampWidth(next) }),
      onClose: close,
      onClosed: () => { setShown(false); setFocusOnOpen(false); },
    },
  };
}

/** `open`: a click, an address (new window), or null (nothing to open: the row only says so). */
type Row = { key: string; icon: ReactNode; name: string; meta: string; open: (() => void) | string | null };

function LinkRow({ row }: { row: Row }) {
  const body = <>{row.icon}<span className="right-link-name">{row.name}</span><span className="right-link-meta">{row.meta}</span></>;
  return (
    <li>
      {row.open === null ? (
        <span className="right-link" data-static="">{body}</span>
      ) : typeof row.open === "string" ? (
        <a className="right-link" href={row.open} target="_blank" rel="noreferrer" title={row.open}>{body}</a>
      ) : (
        <button type="button" className="right-link" onClick={row.open} title={row.name}>{body}</button>
      )}
    </li>
  );
}

function Group({ label, rows }: { label: string; rows: Row[] }) {
  const id = useId();
  if (!rows.length) return null;
  return (
    <section className="right-group" aria-labelledby={id}>
      <h3 className="right-group-label" id={id}>{label}<span>{rows.length}</span></h3>
      <ul>{rows.map((row) => <LinkRow key={row.key} row={row} />)}</ul>
    </section>
  );
}

const kindIcon = (name: IconName) => <Icon name={name} size={15} className="right-link-icon" />;

function Links({ session, state, pages, onOpenSession, onOpenArtifact, onOpenPage }: { session: Session; state: State; pages: BrowserPage[]; onOpenSession: (session: Session) => void; onOpenArtifact: (artifactId: string) => void; onOpenPage?: (page: BrowserPage) => void }) {
  const items = state.transcripts[session.id]?.items;
  const links = useMemo(() => linksOf(session, items ?? [], state, pages), [session, items, state, pages]);
  const when = (at: number | null) => (at ? ` · ${ago(at)}` : "");
  const documents: Row[] = links.documents.map((entry) => ({ key: entry.artifact.id, icon: kindIcon(docIcon(entry.artifact)), name: entry.artifact.name, meta: `${entry.state}${when(entry.at)}`, open: entry.gone ? null : () => onOpenArtifact(entry.artifact.id) }));
  const web: Row[] = links.web.map((entry) => entry.kind === "tab"
    ? { key: entry.key, icon: kindIcon("globe"), name: entry.title, meta: entry.state, open: !entry.closed ? () => onOpenSession(entry.session) : !entry.page ? null : onOpenPage ? () => onOpenPage(entry.page!) : entry.page.url }
    : { key: entry.key, icon: kindIcon("globe"), name: entry.title, meta: `봄${when(entry.at)}`, open: entry.url });
  const chats: Row[] = links.chats.map((entry) => ({ key: entry.session.id, icon: kindIcon("chat"), name: entry.session.purpose, meta: entry.relation, open: () => onOpenSession(entry.session) }));
  if (!documents.length && !web.length && !chats.length) return <p className="right-empty">아직 이 대화와 이어진 것이 없습니다.</p>;
  return <><Group label="문서" rows={documents} /><Group label="웹" rows={web} /><Group label="대화" rows={chats} /></>;
}

function ChatOutline({ session, state, onPicked }: { session: Session; state: State; onPicked: () => void }) {
  const { entries, current } = useRequestOutline(session.id, state.transcripts[session.id]?.items, turnRunning(session));
  if (!entries.length) return <p className="right-empty">요청을 보내면 여기에 목록이 생깁니다.</p>;
  return <OutlineList label="요청 목록" entries={entries} current={current} onPick={(entry) => { jumpInNote(`chat:${session.id}`, entry.id); onPicked(); }} />;
}

/** A Markdown document's headings, read from its latest revision. */
function DocumentOutline({ artifact, readText, onPicked }: { artifact: Artifact; readText: (artifactId: string) => Promise<string>; onPicked: () => void }) {
  const markdown = artifact.format === "markdown";
  const [entries, setEntries] = useState<OutlineEntry[] | null>(null);
  useEffect(() => {
    setEntries(null);
    if (!markdown) return;
    let live = true;
    readText(artifact.id)
      .then((text) => { if (live) setEntries(headingsOf(text).map((heading) => ({ id: String(heading.line), text: heading.text, level: heading.level }))); })
      .catch(() => { if (live) setEntries([]); });
    return () => { live = false; };
  }, [artifact.id, artifact.revision, markdown, readText]);
  if (!markdown) return <p className="right-empty">이 형식의 문서에는 개요가 없습니다.</p>;
  if (!entries) return null;
  if (!entries.length) return <p className="right-empty">이 문서에는 제목(#)이 없습니다.</p>;
  return <OutlineList label="문서 개요" entries={entries} current={null} onPick={(entry) => { jumpInNote(`doc:${artifact.id}`, entry.id, entry.text); onPicked(); }} />;
}

export function RightSidebar({ id, asideRef, note, state, pages, readText, tab, onTab, width, onWidth, overlay, closing, autoFocus, onClose, onClosed, onOpenSession, onOpenArtifact, onOpenPage }: {
  id: string; asideRef: RefObject<HTMLElement | null>;
  note: SideNote; state: State; pages: BrowserPage[];
  readText: (artifactId: string) => Promise<string>;
  tab: RightTab; onTab: (tab: RightTab) => void;
  width: number; onWidth: (width: number) => void;
  overlay: boolean; closing: boolean; autoFocus: boolean;
  onClose: () => void; onClosed: () => void;
  onOpenSession: (session: Session) => void; onOpenArtifact: (artifactId: string) => void;
  /** A closed web tab's address in a new web tab (absent where there are no web tabs: a link instead). */
  onOpenPage?: (page: BrowserPage) => void;
}) {
  const tabsId = `${id}-tab`;
  const panelId = `${id}-panel`;
  // Dragging sets the width on the sheet directly; the prefs take it when the drag ends.
  const [live, setLive] = useState<number | null>(null);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const shownWidth = live ?? width;
  useLayoutEffect(() => {
    if (autoFocus) asideRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  }, [autoFocus, asideRef]);
  // Gone once it has slid out; reduced motion has no slide to wait for.
  const closed = useRef(onClosed);
  closed.current = onClosed;
  useEffect(() => {
    const element = asideRef.current;
    if (!closing || !element) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) { closed.current(); return; }
    const done = (event: Event) => { if (event.target === element) closed.current(); };
    element.addEventListener("animationend", done);
    return () => element.removeEventListener("animationend", done);
  }, [closing, asideRef]);
  const picked = () => { if (overlay) onClose(); };
  const toNote = (session: Session) => { onOpenSession(session); picked(); };
  const toDoc = (artifactId: string) => { onOpenArtifact(artifactId); picked(); };
  const toPage = onOpenPage ? (page: BrowserPage) => { onOpenPage(page); picked(); } : undefined;
  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    drag.current = { x: event.clientX, width };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };
  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    setLive(clampWidth(drag.current.width + drag.current.x - event.clientX));
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const next = clampWidth(drag.current.width + drag.current.x - event.clientX);
    drag.current = null;
    setLive(null);
    onWidth(next);
  };
  const panel = !note
    ? <p className="right-empty">{tab === "outline" ? "대화나 문서를 열면 개요가 여기에 보입니다." : "대화를 열면 그 대화가 만든 문서와 이어진 대화가 보입니다."}</p>
    : tab === "outline"
      ? note.kind === "chat" ? <ChatOutline session={note.session} state={state} onPicked={picked} />
        : note.kind === "document" ? <DocumentOutline artifact={note.artifact} readText={readText} onPicked={picked} />
          : <p className="right-empty">이 화면에는 개요가 없습니다.</p>
      : note.kind === "chat" ? <Links session={note.session} state={state} pages={pages} onOpenSession={toNote} onOpenArtifact={toDoc} onOpenPage={toPage} />
        : <p className="right-empty">대화를 열면 그 대화가 만든 문서와 이어진 대화가 보입니다.</p>;
  return (
    <>
      {overlay ? <button type="button" className="right-sidebar-scrim" data-covers-web="" data-state={closing ? "closing" : "open"} aria-label="오른쪽 사이드바 닫기" onClick={onClose} /> : null}
      <aside
        ref={asideRef}
        id={id}
        className="right-sidebar"
        aria-label="오른쪽 사이드바"
        data-overlay={overlay ? "true" : undefined}
        // Laid over the work, a native web page under it gives way (browser-state.present).
        data-covers-web={overlay ? "" : undefined}
        data-state={closing ? "closing" : "open"}
        style={{ "--right-width": `${shownWidth}px` } as CSSProperties}
        onKeyDown={(event) => {
          if (event.key === "Escape" && overlay && !event.defaultPrevented) { event.preventDefault(); onClose(); }
        }}
      >
        {!overlay ? (
          <div
            className="right-sidebar-edge"
            role="separator"
            aria-orientation="vertical"
            aria-label="오른쪽 사이드바 너비"
            aria-valuemin={RIGHT_WIDTH.min}
            aria-valuemax={RIGHT_WIDTH.max}
            aria-valuenow={shownWidth}
            tabIndex={0}
            onPointerDown={startDrag}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={() => { drag.current = null; setLive(null); }}
            onKeyDown={(event) => {
              const step = event.key === "ArrowLeft" ? 16 : event.key === "ArrowRight" ? -16 : 0;
              if (!step) return;
              event.preventDefault();
              onWidth(width + step);
            }}
          />
        ) : null}
        <Segmented tabs id={tabsId} controls={panelId} className="right-sidebar-tabs" label="오른쪽 사이드바 보기" value={tab} onChange={onTab}
          options={[{ value: "outline", label: "개요" }, { value: "links", label: "연결" }]} />
        <div className="right-sidebar-body" role="tabpanel" id={panelId} aria-labelledby={`${tabsId}-${tab === "outline" ? 0 : 1}`}>
          {panel}
        </div>
      </aside>
    </>
  );
}
