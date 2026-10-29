import { useCallback, useEffect, useMemo, useState } from "react";
import { PROVIDER_LABEL, type HomeViews, type ProjectPick, type Provider, type Session, type Work } from "@workbench/contracts";
import type { Api } from "../api.ts";
import { entryClient, pickedWork } from "../entry.ts";
import { folderPath, type State } from "../state.ts";
import { readHomeMode, type HomeMode } from "../overview.ts";
import { workHidden } from "../tree.ts";
import { Wordmark } from "./BrandMark.tsx";
import { Composer } from "./Composer.tsx";
import { HomeModes } from "./HomeModes.tsx";
import { Icon } from "./Icon.tsx";
import { MenuItem, Popover } from "./Popover.tsx";
import { ModelPicker, type ModelChoice } from "./ModelPicker.tsx";
import { EngineMark } from "./EngineMark.tsx";
import { ProjectChoice } from "./ProjectChoice.tsx";
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

// The logo comes in once per launch (not each time home is opened again).
let greeted = false;

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
  motion = true,
}: {
  state: State;
  folderId: string | null;
  onClearFolder: () => void;
  /** `pick`: where the request goes ("auto": the folder's live work, else a new project). */
  onStart: (text: string, provider: Provider, cwd: string | null, choice: ModelChoice, pick: ProjectPick) => Promise<boolean>;
  onOpenWork: (work: Work) => void;
  /** A project's page (home "프로젝트"). */
  onOpenProject?: (work: Work) => void;
  /** With a request's item id (home "흐름"), the conversation opens at that request. */
  onOpenSession: (session: Session, itemId?: string) => void;
  onOpenDoc: (artifactId: string) => void;
  api: Api;
  /** The overview mode kept in the screen preferences (지금 · 보드 · 지도 · 흐름 · 문서). */
  homeMode: unknown;
  onHomeMode: (mode: HomeMode) => void;
  /** Each mode's views (screen preferences `homeViews`). */
  homeViews?: unknown;
  onHomeViews?: (views: HomeViews) => void;
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
  // The overview needs something to show; a first launch is just the brand and the input.
  const board = !path.length && Object.values(state.works).some((work) => !workHidden(state, work));
  /* Attribution Assurance License: shown each time the app starts (the design editor is doory). */
  const credit = (
    <p className="start-credit">
      디자인 편집기: Doory by Siam, creator and maintainer of Doory,{" "}
      <a href="https://github.com/shaongitbd/doory" target="_blank" rel="noreferrer">
        https://github.com/shaongitbd/doory
      </a>
    </p>
  );

  return (
    <main className={`start-view${board ? " with-board" : ""}`} onContextMenu={(event) => openMenu(event, engine)}>
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
          placeholder={target ? "새 세션의 첫 요청을 입력하세요" : "새 작업의 첫 요청을 입력하세요"}
          busy={false}
          autoFocus
          onSend={(text) => onStart(text, engine, cwd, choice, pick)}
          target={
            <>
              <ModelPicker models={state.providers[engine]?.models ?? []} value={choice} onChange={setChoice} />
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
        {board ? null : credit}
      </div>
      {board ? (
        <HomeModes
          api={api}
          state={state}
          mode={readHomeMode(homeMode)}
          onMode={onHomeMode}
          views={homeViews}
          onViews={onHomeViews}
          onOpenSession={onOpenSession}
          onOpenWork={onOpenWork}
          onOpenProject={onOpenProject}
          onOpenDoc={onOpenDoc}
          footer={<div className="column">{credit}</div>}
        />
      ) : null}
    </main>
  );
}
