import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { failure, type Notify } from "../top-notice.ts";
import { PROVIDER_LABEL, accessFor, type BrowserPage, type AccessMode, type AgentProfile, type Attachment, type CreateTarget, type DocRef, type EngineCommand, type Provider, type Session, type UiPrefs, type Work, type Workspace, type UpdateWorkspaceRequest } from "@workbench/contracts";
import type { ReactNode } from "react";
import type { MentionItem } from "../mention.ts";
import { CreateChip, CreateTargetButton, stemOf } from "./CreateTarget.tsx";
import { isBusy, sessionsOf, turnRunning, type State } from "../state.ts";
import { sessionLabel, statusText, statusTone } from "../format.ts";
import { Composer } from "./Composer.tsx";
import { readDraft } from "../draft.ts";
import { ChangeChip } from "./project/ChangeChip.tsx";
import { EditableText } from "./EditableText.tsx";
import { ModelPicker, type ModelChoice } from "./ModelPicker.tsx";
import { AgentProfilePicker } from "./AgentProfilePicker.tsx";
import { Icon } from "./Icon.tsx";
import { MenuItem, Popover } from "./Popover.tsx";
import { EngineMark } from "./EngineMark.tsx";
import { EngineTabs } from "./StartView.tsx";
import { accentStyle, useAppearance } from "../appearance.ts";
import { useUnseen } from "./SessionCards.tsx";
import { workSessions } from "../tree.ts";
import { Transcript } from "./Transcript.tsx";
import { AccessPicker, ContextGauge } from "./SessionControls.tsx";
import { PendingFiles, usePendingFiles } from "./Attachments.tsx";
import { PlanToggle } from "./PlanFirst.tsx";
import "../styles/worktrees.css";
import { DrawChip, DrawPill, type DrawState } from "./ImageGen.tsx";
import { readDrawChoice, writeDrawChoice } from "../imagegen.ts";
import { LinkBar } from "./LinkBar.tsx";
import { BrowserPill, type BrowserActions } from "./BrowserPill.tsx";
import type { ModeProps } from "../workmodes.ts";
import { VaultGuardPill } from "./pkm/VaultGuardPill.tsx";
import { NoteChips } from "./pkm/NoteChips.tsx";
import { paneDrag, usePaneActions, useNoteDrop } from "../panedrag.ts";
import type { Api } from "../api.ts";
import { ConversationHead, StatusProp, WorktreeProp, useNoteMenu, type DocModes } from "./note/ConversationHead.tsx";
import { RawNote } from "./note/RawNote.tsx";
import { useDocumentReferences } from "../document-references.ts";
import { NoteBanner } from "../conversation/NoteBanner.tsx";
import { DocContext, useDocs } from "./DocCards.tsx";
import { ChildWork } from "./companion/ChildWork.tsx";
import { childWork } from "../companion.ts";

export type WorkActions = {
  /** Send a request; while the engine works it steers into the turn or waits ("queue"). `notes`: vault notes read with it. */
  send: (session: Session, text: string, refs?: DocRef[], create?: CreateTarget | null, mode?: "auto" | "queue", attachments?: Attachment[], plan?: boolean, omitChanges?: string[], notes?: string[]) => Promise<boolean>;
  /** Keep a pasted or dropped file for the requesting composer's project (null: it could not). */
  upload: (file: File, workId: string) => Promise<Attachment | null>;
  /** "이 요청 전으로": a new session up to that request, opened with the request in its input. */
  fork: (session: Session, itemId: string) => void;
  /** The desktop clipboard's picture (a screenshot pasted in the desktop app), or null. */
  clipboardPicture: () => Promise<File | null>;
  /** "/" in the input: the engine's commands and skills for this session (empty when unavailable). */
  commands: (session: Session) => Promise<EngineCommand[]>;
  queued: {
    send: (session: Session, queuedId: string) => void;
    edit: (session: Session, queuedId: string, text: string) => void;
    cancel: (session: Session, queuedId: string) => void;
  };
  handoff: (source: Session, target: Session, text: string, refs?: DocRef[], attachments?: Attachment[]) => Promise<boolean>;
  /** "그림": draw the request with GPT Image through Codex; the picture shows in this conversation. */
  draw: (session: Session, brief: string, draw: DrawState) => Promise<boolean>;
  pickSession: (work: Work, exclude: Session | null) => Promise<Session | null>;
  openArtifact: (artifactId: string) => void;
  /** A document opened from this conversation (a card, a 연결 row): beside it, in its tab. */
  openBeside: (artifactId: string, proposalId?: string) => void;
  /** A web page opened from this conversation's 연결: beside it. False: there is no conversation to put it beside. */
  openPageBeside: (pageId: string) => boolean;
  openFile: (work: Work, path: string, workspaceId?: string) => Promise<void>;
  newDesign: (work: Work, preset: string, workspaceId?: string) => Promise<void>;
  interrupt: (session: Session) => void;
  answer: (session: Session, itemId: string, decision: "accept" | "decline", response?: import("@workbench/contracts").OfficeInteractionResponse) => void;
  newSession: (work: Work, provider: Provider, choice?: ModelChoice, options?: { browser?: boolean; worktree?: boolean; workspaceId?: string }) => Promise<Session | null>;
  createWorkspace: (work: Work, cwd: string) => Promise<Workspace | null>;
  updateWorkspace: (workspace: Workspace, patch: UpdateWorkspaceRequest) => Promise<Workspace | null>;
  openWorkspace: (workspace: Workspace | null) => Promise<boolean>;
  openTerminals: (workspace: Workspace) => void;
  openServices: (workspace: Workspace) => void;
  openBrowser: (workspace: Workspace) => void;
  prepareWorkspace: (workspace: Workspace) => void;
  reviewWorkspace: (workspace: Workspace) => void;
  workspaceGit: Pick<Api, "workspaceRepository" | "connectWorktree" | "worktreeCreations" | "createWorktreeWorkspace" | "cancelWorktreeCreation">;
  /** "변경 검토" of a session working in a git worktree ("격리 사본"). */
  reviewWorktree: (session: Session) => void;
  selectSession: (work: Work, session: Session) => void;
  renameSession: (session: Session, purpose: string) => void;
  setModel: (session: Session, choice: ModelChoice) => void;
  /** Access for a session (or, with none yet, for new sessions of the engine). */
  setAccess: (session: Session | null, provider: Provider, mode: AccessMode) => void;
  compact: (session: Session) => void;
  /** The agent browser (the "브라우저" pill). */
  browser: BrowserActions;
  moveWork: (work: Work, folderId: string | null) => void;
  /** "프로젝트 = 노트 한 장": the work's project page. */
  openProject: (work: Work) => void;
  openSidebar: () => void;
  restore: (target: { kind: "folder" | "work" | "session"; id: string }) => void;
  /** 보관함: where a removed document (and with it its AI) is brought back. */
  openArchive: () => void;
};

const NO_PAGES: BrowserPage[] = [];

/** Tabs that stay readable with many sessions: the active one and the latest few, the rest behind "+N". */
const MAX_TABS = 5;

function StatusDot({ tone }: { tone: string }) {
  return <span className={`dot dot-${tone}`} aria-hidden />;
}

/** Requests written while the engine worked, waiting for the turn to end ("끝나면 보내기"). */
/** `readOnly` (an archived conversation, or its document removed): the requests stay visible, untouched, with no actions. */
export function QueuedList({ session, busy, actions, readOnly = false }: { session: Session; busy: boolean; actions: WorkActions["queued"]; readOnly?: boolean }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  if (!session.queued.length) return null;
  const kept = session.queued.filter((entry) => entry.held).length;
  const waiting = session.queued.length - kept;
  return (
    <div className="queued-list" role="list" aria-label="끝나면 보낼 요청">
      <div className="queued-head">
        {/* Requests kept after a stop, a failure or a restart go only by hand; the others follow the turn. */}
        <Icon name="bell" size={13} />{" "}
        {[
          waiting ? `끝나면 보낼 요청 ${waiting}개 · 차례대로 보냅니다` : null,
          kept ? `남겨 둔 요청 ${kept}개 · ${readOnly ? "대화를 되돌리면 보낼 수 있습니다" : "직접 보내거나 지울 수 있습니다"}` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </div>
      {session.queued.map((entry, index) => (
        <div key={entry.id} className={`queued-row${entry.held ? " held" : ""}`} role="listitem">
          <span className="queued-no">{index + 1}</span>
          {editing === entry.id ? (
            <form
              className="queued-edit"
              onSubmit={(event) => {
                event.preventDefault();
                if (draft.trim()) actions.edit(session, entry.id, draft);
                setEditing(null);
              }}
            >
              <textarea
                autoFocus
                value={draft}
                rows={Math.min(6, Math.max(2, draft.split("\n").length))}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setEditing(null);
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                    event.preventDefault();
                    if (draft.trim()) actions.edit(session, entry.id, draft);
                    setEditing(null);
                  }
                }}
              />
            </form>
          ) : (
            <span className="queued-text" title={entry.text}>
              {entry.origin ? <span className="queued-tag" title="휴대폰 메신저에서 보낸 요청">휴대폰</span> : null}
              {entry.held ? <span className="queued-tag">남겨 둠</span> : null}
              {entry.text}
              {entry.refs.length ? <span className="muted"> · 문서 {entry.refs.length}</span> : null}
              {entry.attachments?.length ? <span className="muted"> · 첨부 {entry.attachments.length}</span> : null}
            </span>
          )}
          {readOnly ? null : <span className="queued-actions">
            <button type="button" className="link" onClick={() => actions.send(session, entry.id)} title={busy ? "하던 작업에 지금 전하기" : "지금 보내기"}>
              {busy ? "지금 끼어들기" : "지금 보내기"}
            </button>
            <button
              type="button"
              className="link"
              onClick={() => {
                setDraft(entry.text);
                setEditing(entry.id);
              }}
            >
              고치기
            </button>
            <button type="button" className="link danger" onClick={() => actions.cancel(session, entry.id)}>
              지우기
            </button>
          </span>}
        </div>
      ))}
    </div>
  );
}

function TargetPicker({
  sessions,
  active,
  hostLabel,
  onSelect,
  onNew,
  onHandoff,
}: {
  sessions: Session[];
  active: Session | null;
  hostLabel: string;
  onSelect: (session: Session) => void;
  /** `worktree`: "격리 사본에서", in a new git worktree of the work's repository. */
  onNew: (provider: Provider, worktree?: boolean) => void;
  onHandoff: () => void;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const { lookOf } = useAppearance();
  return (
    <div className="anchor">
      <button type="button" className="select-button" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}>
        {active ? <EngineMark provider={active.provider} size={15} /> : null}
        {active ? `${PROVIDER_LABEL[active.provider]} · ${hostLabel}` : "엔진 선택"}
        <Icon name={open ? "chevronUp" : "chevronDown"} size={14} />
      </button>
      <Popover open={open} onClose={close} placement="above" align="right">
        {sessions.length ? <div className="menu-label">이 작업의 세션</div> : null}
        {sessions.map((session) => (
          <MenuItem
            key={session.id}
            active={session.id === active?.id}
            hint={statusText(session)}
            onSelect={() => {
              onSelect(session);
              close();
            }}
          >
            <span className="menu-engine" style={accentStyle(lookOf(session.provider))}>
              <EngineMark provider={session.provider} size={15} />
              {sessionLabel(session)}
            </span>
          </MenuItem>
        ))}
        {sessions.length ? <div className="menu-divider" /> : null}
        {(["claude", "codex"] as const).map((provider) => (
          <MenuItem
            key={provider}
            onSelect={() => {
              onNew(provider);
              close();
            }}
          >
            <span className="menu-engine" style={accentStyle(lookOf(provider))}>
              <EngineMark provider={provider} size={15} />
              새 {PROVIDER_LABEL[provider]} 세션
            </span>
          </MenuItem>
        ))}
        {(["claude", "codex"] as const).map((provider) => (
          <MenuItem
            key={`${provider}-worktree`}
            hint="git 저장소"
            onSelect={() => {
              onNew(provider, true);
              close();
            }}
          >
            <span className="menu-engine" style={accentStyle(lookOf(provider))}>
              <EngineMark provider={provider} size={15} />새 {PROVIDER_LABEL[provider]} 세션 · 격리 사본에서
            </span>
          </MenuItem>
        ))}
        <div className="menu-divider" />
        <MenuItem
          hint="답은 이 작업으로"
          onSelect={() => {
            close();
            onHandoff();
          }}
        >
          <span className="menu-engine">
            <Icon name="send" size={15} /> 다른 세션에 보내기…
          </span>
        </MenuItem>
      </Popover>
    </div>
  );
}

export function WorkView({
  api,
  onToast,
  state,
  work,
  actions,
  engine,
  setEngine,
  pickFile,
  tabs,
  openDocIds,
  focusItem,
  onFocusDone,
  sidebarOpen,
  prefs,
  modes,
  pages = NO_PAGES,
  docModes,
}: {
  api: Api;
  onToast: Notify;
  state: State;
  work: Work;
  actions: WorkActions;
  engine: Provider;
  setEngine: (provider: Provider) => void;
  pickFile: ((folder: string) => Promise<string | null>) | null;
  /** Open document tabs of this work. */
  tabs?: ReactNode;
  openDocIds?: string[];
  /** A message to bring into view (a search hit). */
  focusItem?: { itemId: string; nonce: number } | null;
  onFocusDone?: () => void;
  sidebarOpen?: boolean;
  /** UI prefs as they are now (the access last picked for each engine lives there). */
  prefs: UiPrefs;
  /** Where the conversation is shown: a window of its own, one of several panes, its tab's kept position. */
  modes?: ModeProps;
  /** The shared browser's pages (a web tab's AI working for this conversation is named by its page). */
  pages?: BrowserPage[];
  /** 읽기 and 검토 of the project's open document, in the note's ⋯. */
  docModes?: DocModes;
}) {
  const { lookOf, openMenu } = useAppearance();
  const references = useDocumentReferences(api, work.id, useCallback((text: string) => onToast(failure(text)), [onToast]));
  const unseen = useUnseen();
  // Archived sessions leave the tabs (they stay in the archive), unless one is on screen.
  const listed = workSessions(state, work.id).filter((session) => !session.documentAgent && !session.pageAgent);
  // A document's or web tab's AI is shown beside its document or page; an archived one, or a
  // document AI whose document was deleted, is shown here, as history.
  const retiredAgent = (session: Session | undefined) => Boolean(session?.documentAgent && !state.artifacts[session.documentAgent.artifactId]);
  const asConversation = (session: Session | undefined) => Boolean(session && ((!session.documentAgent && !session.pageAgent) || session.archivedAt || retiredAgent(session)));
  const shown = (work.activeSessionId && asConversation(state.sessions[work.activeSessionId]) && state.sessions[work.activeSessionId]) || listed[listed.length - 1] || sessionsOf(state, work.id).filter((session) => !session.documentAgent && !session.pageAgent).at(-1) || null;
  const active = shown;
  // A document AI whose document was deleted: history only, until the document comes back from 보관함.
  const retiredDoc = active?.documentAgent && !state.artifacts[active.documentAgent.artifactId] ? active.documentAgent.artifactId : null;
  const retired = retiredDoc
    ? state.removedArtifacts[retiredDoc]
      ? `${state.removedArtifacts[retiredDoc]!.removed?.kind === "unlisted" ? "목록에서 뺀" : "지운"} 문서 「${state.removedArtifacts[retiredDoc]!.name}」의 문서 AI 기록입니다. 문서를 되돌리면 이어서 쓸 수 있습니다.`
      : "영구 삭제한 문서의 문서 AI 기록입니다. 읽기만 할 수 있습니다."
    : null;
  // A conversation the gateway takes nothing for: no input at all, one line in its place saying
  // why, with its way out (되돌리기; for a removed document, 보관함).
  const readOnly = retired
    ? { text: retired, action: retiredDoc && state.removedArtifacts[retiredDoc] ? { label: "보관함에서 보기", run: actions.openArchive } : undefined }
    : active?.archivedAt
      ? { text: "보관한 대화입니다. 읽기만 할 수 있습니다.", action: { label: "되돌리기", run: () => actions.restore({ kind: "session", id: active.id }) } }
      : null;
  const workspace = state.workspaces[active?.workspaceId ?? work.defaultWorkspaceId ?? ""];
  const cwd = workspace?.cwd ?? active?.worktree?.cwd ?? work.cwd;
  const members = listed.filter((entry) => !workspace || entry.workspaceId === workspace.id);
  const sessions = shown && shown.archivedAt ? [...members, shown] : members;
  const [moreOpen, setMoreOpen] = useState(false);
  const closeMore = useCallback(() => setMoreOpen(false), []);
  const archivedFolder = (() => {
    for (let at = work.folderId; at; at = state.folders[at]?.parentId ?? null) if (state.folders[at]?.archivedAt) return state.folders[at]!;
    return null;
  })();
  const transcript = active ? state.transcripts[active.id] : undefined;
  const busy = isBusy(active ?? undefined);
  const working = turnRunning(active);
  const otherActive = Object.values(state.works).filter(
    (other) => other.id !== work.id && sessionsOf(state, other.id).some((session) => isBusy(session)),
  ).length;

  const [draftChoice, setDraftChoice] = useState<ModelChoice>({ model: null, effort: null });
  // The browser switch before this work's first session exists.
  const [browserDraft, setBrowserDraft] = useState(false);
  const pickerProvider = active?.provider ?? engine;
  const models = state.providers[pickerProvider]?.models ?? [];
  const [resolvedRole, setResolvedRole] = useState<{ sessionId: string; profile: AgentProfile | null } | null>(null);
  const resolveProfile = useCallback((profile: AgentProfile | null) => {
    if (active) setResolvedRole({ sessionId: active.id, profile });
  }, [active?.id]);
  const profile = active && resolvedRole && resolvedRole.sessionId === active.id && resolvedRole.profile?.id === active.profileId ? resolvedRole.profile : null;
  const access = accessFor(pickerProvider, active?.access ?? profile?.access, prefs, state.providers[pickerProvider]?.configuredAccess);
  // "원문": the raw Markdown of this conversation instead of the reading view (per session shown).
  const [rawFor, setRawFor] = useState<string | null>(null);
  // The inline title being renamed (the session it belongs to, so another session never takes the draft).
  const [titleEdit, setTitleEdit] = useState<string | null>(null);
  const raw = Boolean(active && rawFor === active.id);
  const [renaming, setRenaming] = useState<string | null>(null);
  // "다른 세션에": the receiving session, and documents pinned to the next request.
  const [handoffTo, setHandoffTo] = useState<Session | null>(null);
  // Documents pinned to the next request, each read (review) or changed (edit) by it.
  const [attached, setAttached] = useState<{ id: string; mode: DocRef["mode"] }[]>([]);
  const [create, setCreate] = useState<CreateTarget | null>(null);
  // "그림": on for the next request; the template and shape are remembered, the rest is per work.
  const [draw, setDraw] = useState<DrawState>(() => ({ on: false, choice: readDrawChoice(), via: null }));
  useEffect(() => setDraw((current) => ({ ...current, on: false, via: null })), [work.id]);
  const changeDraw = (next: DrawState) => {
    writeDrawChoice(next.choice);
    setDraw(next);
  };
  const [attachOpen, setAttachOpen] = useState(false);
  // Vault notes dropped on the input (from a note beside it): read-only references of the next request.
  const [notes, setNotes] = useState<{ path: string; title: string }[]>([]);
  useEffect(() => setNotes([]), [work.id]);
  const noteDrop = useNoteDrop((note) => {
    if (note.path.endsWith(".md")) setNotes((current) => (current.some((entry) => entry.path === note.path) ? current : [...current, note]));
  });
  const panes = usePaneActions();
  // Capture this composer's owner, including when another pane gains focus during an upload.
  const draftKey = `work:${work.id}:${active?.id ?? "none"}`;
  const pending = usePendingFiles(file => actions.upload(file, active?.workId ?? work.id), draftKey);
  // Text typed before the conversation turned read-only is kept under its own key and comes back with the input.
  const keptDraft = Boolean(readOnly && active && readDraft(`work:${work.id}:${active.id}`).trim());
  // "/" in the input: the active session's commands and skills, asked for when first typed.
  const [commandList, setCommandList] = useState<{ sessionId: string; items: EngineCommand[] } | null>(null);
  const slash = active
    ? {
        items: commandList?.sessionId === active.id ? commandList.items : null,
        onOpen: () => void actions.commands(active).then((items) => setCommandList({ sessionId: active.id, items })),
      }
    : undefined;
  // "계획 먼저": on until a plan is accepted (or turned off), for this work.
  const [planFirst, setPlanFirst] = useState(false);
  // "알릴 변경": lines of what changed the user chose not to send with the next request.
  const [omitChanges, setOmitChanges] = useState<string[]>([]);
  useEffect(() => setOmitChanges([]), [active?.id]);
  // What can change what the next request is told: the work's documents and its project note.
  const changePulse = `${state.pkm[`project:${work.id}`] ?? 0}#${Object.values(state.artifacts)
    .filter((artifact) => artifact.workId === work.id)
    .map((artifact) => artifact.revision)
    .join(",")}#${Object.values(state.proposals)
    .filter((proposal) => proposal.sessionId === active?.id)
    .map((proposal) => proposal.status)
    .join(",")}`;
  const [planWork, setPlanWork] = useState(work.id);
  if (planWork !== work.id) {
    setPlanWork(work.id);
    setPlanFirst(false);
  }
  const filePicker = useRef<HTMLInputElement>(null);
  const artifacts = Object.values(state.artifacts)
    .filter((artifact) => artifact.workId === work.id)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  // "@" offers the open documents first, then the rest of this work.
  const open = openDocIds ?? [];
  const mentionItems: MentionItem[] = [
    ...open.map((id) => state.artifacts[id]).filter((artifact) => artifact && artifact.workId === work.id),
    ...artifacts.filter((artifact) => !open.includes(artifact.id)),
  ].map((artifact) => ({ id: artifact.id, name: artifact.name, format: artifact.format, group: open.includes(artifact.id) ? "open" : "work", hint: references.hint(artifact) }));

  const recency = (session: Session) => Math.max(session.previewAt ?? 0, session.updatedAt);
  const keep = new Set(
    [...sessions]
      .sort((a, b) => Number(b.id === active?.id) - Number(a.id === active?.id) || Number(isBusy(b)) - Number(isBusy(a)) || recency(b) - recency(a))
      .slice(0, MAX_TABS - 1 + Number(sessions.length <= MAX_TABS))
      .map((session) => session.id),
  );
  const tabSessions = sessions.filter((session) => keep.has(session.id));
  const hiddenTabs = sessions.length - tabSessions.length;

  // What this conversation's documents' and pages' AIs are doing: read here, opened beside their document or page.
  const children = active && !readOnly ? childWork(state, active, pages) : [];
  // A card in this conversation opens its document beside it, in this conversation's tab.
  const docs = useDocs();
  const docsHere = useMemo(() => ({ state: docs.state, actions: { ...docs.actions, openArtifact: actions.openBeside } }), [docs.state, docs.actions, actions.openBeside]);

  const inherited = profile ? { name: profile.name, model: profile.model, effort: profile.effort } : undefined;
  const noteMenu = useNoteMenu({ api, state, work, session: active, actions, cwd, pickFile, onToast, onRename: () => active && setTitleEdit(active.id), docModes });
  const head = (
    <ConversationHead state={state} work={work} session={active} actions={actions} cwd={cwd} inherited={inherited}
      raw={raw} onRaw={(next) => setRawFor(next && active ? active.id : null)} menuButton={noteMenu.trigger("head")}
      renaming={Boolean(active && titleEdit === active.id)} onRenaming={(on) => setTitleEdit(on && active ? active.id : null)} readOnly={Boolean(readOnly)} />
  );
  // While the head is out of view, the pinned band carries its essentials at its right end.
  const band = active ? { title: sessionLabel(active), tail: <><StatusProp session={active} /><WorktreeProp session={active} actions={actions} />{noteMenu.trigger("band")}</> } : undefined;
  // The raw note is fetched again when an item completes, and at the end of the turn.
  const items = transcript?.items ?? [];
  const settled = items.filter((item) => !(item.kind === "assistant" && item.streaming) && !(item.kind === "tool" && item.status === "running")).length;

  return (
    <main className="work-view" onContextMenu={(event) => openMenu(event, active?.provider ?? engine)}>
      {tabs}
      {noteMenu.layers}
      {sessions.length > 1 && !modes?.single && !modes?.groupedTabs ? (
        <nav className="column session-tabs" aria-label="세션">
          {tabSessions.map((session) =>
            renaming === session.id ? (
              <EditableText
                key={session.id}
                className="session-tab-edit"
                value={session.purpose}
                onSave={(purpose) => actions.renameSession(session, purpose)}
                onDone={() => setRenaming(null)}
              />
            ) : (
              <button
                key={session.id}
                type="button"
                className={`session-tab${session.id === active?.id ? " active" : ""}`}
                style={accentStyle(lookOf(session.provider))}
                onPointerDown={(event) => paneDrag.press({ item: { kind: "session", id: session.id }, label: sessionLabel(session) }, event)}
                onClick={(event) => {
                  if (paneDrag.justDragged()) return;
                  if (panes && (event.ctrlKey || event.metaKey)) panes.openBeside({ kind: "session", id: session.id });
                  else actions.selectSession(work, session);
                }}
                onAuxClick={(event) => event.button === 1 && panes?.openBeside({ kind: "session", id: session.id })}
                onDoubleClick={() => setRenaming(session.id)}
                onContextMenu={(event) => openMenu(event, session.provider)}
                title="두 번 눌러 이름 바꾸기 · 오른쪽 클릭으로 외형"
              >
                {isBusy(session) ? <StatusDot tone={statusTone(session)} /> : <span className="badged"><EngineMark provider={session.provider} size={14} />{unseen.has(session.id) ? <span className="new-badge" title="새 답" /> : null}</span>}
                {sessionLabel(session)}
              </button>
            ),
          )}
          {hiddenTabs ? (
            <div className="anchor">
              <button type="button" className="session-tab more" onClick={() => setMoreOpen(!moreOpen)} title="이 작업의 다른 세션" aria-expanded={moreOpen}>
                <span className="badged">+{hiddenTabs}{sessions.some((session) => unseen.has(session.id) && !tabSessions.includes(session)) ? <span className="new-badge" /> : null}</span>
              </button>
              <Popover open={moreOpen} onClose={closeMore} align="left">
                <div className="menu-label">이 작업의 다른 세션</div>
                {sessions
                  .filter((session) => !tabSessions.includes(session))
                  .map((session) => (
                    <MenuItem
                      key={session.id}
                      hint={statusText(session)}
                      onSelect={() => {
                        closeMore();
                        actions.selectSession(work, session);
                      }}
                    >
                      <span className="menu-engine" style={accentStyle(lookOf(session.provider))}>
                        <EngineMark provider={session.provider} size={15} />
                        {sessionLabel(session)}
                        {unseen.has(session.id) ? <span className="new-dot" /> : null}
                      </span>
                    </MenuItem>
                  ))}
              </Popover>
            </div>
          ) : null}
        </nav>
      ) : null}

      {/* Not read-only: the project (or its folder) is archived, or the record was imported. The same line, above the conversation. */}
      {!readOnly && (work.archivedAt || archivedFolder) ? (
        <div className="column note-banner-row">
          <NoteBanner action={{ label: "되돌리기", run: () => actions.restore(work.archivedAt ? { kind: "work", id: work.id } : { kind: "folder", id: archivedFolder!.id }) }}>
            {work.archivedAt ? "보관한 프로젝트입니다." : `보관한 폴더(${archivedFolder!.name}) 안의 프로젝트입니다.`} 사이드바와 목록에는 보이지 않습니다.
          </NoteBanner>
        </div>
      ) : null}
      {!readOnly && active?.importedHistory ? (
        <div className="column note-banner-row">
          <NoteBanner tail={<span className="muted" title={active.importedHistory.nativeSessionId}>{PROVIDER_LABEL[active.importedHistory.provider]}</span>}>
            {active.importedHistory.kind === "archive" ? "가져온 과거 기록 · 새 요청을 보내면 이어서 작업합니다." : "가져온 기록에서 이어 쓰는 대화"}
          </NoteBanner>
        </div>
      ) : null}

      {active && raw ? (
        <RawNote api={api} sessionId={active.id} head={head} pulse={`${items.length}:${settled}:${working}`} running={working} />
      ) : active ? (
        <DocContext.Provider value={docsHere}>
        <Transcript
          head={head}
          band={band}
          sessionId={active.id}
          items={transcript?.items ?? []}
          provider={active.provider}
          running={working}
          loading={!transcript}
          onAnswer={(itemId, decision, response) => {
            // Going ahead with a plan ends "계획 먼저" for the requests after it.
            const answered = transcript?.items.find((item) => item.id === itemId);
            if (decision === "accept" && answered?.kind === "approval" && answered.plan) setPlanFirst(false);
            actions.answer(active, itemId, decision, response);
          }}
          onTrust={() => actions.setAccess(active, active.provider, "full")}
          onFork={busy || readOnly ? undefined : (itemId) => actions.fork(active, itemId)}
          readOnly={Boolean(readOnly)}
          focusItem={focusItem ?? null}
          onFocusDone={onFocusDone}
          position={modes?.uiState?.chatScroll}
          onPosition={(chatScroll) => modes?.onUiState?.({ chatScroll })}
        />
        </DocContext.Provider>
      ) : (
        <div className="transcript">
          <div className="column transcript-inner">
            {head}
            <div className="empty-hint">아래에서 엔진을 고르고 이 작업의 첫 요청을 보내세요.</div>
          </div>
        </div>
      )}

      <div className={`column composer-area${noteDrop.over ? " note-over" : ""}`} {...noteDrop.props}>
        {active ? <LinkBar session={active} /> : null}
        <ChildWork lines={children} onOpen={(child) => actions.selectSession(work, child)} />
        {active ? <QueuedList session={active} busy={busy} actions={actions.queued} readOnly={Boolean(readOnly)} /> : null}
        {active && !handoffTo && !readOnly ? <ChangeChip session={active} omit={omitChanges} onOmit={setOmitChanges} pulse={changePulse} /> : null}
        {!active ? (
          <EngineTabs
            value={engine}
            onChange={(next) => {
              setEngine(next);
              setDraftChoice({ model: null, effort: null });
            }}
          />
        ) : null}
        {readOnly ? <NoteBanner action={readOnly.action}>{readOnly.text}{keptDraft ? ` 쓰던 요청은 그대로 두었습니다. ${retired ? "문서를 되돌리면" : "되돌리면"} 입력창에 다시 나옵니다.` : null}</NoteBanner> : <Composer
          provider={handoffTo?.provider ?? pickerProvider}
          disabled={Boolean(workspace?.archivedAt || workspace?.removedAt)}
          mentions={
            // A drawing goes without documents, so "@" is off while drawing is on.
            draw.on
              ? undefined
              : {
                  items: mentionItems,
                  onPick: (item) => setAttached((current) => (current.some((entry) => entry.id === item.id) ? current : [...current, { id: item.id, mode: "review" }])),
                }
          }
          draftKey={draftKey}
          voiceScope={(handoffTo ?? active) ? { workId: (handoffTo ?? active)!.workId, sessionId: (handoffTo ?? active)!.id } : undefined}
          voiceReply={state.transcripts[(handoffTo ?? active)?.id ?? ""]?.items.filter(item => item.kind === "assistant" && !item.streaming).map(item => item.kind === "assistant" ? item.text : "").at(-1)}
          placeholder={draw.on ? "그릴 그림을 설명하세요" : planFirst ? "계획부터 세울 요청 (계획을 보고 진행할지 고릅니다)" : "이 작업에 이어서 요청하기"}
          busy={busy}
          waiting={working}
          steerable={working && !handoffTo}
          autoFocus={!modes?.paned}
          left={
            <>
              <AccessPicker provider={pickerProvider} value={access} onChange={(mode) => actions.setAccess(active, pickerProvider, mode)} />
              {active ? <ContextGauge context={active.context} canCompact={!busy && Boolean(active.nativeSessionId)} onCompact={() => actions.compact(active)} /> : null}
            </>
          }
          tools={
            <>
              {active ? <AgentProfilePicker key={active.id} api={api} session={active} models={{ claude: state.providers.claude?.models, codex: state.providers.codex?.models }} onRefreshModels={provider => api.refreshProviders(provider)} onResolved={resolveProfile} onNotice={onToast} /> : null}
              {!handoffTo ? <PlanToggle on={planFirst} onChange={setPlanFirst} /> : null}
              <DrawPill state={state} work={work} session={active} provider={pickerProvider} value={draw} onChange={changeDraw} />
              <BrowserPill
                session={active}
                status={state.browser}
                access={access}
                actions={actions.browser}
                draft={browserDraft}
                onDraft={setBrowserDraft}
                ownerLabel={state.browser?.window.kind === "agent" ? (state.sessions[state.browser.window.sessionId]?.purpose ?? null) : null}
              />
              <VaultGuardPill provider={pickerProvider} access={access} workId={work.id} />
              <CreateTargetButton
                tools={state.tools}
                api={api}
                scope={{ sessionId: active?.id, workId: work.id, workspaceId: workspace?.id }}
                onTemplate={(target) => { setCreate(target); setAttached((current) => current.map((entry) => ({ ...entry, mode: "review" }))); }}
                onPick={(format) => {
                  const first = attached[0] ? state.artifacts[attached[0].id] : undefined;
                  setCreate({ format, name: first ? stemOf(first.name) : "새 문서" });
                  setAttached((current) => current.map((entry) => ({ ...entry, mode: "review" })));
                }}
              />
            </>
          }
          onFiles={pending.add}
          onDesktopPicture={actions.clipboardPicture}
          attachments={pending.count}
          slash={handoffTo ? undefined : slash}
          header={
            handoffTo || attached.length || create || pending.files.length || draw.on || notes.length ? (
              <div className="doc-chips">
                {draw.on ? <DrawChip state={state} provider={pickerProvider} value={draw} onClear={() => setDraw({ ...draw, on: false })} /> : null}
                <NoteChips notes={notes} onRemove={(path) => setNotes((current) => current.filter((note) => note.path !== path))} />
                <PendingFiles files={pending.files} onRetry={pending.retry} onRemove={(key) => pending.remove([key])} />
                {handoffTo ? (
                  <span className="target-chip" style={accentStyle(lookOf(handoffTo.provider))}>
                    <EngineMark provider={handoffTo.provider} size={13} /> @{handoffTo.purpose}
                    <button type="button" onClick={() => setHandoffTo(null)} aria-label="받는 세션 지우기">
                      <Icon name="x" size={11} />
                    </button>
                  </span>
                ) : null}
                {attached.map((entry) => {
                  const artifact = state.artifacts[entry.id];
                  const editable = artifact && artifact.format !== "pdf" && artifact.format !== "hwp" && artifact.format !== "xmind" && artifact.format !== "epub" && !handoffTo && !create;
                  return artifact ? (
                    <span key={entry.id} className={`ref-chip${entry.mode === "edit" ? " editing" : ""}`}>
                      <Icon name="file" size={12} /> {artifact.name} · {references.pins[entry.id] ? `r${references.pins[entry.id].revision} 고정 · 미저장 제외` : `${references.hint(artifact)} · 보낼 때 저장`}
                      <button type="button" className="ref-role" onClick={() => void references.toggleSnapshot(entry.id)}>{references.pins[entry.id] ? "최신으로" : "저장된 판만"}</button>
                      {editable ? (
                        <button
                          type="button"
                          className="ref-role"
                          title="읽기: 자료로만 씀 · 고치기: AI가 이 문서의 수정안을 만듦"
                          onClick={() => setAttached(attached.map((item) => (item.id === entry.id ? { ...item, mode: item.mode === "edit" ? "review" : "edit" } : item)))}
                        >
                          {entry.mode === "edit" ? "고치기" : "읽기"}
                        </button>
                      ) : null}
                      <button type="button" onClick={() => { setAttached(attached.filter((item) => item.id !== entry.id)); references.forget(entry.id); }} aria-label="문서 빼기">
                        <Icon name="x" size={11} />
                      </button>
                    </span>
                  ) : null;
                })}
                {create ? <CreateChip target={create} onChange={setCreate} onClear={() => setCreate(null)} /> : null}
                {handoffTo ? <span className="muted">회신: 이 작업</span> : null}
              </div>
            ) : null
          }
          onSend={async (text, mode) => {
            if (draw.on) {
              // A drawing goes by itself (attached documents wait for the next request).
              const source: Session | null = active ?? (await actions.newSession(work, engine, draftChoice));
              if (!source) return false;
              const drawn = await actions.draw(source, text, draw);
              if (drawn) setDraw({ ...draw, on: false });
              return drawn;
            }
            // Attached documents travel as the revision they have now; handoffs are read-only.
            // A new document is made from the attached ones, so they are only read.
            const refs = await references.resolve(attached
              .map((entry) => ({ entry, artifact: state.artifacts[entry.id] }))
              .filter((pair): pair is { entry: (typeof attached)[number]; artifact: NonNullable<typeof pair.artifact> } => Boolean(pair.artifact))
              .map(({ entry, artifact }) => ({
                artifactId: artifact.id,
                mode: entry.mode === "edit" && !handoffTo && !create ? ("edit" as const) : ("review" as const),
                selection: null,
              })));
            if (!refs) return false;
            // "/compact" is the conversation's own "지금 압축", for either engine.
            if (active && !handoffTo && /^\/compact\s*$/.test(text)) {
              actions.compact(active);
              return true;
            }
            const { carried, done } = await pending.take();
            if (!text && !carried.length) return false;
            const source: Session | null = active ?? (await actions.newSession(work, engine, draftChoice, { browser: browserDraft }));
            if (!source) return false;
            const sent = handoffTo
              ? await actions.handoff(source, handoffTo, text, refs, carried)
              : await actions.send(source, text, refs, create, mode ?? "auto", carried, planFirst, omitChanges, notes.map((note) => note.path));
            if (sent) {
              // Notes do not go to another session ("다른 세션에"); they wait for this one's next request.
              if (!handoffTo) setNotes([]);
              setOmitChanges([]);
              setHandoffTo(null);
              setAttached([]);
              references.clear();
              setCreate(null);
              done();
            }
            return sent;
          }}
          onStop={active ? () => actions.interrupt(active) : undefined}
          target={
            <>
            <ModelPicker
              models={models}
              onRefresh={() => api.refreshProviders(pickerProvider)}
              value={active ? { model: active.model, effort: active.effort } : draftChoice}
              inherited={profile ? { name: profile.name, model: profile.model, effort: profile.effort } : undefined}
              onChange={(choice) => (active ? actions.setModel(active, choice) : setDraftChoice(choice))}
            />
            {active ? (
              <TargetPicker
                sessions={sessions}
                active={active}
                hostLabel={state.hostLabel}
                onSelect={(session) => actions.selectSession(work, session)}
                onNew={(provider, worktree) => void actions.newSession(work, provider, undefined, { workspaceId: workspace?.id, ...(worktree ? { worktree: true } : {}) })}
                onHandoff={() => void actions.pickSession(work, active).then((picked) => picked && picked.id !== active.id && setHandoffTo(picked))}
              />
            ) : null}
            <div className="anchor">
              <button type="button" className="icon-button" onClick={() => setAttachOpen(!attachOpen)} title="프로젝트 문서 붙이기" aria-label="프로젝트 문서 붙이기" aria-expanded={attachOpen} aria-haspopup="menu">
                <Icon name="file" size={17} />
              </button>
              <input
                ref={filePicker}
                type="file"
                multiple
                hidden
                onChange={(event) => {
                  if (event.target.files?.length) pending.add(Array.from(event.target.files));
                  event.target.value = "";
                }}
              />
              <Popover open={attachOpen} onClose={() => setAttachOpen(false)} placement="above" align="right">
                <MenuItem
                  onSelect={() => {
                    setAttachOpen(false);
                    filePicker.current?.click();
                  }}
                  hint="붙여넣기·끌어 놓기도 됨"
                >
                  파일·그림 고르기…
                </MenuItem>
                <div className="menu-label">요청에 붙일 문서 · 보내기 전에 저장 확인</div>
                {artifacts.map((artifact) => (
                  <MenuItem
                    key={artifact.id}
                    active={attached.some((entry) => entry.id === artifact.id)}
                    hint={references.hint(artifact)}
                    onSelect={() => {
                      setAttached(
                        attached.some((entry) => entry.id === artifact.id)
                          ? attached.filter((entry) => entry.id !== artifact.id)
                          : [...attached, { id: artifact.id, mode: "review" }],
                      );
                      setAttachOpen(false);
                      references.forget(artifact.id);
                    }}
                  >
                    {artifact.name}
                  </MenuItem>
                ))}
                {!artifacts.length ? <div className="menu-label">이 작업에 문서가 아직 없습니다.</div> : null}
              </Popover>
            </div>
            </>
          }
        />}
        <div className="footer-line">
          {noteDrop.over && !readOnly ? (
            "놓으면 이 요청에 노트가 읽기 전용으로 붙습니다."
          ) : otherActive && !sidebarOpen ? (
            <>
              다른 작업 {otherActive}개 진행 중 ·{" "}
              <button type="button" className="link" onClick={actions.openSidebar}>
                사이드바에서 보기
              </button>
            </>
          ) : null}
        </div>
      </div>
    </main>
  );
}
