import { useCallback, useState } from "react";
import { PROVIDER_LABEL, isUnseen, type Provider, type Session, type Work } from "@workbench/contracts";
import { folderPath, type State } from "../state.ts";
import { nowSessions, sessionHidden, workDocs, workHidden, workSessions } from "../tree.ts";
import { ago, statusText, statusTone } from "../format.ts";
import { Wordmark } from "./BrandMark.tsx";
import { Composer } from "./Composer.tsx";
import { Icon } from "./Icon.tsx";
import { MenuItem, Popover } from "./Popover.tsx";
import { ModelPicker, type ModelChoice } from "./ModelPicker.tsx";
import { EngineMark } from "./EngineMark.tsx";
import { accentStyle, fontStack, useAppearance } from "../appearance.ts";

const ENGINE_KEY = "workbench.lastEngine";

export function useEngineChoice() {
  const [engine, setEngine] = useState<Provider>(() => (localStorage.getItem(ENGINE_KEY) as Provider | null) ?? "claude");
  return [
    engine,
    (next: Provider) => {
      localStorage.setItem(ENGINE_KEY, next);
      setEngine(next);
    },
  ] as const;
}

/**
 * Engine tabs above the input box. Each tab wears its engine's own look (mark, color, type), and the
 * selected engine's look covers the screen, so the choice is visible before anything is sent.
 */
export function EngineTabs({ value, onChange }: { value: Provider; onChange: (provider: Provider) => void }) {
  const { lookOf, openMenu } = useAppearance();
  return (
    <div className="engine-tabs" role="radiogroup" aria-label="엔진">
      {(["claude", "codex"] as const).map((provider) => {
        const look = lookOf(provider);
        return (
          <button
            key={provider}
            type="button"
            role="radio"
            aria-checked={value === provider}
            className="engine-tab"
            style={{ ...accentStyle(look), fontFamily: fontStack(look.font) }}
            onClick={() => onChange(provider)}
            onContextMenu={(event) => openMenu(event, provider)}
            title="오른쪽 클릭: 이 엔진의 외형"
          >
            <EngineMark provider={provider} size={19} />
            {PROVIDER_LABEL[provider]}
          </button>
        );
      })}
    </div>
  );
}

/** Pick a working folder: none (app-managed), a recent one, or a folder chosen in the system dialog. */
function FolderChoice({
  value,
  recent,
  onChange,
  pickFolder,
}: {
  value: string | null;
  recent: string[];
  onChange: (cwd: string | null) => void;
  pickFolder: (() => Promise<string | null>) | null;
}) {
  const [open, setOpen] = useState(false);
  const [typing, setTyping] = useState("");
  const close = useCallback(() => setOpen(false), []);
  const label = value ? value.split("/").filter(Boolean).slice(-1)[0] ?? value : "폴더 없이";
  return (
    <div className="anchor">
      <button type="button" className="select-button" onClick={() => setOpen(!open)} title={value ?? "앱이 이 작업 전용 폴더를 만듭니다"}>
        <Icon name="folder" size={14} />
        {label}
        <Icon name={open ? "chevronUp" : "chevronDown"} size={14} />
      </button>
      <Popover open={open} onClose={close} placement="above" align="right" className="folder-menu">
        <MenuItem
          active={value === null}
          hint="앱이 전용 폴더를 만듦"
          onSelect={() => {
            onChange(null);
            close();
          }}
        >
          폴더 없이 시작
        </MenuItem>
        {pickFolder ? (
          <MenuItem
            onSelect={() => {
              close();
              void pickFolder().then((picked) => picked && onChange(picked));
            }}
          >
            폴더 선택…
          </MenuItem>
        ) : null}
        {recent.length ? <div className="menu-label">최근 폴더</div> : null}
        {recent.map((path) => (
          <MenuItem
            key={path}
            active={value === path}
            onSelect={() => {
              onChange(path);
              close();
            }}
          >
            <span className="mono">{path}</span>
          </MenuItem>
        ))}
        {!pickFolder ? (
          <form
            className="menu-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (typing.trim()) {
                onChange(typing.trim());
                close();
              }
            }}
          >
            <input value={typing} onChange={(event) => setTyping(event.target.value)} placeholder="/home/…/폴더 경로" />
          </form>
        ) : null}
      </Popover>
    </div>
  );
}

// The logo comes in once per launch (not each time home is opened again).
let greeted = false;

/** One session as a line: what it is, where it is, its last reply or what it is doing. */
function SessionLine({ state, session, onOpen }: { state: State; session: Session; onOpen: (session: Session) => void }) {
  const work = state.works[session.workId];
  const busy = session.status !== "idle" && session.status !== "error";
  const tone = statusTone(session);
  return (
    <button type="button" className="home-session" onClick={() => onOpen(session)} title={`${session.purpose} · ${PROVIDER_LABEL[session.provider]}`}>
      <EngineMark provider={session.provider} size={15} />
      <span className="home-session-main">
        <span className="home-session-title">
          {work ? <span className="home-session-work">{work.title}</span> : null}
          {session.purpose}
        </span>
        <span className="home-session-preview">{busy ? statusText(session) : (session.preview ?? "아직 답이 없습니다")}</span>
      </span>
      <span className={`home-session-state tone-${tone}`}>
        {session.status === "awaitingApproval" ? "확인 필요" : busy ? "진행 중" : isUnseen(session) ? "새 답" : ago(session.previewAt ?? session.updatedAt)}
      </span>
    </button>
  );
}

/** What is going on across all works: needs you, running, new replies; then where to pick up. */
function HomeBoard({ state, onOpenSession, onOpenWork }: { state: State; onOpenSession: (session: Session) => void; onOpenWork: (work: Work) => void }) {
  const now = nowSessions(state, null);
  const live = [...now.attention, ...now.running, ...now.unseen];
  const shown = new Set(live.map((session) => session.id));
  const recent = Object.values(state.sessions)
    .filter((session) => !shown.has(session.id) && !sessionHidden(state, session) && session.previewAt)
    .sort((a, b) => (b.previewAt ?? 0) - (a.previewAt ?? 0))
    .slice(0, 6);
  const works = Object.values(state.works)
    .filter((work) => !workHidden(state, work))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 6);
  if (!live.length && !recent.length && !works.length) return null;
  return (
    <div className="home-board">
      {live.length ? (
        <section className="home-section" aria-label="지금">
          <h2 className="section-label">지금</h2>
          {live.map((session) => (
            <SessionLine key={session.id} state={state} session={session} onOpen={onOpenSession} />
          ))}
        </section>
      ) : null}
      {recent.length ? (
        <section className="home-section" aria-label="이어서 하기">
          <h2 className="section-label">이어서 하기</h2>
          {recent.map((session) => (
            <SessionLine key={session.id} state={state} session={session} onOpen={onOpenSession} />
          ))}
        </section>
      ) : null}
      {works.length ? (
        <section className="home-section" aria-label="작업">
          <h2 className="section-label">작업</h2>
          <div className="home-works">
            {works.map((work) => {
              const path = folderPath(state, work.folderId).map((folder) => folder.name).join(" / ");
              const sessions = workSessions(state, work.id).length;
              const docs = workDocs(state, work.id).length;
              return (
                <button key={work.id} type="button" className="home-work" onClick={() => onOpenWork(work)}>
                  <span className="home-work-title">
                    <Icon name="project" size={14} />
                    {work.title}
                  </span>
                  <span className="home-work-path">{path || "분류 없음"}</span>
                  <span className="home-work-meta">
                    세션 {sessions}
                    {docs ? ` · 문서 ${docs}` : ""} · {ago(work.updatedAt)}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
}

/**
 * Home: the brand, a new session right away (the input is ready at once, the logo only greets),
 * then what is going on across all works. With a folder picked from the sidebar it is just the
 * start of a new work there.
 */
export function StartView({
  state,
  folderId,
  onClearFolder,
  onStart,
  onOpenWork,
  onOpenSession,
  pickFolder,
  engine,
  setEngine,
  motion = true,
}: {
  state: State;
  folderId: string | null;
  onClearFolder: () => void;
  onStart: (text: string, provider: Provider, cwd: string | null, choice: ModelChoice) => Promise<boolean>;
  onOpenWork: (work: Work) => void;
  onOpenSession: (session: Session) => void;
  pickFolder: (() => Promise<string | null>) | null;
  engine: Provider;
  setEngine: (provider: Provider) => void;
  /** The logo's short entrance (off in settings or with reduced motion). */
  motion?: boolean;
}) {
  const [greet] = useState(() => {
    const first = !greeted;
    greeted = true;
    return first && motion;
  });
  const { openMenu } = useAppearance();
  const [cwd, setCwd] = useState<string | null>(null);
  const [choice, setChoice] = useState<ModelChoice>({ model: null, effort: null });
  const works = Object.values(state.works).sort((a, b) => b.updatedAt - a.updatedAt);
  const recentFolders = [...new Set(works.filter((work) => !work.cwdManaged).map((work) => work.cwd))].slice(0, 5);
  const path = folderPath(state, folderId);

  return (
    <main className="start-view" onContextMenu={(event) => openMenu(event, engine)}>
      <div className="column start-inner">
        <h1 className={`home-brand${greet ? " greet" : ""}`}>
          <Wordmark className="home-wordmark" title="Achmage" />
        </h1>
        {path.length ? (
          <div className="start-folder">
            <Icon name="folder" size={14} />
            {path.map((folder) => folder.name).join(" / ")}에 새 작업
            <button type="button" className="icon-button small" onClick={onClearFolder} aria-label="분류 해제">
              <Icon name="x" size={12} />
            </button>
          </div>
        ) : null}
        <EngineTabs
          value={engine}
          onChange={(next) => {
            setEngine(next);
            setChoice({ model: null, effort: null });
          }}
        />
        <Composer
          draftKey={`new:${folderId ?? "root"}`}
          placeholder="새 작업의 첫 요청을 입력하세요"
          busy={false}
          autoFocus
          onSend={(text) => onStart(text, engine, cwd, choice)}
          target={
            <>
              <ModelPicker models={state.providers[engine]?.models ?? []} value={choice} onChange={setChoice} />
              <FolderChoice value={cwd} recent={recentFolders} onChange={setCwd} pickFolder={pickFolder} />
            </>
          }
        />
        {path.length ? null : <HomeBoard state={state} onOpenSession={onOpenSession} onOpenWork={onOpenWork} />}
        {/* Attribution Assurance License: shown each time the app starts (the design editor is doory). */}
        <p className="start-credit">
          디자인 편집기: Doory by Siam, creator and maintainer of Doory,{" "}
          <a href="https://github.com/shaongitbd/doory" target="_blank" rel="noreferrer">
            https://github.com/shaongitbd/doory
          </a>
        </p>
      </div>
    </main>
  );
}
