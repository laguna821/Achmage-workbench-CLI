import { flushSync } from "react-dom";
import { ItemIcon, artifactKind } from "../ItemIcon.tsx";
import { memo, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { Artifact, Session, Work } from "@workbench/contracts";
import { nowSessions, sessionHidden, workHidden, type Row } from "../../tree.ts";
import { Icon, type IconName } from "../Icon.tsx";
import { VaultSection } from "../pkm/VaultSection.tsx";
import { dateGroup, docKind, shortDate } from "./model.ts";
import { NowSection, SectionHead } from "./NavPane.tsx";
import { StateMark, sideClick, sessionState } from "./rows.tsx";
import type { NavShared } from "./shared.ts";
import { LIST_STOP, typeAhead } from "./focus.ts";

// The rail's other list destinations (N1): 문서 (every project's documents, each saying its project
// and opening there), 활동 (what is happening now, then what changed, by time, with the ways to the
// notifications, 작업 현황 and 보관함) and 볼트 (the read-only Obsidian vault, as it was).

function Head({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="nav-head">
      <h2 className="nav-title">{title}</h2>
      {children ? <span className="nav-head-tools">{children}</span> : null}
    </div>
  );
}

/** skin 2: an empty list says what is empty in one line and offers the one thing to do (rule k1). */
export function ListEmpty({ line, action, onAction }: { line: string; action?: string; onAction?: (anchor: HTMLButtonElement) => void }) {
  return (
    <div className="nav-empty" role="status">
      <p>{line}</p>
      {action && onAction ? <button type="button" className="ghost-button small nav-empty-action" onClick={(event) => onAction(event.currentTarget)}>{action}</button> : null}
    </div>
  );
}

/** ↑↓ through a list's rows. */
function stepKey(event: ReactKeyboardEvent<HTMLElement>) {
  if (typeAhead(event)) { event.preventDefault(); return true; }
  const rows = [...(event.currentTarget.closest(".nav-level")?.querySelectorAll<HTMLElement>(LIST_STOP) ?? [])];
  const at = rows.indexOf(event.currentTarget);
  const next = event.key === "ArrowDown" ? rows[at + 1] : event.key === "ArrowUp" ? rows[at - 1] : event.key === "Home" ? rows[0] : event.key === "End" ? rows.at(-1) : undefined;
  if (!next) return false;
  event.preventDefault();
  next.focus();
  next.scrollIntoView({ block: "nearest" });
  return true;
}

type Groups<T> = { key: string; label: string; items: T[] }[];
function byDate<T>(items: T[], at: (item: T) => number): Groups<T> {
  const now = Date.now();
  const out: Groups<T> = [];
  for (const item of items) {
    const group = dateGroup(at(item), now);
    const last = out.at(-1);
    if (last && last.key === group.key) last.items.push(item);
    else out.push({ ...group, items: [item] });
  }
  return out;
}

// ── 문서 ───────────────────────────────────────────────────────────────────────────────────

/** Rows a long list shows before "N개 더 보기" (tech review P1: the 문서 list and each level-2 section). */
export const LIST_SHOWN = 100;

/**
 * The first `limit` of `rows`, plus the row on screen if it is further down (the current row is always
 * shown), and how many stay behind "N개 더 보기".
 */
export function capRows<T>(rows: T[], limit: number, all: boolean, keep: (row: T) => boolean): { shown: T[]; hidden: number } {
  if (all || rows.length <= limit) return { shown: rows, hidden: 0 };
  const shown = rows.slice(0, limit);
  const kept = rows.slice(limit).find(keep);
  if (kept) shown.push(kept);
  return { shown, hidden: rows.length - shown.length };
}

/**
 * "대화 180개 더 보기" under a list cut short (re-review 1, next round 4): it says what it shows, ↑↓ Home End
 * reach it as a row, and once pressed the focus goes to the first row it brought (not to BODY with the key).
 */
export function MoreRows({ what, hidden, onShow, onKey }: { what: string; hidden: number; onShow: () => void; onKey?: (event: ReactKeyboardEvent<HTMLElement>) => void }) {
  if (!hidden) return null;
  return (
    <button type="button" className="text-button nav-more" data-list-more="" onKeyDown={onKey ?? ((event) => { stepKey(event); })}
      onClick={(event) => {
        const level = event.currentTarget.closest(".nav-level");
        const before = new Set(level?.querySelectorAll("[data-list-row]") ?? []);
        const hadFocus = event.currentTarget === document.activeElement;
        flushSync(onShow);
        if (!hadFocus) return;
        const first = [...(level?.querySelectorAll<HTMLElement>("[data-list-row]") ?? [])].find((row) => !before.has(row));
        first?.focus();
        first?.scrollIntoView?.({ block: "nearest" });
      }}>
      {what} {hidden}개 더 보기
    </button>
  );
}

/** For tests: how many times a 문서 row rendered (a state change must not re-render unchanged rows). */
export const docRowRenders = { count: 0 };

type DocRowHandlers = {
  open: (artifact: Artifact, event?: { ctrlKey: boolean; metaKey: boolean; button: number }) => void;
  openRight: (artifact: Artifact) => void;
  menu: (artifact: Artifact, work: Work, x: number, y: number) => void;
};

const DocRow = memo(function DocRow({ artifact, work, current, handlers }: { artifact: Artifact; work: Work; current: boolean; handlers: { current: DocRowHandlers } }) {
  docRowRenders.count += 1;
  return (
    <div
      role="listitem"
      tabIndex={0}
      className={`side-row nav-doc-row${current ? " current" : ""}`}
      data-row-id={artifact.id}
      data-list-row=""
      title={`${artifact.name}\n${work.title}, ${shortDate(artifact.updatedAt)}\n${artifact.path}`}
      aria-label={`${artifact.name}, ${docKind(artifact.name, artifact.format)}, ${work.title}`}
      onClick={(event) => handlers.current.open(artifact, event)}
      onAuxClick={(event) => event.button === 1 && handlers.current.openRight(artifact)}
      onContextMenu={(event) => { event.preventDefault(); handlers.current.menu(artifact, work, event.clientX, event.clientY); }}
      onKeyDown={(event) => {
        if (stepKey(event)) return;
        if (event.key === "Enter") { event.preventDefault(); handlers.current.open(artifact); }
        else if ((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu") { event.preventDefault(); const box = event.currentTarget.getBoundingClientRect(); handlers.current.menu(artifact, work, box.left + 24, box.bottom - 4); }
      }}
    >
      <ItemIcon kind={artifactKind(artifact)} size={16} className="side-row-icon" />
      <span className="side-row-label">{artifact.name}</span>
      {/* One trailing fact: the project it opens in (its kind is in the name and the tooltip). */}
      <span className="side-row-trail"><span className="nav-owner"><ItemIcon kind="project" size={12} /><span>{work.title}</span></span></span>
    </div>
  );
});

export function DocsList({ shared }: { shared: NavShared }) {
  const { state, actions } = shared;
  const [query, setQuery] = useState("");
  const [fieldOpen, setFieldOpen] = useState(false);
  const [all, setAll] = useState(false);
  const showField = fieldOpen || Boolean(query);
  // Recomputed only when the documents or the projects change (a streamed reply changes sessions only).
  const docs = useMemo(() => {
    const out: { artifact: Artifact; work: Work }[] = [];
    for (const artifact of Object.values(state.artifacts)) {
      if (artifact.role === "project-note") continue;
      const work = state.works[artifact.workId];
      if (!work || workHidden(state, work)) continue;
      out.push({ artifact, work });
    }
    return out.sort((a, b) => b.artifact.updatedAt - a.artifact.updatedAt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.artifacts, state.works, state.folders]);
  // The documents' AIs, once per change of the sessions (not one scan of every session per row).
  const agents = useMemo(() => {
    const map = new Map<string, Session[]>();
    for (const session of Object.values(state.sessions)) {
      const id = session.documentAgent?.artifactId;
      if (!id || session.archivedAt) continue;
      map.set(id, [...(map.get(id) ?? []), session]);
    }
    return map;
  }, [state.sessions]);
  const text = query.trim().toLocaleLowerCase("ko");
  // Finding searches ALL documents, not only the rows shown.
  const found = useMemo(() => (text ? docs.filter(({ artifact, work }) => `${artifact.name} ${work.title}`.toLocaleLowerCase("ko").includes(text)) : docs), [docs, text]);
  const { shown, hidden } = capRows(found, LIST_SHOWN, all, (entry) => entry.artifact.id === shared.currentDocId);
  const docRow = (artifact: Artifact, work: Work): Extract<Row, { type: "doc" }> => ({ type: "doc", id: artifact.id, depth: 0, artifact, work, agents: agents.get(artifact.id) ?? [] });
  // Stable handlers for the memoised rows: they read the latest props through a ref.
  const handlers = useRef<DocRowHandlers>(null as unknown as DocRowHandlers);
  handlers.current = {
    open: (artifact, event) => {
      if (event && sideClick(event) && actions.openRight) return actions.openRight({ kind: "doc", id: artifact.id });
      actions.openDoc(artifact);
    },
    openRight: (artifact) => actions.openRight?.({ kind: "doc", id: artifact.id }),
    menu: (artifact, work, x, y) => shared.rowMenu(docRow(artifact, work), x, y),
  };
  return (
    <div className="nav-level nav-docs" data-level="docs">
      <Head title="문서">
        <button type="button" className={`icon-button small nav-find${showField ? " pressed" : ""}`} aria-label="문서 찾기" aria-expanded={showField} title="문서·프로젝트 이름 찾기 (Ctrl+F)" onClick={() => setFieldOpen(!showField)}>
          <Icon name="search" size={16} />
        </button>
      </Head>
      {showField ? <label className="nav-field">
        <Icon name="search" size={14} />
        <input autoFocus={fieldOpen} value={query} placeholder="문서·프로젝트 이름 찾기" aria-label="문서 찾기" spellCheck={false} onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (query) setQuery(""); else setFieldOpen(false); } else if (event.key === "ArrowDown") { event.preventDefault(); event.currentTarget.closest(".nav-level")?.querySelector<HTMLElement>("[data-list-row]")?.focus(); } }} />
      </label> : null}
      <div className="nav-scroll side-scroll" role="list" aria-label="모든 프로젝트의 문서">
        {byDate(shown, (entry) => entry.artifact.updatedAt).map((group) => (
          <div key={group.key} role="none">
            <div className="nav-group" role="presentation"><span>{group.label}</span><span className="nav-count">{group.items.length}</span></div>
            {group.items.map(({ artifact, work }) => <DocRow key={artifact.id} artifact={artifact} work={work} current={artifact.id === shared.currentDocId} handlers={handlers} />)}
          </div>
        ))}
        <MoreRows what="문서" hidden={hidden} onShow={() => setAll(true)} />
        {!found.length ? (text ? <ListEmpty line="찾는 이름의 문서가 없습니다." action="찾기 지우기" onAction={() => setQuery("")} /> : <ListEmpty line="아직 문서가 없습니다." action="새 문서 만들기" onAction={(anchor) => { const box = anchor.getBoundingClientRect(); if (actions.creationMenu) actions.creationMenu(shared.currentWorkId ? state.works[shared.currentWorkId] ?? null : null, box.left, box.bottom); else actions.newSession({}); }} />) : null}
      </div>
    </div>
  );
}

// ── 활동 ───────────────────────────────────────────────────────────────────────────────────

type Entry = { kind: "session"; session: Session; work: Work; at: number } | { kind: "doc"; artifact: Artifact; work: Work; at: number };

export function ActivityList({ shared }: { shared: NavShared }) {
  const { state, actions, nav } = shared;
  const entries = useMemo(() => {
    const out: Entry[] = [];
    for (const session of Object.values(state.sessions)) {
      if (sessionHidden(state, session) || session.documentAgent) continue;
      out.push({ kind: "session", session, work: state.works[session.workId]!, at: session.previewAt ?? session.updatedAt });
    }
    for (const artifact of Object.values(state.artifacts)) {
      const work = state.works[artifact.workId];
      if (artifact.role === "project-note" || !work || workHidden(state, work)) continue;
      out.push({ kind: "doc", artifact, work, at: artifact.updatedAt });
    }
    return out.sort((a, b) => b.at - a.at).slice(0, 40);
  }, [state]);
  const folded = Boolean(nav.sections.history);
  const link = (icon: IconName, label: string, run: (() => void) | undefined, count?: number) =>
    run ? (
      <button type="button" className="side-row nav-link-row" data-list-row="" onClick={run} onKeyDown={(event) => stepKey(event)}>
        <Icon name={icon} size={15} className="side-row-icon" />
        <span className="side-row-label">{label}</span>
        {count ? <span className="side-row-trail"><span className="nav-count">{count}</span></span> : null}
      </button>
    ) : null;
  const open = (entry: Entry, event?: { ctrlKey: boolean; metaKey: boolean; button: number }) => {
    if (entry.kind === "session") {
      if (event && sideClick(event) && actions.openRight) return actions.openRight({ kind: "session", id: entry.session.id });
      return actions.openSession(entry.session);
    }
    if (event && sideClick(event) && actions.openRight) return actions.openRight({ kind: "doc", id: entry.artifact.id });
    actions.openDoc(entry.artifact);
  };
  return (
    <div className="nav-level nav-activity" data-level="activity">
      <Head title="활동">
        {actions.openHomeView ? (
          <button type="button" className="icon-button small nav-calendar" aria-label="달력으로 보기" title="달력으로 보기: 날짜별 대화와 문서 (흐름)" onClick={() => actions.openHomeView!("flow")}>
            <Icon name="calendar" size={16} />
          </button>
        ) : null}
      </Head>
      <div className="nav-scroll side-scroll">
        <div className="nav-links">
          {link("bell", "알림", actions.openNotifications, shared.unreadNotices)}
          {link("run", "작업 현황", actions.openTasks)}
          {link("archive", "보관함", actions.openArchive)}
        </div>
        <NowSection shared={shared} />
        <section className="side-section nav-history" aria-label="기록">
          <SectionHead id="history" label="기록" shared={shared} count={entries.length || undefined} />
          {!folded && !entries.length ? <ListEmpty line="아직 기록이 없습니다." action="새 대화" onAction={() => actions.newSession({})} /> : null}
          {folded ? null : byDate(entries, (entry) => entry.at).map((group) => (
            <div key={group.key} role="none">
              <div className="nav-group" role="presentation"><span>{group.label}</span></div>
              {group.items.map((entry) => {
                const id = entry.kind === "session" ? entry.session.id : entry.artifact.id;
                const said = entry.kind === "session" ? sessionState(entry.session, shared.visibleSessionId) : null;
                const label = entry.kind === "session" ? entry.session.purpose : entry.artifact.name;
                return (
                  <div
                    key={`${entry.kind}:${id}`}
                    role="button"
                    tabIndex={0}
                    className={`side-row nav-history-row${id === shared.visibleSessionId || id === shared.currentDocId ? " current" : ""}`}
                    data-list-row=""
                    data-history-id={id}
                    title={`${label}\n${entry.work.title}, ${shortDate(entry.at)}${said ? `\n${said.word}` : ""}`}
                    aria-label={`${label}${said ? `, ${said.word}` : ""}, ${entry.work.title}`}
                    onClick={(event) => open(entry, event)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      if (entry.kind === "session") shared.rowMenu({ type: "session", id, depth: 0, session: entry.session, work: entry.work }, event.clientX, event.clientY);
                    }}
                    onKeyDown={(event) => { if (stepKey(event)) return; if (event.key === "Enter") { event.preventDefault(); open(entry); } }}
                  >
                    {entry.kind === "session" ? <StateMark state={said} /> : <ItemIcon kind={artifactKind(entry.artifact)} size={16} className="side-row-icon" />}
                    <span className="side-row-label">{label}</span>
                    {/* One trailing fact: the state word while it asks, fails, runs or answered anew; else the project. */}
                    <span className="side-row-trail">
                      {said && said.id !== "done" ? <span className={`row-state tone-${said.tone}`}>{said.word}</span> : <span className="nav-owner"><ItemIcon kind="project" size={12} /><span>{entry.work.title}</span></span>}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}

// ── 지금 (the rail's first place, lit while home's 지금 is on screen) ────────────────────────────
/** What 지금 means for navigation: the conversations that need the person, run, or have a new answer
 *  (rowState, one derivation), grouped by project — the most pressing project first. Home beside it
 *  holds the table; the list is the way to each of them. Opening one leaves 지금 (the rail then lights
 *  the place of what is on screen). */
export function NowList({ shared, onProjects }: { shared: NavShared; onProjects: () => void }) {
  const { state, actions, visibleSessionId } = shared;
  const groups = useMemo(() => {
    const now = nowSessions(state, visibleSessionId);
    const seen = new Set<string>();
    const rows = [...now.attention, ...now.running, ...now.unseen].filter((session) => (seen.has(session.id) ? false : (seen.add(session.id), true)));
    const byWork = new Map<string, { work: Work; sessions: Session[] }>();
    for (const session of rows) {
      const work = state.works[session.workId];
      if (!work) continue;
      const entry = byWork.get(work.id) ?? { work, sessions: [] };
      entry.sessions.push(session);
      byWork.set(work.id, entry);
    }
    // The order inside is the order of precedence (확인 필요 › 실패 › 진행 중 › 새 답), then the newest.
    return [...byWork.values()];
  }, [state, visibleSessionId]);
  const total = groups.reduce((sum, group) => sum + group.sessions.length, 0);
  return (
    <div className="nav-level nav-now" data-level="now">
      {/* The place's name 지금 is the rail's, the page's head's and the tab's (ruling 3): the column names what it lists. */}
      <Head title="챙길 대화" />
      <div className="nav-scroll side-scroll">
        {!total ? <ListEmpty line="지금 확인하거나 기다릴 대화가 없습니다." action="프로젝트 보기" onAction={onProjects} /> : null}
        {groups.map((group) => (
          <section key={group.work.id} className="side-section nav-now-group" aria-label={`${group.work.title} ${group.sessions.length}`}>
            <div className="nav-group" role="presentation"><span>{group.work.title}</span><span className="nav-count">{group.sessions.length}</span></div>
            {group.sessions.map((session) => {
              const said = sessionState(session, visibleSessionId);
              return (
                <div
                  key={session.id}
                  role="button"
                  tabIndex={0}
                  className={`side-row nav-now-row${session.id === visibleSessionId ? " current" : ""}`}
                  data-list-row=""
                  data-row-id={session.id}
                  title={`${session.purpose}\n${group.work.title}${said ? `, ${said.word}` : ""}`}
                  aria-label={`${session.purpose}${said ? `, ${said.word}` : ""}, ${group.work.title}`}
                  onClick={(event) => (sideClick(event) && actions.openRight ? actions.openRight({ kind: "session", id: session.id }) : actions.openSession(session))}
                  onContextMenu={(event) => { event.preventDefault(); shared.rowMenu({ type: "session", id: session.id, depth: 0, session, work: group.work }, event.clientX, event.clientY); }}
                  onKeyDown={(event) => { if (stepKey(event)) return; if (event.key === "Enter") { event.preventDefault(); actions.openSession(session); } }}
                >
                  <StateMark state={said} />
                  <span className="side-row-label">{session.purpose}</span>
                  <span className="side-row-trail">{said ? <span className={`row-state tone-${said.tone}`}>{said.word}</span> : null}</span>
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}

// ── 볼트 ───────────────────────────────────────────────────────────────────────────────────

export function VaultList({ shared }: { shared: NavShared }) {
  return (
    <div className="nav-level nav-vault" data-level="vault">
      <Head title="볼트"><span className="nav-meta" title="옵시디언 볼트를 읽기만 합니다. 원본을 만들거나 고치지 않습니다.">읽기 전용 원본</span></Head>
      <div className="nav-scroll side-scroll">
        <VaultSection theme={shared.theme} openMenu={shared.actions.openMenu} />
        <div className="nav-vault-note">볼트를 연결하거나 바꾸는 것은 설정 › 볼트에서 합니다.</div>
      </div>
    </div>
  );
}
