import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  FORMAT_LABEL,
  PROVIDER_LABEL,
  isUnseen,
  readHomeViews,
  type Artifact,
  type GroupRule,
  type HomeView,
  type HomeViewMode,
  type HomeViews,
  type ModeViews,
  type Provider,
  type Session,
  type TranscriptItem,
  type Work,
} from "@workbench/contracts";
import type { Api } from "../api.ts";
import type { State } from "../state.ts";
import { accentStyle, useAppearance } from "../appearance.ts";
import { ago, statusText, statusTone } from "../format.ts";
import { measure, play, type FlipFirst } from "../flip.ts";
import { boardOf, colorOf, foldKey, groupItems, localDay, nestGroups, sortItems, type Group, type KeyDef } from "../groups.ts";
import { HOME_MODES, bucketOf, docEntries, heldCount, isWorking, lastExchange, nowGroups, recentWorks, resumeSessions, type DocEntry, type HomeMode } from "../overview.ts";
import { projectMatcher, queryProject } from "../project-query.ts";
import { sessionHidden } from "../tree.ts";
import { thumbOf, type Thumb } from "../thumbs.ts";
import { FormatBadge } from "./DocCards.tsx";
import { EngineMark } from "./EngineMark.tsx";
import { Icon } from "./Icon.tsx";
import { ModeBar } from "./ModeBar.tsx";
import { ProjectsMode } from "./project/ProjectsMode.tsx";
import { foldedReply } from "./docs/ConversationDrawer.tsx";
import { FlowMode, type FlowLens } from "./FlowMode.tsx";
import { useOptionalPkm } from "./pkm/PkmContext.tsx";
import { DEFAULT_DOC_FIELDS, DOC_FIELDS, docKeys, docSorts, projectKeys, projectQuery, projectRows, propertyKey, sessionKeys, sessionSorts, type ProjectRow } from "./views/keys.ts";
import { GroupBoard, GroupSections } from "./views/layouts.tsx";
import { GroupHead, More, groupStyle, lookProps, toggleFold, usePaint } from "./views/parts.tsx";
import { WorkCard, useWorkContents } from "./views/ProjectBits.tsx";
import { useProjectData } from "./views/useProjectData.ts";
import { ViewHead, ViewTabs, ViewTools, type ShownGroups } from "./views/ViewHead.tsx";
import "../styles/views.css";
import "../styles/groups.css";

// Home overview modes: 지금 · 프로젝트 · 흐름 · 문서, one bar at the bottom, keys 1–4. The same
// sessions, works and documents along four axes; each mode has named views (tabs) that group,
// sort, filter and colour them the person's way (프로젝트-내비게이터-그룹보기-설계 §3). Switching
// keeps things in place (FLIP) and keeps what was being read where it was. Lists are capped with
// "더 보기", so a hundred sessions stay quick.

type Open = {
  /** With a request's item id ("흐름"), the conversation opens there. */
  session: (session: Session, itemId?: string) => void;
  work: (work: Work) => void;
  doc: (artifactId: string) => void;
};

/** How a session is doing, in a word or two. */
function stateLabel(session: Session) {
  if (session.status === "awaitingApproval") return "확인 필요";
  if (session.status === "error") return "오류";
  const working = isWorking(session);
  if (!working && session.lastError) return "실패";
  if (!working && heldCount(session)) return `남겨 둔 요청 ${heldCount(session)}`;
  if (working) return "진행 중";
  if (isUnseen(session)) return "새 답";
  if (session.queued.length) return `예약 ${session.queued.length}`;
  return ago(session.previewAt ?? session.updatedAt);
}

/** The line under a session's name: what it does now, what went wrong, or the start of its last reply. */
function lineOf(session: Session) {
  if (isWorking(session) || session.status === "awaitingApproval") return statusText(session);
  if (session.lastError) return `오류: ${session.lastError}`;
  const held = session.queued.find((entry) => entry.held);
  if (held) return `남겨 둔 요청: ${held.text}`;
  return session.preview ?? "아직 답이 없습니다";
}

/** The last request and reply of a session, the reply folded to its points (textfold, no model). */
function LastReply({ api, state, session }: { api: Api; state: State; session: Session }) {
  const loaded = state.transcripts[session.id]?.items;
  const [items, setItems] = useState<TranscriptItem[] | null>(loaded ?? null);
  const [error, setError] = useState<string | null>(null);
  const [whole, setWhole] = useState(false);
  useEffect(() => {
    if (loaded) return setItems(loaded);
    let active = true;
    api
      .items(session.id)
      .then((result) => active && setItems(result.items))
      .catch((reason: Error) => active && setError(reason.message));
    return () => {
      active = false;
    };
  }, [api, session.id, session.previewAt, loaded]);
  if (error) return <div className="home-reply muted">{error}</div>;
  if (!items) return <div className="home-reply muted">불러오는 중…</div>;
  const { request, answer } = lastExchange(items as { kind: string; text?: string }[]);
  const approvals = items.filter((item) => item.kind === "approval" && item.decision === null);
  const folded = answer ? foldedReply(answer) : null;
  return (
    <div className="home-reply">
      {approvals.map((item) =>
        item.kind === "approval" ? (
          <div key={item.id} className="home-reply-approval">
            <strong>{item.title}</strong>
            {item.detail ? <code>{item.detail}</code> : null}
          </div>
        ) : null,
      )}
      {request ? (
        <div className="home-reply-request" title={request}>
          <span className="drawer-label">요청</span> {request.split("\n").find((line) => line.trim()) ?? request}
        </div>
      ) : null}
      {answer ? (
        <div className="home-reply-answer">
          <div className="markdown">
            <Markdown remarkPlugins={[remarkGfm]}>{folded && !whole ? folded : answer}</Markdown>
          </div>
          {folded ? (
            <button type="button" className="link" onClick={() => setWhole(!whole)}>
              {whole ? "요점만" : "답 전체"}
            </button>
          ) : null}
        </div>
      ) : (
        <div className="muted">{isWorking(session) ? `${PROVIDER_LABEL[session.provider]}가 ${statusText(session)}…` : "아직 답이 없습니다."}</div>
      )}
    </div>
  );
}

/** One session as a line; the chevron opens its last reply in place. */
function SessionRow({ api, state, session, open }: { api: Api; state: State; session: Session; open: Open }) {
  const { lookOf } = useAppearance();
  const [expanded, setExpanded] = useState(false);
  const work = state.works[session.workId];
  return (
    <div className={`home-row${expanded ? " expanded" : ""}`} data-flip={`s:${session.id}`} style={accentStyle(lookOf(session.provider))}>
      <div className="home-row-line">
        <button type="button" className="home-session" onClick={() => open.session(session)} title={`${session.purpose} · ${PROVIDER_LABEL[session.provider]}`}>
          <EngineMark provider={session.provider} size={15} />
          <span className="home-session-main">
            <span className="home-session-title">
              {work ? <span className="home-session-work">{work.title}</span> : null}
              {session.purpose}
            </span>
            <span className="home-session-preview">{lineOf(session)}</span>
          </span>
          <span className={`home-session-state tone-${statusTone(session)}`}>{stateLabel(session)}</span>
        </button>
        <button
          type="button"
          className="icon-button small home-row-toggle"
          aria-expanded={expanded}
          aria-label={expanded ? "접기" : "마지막 답 보기"}
          title={expanded ? "접기" : "마지막 답 보기"}
          onClick={() => setExpanded(!expanded)}
        >
          <Icon name={expanded ? "chevronUp" : "chevronDown"} size={14} />
        </button>
      </div>
      {expanded ? <LastReply api={api} state={state} session={session} /> : null}
    </div>
  );
}

/** A mode's current view, and a way to change it (saved at once). */
function useModeView(views: ModeViews, onViews: (next: ModeViews) => void) {
  const view = views.views.find((entry) => entry.id === views.current) ?? views.views[0]!;
  const setView = useCallback((next: HomeView) => onViews({ ...views, views: views.views.map((entry) => (entry.id === next.id ? next : entry)) }), [views, onViews]);
  return [view, setView] as const;
}

const keyChoices = <T,>(keys: KeyDef<T>[]) => keys.map((entry) => ({ key: entry.key, label: entry.label, dated: entry.kind === "date" || entry.kind === "past" }));

/** The groups on screen, for the colours in "모양". */
const shownOf = <T,>(def: KeyDef<T> | null, groups: Group<T>[]): ShownGroups[] => (def ? [{ key: def.key, label: def.label, list: groups.map((group) => ({ id: group.id, label: group.label, color: group.color })) }] : []);

/** A view's filter over projects (the shared query); words also find the session's or document's own name. */
function useProjectFilter(api: Api, state: State, filter: string) {
  const on = Boolean(filter.trim());
  const data = useProjectData(api, state, on);
  const matcher = useMemo(() => projectMatcher(filter), [filter]);
  return useCallback(
    (work: Work | undefined, name: string) => {
      if (!on) return true;
      if (!work) return false;
      const project = queryProject(work, data.summaries.get(work.id), state.folders);
      return matcher({ ...project, title: `${work.title} ${name}` });
    },
    [on, data.summaries, matcher, state.folders],
  );
}

const STATUS_KEY = "status";
const CAP = 8;

/** A list of sessions cut short, "N개 더 보기" for the rest. */
function SessionList({ api, state, sessions, open, cap = CAP }: { api: Api; state: State; sessions: Session[]; open: Open; cap?: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? sessions : sessions.slice(0, cap);
  return (
    <>
      {shown.map((session) => (
        <SessionRow key={session.id} api={api} state={state} session={session} open={open} />
      ))}
      <More hidden={sessions.length - shown.length} onMore={() => setAll(true)} />
    </>
  );
}

/** What "지금" lists when grouped another way: what waits, then recent replies. */
function nowItems(state: State): Session[] {
  const live = Object.values(state.sessions).filter((session) => !sessionHidden(state, session));
  const waiting = live.filter((session) => bucketOf(session));
  const recent = live
    .filter((session) => !bucketOf(session) && session.previewAt)
    .sort((a, b) => (b.previewAt ?? 0) - (a.previewAt ?? 0))
    .slice(0, 24);
  return [...waiting, ...recent];
}

/**
 * "지금": what waits for the user. Its first view is today's screen — waiting sessions by state in
 * order, then where to pick up and the latest works; other views group the same sessions (and
 * recent replies) by folder, project or engine, as a list or a board.
 */
function NowMode({ api, state, open, views, onViews }: { api: Api; state: State; open: Open; views: ModeViews; onViews: (next: ModeViews) => void }) {
  const [view, setView] = useModeView(views, onViews);
  const { paint, panel } = usePaint(view, setView);
  const pkm = useOptionalPkm();
  const { lookOf } = useAppearance();
  const claude = lookOf("claude").palette.accent;
  const codex = lookOf("codex").palette.accent;
  const engineColor = useCallback((provider: Provider) => (provider === "claude" ? claude : codex), [claude, codex]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const keys = useMemo(() => sessionKeys(state, engineColor), [state.folders, state.works, engineColor]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sorts = useMemo(() => sessionSorts(state), [state.works]);
  const passes = useProjectFilter(api, state, view.filter);
  const keep = (session: Session) => passes(state.works[session.workId], session.purpose);
  const groupDef = keys.find((entry) => entry.key === view.group?.key) ?? null;
  const subDef = groupDef ? (keys.find((entry) => entry.key === view.subgroup?.key) ?? null) : null;
  const today = localDay(Date.now());
  const [marking, setMarking] = useState(false);
  // "모두 읽음" (from the former "보드"): every new answer in the group marked read.
  const markAll = (sessions: Session[]) => {
    setMarking(true);
    void Promise.all(sessions.map((session) => api.updateSession(session.id, { seen: true }).catch(() => undefined))).finally(() => setMarking(false));
  };
  const { sessions: sessionsOf, docs: docsOf, pending } = useWorkContents(state);
  const head = (shown: ShownGroups[]) => (
    <ViewHead
      tabs={<ViewTabs mode="now" views={views} onViews={onViews} />}
      tools={<ViewTools mode="now" view={view} onView={setView} groupKeys={keyChoices(keys)} sortKeys={sorts.map((entry) => ({ key: entry.key, label: entry.label, dated: entry.key === "activity" }))} groups={shown} filterHint="이름 · #태그 · 단계:진행중 · 폴더:이름" />}
    />
  );

  // Today's screen: by state, newest first in each, then "이어서 하기" and the latest works.
  const asToday = view.layout === "list" && (!view.group || view.group.key === STATUS_KEY) && !view.subgroup;
  if (asToday) {
    const groups = nowGroups(state)
      .map((group) => ({ ...group, sessions: group.sessions.filter(keep) }))
      .filter((group) => group.sessions.length);
    const ordered = view.group?.reverse ? [...groups].reverse() : groups;
    const listed = new Set(groups.flatMap((group) => group.sessions.map((session) => session.id)));
    const resume = resumeSessions(state, listed).filter(keep);
    const works = recentWorks(state).filter((work) => passes(work, ""));
    const look = lookProps(view.look);
    // The states' own colours show once the view's look is on (or a colour is picked): the default stays as plain as before.
    const lit = view.look.border || view.look.heading || view.look.tint > 0;
    const known = keys.find((entry) => entry.key === STATUS_KEY)!.known!;
    return (
      <div className="now-mode">
        {head([{ key: STATUS_KEY, label: "상태", list: known.filter((entry) => groups.some((group) => group.bucket === entry.id)).map((entry) => ({ id: entry.id, label: entry.label, color: entry.color ?? null })) }])}
        <div className={`home-board ${look.className}`} style={look.style}>
          {ordered.map((group) => {
            const base = known.find((entry) => entry.id === group.bucket)?.color ?? null;
            const picked = view.look.colors[`${STATUS_KEY}=${group.bucket}`] ?? null;
            const color = picked ?? (lit ? base : null);
            const fold = foldKey(STATUS_KEY, group.bucket);
            const folded = view.collapsed.includes(fold);
            return (
              <section key={group.bucket} className={`home-section bucket-${group.bucket} group-section${color ? " has-color" : ""}${folded ? " folded" : ""}`} style={groupStyle(color)} aria-label={group.label}>
                <GroupHead
                  className="section-label"
                  label={group.label}
                  count={group.sessions.length}
                  color={color}
                  folded={folded}
                  onToggle={() => setView(toggleFold(view, fold))}
                  onPaint={(x, y) => paint(STATUS_KEY, { id: group.bucket, label: group.label, color: base }, x, y)}
                >
                  {group.bucket === "unseen" && group.sessions.length ? (
                    <button type="button" className="text-button board-action" disabled={marking} onClick={() => markAll(group.sessions)} title="새 답을 모두 읽음으로 표시합니다">
                      모두 읽음
                    </button>
                  ) : null}
                </GroupHead>
                {folded ? null : <SessionList api={api} state={state} sessions={group.sessions} open={open} />}
              </section>
            );
          })}
          {!groups.length ? <p className="home-quiet">{view.filter.trim() ? "거르기에 맞는, 기다리는 일이 없습니다." : "지금 기다리는 일은 없습니다."}</p> : null}
          {resume.length ? (
            <section className="home-section" aria-label="이어서 하기">
              <h2 className="section-label">이어서 하기</h2>
              {resume.map((session) => (
                <SessionRow key={session.id} api={api} state={state} session={session} open={open} />
              ))}
            </section>
          ) : null}
          {works.length ? (
            <section className="home-section" aria-label="작업">
              <h2 className="section-label">작업</h2>
              <div className="home-works">
                {works.map((work) => (
                  <WorkCard
                    key={work.id}
                    state={state}
                    work={work}
                    sessions={sessionsOf(work.id)}
                    docs={docsOf(work.id)}
                    pending={pending}
                    stages={[]}
                    fields={["folder", "sessions", "activity"]}
                    open={{ session: open.session, doc: open.doc, project: open.work }}
                  />
                ))}
              </div>
            </section>
          ) : null}
        </div>
        {panel}
      </div>
    );
  }

  // Grouped another way: the sessions waiting and the recent replies.
  const items = nowItems(state).filter(keep);
  const sortRule = view.sort ?? ({ key: "activity", dir: "desc" } as const);
  const ordered = sortItems(items, sorts.find((entry) => entry.key === sortRule.key) ?? null, sortRule.dir, (session) => session.purpose);
  const rule: GroupRule | null = view.group ?? (view.layout === "board" ? { key: STATUS_KEY } : null);
  const def = groupDef ?? (view.layout === "board" ? keys[0]! : null);
  if (view.layout === "board" && def) {
    const board = boardOf(ordered, def, rule, subDef, view.subgroup, today);
    // The state, the engine and the project are the sessions' own: nothing on this board is dragged.
    const fixed = () => def.fixed ?? subDef?.fixed ?? null;
    return (
      <div className="now-mode">
        {head([...shownOf(def, board.columns), ...shownOf(subDef, board.lanes ?? [])])}
        <GroupBoard
          view={view}
          onView={setView}
          paint={paint}
          board={board}
          colKey={def.key}
          laneKey={subDef?.key ?? null}
          itemId={(session) => session.id}
          itemAttr="session"
          itemTitle={(session) => session.purpose}
          card={(session) => <NowCard state={state} session={session} />}
          onOpen={(session) => open.session(session)}
          canMove={fixed}
          onMove={() => pkm?.onToast(fixed() ?? "")}
          cardHint="누르면 세션 열기"
        />
        {!ordered.length ? <p className="home-quiet">지금 기다리는 일은 없습니다.</p> : null}
        {panel}
      </div>
    );
  }
  const groups = def ? nestGroups(groupItems(ordered, def, rule, today), subDef, view.subgroup, today) : [{ id: "", label: "", color: null, items: ordered, depth: 0, sub: null }];
  return (
    <div className="now-mode">
      {head(shownOf(def, groups))}
      <GroupSections
        view={view}
        onView={setView}
        paint={paint}
        ruleKey={def?.key ?? ""}
        subKey={subDef?.key}
        groups={groups}
        heading={Boolean(def)}
        sectionClass="home-section"
        className="home-board"
        body={(sessions, _group, path) => <SessionList key={path} api={api} state={state} sessions={sessions} open={open} />}
      />
      {!ordered.length ? <p className="home-quiet">지금 기다리는 일은 없습니다.</p> : null}
      {panel}
    </div>
  );
}

/** A session on a board of "지금". */
function NowCard({ state, session }: { state: State; session: Session }) {
  const { lookOf } = useAppearance();
  const work = state.works[session.workId];
  return (
    <>
      <span className="now-card-head" style={accentStyle(lookOf(session.provider))}>
        <EngineMark provider={session.provider} size={13} />
        <span className="now-card-work">{work?.title ?? ""}</span>
      </span>
      <span className="kanban-card-title">{session.purpose}</span>
      <span className="kanban-card-meta">
        <span className={`home-session-state tone-${statusTone(session)}`}>{stateLabel(session)}</span>
      </span>
    </>
  );
}

/** A document's first page (or opening lines), drawn once it scrolls into view. */
function DocThumb({ api, artifact, tools }: { api: Api; artifact: Artifact; tools: State["tools"] }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [thumb, setThumb] = useState<Thumb | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || visible) return;
    const observer = new IntersectionObserver((entries) => entries.some((entry) => entry.isIntersecting) && setVisible(true), { rootMargin: "240px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible]);
  useEffect(() => {
    if (!visible) return;
    let active = true;
    void thumbOf(api, artifact, tools).then((result) => active && setThumb(result));
    return () => {
      active = false;
    };
  }, [visible, api, artifact, tools]);
  return (
    <span ref={ref} className={`doc-thumb format-${artifact.format}${thumb?.kind === "text" ? " text" : ""}`}>
      {thumb?.kind === "image" ? (
        <img src={thumb.url} alt="" loading="lazy" />
      ) : thumb?.kind === "text" ? (
        <span className="doc-thumb-text">{thumb.text || artifact.name}</span>
      ) : (
        <span className="doc-thumb-mark">
          <FormatBadge format={artifact.format} />
          {thumb ? null : <span className="spinner small" />}
        </span>
      )}
    </span>
  );
}

function DocTile({ api, state, entry, open }: { api: Api; state: State; entry: DocEntry; open: Open }) {
  return (
    <button type="button" className="doc-tile" data-flip={`d:${entry.artifact.id}`} onClick={() => open.doc(entry.artifact.id)} title={`${entry.artifact.path} · ${FORMAT_LABEL[entry.artifact.format]}`}>
      <span className="doc-tile-page">
        <DocThumb api={api} artifact={entry.artifact} tools={state.tools} />
        {entry.pending ? <span className="doc-tile-badge">수정안 {entry.pending}</span> : entry.running ? <span className="doc-tile-badge running">수정안 만드는 중</span> : null}
      </span>
      <span className="doc-tile-name">
        <FormatBadge format={entry.artifact.format} />
        <span>{entry.artifact.name}</span>
      </span>
      <span className="doc-tile-meta">
        {entry.work.title} · r{entry.artifact.revision} · {ago(entry.artifact.updatedAt)}
      </span>
    </button>
  );
}

const docCell = (field: string, entry: DocEntry, state: State): ReactNode => {
  switch (field) {
    case "project":
      return entry.work.title;
    case "folder": {
      const folder = entry.work.folderId ? state.folders[entry.work.folderId] : undefined;
      return folder?.name ?? "폴더 밖";
    }
    case "format":
      return FORMAT_LABEL[entry.artifact.format];
    case "revision":
      return `r${entry.artifact.revision}`;
    case "modified":
      return ago(entry.artifact.updatedAt);
    case "proposals":
      return entry.pending ? <span className="kanban-badge hot">수정안 {entry.pending}</span> : "";
    default:
      return "";
  }
};

function DocGrid({ api, state, entries, open, cap }: { api: Api; state: State; entries: DocEntry[]; open: Open; cap: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? entries : entries.slice(0, cap);
  return (
    <>
      <div className="docs-grid">
        {shown.map((entry) => (
          <DocTile key={entry.artifact.id} api={api} state={state} entry={entry} open={open} />
        ))}
      </div>
      <More hidden={entries.length - shown.length} onMore={() => setAll(true)} />
    </>
  );
}

function DocLines({ state, entries, open, fields }: { state: State; entries: DocEntry[]; open: Open; fields: string[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? entries : entries.slice(0, 60);
  return (
    <>
      <div className="doc-lines">
        {shown.map((entry) => (
          <button key={entry.artifact.id} type="button" className="doc-line" data-flip={`d:${entry.artifact.id}`} onClick={() => open.doc(entry.artifact.id)} title={entry.artifact.path}>
            <FormatBadge format={entry.artifact.format} />
            <span className="doc-line-name">{entry.artifact.name}</span>
            <span className="doc-line-side">
              {fields.map((field) => (
                <span key={field} className={`doc-line-field field-${field}`}>
                  {docCell(field, entry, state)}
                </span>
              ))}
            </span>
          </button>
        ))}
      </div>
      <More hidden={entries.length - shown.length} onMore={() => setAll(true)} />
    </>
  );
}

/** "문서": what was made, as first pages (today's view), or grouped by project, folder, format or when it changed. */
function DocsMode({ api, state, open, views, onViews }: { api: Api; state: State; open: Open; views: ModeViews; onViews: (next: ModeViews) => void }) {
  const [view, setView] = useModeView(views, onViews);
  const { paint, panel } = usePaint(view, setView);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const keys = useMemo(() => docKeys(state), [state.folders, state.works]);
  const sorts = useMemo(() => docSorts(), []);
  const passes = useProjectFilter(api, state, view.filter);
  const entries = docEntries(state).filter((entry) => passes(entry.work, entry.artifact.name));
  const sortRule = view.sort ?? ({ key: "modified", dir: "desc" } as const);
  const ordered = sortItems(entries, sorts.find((entry) => entry.key === sortRule.key) ?? null, sortRule.dir, (entry) => entry.artifact.name);
  const groupDef = keys.find((entry) => entry.key === view.group?.key) ?? null;
  const subDef = groupDef ? (keys.find((entry) => entry.key === view.subgroup?.key) ?? null) : null;
  const today = localDay(Date.now());
  const groups = groupDef ? nestGroups(groupItems(ordered, groupDef, view.group, today), subDef, view.subgroup, today) : [{ id: "", label: "", color: null, items: ordered, depth: 0, sub: null }];
  const waiting = entries.reduce((sum, entry) => sum + entry.pending, 0);
  const fields = view.layout === "cards" ? [] : (view.fields ?? DEFAULT_DOC_FIELDS[view.layout as "list" | "table"]);
  const subShown: Group<DocEntry>[] = [];
  for (const group of groups) for (const sub of group.sub ?? []) if (!subShown.some((entry) => entry.id === sub.id)) subShown.push(sub);
  const body = (items: DocEntry[], path: string): ReactNode =>
    view.layout === "cards" ? (
      <DocGrid key={path} api={api} state={state} entries={items} open={open} cap={groupDef ? 24 : 36} />
    ) : view.layout === "list" ? (
      <DocLines key={path} state={state} entries={items} open={open} fields={fields} />
    ) : (
      <DocTable key={path} state={state} entries={items} open={open} fields={fields} />
    );
  return (
    <div className="docs">
      <ViewHead
        tabs={<ViewTabs mode="docs" views={views} onViews={onViews} />}
        tools={
          <ViewTools
            mode="docs"
            view={view}
            onView={setView}
            groupKeys={keyChoices(keys)}
            sortKeys={sorts.map((entry) => ({ key: entry.key, label: entry.label, dated: entry.key === "modified" }))}
            fields={view.layout === "cards" ? undefined : DOC_FIELDS}
            defaultFields={view.layout === "cards" ? undefined : DEFAULT_DOC_FIELDS[view.layout as "list" | "table"]}
            groups={[...shownOf(groupDef, groups), ...shownOf(subDef, subShown)]}
            filterHint="이름 · #태그 · 단계:진행중 · 폴더:이름"
          />
        }
      />
      <div className="mode-head">
        <span className="muted">
          문서 {entries.length}
          {waiting ? ` · 검토할 수정안 ${waiting}` : ""}
        </span>
      </div>
      <GroupSections
        view={view}
        onView={setView}
        paint={paint}
        ruleKey={groupDef?.key ?? ""}
        subKey={subDef?.key}
        groups={groups}
        heading={Boolean(groupDef)}
        sectionClass="docs-section"
        body={(items, _group, path) => body(items, path || "all")}
      />
      {!entries.length ? <p className="home-quiet">{view.filter.trim() ? "거르기에 맞는 문서가 없습니다." : "아직 문서가 없습니다. 대화에서 만든 파일이나 연 문서가 여기에 모입니다."}</p> : null}
      {panel}
    </div>
  );
}

function DocTable({ state, entries, open, fields }: { state: State; entries: DocEntry[]; open: Open; fields: string[] }) {
  const label = Object.fromEntries(DOC_FIELDS.map((field) => [field.id, field.label]));
  return (
    <div className="projects-table-wrap">
      <table className="projects-table doc-table">
        <thead>
          <tr>
            <th>
              <span className="projects-th">이름</span>
            </th>
            {fields.map((field) => (
              <th key={field}>
                <span className="projects-th">{label[field]}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.artifact.id}>
              <td>
                <button type="button" className="projects-name" onClick={() => open.doc(entry.artifact.id)} title={entry.artifact.path}>
                  {entry.artifact.name}
                </button>
              </td>
              {fields.map((field) => (
                <td key={field} className={field === "modified" ? "muted" : undefined}>
                  {docCell(field, entry, state)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** "흐름": the calendar as it is, with a view's filter and its "색 기준" (the engine, or any project key). */
function FlowWithViews({ api, state, open, views, onViews }: { api: Api; state: State; open: Open; views: ModeViews; onViews: (next: ModeViews) => void }) {
  const [view, setView] = useModeView(views, onViews);
  const colorBy = view.colorBy ?? "engine";
  const wants = Boolean(view.filter.trim()) || colorBy !== "engine";
  const data = useProjectData(api, state, wants);
  const { lookOf } = useAppearance();
  const claude = lookOf("claude").palette.accent;
  const codex = lookOf("codex").palette.accent;
  const engineColor = useCallback((provider: Provider) => (provider === "claude" ? claude : codex), [claude, codex]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const keys = useMemo(() => projectKeys({ state, summaries: data.summaries, stages: data.stages, template: data.template, engineColor }), [state.folders, data.summaries, data.stages, data.template, engineColor]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rows = useMemo(() => new Map(projectRows(state, data.summaries).map((row) => [row.work.id, row] as const)), [state.works, state.sessions, state.folders, data.summaries]);
  const colorKeys = [{ key: "engine", label: "엔진" }, ...keyChoices(keys.filter((entry) => entry.key !== "engine" && entry.key !== "activity" && entry.key !== "created"))];
  const def: KeyDef<ProjectRow> | null = colorBy === "engine" ? null : (keys.find((entry) => entry.key === colorBy) ?? (colorBy.startsWith("prop:") ? propertyKey(colorBy.slice(5), "text") : null));
  const today = localDay(Date.now());
  const matcher = useMemo(() => projectMatcher(view.filter), [view.filter]);
  const filtering = Boolean(view.filter.trim());
  // A work's colour: its first group under the key, as the view paints that group.
  const colors = useMemo(() => {
    if (!def) return null;
    const out = new Map<string, string | null>();
    for (const row of rows.values()) {
      const group = groupItems([row], def, { hideEmpty: true }, today)[0];
      out.set(row.work.id, group && group.id ? colorOf(view.look, def.key, group) : null);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def?.key, rows, view.look]);
  const lens: FlowLens = useMemo(
    () => ({
      key: `${filtering ? view.filter : ""}|${colorBy}|${data.summaries.size}:${[...data.summaries.values()].map((entry) => entry.noteUpdatedAt ?? 0).join(",")}|${JSON.stringify(view.look.colors)}`,
      keep: filtering ? (work: Work) => (rows.get(work.id) ? matcher(projectQuery(rows.get(work.id)!, state.folders)) : false) : undefined,
      paint: colors ? (work: Work) => colors.get(work.id) ?? null : undefined,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filtering, view.filter, colorBy, data.summaries, colors, rows, matcher, state.folders, view.look.colors],
  );
  const shown = def ? shownOf(def, groupItems([...rows.values()].filter((row) => !row.archived), def, { hideEmpty: true }, today).filter((group) => group.id)) : [];
  return (
    <>
      <ViewHead
        tabs={<ViewTabs mode="flow" views={views} onViews={onViews} />}
        tools={<ViewTools mode="flow" view={view} onView={setView} groupKeys={[]} sortKeys={[]} colorKeys={colorKeys} groups={shown} filterHint="이름 · #태그 · 단계:진행중 · 폴더:이름 · 속성:값" />}
      />
      <FlowMode api={api} state={state} open={open} lens={lens} />
    </>
  );
}

const editable = (target: EventTarget | null) => target instanceof HTMLElement && Boolean(target.closest("input, textarea, select, [contenteditable=true], [contenteditable=''], .cm-editor"));

/** What the screen kept on this device before views (read once, when no views are saved yet). */
const legacyPrefs = () => {
  try {
    return { projectsLayout: localStorage.getItem("workbench.projectsLayout"), homeMap: localStorage.getItem("workbench.homeMap") };
  } catch {
    return {};
  }
};

/**
 * The home overview: the current mode's views and content, then `footer`, then the mode bar
 * (sticky at the bottom centre). Keys 1–4 switch modes when focus is not in a text field.
 */
export function HomeModes({
  api,
  state,
  mode,
  onMode,
  views,
  onViews,
  onOpenSession,
  onOpenWork,
  onOpenDoc,
  onOpenProject,
  footer,
}: {
  api: Api;
  state: State;
  mode: HomeMode;
  onMode: (mode: HomeMode) => void;
  /** The views kept in the screen preferences (`homeViews`), as saved. */
  views?: unknown;
  onViews?: (next: HomeViews) => void;
  /** With a request's item id ("흐름"), the conversation opens at that request. */
  onOpenSession: (session: Session, itemId?: string) => void;
  onOpenWork: (work: Work) => void;
  onOpenDoc: (artifactId: string) => void;
  /** A project's page (from "프로젝트"); its conversation when there is none. */
  onOpenProject?: (work: Work) => void;
  footer?: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const first = useRef<FlipFirst | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const open: Open = useMemo(() => ({ session: onOpenSession, work: onOpenWork, doc: onOpenDoc }), [onOpenSession, onOpenWork, onOpenDoc]);
  const scroller = () => root.current?.closest<HTMLElement>(".start-view") ?? null;
  const homeViews = useMemo(() => readHomeViews(views, legacyPrefs()), [views]);
  // Without a place to keep them (tests), views change for this window only.
  const [local, setLocal] = useState<HomeViews | null>(null);
  const shown = onViews ? homeViews : (local ?? homeViews);
  const modeViews = (name: HomeViewMode) => ({
    views: shown.modes[name],
    onViews: (next: ModeViews) => {
      const all = { ...shown, modes: { ...shown.modes, [name]: next } };
      if (onViews) onViews(all);
      else setLocal(all);
    },
  });

  const switchTo = useCallback(
    (next: HomeMode) => {
      if (next === mode) return;
      if (root.current) first.current = measure(root.current, scroller(), pointer.current);
      onMode(next);
    },
    [mode, onMode],
  );

  useLayoutEffect(() => {
    const snapshot = first.current;
    first.current = null;
    if (snapshot && root.current) play(root.current, scroller(), snapshot);
  }, [mode]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing || editable(event.target)) return;
      // Two panes may both show home: the keys belong to the one with the focus.
      if (root.current?.closest('[data-pane-active="false"]')) return;
      const index = ["1", "2", "3", "4", "5"].indexOf(event.key);
      if (index < 0 || index >= HOME_MODES.length) return;
      event.preventDefault();
      switchTo(HOME_MODES[index]!.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [switchTo]);

  return (
    <>
      <div
        ref={root}
        className={`home-modes mode-${mode}`}
        onPointerMove={(event) => {
          pointer.current = { x: event.clientX, y: event.clientY };
        }}
        onPointerLeave={() => {
          pointer.current = null;
        }}
      >
        {mode === "now" ? (
          <NowMode api={api} state={state} open={open} {...modeViews("now")} />
        ) : mode === "projects" ? (
          <ProjectsMode api={api} state={state} openProject={onOpenProject ?? onOpenWork} open={open} {...modeViews("projects")} />
        ) : mode === "flow" ? (
          <FlowWithViews api={api} state={state} open={open} {...modeViews("flow")} />
        ) : (
          <DocsMode api={api} state={state} open={open} {...modeViews("docs")} />
        )}
      </div>
      {footer}
      <ModeBar
        className="home-mode-bar"
        label="홈 보기"
        keyHint=""
        modes={HOME_MODES.map((entry) => ({ id: entry.id, label: entry.label, title: `${entry.label} — ${entry.question}` }))}
        value={mode}
        onChange={switchTo}
      />
    </>
  );
}
