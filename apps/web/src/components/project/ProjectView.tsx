import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { PROVIDER_LABEL, type ProjectEvent, type ProjectPage, type ProjectSummary, type ProjectWrite, type Session, type StoppedPlace, type Work } from "@workbench/contracts";
import type { Api } from "../../api.ts";
import { ago, statusText } from "../../format.ts";
import { ObsidianMarkdown, obsidianComponents, obsidianUrlTransform } from "../../markdown/obsidian.tsx";
import type { Components } from "react-markdown";
import { asLink, continueSession, duration, eventDays, linkLabel, sessionOrder, stageOf } from "../../project.ts";
import { neighbours } from "../../graph.ts";
import type { State } from "../../state.ts";
import type { MenuEntry, MenuRequest } from "../ContextMenu.tsx";
import { FormatBadge } from "../DocCards.tsx";
import { diagramComponents } from "../Diagram.tsx";
import { EngineMark } from "../EngineMark.tsx";
import { Icon, type IconName } from "../Icon.tsx";
import { docPictureComponents } from "../ImageGen.tsx";
import { CardComposer } from "../pkm/CardComposer.tsx";
import { MarkdownEditor } from "../docs/MarkdownEditor.tsx";
import { useEngineChoice } from "../StartView.tsx";
import { StageDialog } from "./StageDialog.tsx";
import "../../styles/project.css";

// "프로젝트 = 노트 한 장": a work's page. From the top: what people wrote (stage, tags, related, other
// properties), one line of what needs attention, the record of this week, decisions and open
// questions, sessions, files, the note itself, and what the engines are told. Every write to the
// note can be undone from the notice it leaves.

type Toast = { text: string; action?: { label: string; run: () => void } };

const DRAWN = diagramComponents();
/** Source links of decisions (`workbench://session/…`) stay links here. */
const keepSources = (url: string) => (url.startsWith("workbench://") ? url : obsidianUrlTransform(url));
const BY_LABEL: Record<string, string> = { user: "나", claude: "Claude", codex: "Codex", external: "앱 밖" };

/** A small input that adds a value on Enter (not while Hangul is being composed) and cancels on Esc. */
function AddInput({ placeholder, onAdd, onDone, list }: { placeholder: string; onAdd: (value: string) => void; onDone: () => void; list?: string }) {
  const [value, setValue] = useState("");
  const onKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && value.trim()) {
      event.preventDefault();
      onAdd(value.trim());
      setValue("");
    } else if (event.key === "Escape") onDone();
  };
  return <input className="project-add-input" autoFocus value={value} placeholder={placeholder} onChange={(event) => setValue(event.target.value)} onKeyDown={onKey} onBlur={onDone} list={list} />;
}

export function ProjectView({
  api,
  state,
  workId,
  onOpenSession,
  onOpenDocument,
  onOpenProject,
  onToast,
  onError,
  openMenu,
}: {
  api: Api;
  state: State;
  workId: string;
  onOpenSession: (session: Session, itemId?: string | null) => void;
  onOpenDocument: (artifactId: string, proposalId: string | null) => void;
  /** Another project's page ("연결"). */
  onOpenProject?: (work: Work) => void;
  onToast: (toast: Toast) => void;
  onError: (error: unknown) => void;
  openMenu: (request: MenuRequest) => void;
}) {
  const work: Work | undefined = state.works[workId];
  const [page, setPage] = useState<ProjectPage | null>(null);
  const [allEvents, setAllEvents] = useState<ProjectEvent[] | null>(null);
  const [details, setDetails] = useState(false);
  const [adding, setAdding] = useState<null | "tag" | "related" | "property" | "decision" | "question">(null);
  const [newKey, setNewKey] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [engine, setEngine] = useEngineChoice();
  const [stagesOpen, setStagesOpen] = useState(false);
  const version = `${state.pkm[`project:${workId}`] ?? 0}:${state.pkm["project:*"] ?? 0}`;
  // "연결": every project's tags and links, to find this one's neighbours (관련, shared tags).
  const [summaries, setSummaries] = useState<ProjectSummary[]>([]);
  useEffect(() => {
    api.projects().then(setSummaries).catch(() => setSummaries([]));
  }, [api, version]);
  // What the page shows of sessions and files changes with them; refetched shortly after.
  const sessions = useMemo(() => Object.values(state.sessions).filter((session) => session.workId === workId && !session.archivedAt), [state.sessions, workId]);
  const files = useMemo(() => Object.values(state.artifacts).filter((artifact) => artifact.workId === workId && artifact.role !== "project-note"), [state.artifacts, workId]);
  const pulse = `${sessions.map((session) => `${session.id}:${session.status}:${session.updatedAt}`).join("|")}#${files.map((artifact) => `${artifact.id}:${artifact.revision}`).join("|")}`;

  const load = useCallback(() => {
    api.project(workId).then(setPage).catch(onError);
  }, [api, workId, onError]);
  useEffect(load, [load, version]);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(load, 400);
    return () => window.clearTimeout(timer.current);
  }, [pulse, load]);
  useEffect(() => {
    if (allEvents) api.projectEvents(workId).then(setAllEvents).catch(onError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  /** A write landed: show the page it returned and a notice that can undo it. */
  const wrote = useCallback(
    (write: ProjectWrite) => {
      setPage(write.page);
      if (!write.token) return;
      onToast({
        text: write.created ? `프로젝트 노트를 만들었습니다 · ${write.summary}` : write.summary,
        action: {
          label: "되돌리기",
          run: () => void api.undoProject(workId, write.token).then(setPage).catch(onError),
        },
      });
    },
    [api, workId, onToast, onError],
  );
  const run = (promise: Promise<ProjectWrite>) => void promise.then(wrote).catch(onError);

  // A decision's "원문" link (`workbench://session/<id>#<item>`) opens that conversation at that reply.
  const sourceLink = useMemo<Components["a"]>(
    () =>
      function SourceLink({ href, children }) {
        const match = /^workbench:\/\/session\/([^#]+)(?:#(.+))?$/.exec(href ?? "");
        if (!match) {
          return (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          );
        }
        return (
          <a
            href="#"
            className="project-source"
            onClick={(event) => {
              event.preventDefault();
              const session = state.sessions[match[1]!];
              if (session) onOpenSession(session, match[2] ? decodeURIComponent(match[2]) : null);
            }}
          >
            {children}
          </a>
        );
      },
    [state.sessions, onOpenSession],
  );
  const pictures = useMemo(
    () => obsidianComponents({ ...(page ? docPictureComponents(DRAWN, workId, page.note.path) : DRAWN), a: sourceLink }),
    [page?.note.path, workId, sourceLink],
  );

  if (!work) return <main className="project-view"><div className="empty-hint">프로젝트를 찾을 수 없습니다.</div></main>;
  if (!page) return <main className="project-view"><div className="empty-hint">불러오는 중…</div></main>;

  const { note, facts, stages } = page;
  const stage = stageOf(stages, note.stage);
  const folders: string[] = [];
  for (let id = work.folderId; id; id = state.folders[id]?.parentId ?? null) {
    const folder = state.folders[id];
    if (!folder) break;
    folders.unshift(folder.name);
  }
  const next = continueSession(work, sessions);
  const related = note.properties.find(([key]) => key === "관련")?.[1] ?? [];
  const others = note.properties.filter(([key]) => !["단계", "tags", "tag", "관련"].includes(key));
  const projectNames = Object.values(state.works).filter((entry) => entry.id !== work.id && !entry.archivedAt).map((entry) => entry.title);

  const stageMenu = (x: number, y: number) => {
    const items: MenuEntry[] = [
      ...stages.map((entry) => ({ kind: "item" as const, label: entry.name, checked: entry.name === note.stage, onSelect: () => run(api.setProjectStage(workId, entry.name)) })),
      { kind: "separator" },
      { kind: "item", label: "값 없음", checked: !note.stage, onSelect: () => run(api.setProjectStage(workId, null)) },
      { kind: "separator" },
      { kind: "item", label: "단계 이름·색 바꾸기…", icon: "palette", onSelect: () => setStagesOpen(true) },
    ];
    openMenu({ x, y, title: "단계", items });
  };
  // 멈춘 곳: one place goes straight there; more open a list of them.
  const goTo = (place: StoppedPlace) => {
    if (place.kind === "proposal" && place.artifactId) onOpenDocument(place.artifactId, place.proposalId ?? null);
    else if (place.sessionId && state.sessions[place.sessionId]) onOpenSession(state.sessions[place.sessionId]!);
  };
  const stoppedMenu = (anchor: HTMLElement) => {
    if (facts.stopped.length === 1) return goTo(facts.stopped[0]!);
    const box = anchor.getBoundingClientRect();
    const icon = (place: StoppedPlace): IconName => (place.kind === "proposal" ? "file" : place.kind === "link" ? "link" : "alert");
    openMenu({ x: box.left, y: box.bottom + 4, title: "멈춘 곳", items: facts.stopped.map((place) => ({ kind: "item", label: place.text, icon: icon(place), hint: ago(place.at), onSelect: () => goTo(place) })) });
  };
  const listValues = (values: string[] | null) => (values ?? []).filter(Boolean);

  const openEvent = (event: ProjectEvent) => {
    if (event.artifactId && event.proposalId) return onOpenDocument(event.artifactId, event.proposalId);
    if (event.artifactId) return onOpenDocument(event.artifactId, null);
    const session = event.sessionId ? state.sessions[event.sessionId] : null;
    if (session) onOpenSession(session);
  };
  const events = allEvents ?? page.events;

  return (
    <main className="project-view">
      <div className="project-scroll">
        <div className="column project-column">
          <header className="project-head">
            <div className="project-crumbs muted">{folders.length ? folders.join(" / ") : "분류 없음"}</div>
            <div className="project-title-row">
              <h1 className="project-title">{work.title}</h1>
              <span className="project-head-tools">
                {next ? (
                  <button type="button" className="button small project-continue" onClick={() => onOpenSession(next)} title="이 프로젝트에서 이어서 하기">
                    <EngineMark provider={next.provider} size={14} /> 이어서: {next.purpose || "세션"}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="icon-button small"
                  title="프로젝트 메뉴"
                  aria-haspopup="menu"
                  onClick={(event) => {
                    const box = event.currentTarget.getBoundingClientRect();
                    const items: MenuEntry[] = [
                      ...(note.artifactId ? [{ kind: "item" as const, label: "노트를 문서로 열기", icon: "page" as const, onSelect: () => onOpenDocument(note.artifactId!, null) }] : []),
                      { kind: "item", label: "노트 경로 복사", icon: "copy", onSelect: () => void navigator.clipboard?.writeText(note.path) },
                      { kind: "item", label: "폴더 경로 복사", icon: "copy", onSelect: () => void navigator.clipboard?.writeText(work.cwd) },
                    ];
                    openMenu({ x: box.left, y: box.bottom + 4, title: work.title, items });
                  }}
                >
                  <Icon name="dots" size={14} />
                </button>
              </span>
            </div>

            {/* What people wrote: the note's own keys, as Obsidian shows properties. */}
            <div className="project-props" aria-label="속성">
              <button
                type="button"
                className={`project-stage${stage ? "" : " empty"}`}
                style={stage ? ({ "--stage": stage.color } as CSSProperties) : undefined}
                onClick={(event) => {
                  const box = event.currentTarget.getBoundingClientRect();
                  stageMenu(box.left, box.bottom + 4);
                }}
                title="단계 바꾸기"
              >
                <span className="project-stage-dot" aria-hidden />
                {stage ? stage.name : "단계 없음"}
              </button>
              {note.tags.map((tag) => (
                <span key={tag} className="project-chip tag">
                  #{tag}
                  <button type="button" className="project-chip-x" aria-label={`${tag} 태그 빼기`} onClick={() => run(api.setProjectProperty(workId, "tags", note.tags.filter((entry) => entry !== tag)))}>
                    <Icon name="x" size={10} />
                  </button>
                </span>
              ))}
              {adding === "tag" ? (
                <AddInput placeholder="태그" onAdd={(value) => run(api.setProjectProperty(workId, "tags", [...note.tags, ...value.split(/[\s,]+/).map((tag) => tag.replace(/^#/, "")).filter(Boolean)]))} onDone={() => setAdding(null)} />
              ) : (
                <button type="button" className="project-add" onClick={() => setAdding("tag")}>
                  + 태그
                </button>
              )}
              {related.length ? <span className="project-sep" aria-hidden /> : null}
              {related.map((value) => (
                <span key={value} className="project-chip link" title={value}>
                  <Icon name="link" size={11} /> {linkLabel(value)}
                  <button type="button" className="project-chip-x" aria-label={`${linkLabel(value)} 관련에서 빼기`} onClick={() => run(api.setProjectProperty(workId, "관련", related.filter((entry) => entry !== value)))}>
                    <Icon name="x" size={10} />
                  </button>
                </span>
              ))}
              {adding === "related" ? (
                <>
                  <AddInput placeholder="관련 프로젝트·노트" list="project-names" onAdd={(value) => run(api.setProjectProperty(workId, "관련", [...related, asLink(value)]))} onDone={() => setAdding(null)} />
                  <datalist id="project-names">
                    {projectNames.map((name) => (
                      <option key={name} value={name} />
                    ))}
                  </datalist>
                </>
              ) : (
                <button type="button" className="project-add" onClick={() => setAdding("related")}>
                  + 관련
                </button>
              )}
            </div>
            {others.length || adding === "property" ? (
              <dl className="project-other-props">
                {others.map(([key, values]) => (
                  <div key={key} className="project-prop">
                    <dt>{key}</dt>
                    <dd>
                      {editing === key ? (
                        <input
                          className="project-add-input"
                          autoFocus
                          value={draft}
                          onChange={(event) => setDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.nativeEvent.isComposing) return;
                            if (event.key === "Enter") {
                              event.preventDefault();
                              const parts = (values?.length ?? 0) > 1 ? draft.split(",").map((part) => part.trim()) : [draft.trim()];
                              run(api.setProjectProperty(workId, key, parts.filter(Boolean)));
                              setEditing(null);
                            } else if (event.key === "Escape") setEditing(null);
                          }}
                          onBlur={() => setEditing(null)}
                        />
                      ) : (
                        <button
                          type="button"
                          className="project-prop-value"
                          onClick={() => {
                            setEditing(key);
                            setDraft(listValues(values).join(", "));
                          }}
                        >
                          {listValues(values).join(", ") || <span className="muted">값 없음</span>}
                        </button>
                      )}
                      <button type="button" className="project-chip-x" aria-label={`${key} 속성 지우기`} onClick={() => run(api.setProjectProperty(workId, key, null))}>
                        <Icon name="x" size={10} />
                      </button>
                    </dd>
                  </div>
                ))}
                {adding === "property" ? (
                  <div className="project-prop">
                    <dt>
                      <input className="project-add-input" autoFocus placeholder="이름" value={newKey} onChange={(event) => setNewKey(event.target.value)} />
                    </dt>
                    <dd>
                      <AddInput
                        placeholder="값 (Enter)"
                        onAdd={(value) => {
                          if (newKey.trim()) run(api.setProjectProperty(workId, newKey.trim(), [value]));
                          setNewKey("");
                          setAdding(null);
                        }}
                        onDone={() => undefined}
                      />
                    </dd>
                  </div>
                ) : null}
              </dl>
            ) : null}
            {adding !== "property" ? (
              <button type="button" className="project-add" onClick={() => setAdding("property")}>
                + 속성
              </button>
            ) : null}

            {/* What needs the person, in one line; each goes straight there. */}
            <div className="project-facts">
              {facts.attention ? (
                <button type="button" className="project-fact attention" onClick={() => facts.attentionSessionId && state.sessions[facts.attentionSessionId] && onOpenSession(state.sessions[facts.attentionSessionId]!)}>
                  확인 필요 {facts.attention}
                </button>
              ) : null}
              {facts.stopped.length ? (
                <button
                  type="button"
                  className="project-fact error"
                  aria-haspopup={facts.stopped.length > 1 ? "menu" : undefined}
                  title={facts.stopped.map((place) => place.text).join("\n")}
                  onClick={(event) => stoppedMenu(event.currentTarget)}
                >
                  멈춘 곳 {facts.stopped.length}
                </button>
              ) : null}
              {facts.proposals ? (
                <button type="button" className="project-fact proposal" onClick={() => facts.proposalArtifactId && onOpenDocument(facts.proposalArtifactId, facts.proposalId)}>
                  수정안 {facts.proposals}
                </button>
              ) : null}
              {facts.running ? <span className="project-fact quiet">진행 중 {facts.running}</span> : null}
              <span className="project-fact quiet">{facts.lastActivity ? ago(facts.lastActivity) : "활동 없음"}</span>
              <span className="project-fact quiet path" title={facts.folder}>
                {facts.folder.replace(/^\/home\/[^/]+/, "~")}
              </span>
              <button type="button" className="project-details-toggle" aria-expanded={details} onClick={() => setDetails(!details)}>
                자세히 <Icon name={details ? "chevronUp" : "chevronDown"} size={12} />
              </button>
            </div>
            {details ? (
              <dl className="project-details">
                <div>
                  <dt>세션</dt>
                  <dd>
                    {facts.sessions}
                    {Object.entries(facts.engines).map(([provider, count]) => ` · ${PROVIDER_LABEL[provider as keyof typeof PROVIDER_LABEL]} ${count}`)}
                  </dd>
                </div>
                <div>
                  <dt>모델</dt>
                  <dd>{facts.models.join(", ") || "—"}</dd>
                </div>
                <div>
                  <dt>요청</dt>
                  <dd>
                    {facts.requests}회 · 작업 시간 {duration(facts.turnMs)}
                  </dd>
                </div>
                <div>
                  <dt>파일</dt>
                  <dd>
                    {facts.files} · 판 사람 {facts.revisions.user} · AI {facts.revisions.engine}
                    {facts.revisions.external ? ` · 앱 밖 ${facts.revisions.external}` : ""}
                  </dd>
                </div>
                <div>
                  <dt>예약 · 격리 사본</dt>
                  <dd>
                    {facts.schedules} · {facts.worktrees}
                  </dd>
                </div>
                <div>
                  <dt>시작 · 가지</dt>
                  <dd>
                    {new Date(facts.createdAt).toLocaleDateString("ko-KR")}
                    {facts.branch ? ` · ${facts.branch}` : ""}
                  </dd>
                </div>
              </dl>
            ) : null}
          </header>

          {note.problem ? <div className="notice notice-error">{note.problem}</div> : null}
          {note.lastAuthor === "engine" ? (
            <div className="project-engine-edit">
              <Icon name="edit" size={13} />
              <span>
                {note.lastSessionId && state.sessions[note.lastSessionId] ? `${PROVIDER_LABEL[state.sessions[note.lastSessionId]!.provider]} · ${state.sessions[note.lastSessionId]!.purpose}` : "엔진"}이 프로젝트 노트를 바꿨습니다 (r{note.revision}).
              </span>
              {note.artifactId ? (
                <button type="button" className="link" onClick={() => onOpenDocument(note.artifactId!, null)}>
                  문서로 보기
                </button>
              ) : null}
              <button type="button" className="link" onClick={() => run(api.revertProjectNote(workId))}>
                되돌리기
              </button>
            </div>
          ) : null}

          <section className="project-section" aria-label="기록">
            <div className="project-section-head">
              <h2>{allEvents ? "전체 기록" : "이번 주 기록"}</h2>
              <button
                type="button"
                className="link small"
                onClick={() => {
                  if (allEvents) setAllEvents(null);
                  else api.projectEvents(workId).then(setAllEvents).catch(onError);
                }}
              >
                {allEvents ? "이번 주만" : "전체 보기"}
              </button>
            </div>
            {events.length ? (
              eventDays(events).map((day) => (
                <div key={day.label} className="project-day">
                  <div className="project-day-label">{day.label}</div>
                  <ul className="project-events">
                    {day.events.map((event) => (
                      <li key={event.id} className={`project-event kind-${event.kind}`}>
                        <button type="button" className="project-event-main" onClick={() => openEvent(event)}>
                          <span className="project-event-time">{new Date(event.at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false })}</span>
                          <span className={`project-event-by by-${event.by ?? "none"}`}>{BY_LABEL[event.by ?? ""] ?? ""}</span>
                          <span className="project-event-text">{event.text}</span>
                        </button>
                        {event.kind !== "decision" && event.kind !== "question" ? (
                          <button
                            type="button"
                            className="project-event-keep"
                            title="이 줄을 결정으로 남기기"
                            onClick={() => run(api.addProjectEntry(workId, { section: "decision", text: event.text, sessionId: event.sessionId, itemId: event.itemId ?? null }))}
                          >
                            결정으로
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            ) : (
              <div className="project-empty">아직 기록이 없습니다. 아래 입력창으로 이 프로젝트의 첫 세션을 시작하세요.</div>
            )}
          </section>

          <section className="project-section project-entries" aria-label="결정과 열린 질문">
            <div className="project-entry-list">
              <div className="project-section-head">
                <h2>결정 {note.decisions.length || ""}</h2>
                <button type="button" className="link small" onClick={() => setAdding("decision")}>
                  + 결정
                </button>
              </div>
              <ul>
                {note.decisions.map((entry) => (
                  <li key={entry.line} className="project-entry">
                    <ObsidianMarkdown components={pictures} urlTransform={keepSources}>{entry.text}</ObsidianMarkdown>
                  </li>
                ))}
              </ul>
              {adding === "decision" ? <AddInput placeholder="정한 것 (Enter)" onAdd={(value) => run(api.addProjectEntry(workId, { section: "decision", text: value }))} onDone={() => setAdding(null)} /> : null}
              {!note.decisions.length && adding !== "decision" ? <div className="project-empty">대화의 답에서 "결정으로 남기기"를 누르면 여기에 모입니다.</div> : null}
            </div>
            <div className="project-entry-list">
              <div className="project-section-head">
                <h2>열린 질문 {note.questions.filter((entry) => !entry.done).length || ""}</h2>
                <button type="button" className="link small" onClick={() => setAdding("question")}>
                  + 질문
                </button>
              </div>
              <ul>
                {note.questions.map((entry) => (
                  <li key={entry.line} className={`project-entry question${entry.done ? " done" : ""}`}>
                    <label>
                      <input type="checkbox" checked={entry.done} onChange={(event) => run(api.setProjectQuestion(workId, entry.line, event.target.checked))} />
                      <ObsidianMarkdown components={pictures} urlTransform={keepSources}>{entry.text}</ObsidianMarkdown>
                    </label>
                  </li>
                ))}
              </ul>
              {adding === "question" ? <AddInput placeholder="열린 질문 (Enter)" onAdd={(value) => run(api.addProjectEntry(workId, { section: "question", text: value }))} onDone={() => setAdding(null)} /> : null}
            </div>
          </section>

          <section className="project-section" aria-label="세션">
            <div className="project-section-head">
              <h2>세션 {sessions.length || ""}</h2>
            </div>
            <ul className="project-rows">
              {sessionOrder(sessions)
                .slice(0, 12)
                .map((session) => (
                  <li key={session.id}>
                    <button type="button" className="project-row" onClick={() => onOpenSession(session)}>
                      <EngineMark provider={session.provider} size={15} />
                      <span className="project-row-title">{session.purpose || "세션"}</span>
                      <span className={`project-row-status status-${session.status}`}>{statusText(session)}</span>
                      <span className="project-row-time muted">{ago(session.updatedAt)}</span>
                    </button>
                  </li>
                ))}
            </ul>
            {!sessions.length ? <div className="project-empty">세션이 없습니다.</div> : null}
          </section>

          <section className="project-section" aria-label="파일">
            <div className="project-section-head">
              <h2>파일 {files.length || ""}</h2>
            </div>
            <ul className="project-rows">
              {[...files]
                .sort((a, b) => b.updatedAt - a.updatedAt)
                .slice(0, 12)
                .map((artifact) => {
                  const pending = Object.values(state.proposals).filter((proposal) => proposal.artifactId === artifact.id && proposal.status === "pending").length;
                  return (
                    <li key={artifact.id}>
                      <button type="button" className="project-row" onClick={() => onOpenDocument(artifact.id, null)}>
                        <FormatBadge format={artifact.format} />
                        <span className="project-row-title">{artifact.name}</span>
                        {pending ? <span className="project-row-status status-awaitingApproval">수정안 {pending}</span> : null}
                        <span className="project-row-time muted">
                          r{artifact.revision} · {ago(artifact.updatedAt)}
                        </span>
                      </button>
                    </li>
                  );
                })}
            </ul>
            {!files.length ? <div className="project-empty">아직 문서가 없습니다.</div> : null}
          </section>

          {(() => {
            const input = Object.values(state.works)
              .filter((entry) => !entry.archivedAt)
              .map((entry) => {
                const summary = summaries.find((other) => other.workId === entry.id);
                return { id: entry.id, title: entry.title, tags: summary?.tags ?? entry.tags ?? [], related: summary?.related ?? [], sessions: 0 };
              });
            const links = neighbours(input, workId);
            if (!links.length) return null;
            return (
              <section className="project-section" aria-label="연결">
                <div className="project-section-head">
                  <h2>연결 {links.length}</h2>
                </div>
                <ul className="project-rows">
                  {links.slice(0, 12).map((link) => {
                    const other = state.works[link.id];
                    if (!other) return null;
                    return (
                      <li key={link.id}>
                        <button type="button" className="project-row" onClick={() => onOpenProject?.(other)}>
                          <Icon name={link.by === "related" ? "link" : "tag"} size={14} />
                          <span className="project-row-title">{other.title}</span>
                          <span className="project-row-time muted">{link.by === "related" ? "관련" : link.tags.map((tag) => `#${tag}`).join(" ")}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })()}

          <section className="project-section project-note" aria-label="노트">
            <div className="project-section-head">
              <h2>노트</h2>
              {editing === "__body" ? null : (
                <button
                  type="button"
                  className="link small"
                  onClick={() => {
                    setDraft(note.body);
                    setEditing("__body");
                  }}
                >
                  편집
                </button>
              )}
            </div>
            {editing === "__body" ? (
              <div className="project-note-editor">
                <MarkdownEditor value={draft} onChange={setDraft} onSelection={() => undefined} />
                <div className="project-note-actions">
                  <button type="button" className="button" onClick={() => setEditing(null)}>
                    취소
                  </button>
                  <button
                    type="button"
                    className="button primary"
                    onClick={() => {
                      run(api.setProjectBody(workId, draft, note.revision));
                      setEditing(null);
                    }}
                  >
                    저장
                  </button>
                </div>
              </div>
            ) : note.body.trim() ? (
              <div className="markdown project-note-body">
                <ObsidianMarkdown components={pictures} urlTransform={keepSources}>{note.body}</ObsidianMarkdown>
              </div>
            ) : (
              <div className="project-empty">{note.exists ? "노트 본문이 비어 있습니다." : "아직 노트 파일이 없습니다. 속성이나 결정을 남기면 이 폴더에 만들어집니다."}</div>
            )}
            <div className="project-note-path muted">{note.path}</div>
          </section>

          <details className="project-section project-card">
            <summary>엔진이 아는 것 (새 세션의 맥락 카드)</summary>
            <pre>{page.card}</pre>
          </details>
        </div>
      </div>
      <CardComposer
        draftKey={`project:${workId}`}
        place={{ kind: "work", workId }}
        notes={[]}
        onNotes={() => undefined}
        engine={engine}
        setEngine={setEngine}
        dropping={false}
        placeholder="이 프로젝트에서 새 세션 시작하기"
        hint="새 세션은 이 프로젝트의 노트(단계·결정·열린 질문)를 맥락 카드로 받습니다."
      />
      {stagesOpen ? <StageDialog api={api} stages={stages} onClose={() => setStagesOpen(false)} onSaved={() => load()} onError={onError} /> : null}
    </main>
  );
}
