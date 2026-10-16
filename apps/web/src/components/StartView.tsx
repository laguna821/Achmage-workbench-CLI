import { useCallback, useState } from "react";
import { PROVIDER_LABEL, type Provider, type Work } from "@workbench/contracts";
import { folderPath, type State } from "../state.ts";
import { Composer } from "./Composer.tsx";
import { Icon } from "./Icon.tsx";
import { MenuItem, Popover } from "./Popover.tsx";
import { ModelPicker, type ModelChoice } from "./ModelPicker.tsx";

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

export function EngineToggle({ value, onChange }: { value: Provider; onChange: (provider: Provider) => void }) {
  return (
    <div className="segmented" role="radiogroup" aria-label="엔진">
      {(["claude", "codex"] as const).map((provider) => (
        <button
          key={provider}
          type="button"
          role="radio"
          aria-checked={value === provider}
          className={value === provider ? "active" : ""}
          onClick={() => onChange(provider)}
        >
          {PROVIDER_LABEL[provider]}
        </button>
      ))}
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

export function StartView({
  state,
  folderId,
  onClearFolder,
  onStart,
  onOpenWork,
  pickFolder,
}: {
  state: State;
  folderId: string | null;
  onClearFolder: () => void;
  onStart: (text: string, provider: Provider, cwd: string | null, choice: ModelChoice) => Promise<boolean>;
  onOpenWork: (work: Work) => void;
  pickFolder: (() => Promise<string | null>) | null;
}) {
  const [engine, setEngine] = useEngineChoice();
  const [cwd, setCwd] = useState<string | null>(null);
  const [choice, setChoice] = useState<ModelChoice>({ model: null, effort: null });
  const works = Object.values(state.works).sort((a, b) => b.updatedAt - a.updatedAt);
  const recentFolders = [...new Set(works.filter((work) => !work.cwdManaged).map((work) => work.cwd))].slice(0, 5);
  const path = folderPath(state, folderId);

  return (
    <main className="start-view">
      <div className="column start-inner">
        <h1 className="start-title">무엇을 할까요?</h1>
        {path.length ? (
          <div className="start-folder">
            <Icon name="folder" size={14} />
            {path.map((folder) => folder.name).join(" / ")}에 새 작업
            <button type="button" className="icon-button small" onClick={onClearFolder} aria-label="분류 해제">
              <Icon name="x" size={12} />
            </button>
          </div>
        ) : null}
        <Composer
          draftKey={`new:${folderId ?? "root"}`}
          placeholder="새 작업의 첫 요청을 입력하세요"
          busy={false}
          autoFocus
          onSend={(text) => onStart(text, engine, cwd, choice)}
          target={
            <>
              <ModelPicker models={state.providers[engine]?.models ?? []} value={choice} onChange={setChoice} />
              <EngineToggle
                value={engine}
                onChange={(next) => {
                  setEngine(next);
                  setChoice({ model: null, effort: null });
                }}
              />
              <FolderChoice value={cwd} recent={recentFolders} onChange={setCwd} pickFolder={pickFolder} />
            </>
          }
        />
        {works.length ? (
          <div className="recent-works">
            <div className="section-label">최근 작업</div>
            {works.slice(0, 5).map((work) => (
              <button key={work.id} type="button" className="recent-work" onClick={() => onOpenWork(work)}>
                <Icon name="file" size={15} />
                <span>{work.title}</span>
                <span className="muted">{folderPath(state, work.folderId).map((folder) => folder.name).join(" / ")}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </main>
  );
}
