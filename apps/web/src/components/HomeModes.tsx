import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { FORMAT_LABEL, PROVIDER_LABEL, isUnseen, type Artifact, type ProjectStage, type ProjectSummary, type Session, type TranscriptItem, type Work } from "@workbench/contracts";
import type { Api } from "../api.ts";
import type { State } from "../state.ts";
import { accentStyle, useAppearance } from "../appearance.ts";
import { ago, statusText, statusTone } from "../format.ts";
import { measure, play, type FlipFirst } from "../flip.ts";
import {
  HOME_MODES,
  docEntries,
  heldCount,
  isWorking,
  lastExchange,
  mapSections,
  mindmapSource,
  nowGroups,
  recency,
  recentWorks,
  resumeSessions,
  workContents,
  type DocEntry,
  type HomeMode,
} from "../overview.ts";
import { thumbOf, type Thumb } from "../thumbs.ts";
import { FormatBadge } from "./DocCards.tsx";
import { Diagram } from "./Diagram.tsx";
import { EngineMark } from "./EngineMark.tsx";
import { Icon } from "./Icon.tsx";
import { ModeBar } from "./ModeBar.tsx";
import { ProjectsMode } from "./project/ProjectsMode.tsx";
import { stageOf } from "../project.ts";
import { foldedReply } from "./docs/ConversationDrawer.tsx";
import { FlowMode } from "./FlowMode.tsx";
import "../styles/views.css";

// Home overview modes (design 3.3): 지금 · 보드 · 지도 · 흐름 · 문서, one bar at the bottom, keys
// 1–5. The same sessions, works and documents in five groupings; switching keeps them in place
// (FLIP) and keeps what was being read where it was. Lists are capped with "더 보기", so a
// hundred sessions stay quick.

type Open = {
  /** With a request's item id ("흐름"), the conversation opens there. */
  session: (session: Session, itemId?: string) => void;
  work: (work: Work) => void;
  doc: (artifactId: string) => void;
};

const MAP_KEY = "workbench.homeMap";

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

/** A work as a card: its name, where it is, and (in "지도") its sessions and documents. */
function WorkCard({ state, work, open, chips, stage }: { state: State; work: Work; open: Open; chips: boolean; stage?: ProjectStage | null }) {
  const { lookOf } = useAppearance();
  const { sessions, docs } = workContents(state, work);
  const pending = new Map<string, number>();
  for (const proposal of Object.values(state.proposals)) if (proposal.status === "pending") pending.set(proposal.artifactId, (pending.get(proposal.artifactId) ?? 0) + 1);
  const last = Math.max(work.updatedAt, ...sessions.map(recency));
  const path = (() => {
    const names: string[] = [];
    for (let at = work.folderId; at && state.folders[at]; at = state.folders[at]!.parentId) names.unshift(state.folders[at]!.name);
    return names.join(" / ");
  })();
  return (
    <div className={`work-card${chips ? " with-chips" : ""}`} data-flip={`w:${work.id}`}>
      <button type="button" className="work-card-title" onClick={() => open.work(work)} title={work.cwd}>
        <Icon name="project" size={14} />
        <span>{work.title}</span>
      </button>
      {stage !== undefined ? (
        <span className={`projects-stage${stage ? "" : " empty"}`} style={stage ? ({ "--stage": stage.color } as CSSProperties) : undefined} title="단계 (프로젝트 노트)">
          <span className="projects-stage-dot" aria-hidden />
          {stage ? stage.name : "값 없음"}
        </span>
      ) : null}
      {!chips ? <span className="work-card-path">{path || "분류 없음"}</span> : null}
      {chips && sessions.length ? (
        <div className="work-chips">
          {sessions.slice(0, 6).map((session) => (
            <button
              key={session.id}
              type="button"
              className={`work-chip session tone-${statusTone(session)}`}
              data-flip={`s:${session.id}`}
              style={accentStyle(lookOf(session.provider))}
              onClick={() => open.session(session)}
              title={`${session.purpose} · ${statusText(session)}`}
            >
              {isWorking(session) || session.status === "awaitingApproval" ? <span className={`dot dot-${statusTone(session)}`} /> : <EngineMark provider={session.provider} size={12} />}
              <span className="work-chip-text">{session.purpose}</span>
              {isUnseen(session) ? <span className="new-dot" title="새 답" /> : null}
            </button>
          ))}
          {sessions.length > 6 ? <span className="work-chip more">+{sessions.length - 6}</span> : null}
        </div>
      ) : null}
      {chips && docs.length ? (
        <div className="work-chips">
          {docs.slice(0, 4).map((artifact) => (
            <button key={artifact.id} type="button" className="work-chip doc" data-flip={`d:${artifact.id}`} onClick={() => open.doc(artifact.id)} title={artifact.path}>
              <FormatBadge format={artifact.format} />
              <span className="work-chip-text">{artifact.name}</span>
              {pending.get(artifact.id) ? <span className="work-chip-count" title="검토할 수정안">{pending.get(artifact.id)}</span> : null}
            </button>
          ))}
          {docs.length > 4 ? <span className="work-chip more">+{docs.length - 4}</span> : null}
        </div>
      ) : null}
      <span className="work-card-meta">
        세션 {sessions.length}
        {docs.length ? ` · 문서 ${docs.length}` : ""} · {ago(last)}
      </span>
    </div>
  );
}

function More({ hidden, onMore }: { hidden: number; onMore: () => void }) {
  return hidden > 0 ? (
    <button type="button" className="link home-more" onClick={onMore}>
      {hidden}개 더 보기
    </button>
  ) : null;
}

/** "지금": what waits for the user, by priority; then where to pick up, and the latest works. */
function NowMode({ api, state, open }: { api: Api; state: State; open: Open }) {
  const groups = nowGroups(state);
  const [marking, setMarking] = useState(false);
  // "모두 읽음" (from the former "보드"): every new answer in the group marked read.
  const markAll = (sessions: Session[]) => {
    setMarking(true);
    void Promise.all(sessions.map((session) => api.updateSession(session.id, { seen: true }).catch(() => undefined))).finally(() => setMarking(false));
  };
  const listed = new Set(groups.flatMap((group) => group.sessions.map((session) => session.id)));
  const resume = resumeSessions(state, listed);
  const works = recentWorks(state);
  const [wide, setWide] = useState<Set<string>>(new Set());
  const CAP = 8;
  return (
    <div className="home-board">
      {groups.map((group) => {
        const shown = wide.has(group.bucket) ? group.sessions : group.sessions.slice(0, CAP);
        return (
          <section key={group.bucket} className={`home-section bucket-${group.bucket}`} aria-label={group.label}>
            <h2 className="section-label">
              {group.label} <span className="home-count">{group.sessions.length}</span>
              {group.bucket === "unseen" && group.sessions.length ? (
                <button type="button" className="text-button board-action" disabled={marking} onClick={() => markAll(group.sessions)} title="새 답을 모두 읽음으로 표시합니다">
                  모두 읽음
                </button>
              ) : null}
            </h2>
            {shown.map((session) => (
              <SessionRow key={session.id} api={api} state={state} session={session} open={open} />
            ))}
            <More hidden={group.sessions.length - shown.length} onMore={() => setWide(new Set([...wide, group.bucket]))} />
          </section>
        );
      })}
      {!groups.length ? <p className="home-quiet">지금 기다리는 일은 없습니다.</p> : null}
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
              <WorkCard key={work.id} state={state} work={work} open={open} chips={false} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

/** "지도": folders › works, each work with its sessions and documents; or the same as a mind map. */
function MapMode({ state, open, summaries, stages }: { state: State; open: Open; summaries?: Map<string, ProjectSummary>; stages?: ProjectStage[] }) {
  const sections = useMemo(() => mapSections(state), [state]);
  const [view, setView] = useState<"cards" | "mindmap">(() => (localStorage.getItem(MAP_KEY) === "mindmap" ? "mindmap" : "cards"));
  const [wide, setWide] = useState<Set<string>>(new Set());
  const source = useMemo(() => (view === "mindmap" ? mindmapSource(state, sections) : ""), [view, state, sections]);
  const CAP = 12;
  const works = sections.reduce((sum, section) => sum + section.works.length, 0);
  return (
    <div className="map">
      <div className="mode-head">
        <div className="segmented small" role="radiogroup" aria-label="카드 보기">
          {(["cards", "mindmap"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={view === value}
              className={view === value ? "active" : ""}
              onClick={() => {
                setView(value);
                localStorage.setItem(MAP_KEY, value);
              }}
            >
              {value === "cards" ? "카드" : "마인드맵"}
            </button>
          ))}
        </div>
        <span className="muted">
          폴더 {sections.filter((section) => section.folderId).length} · 작업 {works}
        </span>
      </div>
      {view === "mindmap" ? (
        <div className="map-mind">
          <Diagram source={source} />
        </div>
      ) : (
        sections.map((section) => {
          const key = section.folderId ?? "loose";
          const shown = wide.has(key) ? section.works : section.works.slice(0, CAP);
          return (
            <section key={key} className="map-section" aria-label={section.path.join(" / ") || "분류 없음"}>
              <h2 className="section-label">
                <Icon name="folder" size={13} /> {section.path.length ? section.path.join(" / ") : "분류 없음"} <span className="home-count">{section.works.length}</span>
              </h2>
              <div className="map-grid">
                {shown.map((work) => (
                  <WorkCard key={work.id} state={state} work={work} open={open} chips stage={summaries && stages ? stageOf(stages, summaries.get(work.id)?.stage ?? null) : undefined} />
                ))}
              </div>
              <More hidden={section.works.length - shown.length} onMore={() => setWide(new Set([...wide, key]))} />
            </section>
          );
        })
      )}
    </div>
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

/** "문서": what was made, as first pages, with the proposals that wait for a decision. */
function DocsMode({ api, state, open }: { api: Api; state: State; open: Open }) {
  const entries = docEntries(state);
  const [wide, setWide] = useState(false);
  const CAP = 36;
  const shown: DocEntry[] = wide ? entries : entries.slice(0, CAP);
  const waiting = entries.reduce((sum, entry) => sum + entry.pending, 0);
  return (
    <div className="docs">
      <div className="mode-head">
        <span className="muted">
          문서 {entries.length}
          {waiting ? ` · 검토할 수정안 ${waiting}` : ""}
        </span>
      </div>
      <div className="docs-grid">
        {shown.map((entry) => (
          <button
            key={entry.artifact.id}
            type="button"
            className="doc-tile"
            data-flip={`d:${entry.artifact.id}`}
            onClick={() => open.doc(entry.artifact.id)}
            title={`${entry.artifact.path} · ${FORMAT_LABEL[entry.artifact.format]}`}
          >
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
        ))}
      </div>
      {!entries.length ? <p className="home-quiet">아직 문서가 없습니다. 대화에서 만든 파일이나 연 문서가 여기에 모입니다.</p> : null}
      <More hidden={entries.length - shown.length} onMore={() => setWide(true)} />
    </div>
  );
}

const editable = (target: EventTarget | null) => target instanceof HTMLElement && Boolean(target.closest("input, textarea, select, [contenteditable=true], [contenteditable=''], .cm-editor"));

/**
 * The home overview: the current mode's content, then `footer`, then the mode bar (sticky at the
 * bottom centre). Keys 1–5 switch modes when focus is not in a text field.
 */
export function HomeModes({
  api,
  state,
  mode,
  onMode,
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
          <NowMode api={api} state={state} open={open} />
        ) : mode === "projects" ? (
          <ProjectsMode api={api} state={state} openProject={onOpenProject ?? onOpenWork} cards={(summaries, stages) => <MapMode state={state} open={open} summaries={summaries} stages={stages} />} />
        ) : mode === "flow" ? (
          <FlowMode api={api} state={state} open={open} />
        ) : (
          <DocsMode api={api} state={state} open={open} />
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
