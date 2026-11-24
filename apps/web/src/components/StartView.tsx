import { useCallback, useEffect, useMemo, useState } from "react";
import { PROVIDER_LABEL, type HomeViews, type ProjectPick, type Provider, type ProviderStatus, type Session, type Work } from "@workbench/contracts";
import type { Api } from "../api.ts";
import { entryClient, pickedWork } from "../entry.ts";
import { folderPath, type State } from "../state.ts";
import { readHomeMode, type HomeMode } from "../overview.ts";
import { BrowseStart } from "./BrowseStart.tsx";
import { Composer } from "./Composer.tsx";
import { HomeModes } from "./HomeModes.tsx";
import { Icon } from "./Icon.tsx";
import { MenuItem, Popover } from "./Popover.tsx";
import { ModelPicker, type ModelChoice } from "./ModelPicker.tsx";
import { engineChoices } from "../engines.ts";
import { EngineMark } from "./EngineMark.tsx";
import { ProjectChoice } from "./ProjectChoice.tsx";
import { useAppearance } from "../appearance.ts";
import { Segmented } from "./ui/Hig.tsx";
import { NoteBanner } from "../conversation/NoteBanner.tsx";

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
 * The engine a new request goes to: a pair of keys, the held one carrying its engine's mark (one mark
 * per row: the mark says which is chosen, the other is a name). In a request row it stands where the
 * conversation's engine control stands, at the right beside send (Hallmark merge: one row language).
 */
/** `ready`: an engine that is not connected carries no mark, so its key does not look ready (I6). */
/** `engines`: which keys show (Gemini only once it is found, engines.ts); Claude and Codex by default. */
export function EngineTabs({ value, onChange, ready, engines = ["claude", "codex"] }: { value: Provider; onChange: (provider: Provider) => void; ready?: (provider: Provider) => boolean; engines?: readonly Provider[] }) {
  return <Segmented className="engine-tabs" value={value} onChange={onChange} label="엔진" options={engines.map(provider => ({ value: provider, label: <>{provider === value && (ready?.(provider) ?? true) ? <EngineMark provider={provider} size={15} /> : null}{PROVIDER_LABEL[provider]}</> }))} />;
}

const engineReady = (status: ProviderStatus | undefined) => Boolean(status?.installed && status.loggedIn);
/** No engine can take a request yet: both were looked for (at least one answered) and none is installed and signed in. */
export function noEngineReady(providers: Partial<Record<Provider, ProviderStatus>> | undefined) {
  const found = Object.values(providers ?? {});
  return found.length > 0 && !found.some(engineReady);
}
/** 지금 with no engine connected: one line above the request row, and the way to connect one. */
export function EngineMissing({ onConnect }: { onConnect?: () => void }) {
  return <NoteBanner label="AI 엔진" action={onConnect ? { label: "AI 엔진 연결", run: onConnect } : undefined}>AI 엔진이 아직 연결되지 않았습니다. 연결하면 여기서 바로 일을 맡길 수 있습니다.</NoteBanner>;
}

/** Pick a working folder: none (app-managed), a recent one, or a folder chosen in the system dialog. */
function FolderChoice({
  value,
  recent,
  onChange,
  pickFolder,
  project,
}: {
  value: string | null;
  recent: string[];
  onChange: (cwd: string | null) => void;
  pickFolder: (() => Promise<string | null>) | null;
  /** A project picked by hand: its folder is shown (picking a folder here goes back to that folder's default). */
  project?: Work | null;
}) {
  const [open, setOpen] = useState(false);
  const [typing, setTyping] = useState("");
  const close = useCallback(() => setOpen(false), []);
  const shown = project ? (project.cwdManaged ? null : project.cwd) : value;
  const label = project?.cwdManaged ? "앱 폴더" : shown ? shown.split("/").filter(Boolean).slice(-1)[0] ?? shown : "폴더 없이";
  return (
    <div className="anchor">
      <button type="button" className="select-button" onClick={() => setOpen(!open)} title={project ? project.cwd : (value ?? "앱이 이 작업 전용 폴더를 만듭니다")}>
        <Icon name="folder" size={14} />
        {label}
        <Icon name={open ? "chevronUp" : "chevronDown"} size={14} />
      </button>
      <Popover open={open} onClose={close} placement="above" align="right" className="folder-menu">
        <MenuItem
          active={!project && value === null}
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
            active={shown === path}
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

/**
 * Home: today's ledger (what waits on the person, then new answers, then where they left off),
 * the request row on its lower edge. The wordmark stays in the top bar. With a folder picked from
 * the sidebar it is just the start of a new work there.
 */
export function StartView({
  state,
  folderId,
  draftKey,
  autoFocus = true,
  onClearFolder,
  onStart,
  onOpenWork,
  onOpenBrowser,
  onOpenProject,
  onOpenSession,
  onOpenDoc,
  api,
  homeMode,
  onHomeMode,
  homeViews,
  onHomeViews,
  pickFolder,
  engine,
  setEngine,
  onConnectEngine,
}: {
  state: State;
  folderId: string | null;
  draftKey?: string;
  autoFocus?: boolean;
  onClearFolder: () => void;
  /** `pick`: where the request goes ("auto": the folder's live work, else a new project). */
  onStart: (text: string, provider: Provider, cwd: string | null, choice: ModelChoice, pick: ProjectPick) => Promise<boolean>;
  onOpenWork: (work: Work) => void;
  onOpenBrowser?: (address: string) => Promise<boolean>;
  /** A project's page (home "프로젝트"). */
  onOpenProject?: (work: Work) => void;
  /** With a request's item id (home "흐름"), the conversation opens at that request. */
  onOpenSession: (session: Session, itemId?: string) => void;
  onOpenDoc: (artifactId: string) => void;
  api: Api;
  /** The overview mode kept in the screen preferences (지금 · 프로젝트 · 흐름 · 문서). */
  homeMode: unknown;
  onHomeMode: (mode: HomeMode) => void;
  /** Each mode's views (screen preferences `homeViews`). */
  homeViews?: unknown;
  onHomeViews?: (views: HomeViews) => void;
  pickFolder: (() => Promise<string | null>) | null;
  engine: Provider;
  setEngine: (provider: Provider) => void;
  /** 설정 › AI 엔진 (the line shown when no engine is connected). */
  onConnectEngine?: () => void;
  /** The logo's short entrance (off in settings or with reduced motion). Home no longer shows the
   * wordmark (it stays in the top bar), so nothing here enters; kept for the caller's wiring. */
  motion?: boolean;
  /** Whether the home wordmark is on screen in this view: never now, so this is not called. */
  onHero?: (shown: boolean) => void;
}) {
  const { openMenu } = useAppearance();
  const [cwd, setCwd] = useState<string | null>(null);
  const [choice, setChoice] = useState<ModelChoice>({ model: null, effort: null });
  // "같은 폴더 = 같은 프로젝트": a folder that already has a live work sends there unless picked otherwise.
  const client = useMemo(() => entryClient(api), [api]);
  const [pick, setPick] = useState<ProjectPick>({ kind: "auto" });
  const [folderWork, setFolderWork] = useState<Work | null>(null);
  useEffect(() => {
    setFolderWork(null);
    if (!cwd) return;
    let stale = false;
    void client
      .workAt(cwd)
      .then((found) => !stale && setFolderWork(found))
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [client, cwd]);
  const target = pickedWork(state, pick, folderWork);
  const works = Object.values(state.works).sort((a, b) => b.updatedAt - a.updatedAt);
  const recentFolders = [...new Set(works.filter((work) => !work.cwdManaged).map((work) => work.cwd))].slice(0, 5);
  const path = folderPath(state, folderId);
  // Home navigation is available from the first launch, including its empty views.
  // A folder-specific "new work" remains a composer, not the all-projects overview.
  const board = !path.length;
  const mode = readHomeMode(homeMode);
  // The request: the conversation's own quiet row (Composer with `engine`, Hallmark U5): the words,
  // then 도구 ……… the engine │ send. The model, the folder and the project the request goes to wait in
  // 도구's sheet, each with its own label and menu; what is set there is named on the closed key.
  // On home it sits on the ledger's lower edge; with a folder picked it is the page's one thing.
  const folderName = cwd ? cwd.split("/").filter(Boolean).slice(-1)[0] ?? cwd : null;
  const missing = noEngineReady(state.providers) ? <EngineMissing onConnect={onConnectEngine} /> : null;
  const request = (
    <BrowseStart onSearch={onOpenBrowser} autoFocus={autoFocus} initialMode="ask">
      <Composer
        provider={engine}
        draftKey={draftKey ?? `new:${folderId ?? "root"}`}
        placeholder={target ? "이 프로젝트에서 할 일을 입력하세요" : "AI에게 맡길 일을 입력하세요"}
        busy={false}
        autoFocus={autoFocus}
        onSend={(text) => onStart(text, engine, cwd, choice, pick)}
        engine={
          <EngineTabs
            value={engine}
            engines={engineChoices(state.providers)}
            ready={(provider) => engineReady(state.providers[provider])}
            onChange={(next) => {
              setEngine(next);
              setChoice({ model: null, effort: null });
            }}
          />
        }
        toolsOn={[...(choice.model ? [choice.model] : []), ...(folderName ? [folderName] : []), ...(pick.kind === "work" && target ? [target.title] : [])]}
        target={<ModelPicker models={state.providers[engine]?.models ?? []} value={choice} onChange={setChoice} onRefresh={() => api.refreshProviders(engine)} />}
        tools={
          <>
            <FolderChoice
              value={cwd}
              recent={recentFolders}
              onChange={(next) => {
                setCwd(next);
                setPick({ kind: "auto" });
              }}
              pickFolder={pickFolder}
              project={pick.kind === "work" ? target : null}
            />
            <ProjectChoice state={state} target={target} folderWork={folderWork} hasFolder={Boolean(cwd)} onChange={setPick} />
          </>
        }
      />
    </BrowseStart>
  );

  // A folder picked from the sidebar: a page with one job, a new work in that folder.
  const entry = (
    <div className="column start-inner">
      <header className="home-head">
        <div className="home-head-title">
          <h1 className="home-title">{path.at(-1)?.name ?? "새 작업"}</h1>
        </div>
      </header>
      <div className="start-folder">
        <Icon name="folder" size={14} />
        {path.map((folder) => folder.name).join(" / ")}에 새 작업
        <button type="button" className="icon-button small" onClick={onClearFolder} aria-label="분류 해제">
          <Icon name="x" size={12} />
        </button>
      </div>
      <section className="home-request" aria-label="새 요청">
        {missing}
        {request}
      </section>
    </div>
  );

  return (
    <main className={`start-view${board ? " with-board" : ""}`} onContextMenu={(event) => openMenu(event, engine)}>
      {board ? (
        <HomeModes
          api={api}
          state={state}
          mode={mode}
          onMode={onHomeMode}
          views={homeViews}
          onViews={onHomeViews}
          onOpenSession={onOpenSession}
          onOpenWork={onOpenWork}
          onOpenProject={onOpenProject}
          onOpenDoc={onOpenDoc}
          dock={mode === "now" ? <section className="home-request" aria-label="새 요청">{missing}{request}</section> : null}
        />
      ) : entry}
    </main>
  );
}
