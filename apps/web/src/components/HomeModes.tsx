import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { ItemIcon } from "./ItemIcon.tsx";
import { isKeptUnread } from "../kept-unread.ts";
import { failure } from "../top-notice.ts";
import Markdown from "react-markdown";
import { REMARK_BASE } from "../markdown/plugins.ts";
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
import { useAppearance } from "../appearance.ts";
import { ago, statusText, statusTone } from "../format.ts";
import { measure, play, type FlipFirst } from "../flip.ts";
import { boardOf, colorOf, foldKey, groupItems, localDay, nestGroups, sortItems, type Group, type KeyDef } from "../groups.ts";
import { Segmented } from "./ui/Hig.tsx";
import { HOME_MODES, needsCount, rowState, bucketOf, docEntries, isWorking, lastExchange, nowGroups, recency, recentWorks, resumeSessions, sessionResume, type DocEntry, type HomeMode } from "../overview.ts";
import { needsPerson, type RowStateInfo as StateInfo } from "../row-state.ts";
import { StateWord } from "./StateMark.tsx";
import { projectMatcher, queryProject } from "../project-query.ts";
import { purposeText, sessionHidden } from "../tree.ts";
import { thumbOf, type Thumb } from "../thumbs.ts";
import { FormatBadge } from "./DocCards.tsx";
import { approvalAsk, askerOf } from "./Transcript.tsx";
import { EngineMark } from "./EngineMark.tsx";
import { Icon } from "./Icon.tsx";
import { ProjectsMode } from "./project/ProjectsMode.tsx";
import { foldedReply } from "../fold-reply.ts";
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
import "../styles/now-home.css";

// Home overview modes: 지금 · 프로젝트 · 흐름 · 문서, one bar at the top, keys 1–4. The same
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

/** How a session is doing: its one state word (row-state.ts), else when it last answered. */
function stateLabel(session: Session) {
  return rowState(session)?.word ?? ago(session.previewAt ?? session.updatedAt);
}

/** The line under a session's name: what it does now, what went wrong, or the start of its last reply. */
function lineOf(session: Session) {
  return sessionResume(session).summary ?? "아직 답이 없습니다";
}

/** The last request and reply of a session, the reply folded to its points (textfold, no model). */
/** `asks`: list the approvals still open (off inside an entry, whose head and cells already say what it asks). */
function LastReply({ api, state, session, asks = true }: { api: Api; state: State; session: Session; asks?: boolean }) {
  // Behind while its items wait aside (perf G1): read from the gateway then.
  const loaded = state.aside[session.id] ? undefined : state.transcripts[session.id]?.items;
  const [items, setItems] = useState<TranscriptItem[] | null>(loaded ?? null);
  // Which answer the items on screen hold (the session's previewAt when they were read): a newer answer
  // is not "seen" until its own transcript is here and shown (tech review 4).
  const [itemsAt, setItemsAt] = useState<number | null | undefined>(loaded ? session.previewAt : undefined);
  const [error, setError] = useState<string | null>(null);
  const [whole, setWhole] = useState(false);
  useEffect(() => {
    if (loaded) { setItems(loaded); setItemsAt(session.previewAt); return; }
    let active = true;
    const asked = session.previewAt;
    api
      .items(session.id)
      .then((result) => { if (active) { setItems(result.items); setItemsAt(asked); } })
      .catch((reason: Error) => active && setError(reason.message));
    return () => {
      active = false;
    };
  }, [api, session.id, session.previewAt, loaded]);
  // An unseen answer read here is seen (re-review 1, next round 8: a web page held for it can then go) —
  // that answer, once on screen, and never one the person chose to keep unread.
  const shownAnswer = items && itemsAt === session.previewAt ? Boolean(lastExchange(items as { kind: string; text?: string }[]).answer) : false;
  const unseen = isUnseen(session) && !session.archivedAt && !isKeptUnread(session);
  useEffect(() => {
    if (shownAnswer && unseen) void api.updateSession(session.id, { seen: true }).catch(() => undefined);
  }, [api, session.id, session.previewAt, shownAnswer, unseen]);
  if (error) return <div className="home-reply muted">{error}</div>;
  if (!items) return <div className="home-reply muted">불러오는 중…</div>;
  const { request, answer } = lastExchange(items as { kind: string; text?: string }[]);
  const approvals = asks ? items.filter((item) => item.kind === "approval" && item.decision === null) : [];
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
          <span className="home-reply-label">요청</span> {request.split("\n").find((line) => line.trim()) ?? request}
        </div>
      ) : null}
      {answer ? (
        <div className="home-reply-answer">
          <div className="markdown">
            <Markdown remarkPlugins={REMARK_BASE}>{folded && !whole ? folded : answer}</Markdown>
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

/** One session as a line; the chevron opens its last reply in place. In today's ledger the section
 * head already says the state, so the line ends on its time instead (one marker a line). */
function SessionRow({ api, state, session, open, timed = false }: { api: Api; state: State; session: Session; open: Open; timed?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const work = state.works[session.workId];
  return (
    <div className={`home-row${expanded ? " expanded" : ""}`} data-flip={`s:${session.id}`}>
      <div className="home-row-line">
        <button type="button" className="home-session" onClick={() => open.session(session)} title={`${session.purpose}, ${PROVIDER_LABEL[session.provider]}`}>
          <EngineMark provider={session.provider} size={15} />
          <span className="home-session-main">
            <span className="home-session-title">
              {work ? <span className="home-session-work">{work.title}</span> : null}
              {session.purpose}
            </span>
            <span className="home-session-preview">{lineOf(session)}</span>
          </span>
          {timed ? (
            <time className="home-session-time">{ago(session.previewAt ?? session.updatedAt)}</time>
          ) : (
            <span className={`home-session-state tone-${statusTone(session)}`}>{stateLabel(session)}</span>
          )}
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

type OpenApproval = Extract<TranscriptItem, { kind: "approval" }>;

/** A plan's text as one plain line: its head lines and list marks dropped (the head already says it is a plan). */
const planLine = (text: string | null | undefined) =>
  (text ?? "").split("\n").filter((line) => line.trim() && !/^\s*#/.test(line)).map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim()).join(", ");

/** What a waiting session asks: its open approval, read from the transcript (loaded if not at hand). */
function useOpenApproval(api: Api, state: State, session: Session) {
  // Behind while its items wait aside (perf G1): read from the gateway then.
  const loaded = state.aside[session.id] ? undefined : state.transcripts[session.id]?.items;
  const [items, setItems] = useState<TranscriptItem[] | null>(loaded ?? null);
  useEffect(() => {
    if (loaded) return setItems(loaded);
    let active = true;
    api.items(session.id).then((result) => active && setItems(result.items)).catch(() => undefined);
    return () => {
      active = false;
    };
  }, [api, session.id, session.updatedAt, loaded]);
  for (let index = (items?.length ?? 0) - 1; index >= 0; index--) {
    const item = items![index]!;
    if (item.kind === "approval" && item.decision === null) return item as OpenApproval;
  }
  return null;
}

/**
 * A session that waits on the person, as an entry (작업 칸): U5's entry, with the conversation's
 * own head words ("Codex가 명령을 실행하려 합니다"), the facts as ruled cells, the keys at its foot.
 * One ink head per view: on home the first entry of the list is the one to act on next (`lead`);
 * the others wait their turn quietly ("queued"). The decision itself is taken in the conversation,
 * so home's keys stay secondary (the one filled key of the screen is send).
 */
function WaitingEntry({ api, state, session, open, lead }: { api: Api; state: State; session: Session; open: Open; lead: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const work = state.works[session.workId];
  const approval = useOpenApproval(api, state, session);
  // The conversation's own head words: a plan waits as "계획을 세웠습니다", any other approval by its title.
  const ask = approval?.plan ? { what: "계획을 세웠습니다", label: "계획", yes: "" } : approvalAsk(approval?.title ?? "");
  const detail = approval && !approval.plan ? approval.detail : null;
  const at = session.previewAt ?? session.updatedAt;
  return (
    <article className={`entry home-entry${expanded ? " expanded" : ""}`} data-kind="approval" data-state={lead ? "waiting" : "queued"} data-flip={`s:${session.id}`} aria-label={`${work ? `${work.title}, ` : ""}${session.purpose}`}>
      <header className="entry-head">
        <EngineMark provider={session.provider} size={15} />
        <span className="entry-who">{askerOf(session.provider)} {ask.what}</span>
        <time className="entry-when" dateTime={new Date(at).toISOString()}>{ago(at)}</time>
      </header>
      {approval?.plan || !approval ? <p className="entry-body home-entry-line">{approval?.plan ? planLine(approval.detail) || lineOf(session) : lineOf(session)}</p> : null}
      {/* Where first (two cells), then what (the command, the reason) on its own row. */}
      <dl className="entry-cells">
        <div className="entry-cell">
          <dt>프로젝트</dt>
          <dd>{work?.title ?? "프로젝트 밖"}</dd>
        </div>
        <div className="entry-cell">
          <dt>대화</dt>
          <dd>{session.purpose}</dd>
        </div>
        {detail ? (
          <div className="entry-cell wide">
            <dt>{ask.label}</dt>
            <dd><code className="entry-value code home-entry-detail">{detail}</code></dd>
          </div>
        ) : approval?.reason ? (
          <div className="entry-cell wide">
            <dt>할 일</dt>
            <dd>{approval.reason}</dd>
          </div>
        ) : null}
      </dl>
      {expanded ? <LastReply api={api} state={state} session={session} asks={false} /> : null}
      <div className="entry-keys">
        <span className="entry-aside">
          <button type="button" className="text-button home-row-toggle" aria-expanded={expanded} aria-label={expanded ? "접기" : "마지막 답 보기"} onClick={() => setExpanded(!expanded)}>
            <Icon name={expanded ? "chevronUp" : "chevronDown"} size={14} />
            {expanded ? "접기" : "마지막 답"}
          </button>
        </span>
        <button type="button" className="button home-entry-open" onClick={() => open.session(session)} title={`${session.purpose} 열기`}>
          열어서 확인
        </button>
      </div>
    </article>
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
function SessionList({ api, state, sessions, open, cap = CAP, timed = false }: { api: Api; state: State; sessions: Session[]; open: Open; cap?: number; timed?: boolean }) {
  const [all, setAll] = useState(false);
  const shown = all ? sessions : sessions.slice(0, cap);
  return (
    <>
      {shown.map((session) => (
        <SessionRow key={session.id} api={api} state={state} session={session} open={open} timed={timed} />
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
  const gemini = lookOf("gemini").palette.accent;
  const engineColor = useCallback((provider: Provider) => (provider === "claude" ? claude : provider === "gemini" ? gemini : codex), [claude, codex, gemini]);
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
      tools={<ViewTools mode="now" view={view} onView={setView} groupKeys={keyChoices(keys)} sortKeys={sorts.map((entry) => ({ key: entry.key, label: entry.label, dated: entry.key === "activity" }))} groups={shown} filterHint="이름, #태그, 단계:진행중, 폴더:이름" />}
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
                {folded ? null : group.bucket === "attention" ? (
                  <div className="home-entries">
                    {group.sessions.map((session, index) => (
                      <WaitingEntry key={session.id} api={api} state={state} session={session} open={open} lead={index === 0} />
                    ))}
                  </div>
                ) : (
                  <div className="home-ledger">
                    <SessionList api={api} state={state} sessions={group.sessions} open={open} timed />
                  </div>
                )}
              </section>
            );
          })}
          {groups.length ? null : view.filter.trim() ? (
            <p className="home-quiet">거르기에 맞는, 기다리는 일이 없습니다.</p>
          ) : resume.length || works.length ? (
            <p className="home-quiet">지금 기다리는 일은 없습니다.</p>
          ) : (
            <div className="home-empty" role="status">
              <h2 className="home-empty-head">아직 기다리는 일이 없습니다</h2>
              <p>아래 칸에 AI에게 맡길 일을 쓰면, 답이 오거나 확인할 일이 생길 때 여기에 차례로 모입니다.</p>
            </div>
          )}
          {resume.length ? (
            <section className="home-section" aria-label="이어서 하기">
              <h2 className="section-label">이어서 하기</h2>
              <div className="home-ledger">
                {resume.map((session) => (
                  <SessionRow key={session.id} api={api} state={state} session={session} open={open} timed />
                ))}
              </div>
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
          onMove={() => pkm?.onToast(failure(fixed() ?? ""))}
          cardHint="누르면 대화 열기"
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
  const work = state.works[session.workId];
  return (
    <>
      <span className="now-card-head">
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
    <button type="button" className="doc-tile" data-flip={`d:${entry.artifact.id}`} onClick={() => open.doc(entry.artifact.id)} title={`${entry.artifact.path}, ${FORMAT_LABEL[entry.artifact.format]}`}>
      <span className="doc-tile-page">
        <DocThumb api={api} artifact={entry.artifact} tools={state.tools} />
        {entry.pending ? <span className="doc-tile-badge">수정안 {entry.pending}</span> : entry.running ? <span className="doc-tile-badge running">수정안 만드는 중</span> : null}
      </span>
      <span className="doc-tile-name">
        <FormatBadge format={entry.artifact.format} />
        <span>{entry.artifact.name}</span>
      </span>
      <span className="doc-tile-meta">
        <span className="doc-tile-work">{entry.work.title}</span>
        <span className="doc-tile-revision">{entry.artifact.revision}판</span>
        <time>{ago(entry.artifact.updatedAt)}</time>
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
      return `${entry.artifact.revision}판`;
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
            filterHint="이름, #태그, 단계:진행중, 폴더:이름"
          />
        }
      />
      <div className="mode-head">
        <span className="muted">문서 {entries.length}</span>
        {waiting ? <span className="muted">검토할 수정안 {waiting}</span> : null}
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
  const gemini = lookOf("gemini").palette.accent;
  const engineColor = useCallback((provider: Provider) => (provider === "claude" ? claude : provider === "gemini" ? gemini : codex), [claude, codex, gemini]);
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
        tools={<ViewTools mode="flow" view={view} onView={setView} groupKeys={[]} sortKeys={[]} colorKeys={colorKeys} groups={shown} filterHint="이름, #태그, 단계:진행중, 폴더:이름, 속성:값" />}
      />
      <FlowMode api={api} state={state} open={open} lens={lens} />
    </>
  );
}

/* ── Skin 2 (S7): home "지금" in the owner's draft's shape (01-dashboard.png) ──────────────────────
 * The head ("지금" + today), a filter row 전체 / 확인 필요 N / 진행 중 N / 완료 (and, at its end,
 * 묶어서 보기), ONE band "확인이 필요한 작업 N개" + 검토하기 › (a teal wash, a deep-teal text key; fix 1) when
 * decisions wait, then ONE table of conversations (작업 | 프로젝트 | 상태 | AI | 최근 활동) whose first rows are
 * those decisions (상태 확인 필요; the whole row's name opens it, its chevron unfolds its full entry in
 * place — no second key per row, fix 1), then 최근 문서 as one ruled row of
 * three. The request row stays on the column's lower edge (the dock). States come from `rowState`
 * (row-state.ts, the one derivation); the 확인 필요 count is `needsCount` (the rail's number). The other
 * views are reached from the list (프로젝트 › 보기 › 보드·표로 보기, 활동 › 달력으로 보기, the rail's 문서);
 * keys 1–4 still switch. */

type NowFilter = "all" | "attention" | "running" | "done";
const NOW_FILTERS: { id: NowFilter; label: string }[] = [
  { id: "all", label: "전체" },
  { id: "attention", label: "확인 필요" },
  { id: "running", label: "진행 중" },
  { id: "done", label: "완료" },
];
/** Table rows before "N개 더 보기". */
const TABLE_ROWS = 12;

const passesFilter = (filter: NowFilter, state: StateInfo | null) =>
  filter === "all" ? true : filter === "attention" ? needsPerson(state) : filter === "running" ? state?.id === "running" : state?.id === "done";

/** What 지금 lists: every visible conversation, newest sign of life first, each with its one state. */
export function nowRows(state: State) {
  return Object.values(state.sessions)
    .filter((session) => !sessionHidden(state, session))
    .map((session) => ({ session, state: rowState(session) }))
    .sort((a, b) => recency(b.session) - recency(a.session));
}

function NowRow({ api, state, row, open, decision = false, expanded, onExpanded }: { api: Api; state: State; row: { session: Session; state: StateInfo | null }; open: Open; decision?: boolean; expanded: boolean; onExpanded: (next: boolean) => void }) {
  const { session } = row;
  const setExpanded = onExpanded;
  const work = state.works[session.workId];
  const kind = session.documentAgent ? "file" : session.pageAgent ? "web" : "chat";
  const at = recency(session);
  return (
    <>
      <tr className={`now-row${expanded ? " expanded" : ""}${decision ? " decision" : ""}`} onClick={(event) => { if (!(event.target as Element).closest("button, a, input, textarea, select")) open.session(session); }} data-session-id={session.id} data-flip={`s:${session.id}`} data-state={row.state?.id ?? "none"}>
        <td className="now-cell-work">
          <button type="button" className="now-work" onClick={() => open.session(session)} title={purposeText(session)}>
            <ItemIcon kind={kind} size={16} />
            <span className="now-text">{purposeText(session) || "대화"}</span>
          </button>
        </td>
        <td className="now-cell-project">
          {work ? (
            <button type="button" className="now-project" onClick={() => open.work(work)} title={`${work.title} 프로젝트 노트 열기`}>
              <ItemIcon kind="project" size={16} />
              <span className="now-text">{work.title}</span>
            </button>
          ) : <span className="now-text muted">프로젝트 밖</span>}
        </td>
        <td className="now-cell-state"><StateWord state={row.state} /></td>
        <td className="now-cell-ai">
          <span className="now-ai"><EngineMark provider={session.provider} size={16} /><span>{PROVIDER_LABEL[session.provider]}</span></span>
        </td>
        <td className="now-cell-time">
          <time dateTime={new Date(at).toISOString()}>{ago(at) || "방금"}</time>
        </td>
        <td className="now-cell-more">
          <button type="button" className="icon-button small now-toggle" aria-expanded={expanded} aria-label={decision ? (expanded ? "확인할 내용 접기" : "확인할 내용 펼치기") : expanded ? "마지막 답 접기" : "마지막 답 보기"} title={decision ? (expanded ? "접기" : "확인할 내용 펼치기") : expanded ? "접기" : "마지막 답 보기"} onClick={() => setExpanded(!expanded)}>
            <Icon name={expanded ? "chevronUp" : "chevronDown"} size={16} />
          </button>
        </td>
      </tr>
      {expanded ? (
        <tr className={`now-reply-row${decision ? " decision" : ""}`}>
          <td colSpan={6}>{decision ? <WaitingEntry api={api} state={state} session={session} open={open} lead /> : <LastReply api={api} state={state} session={session} />}</td>
        </tr>
      ) : null}
    </>
  );
}

function NowHome({ api, state, open, onMode, grouped, onGrouped }: { api: Api; state: State; open: Open; onMode: (mode: HomeMode) => void; grouped: boolean; onGrouped: (next: boolean) => void }) {
  const [filter, setFilter] = useState<NowFilter>("all");
  const [all, setAll] = useState(false);
  const [marking, setMarking] = useState(false);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(() => new Set());
  const tabs = useRef<HTMLDivElement>(null);
  const table = useRef<HTMLTableElement>(null);
  const rows = nowRows(state);
  const counts = {
    all: rows.length,
    attention: needsCount(state), // the rail's 지금 number: the same function
    running: rows.filter((row) => row.state?.id === "running").length,
    done: rows.filter((row) => row.state?.id === "done").length,
  };
  // What waits for a decision (an approval): the table's FIRST rows, oldest first (the one asked first
  // is answered first); one band over the table says how many and goes to the first (the owner's draft).
  const asking = rows.filter((row) => row.state?.id === "attention" && row.session.status === "awaitingApproval").sort((a, b) => recency(a.session) - recency(b.session));
  const decisions = filter === "all" || filter === "attention" ? asking : [];
  const decided = new Set(decisions.map((row) => row.session.id));
  const listed = [...decisions, ...rows.filter((row) => !decided.has(row.session.id) && passesFilter(filter, row.state))];
  const shown = all ? listed : listed.slice(0, Math.max(TABLE_ROWS, decisions.length));
  const unseen = rows.filter((row) => row.state?.id === "unseen").map((row) => row.session);
  const unfold = (id: string, next: boolean) => setUnfolded((current) => { const copy = new Set(current); if (next) copy.add(id); else copy.delete(id); return copy; });
  const review = () => {
    const first = asking[0];
    if (!first) return;
    if (filter !== "all" && filter !== "attention") setFilter("all");
    unfold(first.session.id, true);
    window.requestAnimationFrame(() => {
      const target = table.current?.querySelector<HTMLElement>(`.now-row[data-session-id="${first.session.id}"]`);
      target?.scrollIntoView?.({ block: "nearest" });
      // The unfolded entry's first key (its own 허용/거절…), else the row's name: the keyboard lands on the decision.
      const entry = target?.nextElementSibling?.classList.contains("now-reply-row") ? target.nextElementSibling : null;
      (entry?.querySelector<HTMLElement>("button:not(:disabled)") ?? target?.querySelector<HTMLElement>(".now-work"))?.focus();
    });
  };
  const markAll = () => {
    setMarking(true);
    void Promise.all(unseen.map((session) => api.updateSession(session.id, { seen: true }).catch(() => undefined))).finally(() => setMarking(false));
  };
  const docs = docEntries(state).slice(0, 3);
  const moveTab = (event: ReactKeyboardEvent) => {
    const index = NOW_FILTERS.findIndex((entry) => entry.id === filter);
    const next = event.key === "ArrowRight" ? index + 1 : event.key === "ArrowLeft" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? NOW_FILTERS.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    const target = NOW_FILTERS[(next + NOW_FILTERS.length) % NOW_FILTERS.length]!;
    setFilter(target.id);
    tabs.current?.querySelector<HTMLElement>(`[data-filter="${target.id}"]`)?.focus();
  };
  const emptyLine = filter === "attention" ? "확인이 필요한 작업이 없습니다." : filter === "running" ? "지금 진행 중인 작업이 없습니다." : filter === "done" ? "아직 끝난 작업이 없습니다." : null;
  return (
    <div className="now-home">
      <NowFilterRow grouped={grouped} onGrouped={onGrouped}>
        <div className="now-tabs" role="tablist" aria-label="지금 거르기" ref={tabs} onKeyDown={moveTab}>
          {NOW_FILTERS.map((entry) => (
            <button key={entry.id} type="button" role="tab" data-filter={entry.id} aria-selected={filter === entry.id} aria-controls="now-panel" tabIndex={filter === entry.id ? 0 : -1}
              className={`now-tab${filter === entry.id ? " current" : ""}`} onClick={() => setFilter(entry.id)}>
              <span>{entry.label}</span>
              {entry.id !== "all" && entry.id !== "done" && counts[entry.id] ? <span className="now-count">{counts[entry.id]}</span> : null}
            </button>
          ))}
        </div>
        {unseen.length ? (
          <button type="button" className="text-button now-mark" disabled={marking} onClick={markAll} title="새 답을 모두 읽음으로 표시합니다">새 답 {unseen.length}개 읽음으로</button>
        ) : null}
      </NowFilterRow>
      <div id="now-panel" role="tabpanel" aria-label={NOW_FILTERS.find((entry) => entry.id === filter)!.label}>
        {decisions.length ? (
          <div className="now-band" role="group" aria-label="확인이 필요한 작업">
            <Icon name="alert" size={16} className="now-band-glyph" />
            <span className="now-band-words">확인이 필요한 작업 <span className="now-band-count">{decisions.length}</span>개</span>
            <button type="button" className="text-button now-band-review" onClick={review}>검토하기<Icon name="chevronRight" size={14} /></button>
          </div>
        ) : null}
        {shown.length ? (
          <table className="now-table" ref={table}>
            <caption className="visually-hidden">대화</caption>
            <colgroup>
              <col className="now-col-work" /><col className="now-col-project" /><col className="now-col-state" /><col className="now-col-ai" /><col className="now-col-time" /><col className="now-col-more" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">작업</th>
                <th scope="col">프로젝트</th>
                <th scope="col">상태</th>
                <th scope="col">AI</th>
                <th scope="col" className="now-th-time">최근 활동</th>
                <th scope="col"><span className="visually-hidden">열기와 펼치기</span></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => <NowRow key={row.session.id} api={api} state={state} row={row} open={open} decision={decided.has(row.session.id)} expanded={unfolded.has(row.session.id)} onExpanded={(next) => unfold(row.session.id, next)} />)}
            </tbody>
          </table>
        ) : rows.length === 0 ? (
          <div className="home-empty now-empty" role="status">
            <h2 className="home-empty-head">아직 맡긴 일이 없습니다</h2>
            <p>아래 칸에 AI에게 맡길 일을 쓰면, 진행 상황과 확인할 일이 이 표에 모입니다.</p>
          </div>
        ) : emptyLine ? (
          <p className="home-quiet">{emptyLine}</p>
        ) : null}
        <More hidden={listed.length - shown.length} onMore={() => setAll(true)} />
      </div>
      {docs.length ? (
        <section className="now-docs" aria-label="최근 문서">
          <h2 className="now-section-head">
            <span>최근 문서</span>
            <button type="button" className="text-button now-docs-all" onClick={() => onMode("docs")}>전체 보기<Icon name="chevronRight" size={14} /></button>
          </h2>
          <ul className="now-docs-row">
            {docs.map((entry) => (
              <li key={entry.artifact.id}>
                <button type="button" className="now-doc" data-flip={`d:${entry.artifact.id}`} onClick={() => open.doc(entry.artifact.id)} title={entry.artifact.path}>
                  <FormatBadge format={entry.artifact.format} />
                  <span className="now-doc-text">
                    <span className="now-doc-name">{entry.artifact.name}</span>
                    <span className="now-doc-meta"><span>{entry.work.title}</span><time dateTime={new Date(entry.artifact.updatedAt).toISOString()}>{ago(entry.artifact.updatedAt) || "방금"}</time></span>
                  </span>
                  {entry.pending ? <span className="now-doc-pending">수정안 {entry.pending}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** 지금's filter row: its filters (none in the grouped views) and, at its end, "묶어서 보기" — the former
 *  지금 views (group, board, filter, colours) for this window, on and off from the same place. */
function NowFilterRow({ grouped, onGrouped, children }: { grouped: boolean; onGrouped: (next: boolean) => void; children?: ReactNode }) {
  return (
    <div className={`now-filters${grouped ? " grouped" : ""}`}>
      {children}
      <button type="button" className={`text-button now-group-key${grouped ? " pressed" : ""}`} aria-pressed={grouped} title={grouped ? "지금을 표 하나로 봅니다" : "지금을 묶어서 봅니다: 묶기, 보드, 거르기, 색"} onClick={() => onGrouped(!grouped)}>
        <Icon name="layers" size={14} />묶어서 보기
      </button>
    </div>
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
 * Home: a page head (the place, the date, the four modes), the mode's views and its content, and
 * the request row on the column's lower edge. The head scrolls with the page; keys 1–4 switch
 * modes from anywhere when focus is not in a text field.
 */
/** What each view of home is called on the page and on its switch. */
const HOME_VIEW_LABEL: Record<HomeMode, string> = { now: "지금", projects: "보드와 표", flow: "달력", docs: "문서" };

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
  intro,
  dock,
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
  /** Above the mode's content, under the page head. */
  intro?: ReactNode;
  /** The request row, kept on the column's lower edge while the ledger scrolls. */
  dock?: ReactNode;
  footer?: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const first = useRef<FlipFirst | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const open: Open = useMemo(() => ({ session: onOpenSession, work: onOpenProject ?? onOpenWork, doc: onOpenDoc }), [onOpenSession, onOpenWork, onOpenProject, onOpenDoc]);
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

  // "지금을 묶어서 보기": the former 지금 views (group, board, filter, colours), kept for this window.
  const GROUPED_KEY = "workbench.nowGrouped.v1";
  const [grouped, setGroupedState] = useState(() => { try { return sessionStorage.getItem(GROUPED_KEY) === "1"; } catch { return false; } });
  const setGrouped = (next: boolean) => { setGroupedState(next); try { sessionStorage.setItem(GROUPED_KEY, next ? "1" : "0"); } catch { /* this view only */ } };
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

  const today = new Date().toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "long" });
  const title = HOME_VIEW_LABEL[mode];
  return (
    <>
      {/* The page head: the place ("지금", or the view's name) and today's date; another view has a key back to 지금. */}
      <header className={`home-head mode-${mode}`}>
        <div className="home-head-title">
          <h1 className="home-title">{title}</h1>
          {mode === "now" ? <p className="home-date">{today}</p> : null}
        </div>
        {/* The four views of home, always in sight (the owner, 2026-11-15: the board, the table and the calendar are the
            point of home — they had gone behind the list's menus). Keys 1–4 switch too. */}
        <nav className="home-mode-nav" aria-label="홈 탐색">
          <Segmented
            className="home-mode-bar"
            label="홈 보기"
            options={HOME_MODES.map((entry, index) => ({ value: entry.id, label: HOME_VIEW_LABEL[entry.id], title: `${HOME_VIEW_LABEL[entry.id]}: ${entry.question} (${index + 1})` }))}
            value={mode}
            onChange={switchTo}
          />
        </nav>
      </header>
      {intro}
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
        {mode === "now" && !grouped ? (
          <NowHome api={api} state={state} open={open} onMode={switchTo} grouped={grouped} onGrouped={setGrouped} />
        ) : mode === "now" ? (
          <>
            <NowFilterRow grouped={grouped} onGrouped={setGrouped} />
            <NowMode api={api} state={state} open={open} {...modeViews("now")} />
          </>
        ) : mode === "projects" ? (
          <ProjectsMode api={api} state={state} openProject={onOpenProject ?? onOpenWork} open={open} {...modeViews("projects")} />
        ) : mode === "flow" ? (
          <FlowWithViews api={api} state={state} open={open} {...modeViews("flow")} />
        ) : (
          <DocsMode api={api} state={state} open={open} {...modeViews("docs")} />
        )}
      </div>
      {dock ? <div className={`home-dock mode-${mode}`}>{dock}</div> : null}
      {footer}
    </>
  );
}
