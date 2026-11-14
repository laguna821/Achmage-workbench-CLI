import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { failure, type Notify } from "../../top-notice.ts";
import { diagramComponents } from "../Diagram.tsx";
import { ObsidianMarkdown, obsidianComponents } from "../../markdown/obsidian.tsx";

const DRAWN = diagramComponents();
import { FORMAT_LABEL, PROVIDER_LABEL, isOfficeFormat, isUnseen, type CreateTarget, type Artifact, type ArtifactRevision, type Attachment, type DocRef, type DocRefInput, type Proposal, type Provider, type Session, type Work } from "@workbench/contracts";
import { ApiRequestError, type Api } from "../../api.ts";
import { accentStyle, useAppearance } from "../../appearance.ts";
import { ago, statusText, statusTone } from "../../format.ts";
import { isBusy, turnRunning, type State } from "../../state.ts";
import { Composer } from "../Composer.tsx";
import { ModelPicker, type ModelChoice } from "../ModelPicker.tsx";
import { PendingFiles, usePendingFiles } from "../Attachments.tsx";
import { FormatBadge, removedLine } from "../DocCards.tsx";
import { EngineMark } from "../EngineMark.tsx";
import { PartialNote } from "../Recovery.tsx";
import { Icon } from "../Icon.tsx";
import { Popover, MenuItem } from "../Popover.tsx";
import { DiffView } from "./DiffView.tsx";
import { HtmlView } from "./HtmlView.tsx";
import { MarkdownEditor, type EditorSelection } from "./MarkdownEditor.tsx";
import { PdfView } from "./PdfView.tsx";
import { HwpxView } from "./HwpxView.tsx";
import { DesignView, type DesignHandle, type DesignStatus } from "./DesignView.tsx";
import { DesignCompare } from "./DesignCompare.tsx";
import type { ThumbSource } from "../../design.ts";
import { OfficeView } from "./OfficeView.tsx";
import { OfficeEditor, type OfficeHandle, type OfficeStatus } from "./OfficeEditor.tsx";
import type { ReactNode } from "react";
import type { MentionItem } from "../../mention.ts";
import { CreateChip, CreateTargetButton, stemOf } from "../CreateTarget.tsx";
import { OfficeCompare } from "./OfficeCompare.tsx";
import { QueuedList } from "../WorkView.tsx";
import { AgentColumn } from "../companion/AgentColumn.tsx";
import { Beside, useStoredRatio } from "../companion/Beside.tsx";
import { companionMinimum } from "../../companion.ts";
import { EditorView } from "@codemirror/view";
import { registerNoteTarget } from "../../conversation/outline.ts";
import { InlineDraw, drawExtension } from "./InlineDraw.tsx";
import { docPictureComponents } from "../ImageGen.tsx";
import { useKeptPosition } from "../../workmodes.ts";
import { useDocImages } from "./DocImages.tsx";
import type { TabUiState } from "../../panes.ts";
import { useDocumentSession } from "../../document-session.ts";
import { clearRecoveredDraft, keepDraft, newestDraft } from "../../document-drafts.ts";
import { readDraft, writeDraft } from "../../draft.ts";
import { markDiscarded } from "../../discarded-edits.ts";
import { registerDocumentCommands } from "../../document-commands.ts";
import { useDocumentReferences } from "../../document-references.ts";
import { OfficeFileMenu } from "../OfficeFileMenu.tsx";
import { useShownPanel } from "../../completion-notifications.ts";
import { NoteBanner } from "../../conversation/NoteBanner.tsx";
import { DOCK_READY_WAIT_MS, DOCK_RETRY_MS, EDITOR_MIN_WIDTH, REVEAL_WAIT_MS, documentAgentParent, documentConversationShown, editorAiIsEntry, editorKeepsAiPanel, isOfficeEditing, isRichTextEditor, isWordEditor, narrowPaneStep, narrowView, otherDocumentAgent, readView, reportsAiSidebar, type AgentReveal } from "./document-modes.ts";
import type { OfficePresentation } from "../../../../../packages/contracts/src/office-output.ts";

/** Save operations only; "unsaved" is derived from the text, never stored (no stale overwrite). */
type SaveState = "idle" | "saving" | "failed" | "conflict";
type Conflict = { code: string; message: string } | null;

const TEXT_FORMATS = new Set(["markdown", "text", "html", "hwpx", "hwp", "xmind", "epub"]);

export type DocSend = (target: Session | null, text: string, refs: DocRef[], handoffTo: Session | null, create: CreateTarget | null, attachments: Attachment[]) => Promise<boolean>;

/**
 * A document in the central area (mockup 03). Saving makes a revision; requests carry the saved
 * revision; AI changes arrive as proposals bound to the revision they were made from.
 */
export default function DocumentView({
  api: rootApi,
  state,
  artifactId,
  focusProposalId,
  focusItem,
  onFocusDone,
  work,
  session: mainSession,
  onBack,
  onSessionMenu,
  onAgentDrawn,
  onEditorHandle,
  revealAgent = null,
  onRevealDone,
  onSend,
  onPickTarget,
  onAiSettings,
  onExternalSetup,
  onOpenArtifact,
  onPresent,
  pickFile,
  onToast,
  tabs,
  openDocIds,
  onLeaveGuard,
  onMcpClose,
  onAnswer,
  queued,
  onReview,
  onRead,
  hosted,
  onBeside,
  uiState,
  onUiState,
  visible = true,
}: {
  /** Its tab is the one on screen (a background tab stays mounted, hidden). */
  visible?: boolean;
  uiState?: TabUiState;
  onUiState?: (state: TabUiState) => void;
  /** The waiting requests of the document's AI: send now, edit, remove — as in a conversation. */
  queued?: import("../WorkView.tsx").WorkActions["queued"];
  /** The proposal the compare view shows ("검토"), null when it closes. */
  onReview?: (proposalId: string | null) => void;
  /** "읽기": the document filling the window, a page at a time. */
  onRead?: () => void;
  /**
   * The document is a conversation's companion (beside it, in that conversation's tab): asking
   * goes to that conversation, so this view shows no AI of its own. Its head closes it, or opens
   * it wide in a tab of its own.
   */
  hosted?: {
    onClose: () => void;
    /** "탭으로 열어 고치기": the document's own tab, where it is edited. */
    onWide: () => void;
    /** "문서 AI": this document's AI, in the document's own tab with its conversation open. */
    onAgent?: (agent: Session) => void;
    /** It lies over the conversation (no room for both): its head carries the way back to the conversation, by name. */
    over?: boolean;
    /** What the covered conversation is doing (e.g. 승인 필요), said on the way back. */
    back?: string | null;
  };
  /** "대화 옆에" (나란히): move this document beside its conversation, in that conversation's tab. */
  onBeside?: () => void;
  /** Answer an approval of the document's AI in its column, without leaving the document. */
  onAnswer?: (session: Session, itemId: string, decision: "accept" | "decline", response?: import("@workbench/contracts").OfficeInteractionResponse) => void;
  /** Register how to save edits only this view holds (the Word editor) before the app leaves it. */
  /** `discard`: the tab closes on the person's 저장하지 않고 옮기기 — nothing is saved, this view's kept copy goes. */
  onLeaveGuard?: (guard: ((reason?: "close" | "discard") => Promise<void>) | null) => void;
  /** Called only after the explicit MCP save/discard operation has settled. */
  onMcpClose?: () => void;
  /** Open document tabs of this work. */
  tabs?: ReactNode;
  openDocIds?: string[];
  api: Api;
  state: State;
  artifactId: string;
  focusProposalId: string | null;
  focusItem?: { sessionId: string; itemId: string; nonce: number } | null;
  onFocusDone?: () => void;
  work: Work;
  session: Session | null;
  onBack: () => void;
  /** This document AI's actions (rename, archive, mute, schedule…), from its conversation's head. */
  onSessionMenu?: (session: Session, x: number, y: number) => void;
  /** The AI this view draws (null while it has none): what counts as looked at for this document. */
  onAgentDrawn?: (artifactId: string, sessionId: string | null) => void;
  /** This view's editor, asked directly for unsaved edits (and to save them) before the document leaves the list. */
  onEditorHandle?: (artifactId: string, viewId: string, handle: import("../../doc-editors.ts").EditorHandle | null) => void;
  /** A row click on one of this document's AIs that no view has acted on yet. */
  revealAgent?: AgentReveal | null;
  /** This view acted on that request (the app forgets it, unless a newer one replaced it). */
  onRevealDone?: (artifactId: string, request: AgentReveal) => void;
  onSend: DocSend;
  /** Opens the "어느 세션에 보낼까요?" picker; resolves with the chosen session. */
  onPickTarget: () => Promise<Session | null>;
  onAiSettings: () => void;
  onExternalSetup: () => void;
  onOpenArtifact: (artifactId: string, scope?: Pick<Artifact, "workId" | "workspaceId"> & { preserveSource?: boolean }) => void;
  onPresent?: (value: OfficePresentation) => void;
  pickFile?: ((folder: string) => Promise<string | null>) | null;
  onToast: Notify;
}) {
  const { lookOf } = useAppearance();
  const artifact = state.artifacts[artifactId] as Artifact | undefined;
  const [agent, setAgent] = useState<Session | null>(null);
  const [agentError, setAgentError] = useState("");
  const [agentRetry, setAgentRetry] = useState(0);
  const [agentChanging, setAgentChanging] = useState(false);
  const agentChangingRef = useRef(false);
  // A document tab owns its child conversation for its entire lifetime. Selecting
  // another tab/main chat must not tear down its writer lease or its running AI.
  // One source of truth: the AI drawn is the one the pane's session names (a click on its row);
  // otherwise the conversation the view opened with.
  const [openedWith] = useState(() => mainSession?.id ?? null);
  const parentId = documentAgentParent(artifactId, mainSession, openedWith);
  const agentScope = useRef({ artifactId, parentId });
  agentScope.current = { artifactId, parentId };
  useEffect(() => {
    let cancelled = false;
    // The writer lease belongs to this view, not to the AI shown: switching keeps the current AI
    // until the next one arrives (never null in between), so the lease is never closed and re-opened.
    setAgentError("");
    void rootApi.documentSession(artifactId, parentId).then((next) => { if (!cancelled) setAgent(next); }, (error) => { if (!cancelled) setAgentError(error instanceof Error ? error.message : String(error)); });
    return () => { cancelled = true; };
  }, [rootApi, artifactId, parentId, agentRetry]);
  const storedAgent = agent ? state.sessions[agent.id] : null;
  const drawn = agent && (!storedAgent || agent.updatedAt > storedAgent.updatedAt) ? agent : storedAgent;
  // The gateway sends nothing to an archived conversation, so the view never offers one as the
  // place to type. `agent` stays (the writer lease is this view's, not the AI's); the conversation
  // is another live AI of the document, or none until the person starts one.
  const ended = drawn?.archivedAt ? drawn : null;
  const session = ended ? null : drawn;
  const [agentNote, setAgentNote] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const sessionsNow = useRef(state.sessions);
  sessionsNow.current = state.sessions;
  useEffect(() => {
    if (!ended) return;
    const other = otherDocumentAgent(sessionsNow.current, artifactId, ended);
    if (!other) return;
    let cancelled = false;
    void rootApi.documentSession(artifactId, other.id).then((next) => {
      if (cancelled) return;
      setAgent(next);
      setAgentNote(`보던 문서 AI 대화는 보관했습니다 · 이 문서의 다른 문서 AI(${PROVIDER_LABEL[next.provider]})로 이어집니다`);
    }, (error) => { if (!cancelled) setAgentError(error instanceof Error ? error.message : String(error)); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ended?.id, rootApi, artifactId]);
  useEffect(() => { onAgentDrawn?.(artifactId, session?.id ?? null); }, [onAgentDrawn, artifactId, session?.id]);
  const canEditFormat = Boolean(artifact);
  // Beside a conversation the document is only read: that view never asks for the writer lease.
  const lease = useDocumentSession(rootApi, artifact && agent ? artifactId : null, session?.id ?? null, canEditFormat && !hosted);
  const api = lease.api;
  const references = useDocumentReferences(rootApi, artifactId, useCallback((text: string) => onToast(failure(text)), [onToast]));
  const [attachOpen, setAttachOpen] = useState(false);
  const everWriter = useRef(false);
  if (lease.canWrite) everWriter.current = true;
  const recoveredDraft = useRef<ReturnType<typeof newestDraft>>(null);
  const [legacyHangulDraft, setLegacyHangulDraft] = useState<ReturnType<typeof newestDraft>>(null);
  // Pasted or dropped pictures: a link in Markdown (R2 or the work folder), refused in the Hangul text view.
  const docImages = useDocImages(api, artifact, onToast);
  // The document's AI as a conversation column beside it (never while the document is itself a
  // conversation's companion: there the conversation it is beside takes the questions).
  const [aiOpenState, setAiOpenState] = useState(false);
  const aiOpen = aiOpenState;
  /** The tab has had a wish for the document's AI (a person's choice, or a flow acting for them): the drawn dock's remembered state is then not taken. */
  const aiChosen = useRef(false);
  const setAiOpen = useCallback((open: boolean) => { aiChosen.current = true; setAiOpenState(open); }, []);
  /** While the Hangul editor is here: the column shown beside it for a notice's target or a waiting approval (the dock cannot show those). */
  const [columnHere, setColumnHereState] = useState(false);
  /** Set at once (an effect of the same commit, e.g. the row-click reveal, must see it). */
  const columnHereNow = useRef(false);
  columnHereNow.current = columnHere;
  const setColumnHere = useCallback((open: boolean) => { columnHereNow.current = open; setColumnHereState(open); }, []);
  const dockEntryNow = useRef(false);
  const [columnRatio, setColumnRatio] = useStoredRatio("workbench.agentColumn.document", 0.38);
  // Notification/search targets can refer to an older child conversation. Keep its exact
  // transcript separate from this editor's current agent and writer registration.
  const [focusedConversationId, setFocusedConversationId] = useState<string | null>(null);
  const focusedConversation = focusedConversationId ? state.sessions[focusedConversationId] : undefined;
  useEffect(() => {
    if (hosted || !focusItem || state.sessions[focusItem.sessionId]?.documentAgent?.artifactId !== artifactId) return;
    setFocusedConversationId(focusItem.sessionId);
    // While the Hangul editor is here the dock cannot show this conversation: the column shows it beside the editor.
    if (dockEntryNow.current) setColumnHere(true); else setAiOpen(true);
  }, [artifactId, focusItem?.nonce, focusItem?.sessionId, state.sessions, Boolean(hosted)]);
  const textual = artifact ? TEXT_FORMATS.has(artifact.format) : false;
  const [base, setBase] = useState<{ revision: number; text: string } | null>(null);
  const [text, setText] = useState("");
  const latestText = useRef(text);
  latestText.current = text;
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [conflict, setConflict] = useState<Conflict>(null);
  const hangul = artifact?.format === "hwpx" || artifact?.format === "hwp";
  const office = artifact ? isOfficeFormat(artifact.format) : false;
  const wordEditor = isWordEditor(artifact?.format);
  const richTextEditor = isRichTextEditor(artifact?.format);
  const [mode, setMode] = useState<"edit" | "preview" | "split" | "render" | "source" | "pages" | "rich">(
    // Beside a conversation every format opens in the app's own read view: no embedded editor
    // there (its own AI panel and input would sit next to the conversation's input).
    hosted ? readView(artifact?.format) : hangul && uiState?.mode === "pages" ? "edit" : uiState?.mode && ["edit", "preview", "split", "render", "source", "pages", "rich"].includes(uiState.mode) ? uiState.mode as "edit" | "preview" | "split" | "render" | "source" | "pages" | "rich"
      : richTextEditor ? "rich" : wordEditor ? "edit" : office ? "pages" : "edit",
  );
  const officeEditing = isOfficeEditing(artifact?.format, mode);
  // The read views a document offers beside a conversation.
  const hostedViews: Array<["preview" | "edit" | "pages" | "render" | "source", string]> = artifact?.format === "markdown" ? [["preview", "미리보기"], ["edit", "원문"]]
    : office ? [["pages", "쪽 보기"], ["preview", "글 보기"]]
    : artifact?.format === "html" ? [["render", "화면"], ["source", "원문"]] : [];
  // A pane too narrow for the embedded editor (its text would wrap a few characters a line) shows
  // the app's own view of the format instead, with one line saying so. `narrowAuto`: that view was
  // the app's choice; `forcedEditor`: the person asked for the editor all the same.
  const editorMode = richTextEditor ? "rich" as const : "edit" as const;
  const [narrowAuto, setNarrowAuto] = useState(false);
  const [forcedEditor, setForcedEditor] = useState(false);
  /** The pane is too narrow for the editor, which stays because it reports unsaved edits: the other view is offered. */
  const [narrowOffer, setNarrowOffer] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  // The tab keeps the view the person has: the stand-in for a narrow pane is not remembered.
  useEffect(() => { onUiState?.({ mode: narrowAuto ? editorMode : mode }); }, [mode, narrowAuto, editorMode, onUiState]);
  const [editorAi, setEditorAi] = useState<boolean | null>(null);
  // A click on this document's AI row, held by the app until this view acts on it: the AI's
  // conversation column opens, whatever the document is shown in. One exception: Word says
  // whether its own AI sidebar is open, and while it is, the conversation is already on screen
  // there — the column is not put beside it too. Only the pane whose session is that AI answers,
  // once, and then hands the request back.
  const revealed = useRef<AgentReveal | null>(null);
  const format = artifact?.format;
  // Without the writer lease an Office document shows its pages only: no editor on this screen.
  const editorHere = everWriter.current;
  const leaseKnown = lease.ready || Boolean(lease.error);
  const officeRef = useRef<OfficeHandle>(null);
  const [officeStatus, setOfficeStatus] = useState<OfficeStatus>({ dirty: false, revision: null, conflict: null, changed: false, same: false });
  const [confirmDrop, setConfirmDrop] = useState(false);
  const [selection, setSelection] = useState<EditorSelection>(null);
  const [compare, setCompare] = useState<{
    title: string;
    before: string;
    after: string;
    beforeLabel: string;
    afterLabel: string;
    proposal?: Proposal;
    /** Designs are compared as pictures, page by page. */
    design?: { before: ThumbSource; after: ThumbSource };
    /** Word/PowerPoint/Excel proposals: rendered pages, or the text difference. */
    office?: boolean;
  } | null>(null);
  const design = artifact?.format === "design";
  const designRef = useRef<DesignHandle>(null);
  const [designStatus, setDesignStatus] = useState<DesignStatus>({ state: "idle", revision: null });
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<ArtifactRevision[]>([]);
  const [viewing, setViewing] = useState<{ revision: number; text: string } | null>(null);
  const officeEditorHere = officeEditing && everWriter.current;
  // The Hangul editor's own dock is the document's 문서 AI while the editor is on this screen and
  // shown (not under an older revision or a comparison: then the column is the AI, as in 글 보기).
  // aiOpen is the tab's one wish for the document's AI: the dock is brought to it here, the column
  // shows it elsewhere. The head's button shows what is on screen (the dock's own report), never the wish.
  const dockEntry = !hosted && officeEditing && editorAiIsEntry(format) && editorHere && !(compare || viewing);
  dockEntryNow.current = dockEntry;
  const draftKey = `doc:${artifactId}`;
  /** What the drawn dock last said: drawn (`ready`), open, and on screen (`shown`: an open dock steps aside for a studio dialog at a narrow pane). Nothing is known before the editor draws it. */
  const [dock, setDock] = useState({ ready: false, open: false, shown: false });
  /** The person pressed 문서 AI to get it: open is not enough, it must be on screen (over a studio dialog, ruling D). Cleared once it is, or by a wish to close. */
  const [dockShowAsked, setDockShowAsked] = useState(false);
  /** The dock did not come to the wish after a few requests (or never appeared): said in one line. */
  const [dockStuck, setDockStuck] = useState(false);
  /** Presses of the head's 문서 AI while the dock is the entry: each one asks the dock afresh (after the failure line too). */
  const [dockPresses, setDockPresses] = useState(0);
  /** The tab has a wish for this visit of the editor (else the drawn dock's remembered state is taken). */
  const wishKnown = useRef(false);
  // What the person typed for this document's AI is ONE draft (ruling A, round 3): the stored draft
  // of the column's input (draftKey) is it, written at every keystroke in either input. The dock's
  // input mirrors it: a change the dock reports by itself (typed or sent there) becomes the draft; a
  // dock showing anything else (drawn fresh, drawn open by itself, kept hidden over a revision, closed
  // behind the column) is given the draft IN PLACE of what it held. So the newer typing always wins
  // and nothing is appended, doubled or brought back.
  /** The text the drawn dock's input holds as far as the tab knows; null: no drawn dock seen yet. */
  const dockText = useRef<string | null>(null);
  /** A draft put in the dock that it has not confirmed yet: its reports until then are not the person's typing. */
  const dockPut = useRef<string | null>(null);
  const putDraft = (text: string) => { dockPut.current = text; officeRef.current?.setAiDraft(text); };
  const syncDraft = (shown: string) => {
    if (dockPut.current !== null) {
      if (shown !== dockPut.current) return;
      dockPut.current = null;
    } else if (dockText.current !== null && shown !== dockText.current) {
      // The dock's input changed by itself: the person typed (or sent) there — the newest text is the draft.
      dockText.current = shown;
      if (readDraft(draftKey) !== shown) writeDraft(draftKey, shown);
      return;
    }
    dockText.current = shown;
    const draft = readDraft(draftKey);
    if (dockEntryNow.current && shown !== draft) putDraft(draft);
  };
  const wasDock = useRef(false);
  if (dockEntry && !wasDock.current) wishKnown.current = aiOpen || aiChosen.current;
  const leftDock = !dockEntry && wasDock.current;
  wasDock.current = dockEntry;
  /** A new editor page (left and back, or opened again in place): its dock is not the one the tab knew. */
  const forgetDock = () => { setDock({ ready: false, open: false, shown: false }); setDockShowAsked(false); dockText.current = null; dockPut.current = null; };
  const onEditorReload = () => forgetDock();
  useEffect(() => { if (!officeEditorHere) forgetDock(); }, [officeEditorHere]);
  useEffect(() => {
    if (!leftDock) return;
    setDockStuck(false);
    // A notice's target or an approval shown beside the editor stays open in the column.
    if (columnHere) { setColumnHere(false); setAiOpen(true); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leftDock]);
  // Back to the dock (from an older revision or a comparison, where the editor stayed drawn; or the
  // column beside the editor closed): the dock gets the draft if it shows anything else.
  useEffect(() => {
    if (!dockEntry || !dock.ready || columnHere || dockPut.current !== null || dockText.current === null) return;
    const draft = readDraft(draftKey);
    if (dockText.current !== draft) putDraft(draft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dockEntry, dock.ready, columnHere, draftKey]);
  /** The person (or a flow acting for them) wants the document's AI open or closed. */
  const wishAi = (open: boolean) => { wishKnown.current = true; setDockStuck(false); setAiOpen(open); };
  const onEditorAi = (open: boolean, draft?: string, report?: { ready: boolean; person: boolean; shown?: boolean }) => {
    setEditorAi(report && !report.ready ? false : open);
    if (!editorAiIsEntry(format) || !report) return;
    const shown = report.ready && open && (report.shown ?? true);
    setDock({ ready: report.ready, open: report.ready && open, shown });
    if (shown || !open) setDockShowAsked(false);
    if (!report.ready) { dockText.current = null; return; }
    syncDraft(draft ?? "");
    // The dock's own close button: that is the person's wish now. A first report with no wish yet: the dock's remembered state.
    if (report.person) wishAi(open);
    else if (!wishKnown.current) { wishKnown.current = true; setAiOpenState(open); }
  };
  /** Where the dock should be: closed while the column is beside the editor; null: no wish yet. */
  const dockWish = !dockEntry || !wishKnown.current ? null : columnHere ? false : aiOpen;
  // Kept until the dock agrees: sent when it is drawn and on every report that differs, then again
  // after a short back-off; after the last try the button stays as the dock is and one line says so.
  // Agreeing to a press for the AI means on screen; an open dock hidden for a studio dialog the person
  // did not ask over is left as it is (ruling C: it steps aside, the button is not pressed).
  const dockAgrees = dock.open === dockWish && !(dockWish && dockShowAsked && !dock.shown);
  useEffect(() => {
    if (dockWish === null || !dock.ready || dockAgrees) return;
    let tries = 0, timer = 0;
    const send = () => {
      officeRef.current?.setAiPanel(dockWish);
      timer = window.setTimeout(tries < DOCK_RETRY_MS.length - 1 ? send : () => setDockStuck(true), DOCK_RETRY_MS[tries]);
      tries += 1;
    };
    send();
    return () => window.clearTimeout(timer);
  }, [dockWish, dock.ready, dockAgrees, dockPresses]);
  // The editor has opened its document but never drew its dock: said, not waited for forever.
  const editorOpened = officeStatus.revision !== null;
  useEffect(() => {
    if (dockWish !== true || dock.ready || !editorOpened) return;
    const timer = window.setTimeout(() => setDockStuck(true), DOCK_READY_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [dockWish, dock.ready, editorOpened, dockPresses]);
  const dockFailed = dockStuck && dockWish !== null && !dockAgrees;
  /** What is on screen: the button's pressed look follows this, never the wish (nor an open dock hidden for a dialog). */
  const aiShown = dockEntry ? columnHere || dock.shown : aiOpen;
  useEffect(() => {
    const request = revealAgent;
    if (hosted || !request || revealed.current === request || !format || mainSession?.id !== request.sessionId) return;
    const act = (column: boolean) => {
      revealed.current = request;
      onRevealDone?.(artifactId, request);
      if (!column) return;
      setFocusedConversationId(null);
      setAiOpen(true);
    };
    // A notice's target shown beside the editor in the same moment is the AI on screen: the dock is not asked too.
    if (dockEntry) { if (!columnHereNow.current) wishAi(true); act(false); return; }
    if (!officeEditing || !reportsAiSidebar(format)) { act(true); return; }
    if (editorHere && editorAi !== null) { act(!editorAi); return; }
    // Pages only on this screen (edited elsewhere, or read-only): there is no sidebar here to show it.
    if (!editorHere && leaseKnown) { act(true); return; }
    // Whether this screen gets the editor, and whether its sidebar is open, is known shortly after
    // the view opens: wait for that, but not for ever.
    const timer = window.setTimeout(() => act(true), REVEAL_WAIT_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealAgent, mainSession?.id, format, officeEditing, editorAi, editorHere, leaseKnown, Boolean(hosted), dockEntry]);
  // On screen: the conversation the column shows (this document's AI, or an older one opened in
  // its place), and Word's own AI sidebar while Word says it is open.
  const columnShows = !hosted && (dockEntry ? columnHere : aiOpen);
  useShownPanel(documentConversationShown({
    format: artifact?.format, mode, visible, sessionId: (officeEditing ? lease.registration?.view.sessionId : null) ?? session?.id ?? null,
    editorHere, editorHidden: Boolean(compare || viewing), editorAi, column: columnShows && !focusedConversation,
  }));
  useShownPanel(visible && columnShows && focusedConversation ? focusedConversation.id : null);
  const [includeDoc, setIncludeDoc] = useState(true);
  const [requestMode, setRequestMode] = useState<"edit" | "review">("edit");
  const [handoffTo, setHandoffTo] = useState<Session | null>(null);
  // Other documents mentioned with "@" (read as material), and a new document as the result.
  const [others, setOthers] = useState<string[]>([]);
  // Pictures and files pasted or dropped into the input below the document go with the request.
  const pending = usePendingFiles(
    (file) =>
      api.uploadAttachment(file, artifact?.workId ?? work.id).catch((error: unknown) => {
        onToast(failure(error instanceof Error ? error : "파일을 올리지 못했습니다."));
        return null;
      }),
    `doc:${artifactId}`,
  );
  const [create, setCreate] = useState<CreateTarget | null>(null);
  const [targetOpen, setTargetOpen] = useState(false);
  const saving = useRef<Promise<number | null> | null>(null);
  const savingText = useRef<string | null>(null);
  // Revisions this view saved itself: their events must not look like someone else's change.
  const ownRevisions = useRef(new Set<number>());
  const timer = useRef<number | undefined>(undefined);
  // "그림": drawing at the cursor of a Markdown document, and its pictures in the preview.
  const markdownDoc = artifact?.format === "markdown";
  const [editorView, setEditorView] = useState<EditorView | null>(null);
  const [drawOpen, setDrawOpen] = useState(false);
  const drawExtensions = useMemo(() => (markdownDoc ? [drawExtension(artifactId)] : undefined), [artifactId, markdownDoc]);
  const pictures = useMemo(() => (artifact ? docPictureComponents(DRAWN, work.id, artifact.path) : DRAWN), [work.id, artifact?.path]);
  const previewComponents = useMemo(() => obsidianComponents({ ...pictures, ...docImages.components }), [pictures, docImages.components]);

  // Load the latest revision; recover a draft the app kept if the window closed before saving.
  const load = useCallback(async (recoverDraft = true) => {
    if (!textual) return;
    const result = await api.artifactText(artifactId);
    setBase({ revision: result.revision, text: result.text });
    if ((artifact?.format === "xmind" || artifact?.format === "epub")) {
      setText(result.text); setSaveState("idle"); setConflict(null); return;
    }
    const draft = recoverDraft && lease.access().writeToken ? newestDraft(artifactId) : null;
    if (hangul) {
      // Earlier versions kept a Markdown patch, not an editor document. Keep it separate
      // from the live binary editor until the user explicitly reviews/applies that draft.
      if (recoverDraft) setLegacyHangulDraft(draft);
      setText(result.text); setSaveState("idle"); setConflict(null); return;
    }
    if (draft && draft.text !== result.text) {
      // Earlier Workbench drafts belong to its source editor. Recover there before changing
      // editors, rather than silently hiding those unsaved bytes behind a rich editor iframe.
      if (richTextEditor) setMode(artifact?.format === "html" ? "source" : "edit");
      recoveredDraft.current = draft;
      setText(draft.text);
      if (draft.baseRevision !== result.revision) {
        const old = await api.artifactText(artifactId, draft.baseRevision).catch(() => null);
        setBase({ revision: draft.baseRevision, text: old?.text ?? result.text });
        setSaveState("conflict");
        setConflict({ code: "revision_conflict", message: `r${draft.baseRevision}의 저장되지 않은 편집을 복원했습니다. 현재 판 r${result.revision}과 비교해 주세요.` });
        return;
      }
      onToast("저장되지 않았던 편집을 되살렸습니다.");
    } else {
      setText(result.text);
    }
    setSaveState("idle");
    setConflict(null);
  }, [api, artifactId, textual, hangul, richTextEditor, artifact?.format, onToast, lease.access]);

  useEffect(() => {
    if (lease.ready) void load().catch((error: Error) => onToast(failure(error)));
  }, [load, onToast, lease.ready]);

  // Keep a local copy of unsaved edits.
  useEffect(() => {
    if (!base || !everWriter.current || hangul || (artifact?.format === "xmind" || artifact?.format === "epub")) return;
    keepDraft(artifactId, lease.viewId, text !== base.text ? { baseRevision: base.revision, text, at: Date.now() } : null);
  }, [artifactId, base, text, lease.viewId, hangul, artifact?.format]);

  const save = useCallback(async (): Promise<number | null> => {
    if (!lease.access().writeToken) {
      return (base && text !== base.text) || ["dirty", "saving", "conflict", "error"].includes(designStatus.state) || officeStatus.dirty ? null : (base?.revision ?? artifact?.revision ?? null);
    }
    // The design and Word editors save by themselves; make sure the last edits are in before anything is sent.
    if (design) return designRef.current ? designRef.current.flush() : (artifact?.revision ?? null);
    if (officeEditing) return officeRef.current ? officeRef.current.flush() : (artifact?.revision ?? null);
    if (!base) return artifact?.revision ?? null;
    if (text === base.text) return base.revision;
    if (saving.current) return saving.current;
    setSaveState("saving");
    savingText.current = text;
    const run = api
      .saveArtifact(artifactId, base.revision, text)
      .then((saved) => {
        ownRevisions.current.add(saved.revision);
        setBase({ revision: saved.revision, text });
        setSaveState("idle");
        setConflict(null);
        clearRecoveredDraft(recoveredDraft.current); recoveredDraft.current = null;
        return saved.revision;
      })
      .catch((error: unknown) => {
        if (error instanceof ApiRequestError && error.status === 409) {
          setConflict({ code: error.code, message: error.message });
          setSaveState("conflict");
        } else {
          // Never shown as saved; the edit stays in the editor and in the local draft.
          setSaveState((current) => {
            if (current !== "failed") onToast(failure(error, "저장하지 못했습니다: "));
            return "failed";
          });
        }
        return null;
      })
      .finally(() => {
        saving.current = null;
        savingText.current = null;
      });
    saving.current = run;
    return run;
  }, [api, artifactId, artifact?.revision, base, text, onToast, design, officeEditing, lease.access, designStatus.state, officeStatus.dirty]);

  // Switching/closing must wait for a confirmed save, including text and design editors.
  useEffect(() => {
    if (!onLeaveGuard) return;
    onLeaveGuard(async (reason) => {
      if (editorView && !editorView.dom.closest(".pane[hidden]")) {
        const cursor = editorView.state.selection.main;
        onUiState?.({ cursor: { anchor: cursor.anchor, head: cursor.head }, scroll: { top: editorView.scrollDOM.scrollTop, left: editorView.scrollDOM.scrollLeft } });
      }
      // Gone from the list (removed, or not there): nothing here to save. The gateway refuses a removal
      // while a view reports unsaved edits, so the tab of a removed document just closes (U38).
      if (!artifact) return;
      // Saved: what follows (removing, archiving, moving the document) is decided by the gateway from
      // this view's report, so leaving ends once the gateway has the clean one (U38: 409 document_unsaved).
      if (reason === "discard") { /* The person chose to leave without saving: nothing is written. */ }
      else if (officeEditing && officeRef.current) {
        const revision = await officeRef.current.leave();
        if (lease.canWrite) await lease.report(false, revision ?? artifact?.revision);
      } else {
        const submittedText = saving.current ? savingText.current : text;
        const revision = await save();
        if (revision === null) throw new Error("문서를 저장하지 못해 이동하지 않았습니다. 현재 편집 내용을 확인해 주세요.");
        if (!design && latestText.current !== submittedText) throw new Error("저장하는 동안 편집 내용이 바뀌어 이동을 보류했습니다. 다시 이동해 주세요.");
        if (lease.canWrite) await lease.report(false, revision);
      }
      if ((reason === "close" || reason === "discard") && lease.canWrite) await api.closeOfficePreview(artifactId);
      if (reason === "discard") {
        // Only once the leave can no longer be refused (a refused leave keeps the editor open with
        // the person's edits, and their recovery copies must stay): every recovery copy of the
        // dropped edits goes, or they would come back on the next opening and be saved by its
        // leave — this view's own copy, the earlier one it was opened from, and, for an embedded
        // editor, which keeps a copy of its own, a mark that makes its next opening drop it.
        keepDraft(artifactId, lease.viewId, null);
        clearRecoveredDraft(recoveredDraft.current); recoveredDraft.current = null;
        if (officeEditing) markDiscarded(artifactId);
      }
    });
    return () => onLeaveGuard(null);
  }, [onLeaveGuard, officeEditing, save, text, design, editorView, onUiState, lease.canWrite, lease.report, api, artifactId, artifact?.revision, Boolean(artifact)]);

  // Autosave shortly after typing stops.
  useEffect(() => {
    if (officeEditing || !lease.canWrite || !base || text === base.text || saveState === "conflict" || saveState === "saving") return;
    window.clearTimeout(timer.current);
    // After a failed save, retry slowly instead of hammering the gateway.
    timer.current = window.setTimeout(() => void save(), saveState === "failed" ? 10_000 : 1200);
    return () => window.clearTimeout(timer.current);
  }, [text, base, saveState, save, lease.canWrite, officeEditing]);
  const unsaved = Boolean(base && text !== base.text);
  const dirty = unsaved || officeStatus.dirty || ["dirty", "saving", "conflict", "error"].includes(designStatus.state);
  // An embedded editor is mounted in this view now (it may hold edits it has not reported yet);
  // `editorEver`: one was, at some time.
  const editorMounted = officeEditing && everWriter.current;
  const editorEver = useRef(false);
  if (editorMounted) editorEver.current = true;
  const measured = useRef(false);
  const narrowNow = useRef({ editing: false, mounted: false, everMounted: false, forced: false, auto: false, unsaved: false, format: artifact?.format, embeds: false });
  narrowNow.current = { editing: officeEditing, mounted: editorMounted, everMounted: editorEver.current, forced: forcedEditor, auto: narrowAuto, unsaved: unsaved || saveState !== "idle", format: artifact?.format, embeds: wordEditor || richTextEditor };
  // A size change never saves, and never removes an editor that is open — whatever it reports
  // (Word and PowerPoint report unsaved edits only every two seconds). Too narrow, an open editor
  // stays and the other view is offered (`narrowOffer`). The app's own view is chosen by itself
  // only at the opening: the first width known for this view, with no editor ever mounted in it.
  const settleWidth = useCallback(() => {
    const now = narrowNow.current;
    if (!now.embeds) return;
    const width = rootRef.current?.getBoundingClientRect().width ?? null;
    const opening = !measured.current && !now.everMounted;
    if (width) measured.current = true;
    const step = narrowPaneStep({ width, editing: now.editing, mounted: now.mounted, opening, forced: now.forced, auto: now.auto, unsaved: now.unsaved });
    setNarrowOffer(step === "offer-view");
    if (step === "back-to-editor") { setNarrowAuto(false); setMode(isRichTextEditor(now.format) ? "rich" : "edit"); }
    else if (step === "open-own-view" && !now.mounted) { setNarrowAuto(true); setMode(narrowView(now.format).mode); }
  }, []);
  // An editor that mounts into a pane already too narrow for it (the pane narrowed while it loaded) gets the offer.
  useEffect(() => { if (editorMounted) settleWidth(); }, [editorMounted, settleWidth]);
  useLayoutEffect(() => {
    settleWidth();
    const element = rootRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    // A resize in progress (a divider dragged, the sidebar sliding) is judged once it rests.
    let timer: number | undefined;
    const observer = new ResizeObserver(() => { window.clearTimeout(timer); timer = window.setTimeout(settleWidth, 200); });
    observer.observe(element);
    return () => { observer.disconnect(); window.clearTimeout(timer); };
  }, [artifactId, settleWidth, Boolean(artifact)]);
  // The app asks this editor itself before the document leaves the list (its state is current).
  // Only the text editors know at once; the Office and design editors report from their frame,
  // later, so they say "unknown" (treated as dirty). Saving itself goes through the leave guard.
  const reliableDirty = !officeEditing && !design;
  // Beside a conversation the document is only read: that view holds nothing to save.
  const dirtyNow = useRef<boolean | "unknown">(false); dirtyNow.current = hosted ? false : dirty || (reliableDirty ? false : "unknown");
  // The app's own comparison with the saved revision (information for the move question only).
  const sameNow = useRef(false); sameNow.current = design ? false : officeEditing ? officeStatus.same || (!officeStatus.dirty && !officeStatus.changed) : Boolean(base && text === base.text);
  useEffect(() => {
    if (!onEditorHandle) return;
    onEditorHandle(artifactId, lease.viewId, { dirty: () => dirtyNow.current, same: () => sameNow.current });
    return () => onEditorHandle(artifactId, lease.viewId, null);
  }, [onEditorHandle, artifactId, lease.viewId]);
  useEffect(() => { lease.report(dirty, (officeEditing ? officeStatus.revision : base?.revision) ?? designStatus.revision ?? artifact?.revision); }, [dirty, officeEditing, base?.revision, officeStatus.revision, designStatus.revision, artifact?.revision, lease.report]);
  useEffect(() => registerDocumentCommands(lease.viewId, {
    artifactId,
    mcp: async (request) => {
      if (!lease.canWrite) return { status: "error", error: { reason: "read_only", message: "이 창에는 문서 편집 권한이 없습니다." } };
      if (!officeEditing) {
        if (request.kind === "status") {
          const pane = bodyRef.current?.closest(".pane");
          return { status: "ok", result: { value: { dirty, active: pane?.getAttribute("data-tab-active") === "true" && pane?.getAttribute("data-pane-active") === "true" } } };
        }
        if (request.kind === "read" && richTextEditor) return base ? { status: "ok", result: { value: text } } : { status: "not_ready" };
        // An outside command needs the editor itself, however narrow the pane is.
        if (wordEditor) { setForcedEditor(true); setNarrowAuto(false); setMode("edit"); return { status: "not_ready" }; }
        if (richTextEditor && !unsaved) { setForcedEditor(true); setNarrowAuto(false); setMode("rich"); return { status: "not_ready" }; }
        return { status: "error", error: { reason: "unsupported", message: "현재 보기의 편집을 저장하고 Office 편집 보기에서 요청해 주세요." } };
      }
      if (!officeRef.current) return { status: "not_ready" };
      if (request.kind === "save" && !request.plan || request.kind === "close" && !request.discard) {
        await officeRef.current.leave();
        const revision = await save();
        if (revision === null) throw new Error("문서를 저장하지 못했습니다. 편집 내용은 유지했습니다.");
        await lease.report(false, revision);
        if (request.kind === "save") return { status: "ok", result: { value: { ok: true, path: artifact?.path } } };
      }
      const reply = await officeRef.current.mcp(request);
      if (request.kind === "close" && reply.status === "ok") {
        if (!onMcpClose) throw new Error("이 문서 창은 외부 닫기를 지원하지 않습니다.");
        await api.closeOfficePreview(artifactId);
        onMcpClose();
      }
      return reply;
    },
    control: async (request) => {
      if (!officeEditing) {
        if (request.cmd === "goto" && wordEditor) { setForcedEditor(true); setNarrowAuto(false); setMode("edit"); return { status: "not_ready" }; }
        return { status: "error", error: { reason: "unsupported", message: "현재 문서 보기는 Office 선택 읽기를 제공하지 않습니다. 편집 보기에서 다시 시도해 주세요." } };
      }
      return officeRef.current?.control(request) ?? { status: "not_ready" };
    },
    dirty: () => dirty,
    flushBeforeReference: () => officeEditing && Boolean(lease.access().writeToken),
    save: async () => {
      const submitted = saving.current ? savingText.current : text;
      const revision = await save();
      if (revision === null) return null;
      if (officeEditing && officeRef.current) await officeRef.current.leave();
      if (!design && !officeEditing && latestText.current !== submitted) throw new Error("참조 문서가 저장 중 바뀌었습니다. 입력을 마친 뒤 다시 보내 주세요.");
      await lease.report(false, revision);
      return revision;
    },
  }), [artifactId, artifact?.path, lease.viewId, lease.canWrite, dirty, save, text, base, design, officeEditing, wordEditor, richTextEditor, unsaved, lease.report, onMcpClose, api]);

  // A new revision from elsewhere (an applied proposal, a revert): reload when nothing is unsaved here.
  useEffect(() => {
    if (!artifact || !base || artifact.revision <= base.revision || saving.current) return;
    if (ownRevisions.current.has(artifact.revision)) return;
    if (text === base.text) void load(false);
    else {
      setConflict({ code: "revision_conflict", message: `다른 곳에서 r${artifact.revision}이 생겼습니다. 내 편집은 그대로 두었습니다.` });
      setSaveState("conflict");
    }
  }, [artifact, base, text, load]);

  const proposals = useMemo(
    () => Object.values(state.proposals).filter((proposal) => proposal.artifactId === artifactId && (proposal.status === "pending" || proposal.status === "running")),
    [state.proposals, artifactId],
  );

  const showProposal = useCallback(
    async (proposal: Proposal) => {
      const texts = await api.proposal(proposal.id);
      const engine = PROVIDER_LABEL[state.sessions[proposal.sessionId]?.provider ?? "claude"];
      setCompare({
        title: `${engine}의 수정안`,
        before: texts.base,
        after: texts.proposed,
        beforeLabel: `r${proposal.baseRevision}`,
        afterLabel: "수정안",
        proposal,
        design: design
          ? { before: { artifactId: proposal.artifactId, proposalId: proposal.id, side: "base" }, after: { artifactId: proposal.artifactId, proposalId: proposal.id, side: "proposed" } }
          : undefined,
        office,
      });
    },
    [api, state.sessions, design, office],
  );

  useEffect(() => {
    const focused = focusProposalId ? state.proposals[focusProposalId] : null;
    if (focused && compare?.proposal?.id !== focused.id)
      void showProposal(focused).catch((error: Error) => {
        onToast(failure(error));
        onReview?.(null);
      });
    // Only when asked to show a specific proposal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusProposalId]);

  // "검토" in the mode bar follows the proposal compared here (opened from the bar or from a card).
  const comparing = compare?.proposal?.id ?? null;
  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (reported.current === comparing) return;
    reported.current = comparing;
    onReview?.(comparing);
  }, [comparing, onReview]);

  // Where the document was read comes back when this view returns from another mode.
  const bodyRef = useRef<HTMLDivElement>(null);
  useKeptPosition(bodyRef, `doc:${artifactId}`, { initial: uiState?.reading, onChange: (reading) => onUiState?.({ reading }) });
  // The right sidebar's outline of this document jumps to a heading: the editor's line when the
  // source is shown, else the heading drawn in the preview.
  const editorAt = useRef(editorView);
  editorAt.current = editorView;
  useEffect(() => registerNoteTarget(`doc:${artifactId}`, {
    element: () => bodyRef.current,
    jump: (line, text) => {
      const editor = editorAt.current;
      if (editor && bodyRef.current?.contains(editor.dom)) {
        const doc = editor.state.doc;
        const heading = (number: number) => number >= 1 && number <= doc.lines && /^\s{0,3}#{1,6}\s/.test(doc.line(number).text);
        let target = heading(Number(line) + 1) ? Number(line) + 1 : 0;
        for (let number = 1; !target && text && number <= doc.lines; number++) if (heading(number) && doc.line(number).text.includes(text)) target = number;
        if (target) {
          const at = doc.line(target).from;
          editor.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: "start", yMargin: 16 }) });
          return;
        }
      }
      const drawn = [...(bodyRef.current?.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6") ?? [])].find((element) => element.textContent?.trim() === text);
      drawn?.scrollIntoView({ block: "start", behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    },
  }), [artifactId]);

  if (!artifact) {
    return (
      <main className="document-view">
        <div className="column empty-hint">문서를 찾을 수 없습니다.</div>
      </main>
    );
  }

  const stale = (proposal: Proposal) => proposal.status === "pending" && artifact.revision !== proposal.baseRevision;
  const apply = async (proposal: Proposal) => {
    const pending = await save();
    if (pending === null) return;
    try {
      const result = await api.applyProposal(proposal.id);
      onToast(`수정안을 적용했습니다 → r${result.artifact.revision}`);
      setCompare(null);
    } catch (error) {
      onToast(failure(error));
    }
  };
  const discard = async (proposal: Proposal) => {
    await api.discardProposal(proposal.id).catch((error: Error) => onToast(failure(error)));
    setCompare(null);
  };

  // Leaving the editor view saves first; edits that cannot be saved keep it where it is.
  const changeMode = async (value: typeof mode) => {
    if (value === mode) return;
    if ((officeEditing || unsaved) && (await save()) === null) {
      onToast(failure("저장하지 못한 편집이 있어 보기를 바꾸지 않았습니다. 위의 안내를 먼저 확인해 주세요."));
      return;
    }
    // A view the person picks is theirs: the editor picked in a narrow pane stays, however narrow.
    setNarrowAuto(false);
    setNarrowOffer(false);
    const width = rootRef.current?.getBoundingClientRect().width ?? 0;
    // 편집기로 열기 holds for that editor: leaving it for another view ends it.
    setForcedEditor(isOfficeEditing(artifact.format, value) ? (forced) => forced || (width > 0 && width < EDITOR_MIN_WIDTH) : false);
    setMode(value);
  };
  const stoodIn = narrowView(artifact.format);
  // After a conflict: my edits become the next revision; the other one stays in the history.
  const keepMine = async () => {
    const conflictNow = officeStatus.conflict;
    if (!officeRef.current || !conflictNow) return;
    try {
      const latest = conflictNow.code === "disk_changed" ? (await api.adoptDisk(artifactId)).revision : artifact.revision;
      const saved = await officeRef.current.rebase(latest);
      onToast(saved === null ? failure("내 편집을 저장하지 못했습니다. 잠시 뒤 다시 해 보세요.") : `내 편집을 새 판 r${saved}로 저장했습니다. 이전 판은 기록에 남아 있습니다.`);
    } catch (error) {
      onToast(failure(error));
    }
  };

  const readers = Object.entries(artifact.readBy)
    .map(([sessionId, revision]) => ({ session: state.sessions[sessionId], revision }))
    .filter((entry): entry is { session: Session; revision: number } => Boolean(entry.session));

  const sendTarget = handoffTo ?? session;
  // Another engine's conversation of this document (each engine keeps its own), after saving.
  const changeEngine = (provider: Provider) => {
    if (agentChangingRef.current) return;
    agentChangingRef.current = true; setAgentChanging(true); setAgentError("");
    void (async () => {
      const revision = await save();
      if (revision === null) return;
      const next = await rootApi.documentSession(artifactId, parentId, false, provider);
      setAgent(next);
      await lease.sync(false, revision, next.id);
    })().catch(error => setAgentError(error instanceof Error ? error.message : String(error))).finally(() => { agentChangingRef.current = false; setAgentChanging(false); });
  };
  const changeModel = (choice: ModelChoice) => {
    if (agentChangingRef.current || !session) return;
    agentChangingRef.current = true; setAgentChanging(true); setAgentError("");
    void rootApi.updateSession(session.id, choice).then(setAgent).catch(error => setAgentError(error instanceof Error ? error.message : String(error))).finally(() => { agentChangingRef.current = false; setAgentChanging(false); });
  };
  const engineLocked = Boolean(session && (isBusy(session) || session.queued.length > 0));
  // PDF and HWP cannot take AI edits (no working copy to patch from); they are always reviewed.
  const editable = artifact.format !== "pdf" && artifact.format !== "xmind" && artifact.format !== "epub";
  const effectiveMode: DocRef["mode"] = handoffTo || !editable || create ? "review" : requestMode;
  const workDocs = Object.values(state.artifacts)
    .filter((entry) => entry.workId === work.id && entry.id !== artifactId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const openIds = openDocIds ?? [];
  const mentionItems: MentionItem[] = [
    ...workDocs.filter((entry) => openIds.includes(entry.id)),
    ...workDocs.filter((entry) => !openIds.includes(entry.id)),
  ].map((entry) => ({ id: entry.id, name: entry.name, format: entry.format, group: openIds.includes(entry.id) ? "open" : "work", hint: references.hint(entry) }));
  const working = Object.values(state.proposals).find((proposal) => proposal.artifactId === artifactId && proposal.status === "running");
  const reviewing = Object.values(state.handoffs).filter(
    (handoff) => handoff.status === "sent" && handoff.refs.some((ref) => ref.artifactId === artifactId),
  );

  const shownState = design
    ? designStatus.state === "idle"
      ? "saved"
      : designStatus.state === "error"
        ? "failed"
        : designStatus.state
    : officeEditing
      ? officeStatus.conflict
        ? "conflict"
        // The label waits for a real change; leaving the document still goes by the editor's own report (`dirty`).
        : officeStatus.changed
          ? "dirty"
          // The editor says dirty but its text equals the saved revision: neither mark is claimed.
          : officeStatus.same
            ? "same"
            : "saved"
    : saveState === "idle"
      ? unsaved
        ? "dirty"
        : "saved"
      : saveState;
  const designLabel =
    designStatus.state === "saving" ? "저장 중…" : designStatus.state === "dirty" ? "저장 안 됨" : designStatus.state === "conflict" ? "충돌" : designStatus.state === "error" ? "저장 못 함" : `r${artifact.revision} 저장됨`;
  const statusLabel =
    shownState === "saved"
      ? `r${base?.revision ?? artifact.revision} 저장됨`
      : shownState === "same"
        ? `r${officeStatus.revision ?? base?.revision ?? artifact.revision}`
      : shownState === "saving"
        ? "저장 중…"
        : shownState === "dirty"
          ? "저장 안 됨"
          : shownState === "failed"
            ? "저장 못 함"
            : "충돌";

  const body = (() => {
    if (!lease.ready) return <div className="column empty-hint">문서를 여는 중…</div>;
    if (compare) {
      return (
        <div className="doc-compare">
          <div className="doc-compare-head">
            <strong>{compare.title}</strong>
            {compare.proposal ? <PartialNote proposal={state.proposals[compare.proposal.id] ?? compare.proposal} compact /> : null}
            {compare.proposal && stale(compare.proposal) ? (
              <span className="proposal-warning">
                r{compare.proposal.baseRevision} 기준 · 지금 r{artifact.revision} — 자동으로 적용하지 않습니다
              </span>
            ) : null}
            <span className="doc-compare-actions">
              {compare.proposal && compare.proposal.status === "pending" && !stale(compare.proposal) && !compare.proposal.problem ? (
                <button type="button" className="button small primary" onClick={() => void apply(compare.proposal!)}>
                  적용
                </button>
              ) : null}
              {compare.proposal && compare.proposal.status === "pending" ? (
                <button type="button" className="button small" onClick={() => void discard(compare.proposal!)}>
                  취소
                </button>
              ) : null}
              <button type="button" className="button small" onClick={() => setCompare(null)}>
                닫기
              </button>
            </span>
          </div>
          {compare.proposal?.problem ? <div className="proposal-warning">디자인 파일이 올바르지 않아 적용할 수 없습니다: {compare.proposal.problem}</div> : null}
          {(state.proposals[compare.proposal?.id ?? ""] ?? compare.proposal)?.removedStructure?.length && compare.proposal?.status === "pending" ? <div className="proposal-warning">{removedLine((state.proposals[compare.proposal.id] ?? compare.proposal).removedStructure!)}</div> : null}
          {compare.office && compare.proposal ? (
            <OfficeCompare proposalId={compare.proposal.id} before={compare.before} after={compare.after} beforeLabel={compare.beforeLabel} afterLabel={compare.afterLabel} />
          ) : compare.design ? (
            <DesignCompare
              before={compare.design.before}
              after={compare.design.after}
              beforeText={compare.before}
              afterText={compare.after}
              beforeLabel={compare.beforeLabel}
              afterLabel={compare.afterLabel}
            />
          ) : (
            <DiffView before={compare.before} after={compare.after} beforeLabel={compare.beforeLabel} afterLabel={compare.afterLabel} />
          )}
        </div>
      );
    }
    if (viewing) {
      return (
        <div className="doc-readonly">
          <div className="notice">
            r{viewing.revision}을 보는 중입니다(읽기 전용).{" "}
            <button type="button" className="link" onClick={() => setViewing(null)}>
              최신 판으로
            </button>{" "}
            ·{" "}
            <button
              type="button"
              className="link"
              onClick={() =>
                void api
                  .revert(artifactId, viewing.revision)
                  .then((reverted) => {
                    onToast(`r${viewing.revision} 내용으로 새 판 r${reverted.revision}을 만들었습니다`);
                    setViewing(null);
                  })
                  .catch((error: Error) => onToast(failure(error)))
              }
            >
              이 판으로 되돌리기(새 판으로)
            </button>
          </div>
          {office ? (
            <OfficeView api={api} artifact={artifact} revision={viewing.revision} mode={mode === "pages" ? "pages" : "text"} />
          ) : design ? (
            <DesignView
              artifact={artifact}
              revision={viewing.revision}
              onStatus={() => undefined}
              onSelection={() => undefined}
              onCopied={onOpenArtifact}
              onExported={(name) => onToast(`작업 폴더에 저장했습니다: ${name}`)}
              onError={(text: string) => onToast(failure(text))}
            />
          ) : (
            <MarkdownEditor value={viewing.text} readOnly onChange={() => undefined} onSelection={() => undefined} />
          )}
        </div>
      );
    }
    if (officeEditing && everWriter.current) return null;
    if (office) return <OfficeView api={api} artifact={artifact} revision={artifact.revision} mode={mode === "pages" ? "pages" : "text"} />;
    if (design) {
      return (
        <DesignView
          ref={designRef}
          artifact={artifact}
          readOnly={!everWriter.current}
          access={lease.access()}
          onStatus={setDesignStatus}
          onSelection={(picked) => setSelection(picked ? { from: 0, to: 0, text: picked.text, label: picked.label, pageId: picked.pageId, objectIds: picked.objectIds } : null)}
          onCopied={(created) => {
            onToast("내 편집을 새 디자인 파일로 저장했습니다.");
            onOpenArtifact(created);
          }}
          onExported={(name, created) => {
            onToast(`작업 폴더에 저장했습니다: ${name}`);
            if (created && name.toLowerCase().endsWith(".pdf")) onOpenArtifact(created);
          }}
          onError={(text: string) => onToast(failure(text))}
        />
      );
    }
    if (artifact.format === "pdf") {
      return (
        <PdfView
          api={api}
          artifactId={artifactId}
          revision={artifact.revision}
          onSelection={setSelection}
          onEdit={async (edit) => {
            try {
              const created = await api.editPdf(artifactId, edit);
              onToast(`PDF 쪽 편집을 새 파일로 저장했습니다: ${created.name}`);
              onOpenArtifact(created.id);
            } catch (error) {
              onToast(failure(error));
            }
          }}
        />
      );
    }
    if (hangul && mode === "pages") {
      return <HwpxView api={api} artifact={artifact} revision={base?.revision ?? artifact.revision} />;
    }
    if (!base) return <div className="column empty-hint">불러오는 중…</div>;
    if (artifact.format === "xmind" || artifact.format === "epub") return <MarkdownEditor value={text} readOnly onChange={() => undefined} onSelection={setSelection} position={uiState} onPosition={onUiState} />;
    if (hangul) {
      return (
        <div className="doc-hangul-text">
          <div className="notice">
            한글 문서의 글 보기입니다. 쪽 배치·표·메모를 편집하려면 {hosted ? "‘탭으로 열어 고치기’" : "‘편집’"}를 누르세요.
          </div>
          <MarkdownEditor value={text} readOnly onChange={setText} onSelection={setSelection} images={docImages.handling} position={uiState} onPosition={onUiState} />
        </div>
      );
    }
    if (artifact.format === "html" && mode === "render") {
      return <HtmlView api={api} artifactId={artifactId} revision={base.revision} />;
    }
    // Beside a conversation the text is only read, whatever the lease says.
    const editor = <MarkdownEditor value={text} readOnly={!lease.canWrite || Boolean(hosted)} onChange={setText} onSelection={setSelection} onBlur={() => void save()} extensions={drawExtensions} onView={setEditorView} images={docImages.handling} position={uiState} onPosition={onUiState} />;
    if (artifact.format === "markdown" && mode === "preview") {
      return (
        <div className="doc-preview">
          <div className="markdown">
            <ObsidianMarkdown components={previewComponents}>{text}</ObsidianMarkdown>
          </div>
        </div>
      );
    }
    if (artifact.format === "markdown" && mode === "split") {
      return (
        <div className="doc-split">
          {editor}
          <div className="doc-preview">
            <div className="markdown">
              <ObsidianMarkdown components={previewComponents}>{text}</ObsidianMarkdown>
            </div>
          </div>
        </div>
      );
    }
    return editor;
  })();

  /** Leaving this view for somewhere else: only once its edits are saved. */
  const afterSaving = (then: () => void) => void save().then((revision) => { if (revision !== null) then(); });
  // What the document's AI has to say while its column is closed: a dot and a word on the button that opens it.
  const agentTone = session ? (statusTone(session) !== "idle" ? statusTone(session) : isUnseen(session) ? "unseen" : null) : null;
  const agentSaid = !session || !agentTone ? null : agentTone === "unseen" ? "새 답" : statusText(session);
  const agentState = agentSaid && !aiShown ? <><span className={`dot dot-${agentTone === "unseen" ? "idle" : agentTone} doc-agent-dot`} aria-hidden /><span className="doc-agent-said">{agentSaid}</span></> : null;
  // Its AI waits for an approval and its conversation is not on screen (the old drawer came up by
  // itself): one line at the document's foot opens it. Word showing it in its own sidebar needs none.
  // The Hangul dock is not that conversation: its approval is answered in the column, shown beside the editor.
  const agentWaits = !hosted && !columnShows && session?.status === "awaitingApproval" && !(officeEditing && editorAi === true && !editorAiIsEntry(format));

  const documentMain = (
    <main ref={rootRef} className="document-view" data-editor-view={lease.viewId} data-editor-access={lease.canWrite ? "write" : "read"} data-hosted={hosted ? "" : undefined}>
      {tabs}
      <header className="doc-header">
        {hosted && !hosted.over ? null : (
          // In its own tab: to its conversation. Laid over its conversation: back to it (the companion closes).
          <button type="button" className="ghost-button doc-back" title={hosted ? "대화로 돌아가기 · 이 문서는 대화의 파일 카드에서 다시 엽니다" : undefined} onClick={() => afterSaving(hosted ? hosted.onClose : onBack)}>
            <Icon name="arrowLeft" size={15} /> 대화{hosted?.over && hosted.back ? ` · ${hosted.back}` : ""}
          </button>
        )}
        <div className="doc-title">
          <FormatBadge format={artifact.format} />
          <span className="doc-name" title={artifact.path}>
            {artifact.name}
          </span>
        </div>
        <div className="doc-header-right">
          {hosted ? (
            // Beside a conversation the input is that conversation's: this document's own AI is in the document's tab.
            <button type="button" className="ghost-button doc-agent-toggle" disabled={!session || !hosted.onAgent} title="이 문서의 AI 대화를 문서의 탭에서 엽니다 · 메인 대화와 따로 실행됩니다" onClick={() => session && hosted.onAgent?.(session)}>
              <Icon name="chat" size={14} /> <span>문서 AI</span>{agentState ? <> · {agentState}</> : null}
            </button>
          ) : (
            <button type="button" className="ghost-button doc-agent-toggle" aria-expanded={aiShown} aria-busy={dockEntry && dockWish === true && !dockAgrees && !dockFailed ? true : undefined}
              title={dockEntry ? "이 문서의 AI를 편집기 안에서 엽니다 · 고른 부분을 바로 고치고 한 번에 되돌릴 수 있습니다" : "이 문서의 AI와 나누는 대화를 문서 옆에 엽니다 · 메인 대화와 따로 실행됩니다"}
              onClick={() => {
                setFocusedConversationId(null);
                if (!dockEntry) { setAiOpen(!aiOpen); return; }
                // The column beside the editor (a notice, an approval) closes; otherwise the dock turns to the other state from what is on screen.
                if (columnHere) { setColumnHere(false); onFocusDone?.(); wishAi(false); return; }
                // Turned to the other state from what is on screen, and asked afresh (the same few tries) —
                // also after the failure line, whose advice is exactly this press. An open dock hidden for a
                // studio dialog is not on screen: the press brings it over the dialog (ruling D).
                wishAi(!dock.shown); setDockShowAsked(!dock.shown); setDockPresses((presses) => presses + 1);
              }}>
              <Icon name="chat" size={14} /> <span>문서 AI</span>{agentState ? <> · {agentState}</> : null}
            </button>
          )}
          {!hosted && onBeside ? (
            <button type="button" className="ghost-button doc-beside" title="나란히 · 이 문서를 대화 옆으로 옮깁니다 (Alt+4)" onClick={onBeside}>
              <Icon name="columns" size={14} /> 대화 옆에
            </button>
          ) : null}
          <OfficeFileMenu api={rootApi} workId={work.id} workspaceId={artifact.workspaceId}
            onExportPdf={officeEditing && ["docx", "pptx", "xlsx", "hwpx", "hwp", "markdown", "html"].includes(artifact.format) ? () => officeRef.current?.exportPdf() : undefined}
            onExportDocx={officeEditing && ["markdown", "html"].includes(artifact.format) ? () => officeRef.current?.exportDocx() : undefined}
            onExportOdt={officeEditing && ["markdown", "html"].includes(artifact.format) ? () => officeRef.current?.exportOdt() : undefined}
            onExportHtml={officeEditing && ["docx", "html"].includes(artifact.format) ? () => officeRef.current?.exportHtml() : undefined}
            onExportImages={officeEditing && ["docx", "pptx", "markdown"].includes(artifact.format) ? () => officeRef.current?.exportImages() : undefined}
            onOpenWord={officeEditing && artifact.format === "markdown" ? () => officeRef.current?.exportDocx(true) : undefined}
            sessionId={session?.workspaceId === artifact.workspaceId ? session?.id : undefined}
            cwd={state.workspaces[artifact.workspaceId ?? ""]?.cwd ?? work.cwd} sourceKey={artifact.id} pickFile={pickFile}
            beforeOpen={async () => await save() !== null} onOpenArtifact={onOpenArtifact} onToast={onToast} />
          {officeEditing ? <button type="button" className="ghost-button" aria-haspopup="dialog" disabled={officeStatus.revision === null || Boolean(compare || viewing)} title="원본 메뉴와 현재 리본의 명령 찾기 (편집기에서 Alt+/)" onClick={() => officeRef.current?.showCommands()}><Icon name="search" size={14} /> 편집 명령</button> : null}
          {markdownDoc && !hosted && (mode === "edit" || mode === "split") && !viewing && !compare && base ? (
            <button type="button" className="ghost-button draw-here" onClick={() => setDrawOpen(!drawOpen)} aria-expanded={drawOpen} title="여기에 그림 그리기 (Ctrl+Alt+G) · GPT Image (Codex)">
              <Icon name="image" size={14} /> 그림
            </button>
          ) : null}
          {hosted ? (
            // Beside a conversation: the app's own read views only (the editor is in the document's tab).
            hostedViews.length > 1 ? (
              <div className="segmented small" role="radiogroup" aria-label="보기">
                {hostedViews.map(([value, label]) => (
                  <button key={value} type="button" role="radio" aria-checked={mode === value} className={mode === value ? "active" : ""} onClick={() => setMode(value)}>{label}</button>
                ))}
              </div>
            ) : null
          ) : artifact.format === "markdown" ? (
            <div className="segmented small" role="radiogroup" aria-label="보기">
              {(["rich", "edit", "split", "preview"] as const).map((value) => (
                <button key={value} type="button" role="radio" aria-checked={mode === value} className={mode === value ? "active" : ""} onClick={() => void changeMode(value)}>
                  {value === "rich" ? "편집" : value === "edit" ? "원문" : value === "split" ? "둘 다" : "미리보기"}
                </button>
              ))}
            </div>
          ) : wordEditor ? (
            <div className="segmented small" role="radiogroup" aria-label="보기">
              {(["edit", "preview"] as const).map((value) => (
                <button key={value} type="button" role="radio" aria-checked={mode === value} className={mode === value ? "active" : ""} onClick={() => void changeMode(value)}>
                  {value === "edit" ? "편집" : artifact.format === "pdf" ? "미리보기" : "글 보기"}
                </button>
              ))}
            </div>
          ) : office ? (
            <div className="segmented small" role="radiogroup" aria-label="보기">
              {(["pages", "preview"] as const).map((value) => (
                <button key={value} type="button" role="radio" aria-checked={mode === value} className={mode === value ? "active" : ""} onClick={() => setMode(value)}>
                  {value === "pages" ? "쪽 보기" : "글 보기"}
                </button>
              ))}
            </div>
          ) : artifact.format === "html" ? (
            <div className="segmented small" role="radiogroup" aria-label="보기">
              {(["rich", "render", "source"] as const).map((value) => (
                <button key={value} type="button" role="radio" aria-checked={mode === value} className={mode === value ? "active" : ""} onClick={() => void changeMode(value)}>
                  {value === "rich" ? "편집" : value === "render" ? "화면" : "원문"}
                </button>
              ))}
            </div>
          ) : null}
          {!hosted && (wordEditor || richTextEditor) ? (
            <button
              type="button"
              className="ghost-button"
              title="저장한 뒤 이음오피스 앱에서 같은 파일을 엽니다"
              onClick={() => {
                if (!state.tools?.ieumApp?.available) { onExternalSetup(); return; }
                void (async () => {
                  const revision = await save();
                  if (revision === null) return;
                  await lease.sync(false, revision);
                  const opened = await api.openExternal(artifactId);
                  onToast(`${opened.app}에서 같은 파일을 열었습니다. 저장 내용은 여기에도 자동으로 반영됩니다.`);
                })().catch((error: Error) => onToast(failure(error)));
              }}
            >
              <Icon name="file" size={14} /> 앱으로 열기
            </button>
          ) : null}
          <div className="anchor">
            <button
              type="button"
              className="ghost-button"
              onClick={() => {
                setHistoryOpen(!historyOpen);
                if (!historyOpen) void api.revisions(artifactId).then(setHistory).catch(() => undefined);
              }}
              title="판 기록"
            >
              r{artifact.revision} <Icon name={historyOpen ? "chevronUp" : "chevronDown"} size={13} />
            </button>
            <Popover open={historyOpen} onClose={() => setHistoryOpen(false)} align="right" className="history-menu">
              <div className="menu-label">판 기록 · 되돌리기도 새 판으로 남습니다</div>
              {[...history].reverse().map((entry) => (
                <MenuItem
                  key={entry.revision}
                  hint={ago(entry.at)}
                  onSelect={() => {
                    setHistoryOpen(false);
                    if (entry.revision === artifact.revision) {
                      setViewing(null);
                      return;
                    }
                    if (design || office) setViewing({ revision: entry.revision, text: "" });
                    else void api.artifactText(artifactId, entry.revision).then((result) => setViewing({ revision: entry.revision, text: result.text }));
                  }}
                >
                  r{entry.revision} ·{" "}
                  {entry.author === "user" ? "내 편집" : entry.author === "engine" ? `${PROVIDER_LABEL[state.sessions[entry.sessionId ?? ""]?.provider ?? "claude"]}` : "외부 변경"}
                  {entry.note ? ` · ${entry.note}` : ""}
                </MenuItem>
              ))}
            </Popover>
          </div>
          <span
            className={`save-state save-${shownState}`}
            data-base-revision={base?.revision ?? ""}
            data-unsaved={base ? String(text !== base.text) : ""}
          >
            {textual || officeEditing ? statusLabel : design ? designLabel : `r${artifact.revision}`}
          </span>
          {onRead ? (
            <button type="button" className="icon-button small" aria-label="읽기" title="읽기 · 화면 가득 쪽 넘기며 읽기 (Alt+5)" onClick={() => afterSaving(onRead)}>
              <Icon name="book" size={16} />
            </button>
          ) : null}
          {hosted ? (
            <>
              <button type="button" className="ghost-button doc-wide" title="이 문서를 탭으로 열어 고칩니다 (Alt+2) · 여기서는 읽기만 합니다" onClick={() => afterSaving(hosted.onWide)}>
                <Icon name="openNew" size={14} /> 탭으로 열어 고치기
              </button>
              {hosted.over ? null : (
                <button type="button" className="icon-button small" aria-label="곁 화면 닫기" title="곁 화면 닫기 · 대화만 보기 (Alt+1)" onClick={() => afterSaving(hosted.onClose)}>
                  <Icon name="x" size={16} />
                </button>
              )}
            </>
          ) : null}
        </div>
      </header>

      {narrowOffer && officeEditing && !forcedEditor ? (
        <div className="doc-note-line">
          <NoteBanner label="좁은 칸 안내" action={{ label: stoodIn.go, run: () => void changeMode(stoodIn.mode) }}>
            칸이 좁아 편집기의 글이 잘릴 수 있습니다. 편집기는 그대로 두었습니다.
          </NoteBanner>
        </div>
      ) : narrowAuto && !officeEditing ? (
        <div className="doc-note-line">
          <NoteBanner label="좁은 칸 안내" action={{ label: "편집기로 열기", run: () => void changeMode(editorMode) }}>
            칸이 좁아 {stoodIn.label}{stoodIn.label === "원문" ? "으로" : "로"} 열었습니다. 편집기는 넓은 칸에서 글이 잘리지 않습니다.
          </NoteBanner>
        </div>
      ) : null}

      {legacyHangulDraft ? <div className="notice doc-legacy-draft" role="status">
        이전 버전에서 저장하지 않은 글 편집이 남아 있습니다(r{legacyHangulDraft.baseRevision}).
        <button type="button" className="button small" onClick={() => setCompare({ title: "이전 글 편집 복구본", before: base?.text ?? "", after: legacyHangulDraft.text, beforeLabel: `현재 r${artifact.revision}`, afterLabel: "복구본" })}>복구본 검토</button>
        <button type="button" className="button small" disabled={!lease.canWrite || artifact.revision !== legacyHangulDraft.baseRevision || officeStatus.dirty} onClick={() => {
          const draft = legacyHangulDraft;
          void api.saveArtifact(artifactId, draft.baseRevision, draft.text).then(() => {
            clearRecoveredDraft(draft); setLegacyHangulDraft(null); setCompare(null); onToast("이전 글 편집을 새 판으로 복구했습니다.");
          }).catch((error: Error) => onToast(failure(error)));
        }}>복구본을 새 판으로 저장</button>
        {artifact.revision !== legacyHangulDraft.baseRevision ? <span>문서가 바뀌어 자동 적용하지 않습니다. 복구본은 보관됩니다.</span> : null}
      </div> : null}

      {readers.length || artifact.diskState !== "same" ? (
        <div className="doc-readers">
          {readers.map(({ session: reader, revision }) => (
            <span key={reader.id} className={`reader-chip${revision === artifact.revision ? " current" : ""}`} style={accentStyle(lookOf(reader.provider))}>
              <EngineMark provider={reader.provider} size={13} /> 읽은 판 r{revision} · {reader.purpose}
              {revision !== artifact.revision ? ` · 지금 r${artifact.revision}` : ""}
            </span>
          ))}
          {artifact.diskState === "changed" ? (
            <span className="reader-chip warn">
              디스크의 파일이 바뀌었습니다
              {!unsaved && !(officeEditing && officeStatus.dirty) ? (
                <button
                  type="button"
                  className="link"
                  onClick={() =>
                    void api
                      .adoptDisk(artifactId)
                      .then((adopted) => onToast(`바뀐 내용을 새 판 r${adopted.revision}로 받았습니다.`))
                      .catch((error: Error) => onToast(failure(error)))
                  }
                >
                  새 판으로 받기
                </button>
              ) : null}
            </span>
          ) : null}
          {artifact.diskState === "missing" ? <span className="reader-chip warn">디스크에서 파일이 사라졌습니다</span> : null}
        </div>
      ) : null}

      {conflict ? (
        <div className="doc-conflict" role="alert">
          <strong>저장하지 않았습니다.</strong> {conflict.message}
          <span className="doc-conflict-actions">
            <button
              type="button"
              className="button small"
              onClick={() =>
                void api.artifactText(artifactId).then((latest) =>
                  setCompare({ title: "최신 판과 내 편집", before: latest.text, after: text, beforeLabel: `r${latest.revision}`, afterLabel: "내 편집" }),
                )
              }
            >
              차이 보기
            </button>
            <button
              type="button"
              className="button small"
              onClick={() => {
                localStorage.setItem(`workbench.docDraft.${artifactId}.kept.${Date.now()}`, text);
                clearRecoveredDraft(recoveredDraft.current); recoveredDraft.current = null;
                void load(false);
              }}
            >
              최신 판 받기(내 편집은 보관)
            </button>
            <button
              type="button"
              className="button small primary"
              onClick={async () => {
                try {
                  if (conflict.code === "disk_changed") await api.adoptDisk(artifactId);
                  const latest = await api.artifactText(artifactId);
                  const saved = await api.saveArtifact(artifactId, latest.revision, text);
                  ownRevisions.current.add(saved.revision);
                  setBase({ revision: saved.revision, text });
                  setConflict(null);
                  setSaveState("idle");
                  clearRecoveredDraft(recoveredDraft.current); recoveredDraft.current = null;
                  onToast(`내 편집을 새 판 r${saved.revision}으로 저장했습니다. 이전 판은 기록에 남아 있습니다.`);
                } catch (error) {
                  onToast(failure(error));
                }
              }}
            >
              내 편집을 새 판으로
            </button>
          </span>
        </div>
      ) : null}

      {officeEditing && officeStatus.conflict ? (
        <div className="doc-conflict" role="alert">
          <strong>저장하지 않았습니다.</strong> {officeStatus.conflict.message}
          <span className="doc-conflict-actions">
            {confirmDrop ? (
              <>
                <span>편집기의 저장하지 않은 편집을 버리고 최신 판을 열까요?</span>
                <button
                  type="button"
                  className="button small"
                  onClick={() => {
                    setConfirmDrop(false);
                    officeRef.current?.reload();
                  }}
                >
                  버리고 열기
                </button>
                <button type="button" className="button small" onClick={() => setConfirmDrop(false)}>
                  그대로 두기
                </button>
              </>
            ) : (
              <>
                <button type="button" className="button small" onClick={() => setConfirmDrop(true)}>
                  최신 판 열기
                </button>
                {officeStatus.dirty ? (
                  <button type="button" className="button small primary" onClick={() => void keepMine()}>
                    내 편집을 새 판으로
                  </button>
                ) : null}
              </>
            )}
          </span>
        </div>
      ) : null}

      {proposals.length && !compare ? (
        <div className="doc-proposals">
          {proposals.map((proposal) => {
            const owner = state.sessions[proposal.sessionId];
            return (
              <div key={proposal.id} className={`doc-proposal${stale(proposal) ? " stale" : ""}`} style={owner ? accentStyle(lookOf(owner.provider)) : undefined}>
                {owner ? <EngineMark provider={owner.provider} size={14} /> : null}
                <span>
                  {owner ? PROVIDER_LABEL[owner.provider] : "AI"}의 수정안 · r{proposal.baseRevision} 기준
                  {proposal.status === "running" ? " · 만드는 중…" : design || office ? (proposal.problem ? " · 파일 오류" : "") : ` · +${proposal.added} −${proposal.removed}`}
                  {stale(proposal) ? ` · 지금 r${artifact.revision}, 자동 적용 안 함` : ""}
                </span>
                <PartialNote proposal={proposal} compact />
                {proposal.status === "pending" ? (
                  <span className="doc-proposal-actions">
                    <button type="button" className="button small" onClick={() => void showProposal(proposal)}>
                      {stale(proposal) ? "차이 보기" : "미리보기"}
                    </button>
                    {!stale(proposal) && !proposal.problem ? (
                      <button type="button" className="button small primary" onClick={() => void apply(proposal)}>
                        적용
                      </button>
                    ) : null}
                    <button type="button" className="button small" onClick={() => void discard(proposal)}>
                      취소
                    </button>
                  </span>
                ) : (
                  <span className="spinner small" />
                )}
              </div>
            );
          })}
        </div>
      ) : null}

      {dockEntry && dockFailed ? <div className="notice doc-dock-failed" role="status">
        {dockWish ? "문서 AI가 편집기 안에서 열리지 않았습니다. 문서 AI를 다시 누르거나, 글 보기에서 대화를 여세요." : "문서 AI가 편집기 안에서 닫히지 않았습니다. 문서 AI를 다시 눌러 주세요."}
      </div> : null}
      {agentError ? <div className="notice" role="alert">{agentError}<button type="button" className="button small" onClick={() => setAgentRetry((value) => value + 1)}>다시 연결</button></div> : null}
      {canEditFormat && !lease.canWrite && !hosted ? <div className="doc-access notice" role="status">
        {lease.error ?? (!lease.ready ? "문서 편집 권한을 확인하는 중…" : lease.registration?.writer ? "다른 탭이나 창에서 편집 중입니다. 이곳에서는 읽기만 할 수 있습니다." : "이 문서를 읽기 전용으로 보고 있습니다.")}
        {dirty ? " 저장되지 않은 입력은 이 탭에 유지했습니다." : ""}
        <button type="button" className="button small" onClick={() => void lease.claim()}>편집 권한 받기</button>
      </div> : null}
      <div className="doc-body" ref={bodyRef} inert={!lease.canWrite && everWriter.current && Boolean(design || officeEditing)}>
        {officeEditing && everWriter.current ? (
          <OfficeEditor ref={officeRef} api={api} artifact={artifact} access={lease.access()} sessionId={lease.registration?.view.sessionId ?? null} hidden={Boolean(compare || viewing)} onStatus={setOfficeStatus} onAiPanel={onEditorAi} onReload={onEditorReload} onNotice={onToast} onCopied={onOpenArtifact} onPresent={onPresent}
            onPrepareAi={(revision) => lease.sync(false, revision)} onAiSettings={onAiSettings}
            onNewSession={async (revision) => {
              await lease.sync(false, revision);
              const scope = agentScope.current;
              const next = await rootApi.documentSession(artifactId, parentId, true);
              if (agentScope.current.artifactId !== scope.artifactId || agentScope.current.parentId !== scope.parentId) throw new Error("문서나 메인 대화가 바뀌었습니다. 현재 문서에서 다시 요청해 주세요.");
              setAgent(next);
              await lease.sync(false, revision, next.id);
              return next.id;
            }} />
        ) : null}
        {body}
      </div>
      {markdownDoc && lease.canWrite ? (
        <InlineDraw
          api={api}
          state={state}
          work={work}
          session={session}
          artifact={artifact}
          view={editorView}
          ready={Boolean(base)}
          open={drawOpen}
          onOpen={setDrawOpen}
          onInsertText={setText}
          onToast={onToast}
        />
      ) : null}
      {agentWaits && session ? (
        <div className="child-work doc-agent-wait">
          <button type="button" className="child-work-line" onClick={() => { setFocusedConversationId(null); if (dockEntry) setColumnHere(true); else setAiOpen(true); }}>
            <span className="dot dot-attention" aria-hidden />
            <EngineMark provider={session.provider} size={14} />
            <span className="child-work-who">문서 AI · 승인 필요</span>
            <span className="child-work-state">확인을 기다립니다</span>
            <span className="child-work-open">열기</span>
            <Icon name="chevronRight" size={14} />
          </button>
        </div>
      ) : null}
    </main>
  );

  // The input zone of the document's AI: under its transcript, in its column.
  const agentInput = (
    <>
        {agentNote && session ? <NoteBanner label="문서 AI 안내">{agentNote}</NoteBanner> : null}
        {ended ? (
          <NoteBanner label="문서 AI 안내" action={{ label: "문서 AI 시작", disabled: starting, run: () => {
            setStarting(true); setAgentError("");
            // The gateway starts (or returns) a live conversation of this document; the lease stays.
            void rootApi.documentSession(artifactId, parentId).then(setAgent, (error) => setAgentError(error instanceof Error ? error.message : String(error))).finally(() => setStarting(false));
          } }}>이 문서의 AI 대화는 보관했습니다. 보관함에서 되돌리거나 새 대화를 시작할 수 있습니다.</NoteBanner>
        ) : <Composer
          provider={sendTarget?.provider}
          disabled={agentChanging || !session}
          onFiles={pending.add}
          onDesktopPicture={() => api.clipboardPicture()}
          attachments={pending.count}
          draftKey={`doc:${artifactId}`}
          voiceScope={sendTarget ? { workId: sendTarget.workId, sessionId: sendTarget.id } : undefined}
          voiceReply={state.transcripts[sendTarget?.id ?? ""]?.items.filter(item => item.kind === "assistant" && !item.streaming).map(item => item.kind === "assistant" ? item.text : "").at(-1)}
          placeholder={selection ? "이 부분에 요청하기" : "이 문서에 요청하기"}
          busy={Boolean(sendTarget && isBusy(sendTarget))}
          waiting={turnRunning(sendTarget)}
          header={
            <div className="doc-chips">
              <PendingFiles files={pending.files} onRetry={pending.retry} onRemove={(key) => pending.remove([key])} />
              {handoffTo ? (
                <span className="target-chip" style={accentStyle(lookOf(handoffTo.provider))}>
                  <EngineMark provider={handoffTo.provider} size={13} /> @{handoffTo.purpose}
                  <button type="button" onClick={() => setHandoffTo(null)} aria-label="받는 세션 지우기">
                    <Icon name="x" size={11} />
                  </button>
                </span>
              ) : null}
              {includeDoc ? (
                <span className="ref-chip">
                  <Icon name="file" size={12} /> 현재 문서 · r{base?.revision ?? artifact.revision}
                  {unsaved || (design && designStatus.state === "dirty") || (officeEditing && officeStatus.dirty) ? " (보낼 때 저장)" : ""}
                  <button type="button" onClick={() => setIncludeDoc(false)} aria-label="문서 빼기">
                    <Icon name="x" size={11} />
                  </button>
                </span>
              ) : (
                <button type="button" className="ref-chip add" onClick={() => setIncludeDoc(true)}>
                  <Icon name="plus" size={12} /> 현재 문서 붙이기
                </button>
              )}
              {includeDoc && selection ? (
                <span className="ref-chip selection">
                  선택한 부분 · {selection.label}
                  <button type="button" onClick={() => setSelection(null)} aria-label="선택 빼기">
                    <Icon name="x" size={11} />
                  </button>
                </span>
              ) : null}
              {others.map((id) => {
                const other = state.artifacts[id];
                return other ? (
                  <span key={id} className="ref-chip">
                    <Icon name="file" size={12} /> {other.name} · {references.pins[id] ? `r${references.pins[id].revision} 고정 · 미저장 제외` : `${references.hint(other)} · 보낼 때 저장`} · 읽기
                    <button type="button" className="ref-role" onClick={() => void references.toggleSnapshot(id)}>{references.pins[id] ? "최신으로" : "저장된 판만"}</button>
                    <button type="button" onClick={() => { setOthers(others.filter((entry) => entry !== id)); references.forget(id); }} aria-label="문서 빼기">
                      <Icon name="x" size={11} />
                    </button>
                  </span>
                ) : null;
              })}
              {create ? <CreateChip target={create} onChange={setCreate} onClear={() => setCreate(null)} /> : null}
              {handoffTo ? <span className="muted">회신: 이 작업 · 읽기 전용 판으로 보냄</span> : null}
            </div>
          }
          onSend={async (message) => {
            const candidates: DocRefInput[] = includeDoc ? [{ artifactId, ...(selection ? { revision: base?.revision ?? artifact.revision } : {}), mode: effectiveMode, selection: selection && textual ? selection : selection ? { ...selection } : null }] : [];
            for (const id of others) {
              const other = state.artifacts[id];
              if (other) candidates.push({ artifactId: other.id, mode: "review", selection: null });
            }
            const refs = await references.resolve(candidates);
            if (!refs) return false;
            const { carried, done } = await pending.take();
            const sent = await onSend(session, message, refs, handoffTo, handoffTo ? null : create, carried);
            if (sent) {
              setAgentNote(null);
              if (handoffTo) setHandoffTo(null);
              setOthers([]);
              references.clear();
              setCreate(null);
              done();
            }
            return sent;
          }}
          mentions={{ items: mentionItems, onPick: (item) => setOthers((current) => (current.includes(item.id) ? current : [...current, item.id])) }}
          tools={<CreateTargetButton api={api} scope={{ sessionId: session?.id, workId: work.id, workspaceId: artifact.workspaceId }} onTemplate={setCreate} tools={state.tools} onPick={(format) => setCreate({ format, name: stemOf(artifact.name) })} />}
          target={
            // The conversation's bar: model, effort, where it goes, a document to attach. The one
            // extra is what the request does to this document: 수정 (a proposal) or 검토 (an answer).
            <>
            {!handoffTo && includeDoc && editable && !create ? (
              <div className="segmented small composer-kind" role="radiogroup" aria-label="요청 종류">
                <button type="button" role="radio" aria-checked={requestMode === "edit"} className={requestMode === "edit" ? "active" : ""} onClick={() => setRequestMode("edit")} title="수정 요청: AI가 작업 사본을 고치고 수정안으로 보여 줍니다">수정</button>
                <button type="button" role="radio" aria-checked={requestMode === "review"} className={requestMode === "review" ? "active" : ""} onClick={() => setRequestMode("review")} title="검토 요청: 읽고 답만 합니다">검토</button>
              </div>
            ) : null}
            {session ? (
              <span className="composer-group" inert={agentChanging || Boolean(handoffTo)}>
                <ModelPicker key={session.id} models={state.providers[session.provider]?.models ?? []} value={{ model: session.model, effort: session.effort }} onChange={changeModel} onRefresh={() => rootApi.refreshProviders(session.provider)} />
              </span>
            ) : null}
            <div className="anchor">
              <button type="button" className="select-button" onClick={() => setTargetOpen(!targetOpen)} aria-haspopup="menu" aria-expanded={targetOpen} title={handoffTo ? handoffTo.purpose : session?.purpose}>
                {sendTarget ? <EngineMark provider={sendTarget.provider} size={15} /> : null}
                <span className="composer-target-name">{handoffTo ? `다른 세션에 · ${handoffTo.purpose}` : session ? `${PROVIDER_LABEL[session.provider]} · ${artifact.name}` : "새 세션"}</span>
                <Icon name={targetOpen ? "chevronUp" : "chevronDown"} size={14} />
              </button>
              <Popover open={targetOpen} onClose={() => setTargetOpen(false)} placement="above" align="right" role="menu" label="받는 곳">
                <div className="menu-label">이 문서의 AI · 엔진마다 대화가 따로 있습니다</div>
                {session ? (["codex", "claude"] as const).map((provider) => {
                  const current = !handoffTo && session.provider === provider;
                  return (
                    <MenuItem key={provider} active={current} disabled={!current && session.provider !== provider && (engineLocked || agentChanging)} disabledReason="응답과 대기 요청을 마치거나 멈춘 뒤 엔진을 바꿀 수 있습니다."
                      onSelect={() => {
                        setTargetOpen(false);
                        setHandoffTo(null);
                        if (session.provider !== provider) changeEngine(provider);
                      }}>
                      <span className="menu-engine" style={accentStyle(lookOf(provider))}><EngineMark provider={provider} size={15} />{PROVIDER_LABEL[provider]}</span>
                    </MenuItem>
                  );
                }) : null}
                <div className="menu-divider" />
                <MenuItem
                  active={Boolean(handoffTo)}
                  hint="검토 요청"
                  onSelect={() => {
                    setTargetOpen(false);
                    void onPickTarget().then((picked) => picked && setHandoffTo(picked.id === session?.id ? null : picked));
                  }}
                >
                  다른 세션에…
                </MenuItem>
              </Popover>
            </div>
            <div className="anchor">
              <button type="button" className="icon-button" title="참조 문서 붙이기" aria-label="참조 문서 붙이기" aria-expanded={attachOpen} aria-haspopup="menu" onClick={() => setAttachOpen(!attachOpen)}><Icon name="file" size={17} /></button>
              <Popover open={attachOpen} onClose={() => setAttachOpen(false)} placement="above" align="right">
                <div className="menu-label">참조 문서 · 보내기 전에 저장 확인</div>
                {mentionItems.map((item) => <MenuItem key={item.id} active={others.includes(item.id)} hint={item.hint} onSelect={() => {
                  setOthers((current) => current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id]);
                  references.forget(item.id); setAttachOpen(false);
                }}>{item.name}</MenuItem>)}
                {!mentionItems.length ? <div className="menu-label">이 작업에 다른 문서가 없습니다.</div> : null}
              </Popover>
            </div>
            </>
          }
        />}
        <div className="footer-line">
          {working ? (
            <span>
              <span className="spinner small" /> {PROVIDER_LABEL[state.sessions[working.sessionId]?.provider ?? "claude"]}가 r{working.baseRevision} 기준 수정안을 만드는 중
            </span>
          ) : null}
          {reviewing.map((handoff) => {
            const target = state.sessions[handoff.targetSessionId];
            return target ? (
              <span key={handoff.id}>
                {" "}
                · {target.purpose} · {PROVIDER_LABEL[target.provider]}가 확인 중
              </span>
            ) : null;
          })}
          {!working && !reviewing.length ? <span className="muted">{FORMAT_LABEL[artifact.format]} · {work.title}</span> : null}
        </div>
    </>
  );

  // A conversation's companion: the document alone (the conversation beside it has the input).
  if (hosted) return documentMain;

  // Another conversation of this document (from a notice or a search hit) is shown in the column
  // in place of the current one — with no input under it: an input sits only under the transcript
  // it sends to.
  const other = focusedConversation && focusedConversation.id !== session?.id ? focusedConversation : null;
  // Beside the editor (a notice, an approval) the column closes and the dock goes back to the wish.
  const closeColumn = () => { if (dockEntry) setColumnHere(false); else setAiOpen(false); setFocusedConversationId(null); onFocusDone?.(); };
  const column = columnShows ? (
    <AgentColumn
      state={state}
      // An archived AI's conversation stays readable here (nothing in it is answered), until another is started.
      session={other ?? session ?? ended ?? null}
      kind="document"
      name={artifact.name}
      inputClass="doc-composer"
      waiting={ended ? undefined : agentError ? undefined : "문서 AI를 준비하고 있습니다."}
      readOnly={Boolean(other ? other.archivedAt : !session && ended)}
      onClose={closeColumn}
      onMenu={onSessionMenu}
      onOpenParent={() => afterSaving(onBack)}
      onAnswer={(answered, itemId, decision, response) => onAnswer?.(answered, itemId, decision, response)}
      focusItem={focusItem && focusItem.sessionId === (other ?? session ?? ended)?.id ? focusItem : null}
      onFocusDone={onFocusDone}
    >
      {other ? (
        <NoteBanner label="문서 AI 안내" action={{ label: "지금 대화로", run: () => { setFocusedConversationId(null); onFocusDone?.(); } }}>
          이 문서의 다른 AI 대화({PROVIDER_LABEL[other.provider]})를 보고 있습니다{other.archivedAt ? " · 보관한 대화라 읽기만 할 수 있습니다" : ""}.
        </NoteBanner>
      ) : (
        <>
          {session && queued ? <QueuedList session={session} busy={isBusy(session)} actions={queued} /> : null}
          {agentInput}
        </>
      )}
    </AgentColumn>
  ) : null;

  return (
    <Beside
      chat={column}
      content={documentMain}
      over="chat"
      // An embedded editor keeps an AI panel of its own beside the page (not the Hangul editor; Word says when it is closed).
      contentMin={companionMinimum({ editing: officeEditing, panel: officeEditing && editorKeepsAiPanel(artifact?.format, editorAi) })}
      ratio={columnRatio}
      onRatio={setColumnRatio}
      resetRatio={0.38}
      chatLabel="문서 AI 대화"
      contentLabel="문서"
      onDismiss={closeColumn}
    />
  );
}
