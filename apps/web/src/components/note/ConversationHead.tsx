import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { BLANK_OFFICE_DOCUMENTS, EFFORT_LABEL, PROVIDER_LABEL, type Session, type Work } from "@workbench/contracts";
import type { Api } from "../../api.ts";
import type { Notify } from "../../top-notice.ts";
import { folderPath, type State } from "../../state.ts";
import { sessionLabel, statusText, statusTone } from "../../format.ts";
import { EditableText } from "../EditableText.tsx";
import { EngineMark } from "../EngineMark.tsx";
import { Icon } from "../Icon.tsx";
import { NoteTitle } from "./NoteTitle.tsx";
import { nextModel, plainModelLabel, type Inherited } from "../ModelPicker.tsx";
import { useOfficeFiles } from "../OfficeFileMenu.tsx";
import { WorkspacePicker } from "../WorkspacePicker.tsx";
import { AnchoredLayer } from "../ui/AnchoredLayer.tsx";
import { ListLayer, MenuGroup, MenuItem, MenuLabel, MenuSeparator } from "../ui/Menu.tsx";
import type { WorkActions } from "../WorkView.tsx";

/** Sizes a new design starts with (the gateway knows the same ids). */
const DESIGN_PRESETS = [
  { id: "square", label: "정사각 (SNS)", size: "1080×1080" },
  { id: "portrait", label: "카드뉴스", size: "1080×1350" },
  { id: "story", label: "세로 (스토리)", size: "1080×1920" },
  { id: "wide", label: "가로 (썸네일·화면)", size: "1920×1080" },
  { id: "a4", label: "A4 문서", size: "794×1123" },
];

type MenuView = "main" | "new" | "design" | "folder";
type Place = "head" | "band";

/** Folders in tree order, for "분류 옮기기". */
function folderOptions(state: State) {
  const options: { id: string; name: string; depth: number }[] = [];
  const walk = (parentId: string | null, depth: number) => {
    Object.values(state.folders)
      .filter((folder) => folder.parentId === parentId)
      .sort((a, b) => a.sort - b.sort)
      .forEach((folder) => {
        options.push({ id: folder.id, name: folder.name, depth });
        walk(folder.id, depth + 1);
      });
  };
  walk(null, 0);
  return options;
}

type NoteContext = {
  api: Api;
  state: State;
  work: Work;
  session: Session | null;
  actions: WorkActions;
  cwd: string;
  pickFile: ((folder: string) => Promise<string | null>) | null;
  onToast: Notify;
  onRename: () => void;
  /** 읽기 and 검토 of the project's open document, from the conversation (the old bar under the input). */
  docModes?: DocModes;
};

/** The project's document the conversation's 읽기 and 검토 are about. `onReview` null: no proposal to review. */
export type DocModes = { artifactId: string; name: string; onRead: () => void; onReview: (() => void) | null };

/**
 * The note's ⋯ menu: one definition, opened from the head or from the pinned band (when the head
 * has scrolled away). `trigger(place)` is its button in that place; `layers` the menu itself.
 */
export function useNoteMenu({ api, state, work, session, actions, cwd, pickFile, onToast, onRename, docModes }: NoteContext) {
  const [openAt, setOpenAt] = useState<Place | null>(null);
  const [view, setView] = useState<MenuView>("main");
  const [pathOpen, setPathOpen] = useState(false);
  const [path, setPath] = useState("");
  const head = useRef<HTMLButtonElement>(null);
  const band = useRef<HTMLButtonElement>(null);
  const [lastPlace, setLastPlace] = useState<Place>("head");
  const anchor = lastPlace === "band" ? band : head;
  const workspace = state.workspaces[session?.workspaceId ?? work.defaultWorkspaceId ?? ""];
  const files = useOfficeFiles({ api, workId: work.id, workspaceId: workspace?.id, sessionId: session?.id, cwd, sourceKey: work.id, pickFile, onOpenArtifact: actions.openArtifact, onToast }, anchor);
  const artifacts = Object.values(state.artifacts)
    .filter((artifact) => artifact.workId === work.id)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const filed = folderPath(state, work.folderId).map((folder) => folder.name).join(" / ");
  const go = (next: MenuView) => () => setView(next);
  const back = <MenuItem icon="arrowLeft" keepOpen onSelect={go("main")}>뒤로</MenuItem>;
  const close = () => { setOpenAt(null); setView("main"); };
  const openAtNow = useRef(openAt);
  openAtNow.current = openAt;
  // The band leaves when the head scrolls back into view: a menu opened from it closes with it
  // instead of hanging where its button was.
  const bandRef = useCallback((element: HTMLButtonElement | null) => {
    band.current = element;
    if (!element && openAtNow.current === "band") { setOpenAt(null); setView("main"); }
  }, []);

  const trigger = (place: Place) => (
    <button type="button" ref={place === "band" ? bandRef : head} className={`icon-button small note-head-more${place === "band" ? " in-band" : ""}`}
      aria-label="노트 메뉴" title="문서 · 파일 · 분류" aria-haspopup="menu" aria-expanded={openAt === place}
      onClick={() => { setView("main"); setLastPlace(place); setOpenAt(openAt === place ? null : place); }}
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault(); setView("main"); setLastPlace(place); setOpenAt(place);
      }}>
      <Icon name="dots" size={16} />
    </button>
  );

  const layers = (
    <>
      {/* The shared menu's list engine: a drill-in swaps the items, and the first becomes active. */}
      <ListLayer role="menu" open={openAt !== null} anchor={anchor} onClose={close} label="노트 메뉴" className="note-menu" align="end" resetKey={view}>
        {view === "main" ? (
          <>
            <MenuGroup label={`이 작업의 문서${artifacts.length ? ` ${artifacts.length}` : ""}`}>
              {artifacts.map((artifact) => (
                <MenuItem key={artifact.id} icon="file" hint={`r${artifact.revision}`} onSelect={() => actions.openArtifact(artifact.id)}>{artifact.name}</MenuItem>
              ))}
            </MenuGroup>
            {!artifacts.length ? <MenuLabel>AI가 만든 문서나 연 파일이 여기에 모입니다.</MenuLabel> : null}
            {docModes ? (
              <>
                <MenuItem icon="book" hint="Alt+5" onSelect={docModes.onRead}>읽기 · {docModes.name}</MenuItem>
                <MenuItem icon="eye" hint={docModes.onReview ? "Alt+3" : undefined} disabled={!docModes.onReview} disabledReason="수정안 없음" onSelect={() => docModes.onReview?.()}>검토 · {docModes.name}</MenuItem>
              </>
            ) : null}
            <MenuItem icon="plus" more keepOpen onSelect={go("new")}>새 문서</MenuItem>
            <MenuItem icon="palette" more keepOpen onSelect={go("design")}>새 디자인</MenuItem>
            <MenuItem icon="folderOpen" disabled={files.busy} onSelect={() => (files.canPick ? files.pick() : setPathOpen(true))}>{files.busy ? "준비 중…" : "파일 열기…"}</MenuItem>
            <MenuSeparator />
            <MenuItem icon="folder" more keepOpen hint={filed || "분류 없음"} onSelect={go("folder")}>분류 옮기기</MenuItem>
            {session ? <MenuItem icon="edit" onSelect={onRename}>이름 바꾸기</MenuItem> : null}
          </>
        ) : view === "new" ? (
          <>
            {back}
            <MenuSeparator />
            {BLANK_OFFICE_DOCUMENTS.map((kind) => <MenuItem key={kind.format} hint={`.${kind.extension}`} onSelect={() => files.create(kind.format)}>{kind.label}</MenuItem>)}
          </>
        ) : view === "design" ? (
          <>
            {back}
            <MenuSeparator />
            {DESIGN_PRESETS.map((preset) => (
              <MenuItem key={preset.id} hint={preset.size} onSelect={() => void actions.newDesign(work, preset.id, workspace?.id)}>{preset.label}</MenuItem>
            ))}
          </>
        ) : (
          <>
            {back}
            <MenuSeparator />
            <MenuLabel>실제 파일 위치는 그대로입니다</MenuLabel>
            <MenuItem type="radio" checked={!work.folderId} onSelect={() => actions.moveWork(work, null)}>분류 없음</MenuItem>
            {folderOptions(state).map((option) => (
              <MenuItem key={option.id} type="radio" checked={work.folderId === option.id} onSelect={() => actions.moveWork(work, option.id)}>
                <span style={{ paddingLeft: option.depth * 14 }}>{option.name}</span>
              </MenuItem>
            ))}
          </>
        )}
      </ListLayer>
      <AnchoredLayer open={pathOpen} onClose={() => setPathOpen(false)} anchor={anchor} align="end" label="파일 열기" className="note-path-layer">
        <form className="note-path-form" onSubmit={(event) => {
          event.preventDefault();
          if (!path.trim()) return;
          files.openPath(path.trim());
          setPath("");
          setPathOpen(false);
        }}>
          <input aria-label="열 문서 경로" value={path} onChange={(event) => setPath(event.target.value)} placeholder="작업 폴더 기준 파일 경로" />
          <button type="submit" className="button small" disabled={!path.trim()}>열기</button>
        </form>
      </AnchoredLayer>
    </>
  );
  return { trigger, layers };
}

/** The session's state as a property: a dot and a word. */
export function StatusProp({ session }: { session: Session }) {
  return <span className="note-prop note-prop-status"><span className={`dot dot-${statusTone(session)}`} aria-hidden /><span>{statusText(session)}</span></span>;
}

/** Working in an isolated git copy: always said, and the way to review its changes. */
export function WorktreeProp({ session, actions }: { session: Session; actions: WorkActions }) {
  if (!session.worktree) return null;
  return (
    <button type="button" className="note-prop worktree-chip" title={`격리 사본: ${session.worktree.path} · 변경 검토`} onClick={() => actions.reviewWorktree(session)}>
      <Icon name="layers" size={14} /><span>격리 사본 <code>{session.worktree.branch}</code></span>
    </button>
  );
}

/**
 * The conversation's head, as a note's: its name as the inline title, its properties on one line
 * (project · engine · model · folder · status), the read/raw switch and the ⋯ menu.
 */
export function ConversationHead({ state, work, session, actions, cwd, raw, onRaw, menuButton, renaming, onRenaming, inherited, readOnly = false }: {
  state: State;
  work: Work;
  session: Session | null;
  actions: WorkActions;
  cwd: string;
  raw: boolean;
  onRaw: (raw: boolean) => void;
  /** The ⋯ menu's button (from `useNoteMenu`). */
  menuButton: ReactNode;
  renaming: boolean;
  onRenaming: (renaming: boolean) => void;
  /** Model and effort a role gives the session (as the input's model picker shows them). */
  inherited?: Inherited;
  /** The conversation takes no requests (archived, or its document removed): there is no input to point at. */
  readOnly?: boolean;
}) {
  const engine = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLElement>(null);
  const [details, setDetails] = useState(false);
  const models = session ? state.providers[session.provider]?.models ?? [] : [];
  const next = session ? nextModel(models, { model: session.model, effort: session.effort }, inherited) : null;
  // The same plain name the input shows (a default is marked in the menu, not here).
  const modelLabel = next ? `${plainModelLabel(next.selected.label)}${next.fromRole ? " · 역할" : ""}` : null;
  // The last answer came from another model than the next request will use: say which is which.
  const changed = Boolean(session?.engineModel && next && session.engineModel !== next.selected.id && session.engineModel !== next.selected.resolvedModel);
  const filed = folderPath(state, work.folderId).map((folder) => folder.name).join(" / ");
  const title = session ? sessionLabel(session) : work.title;
  // Renaming from the band's menu: bring the title back into view.
  useEffect(() => { if (renaming) root.current?.scrollIntoView?.({ block: "nearest" }); }, [renaming]);

  return (
    <header className="note-head" data-kind="chat" ref={root}>
      <NoteTitle
        icon={session?.pageAgent ? "globe" : "chat"}
        title={title}
        hint={session ? "두 번 눌러 이름 바꾸기" : undefined}
        onDoubleClick={session ? () => onRenaming(true) : undefined}
        editor={renaming && session ? <EditableText className="note-title-edit" label="대화 이름" value={session.purpose || title} onSave={(purpose) => actions.renameSession(session, purpose)} onDone={() => onRenaming(false)} /> : undefined}
        tools={
          <>
            {session ? (
              <button type="button" className={`icon-button small note-raw-toggle${raw ? " pressed" : ""}`} aria-pressed={raw} aria-label="원문(md) 보기"
                title={raw ? "읽기로 돌아가기" : "원문(md) 보기 · 내보내는 마크다운 그대로"} onClick={() => onRaw(!raw)}>
                <Icon name="markdown" size={16} />
              </button>
            ) : null}
            {menuButton}
          </>
        }
      />
      <ul className="note-props" aria-label="속성">
        <li>
          <button type="button" className="note-prop project-link" onClick={() => actions.openProject(work)} title={`${filed ? `${filed} / ` : ""}${work.title} · 프로젝트 노트 열기`}>
            <Icon name="project" size={14} /><span>{work.title}</span>
          </button>
        </li>
        {session ? (
          <li>
            <button type="button" ref={engine} className="note-prop" aria-expanded={details} aria-haspopup="dialog" title="세션 상세" onClick={() => setDetails(!details)}>
              <EngineMark provider={session.provider} size={14} /><span>{PROVIDER_LABEL[session.provider]}</span>
            </button>
            <AnchoredLayer open={details} onClose={() => setDetails(false)} anchor={engine} label="세션 상세" className="status-detail">
              <dl>
                <dt>세션</dt>
                <dd>{sessionLabel(session)}</dd>
                <dt>모델</dt>
                <dd>{modelLabel}{changed ? <span className="muted"> · 다음 요청부터</span> : null}</dd>
                <dt>추론 강도</dt>
                <dd>{next?.effortLabel ?? "모델 기본값"}</dd>
                {session.engineModel ? (
                  <>
                    <dt>최근 응답</dt>
                    <dd className="mono">{session.engineModel}{session.engineEffort ? ` · ${EFFORT_LABEL[session.engineEffort] ?? session.engineEffort}` : ""}</dd>
                  </>
                ) : null}
                <dt>실행 위치</dt>
                <dd>{state.hostLabel}</dd>
                <dt>작업 폴더</dt>
                <dd className="mono">{cwd}</dd>
                {session.lastError ? (
                  <>
                    <dt>마지막 오류</dt>
                    <dd>{session.lastError}</dd>
                  </>
                ) : null}
              </dl>
            </AnchoredLayer>
          </li>
        ) : null}
        {/* A read-only conversation has no input to change it in, and no next request. */}
        {session ? <li><span className="note-prop" title={readOnly ? "모델" : "다음 요청의 모델 · 입력창에서 바꿉니다"}>{modelLabel}</span></li> : null}
        <li className="note-prop-workspace"><WorkspacePicker state={state} work={work} session={session} actions={actions} /></li>
        {session ? <li><StatusProp session={session} /></li> : null}
        {session?.worktree ? <li><WorktreeProp session={session} actions={actions} /></li> : null}
      </ul>
    </header>
  );
}
