import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { diagramComponents } from "../Diagram.tsx";
import { ObsidianMarkdown, obsidianComponents } from "../../markdown/obsidian.tsx";

const DRAWN = diagramComponents();
import { FORMAT_LABEL, PROVIDER_LABEL, isOfficeFormat, type CreateTarget, type Artifact, type ArtifactRevision, type Attachment, type DocRef, type DocRefInput, type Proposal, type Session, type Work } from "@workbench/contracts";
import { ApiRequestError, type Api } from "../../api.ts";
import { accentStyle, useAppearance } from "../../appearance.ts";
import { ago } from "../../format.ts";
import { isBusy, type State } from "../../state.ts";
import { Composer } from "../Composer.tsx";
import { PendingFiles, usePendingFiles } from "../Attachments.tsx";
import { FormatBadge } from "../DocCards.tsx";
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
import { ConversationDrawer, ConversationSheet, type DrawerMode } from "./ConversationDrawer.tsx";
import type { EditorView } from "@codemirror/view";
import { InlineDraw, drawExtension } from "./InlineDraw.tsx";
import { docPictureComponents } from "../ImageGen.tsx";
import { useKeptPosition, type ModeProps } from "../../workmodes.ts";
import { useDocImages } from "./DocImages.tsx";
import type { TabUiState } from "../../panes.ts";
import { useDocumentSession } from "../../document-session.ts";
import { clearRecoveredDraft, keepDraft, newestDraft } from "../../document-drafts.ts";
import { registerDocumentCommands } from "../../document-commands.ts";
import { useDocumentReferences } from "../../document-references.ts";
import { OfficeFileMenu } from "../OfficeFileMenu.tsx";

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
  work,
  session,
  onBack,
  onSend,
  onPickTarget,
  onNewSession,
  onAiSettings,
  onOpenArtifact,
  pickFile,
  onToast,
  tabs,
  openDocIds,
  onLeaveGuard,
  onAnswer,
  modes,
  uiState,
  onUiState,
}: {
  uiState?: TabUiState;
  onUiState?: (state: TabUiState) => void;
  /** The work screen's modes: their bar, and in "나란히" where the input goes. */
  modes?: ModeProps;
  /** Answer an approval of the session from the drawer, without leaving the document. */
  onAnswer?: (session: Session, itemId: string, decision: "accept" | "decline") => void;
  /** Register how to save edits only this view holds (the Word editor) before the app leaves it. */
  onLeaveGuard?: (guard: ((reason?: "close") => Promise<void>) | null) => void;
  /** Open document tabs of this work. */
  tabs?: ReactNode;
  openDocIds?: string[];
  api: Api;
  state: State;
  artifactId: string;
  focusProposalId: string | null;
  work: Work;
  session: Session | null;
  onBack: () => void;
  onSend: DocSend;
  /** Opens the "어느 세션에 보낼까요?" picker; resolves with the chosen session. */
  onPickTarget: () => Promise<Session | null>;
  onNewSession: () => Promise<Session | null>;
  onAiSettings: () => void;
  onOpenArtifact: (artifactId: string) => void;
  pickFile?: ((folder: string) => Promise<string | null>) | null;
  onToast: (message: string) => void;
}) {
  const { lookOf } = useAppearance();
  const artifact = state.artifacts[artifactId] as Artifact | undefined;
  const canEditFormat = Boolean(artifact);
  const lease = useDocumentSession(rootApi, artifact ? artifactId : null, session?.id ?? null, canEditFormat);
  const api = lease.api;
  const references = useDocumentReferences(rootApi, artifactId, onToast);
  const [attachOpen, setAttachOpen] = useState(false);
  const everWriter = useRef(false);
  if (lease.canWrite) everWriter.current = true;
  const recoveredDraft = useRef<ReturnType<typeof newestDraft>>(null);
  const [legacyHangulDraft, setLegacyHangulDraft] = useState<ReturnType<typeof newestDraft>>(null);
  // Pasted or dropped pictures: a link in Markdown (R2 or the work folder), refused in the Hangul text view.
  const docImages = useDocImages(api, artifact, onToast);
  const [drawer, setDrawer] = useState<DrawerMode>("closed");
  const textual = artifact ? TEXT_FORMATS.has(artifact.format) : false;
  const [base, setBase] = useState<{ revision: number; text: string } | null>(null);
  const [text, setText] = useState("");
  const latestText = useRef(text);
  latestText.current = text;
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [conflict, setConflict] = useState<Conflict>(null);
  const hangul = artifact?.format === "hwpx" || artifact?.format === "hwp";
  const office = artifact ? isOfficeFormat(artifact.format) : false;
  // Document screens built from IeumOffice, inside the central Workbench tab.
  const wordEditor = artifact?.format === "docx" || artifact?.format === "pptx" || artifact?.format === "xlsx" || artifact?.format === "pdf" || (artifact?.format === "xmind" || artifact?.format === "epub") || hangul;
  const richTextEditor = artifact?.format === "markdown" || artifact?.format === "html";
  const [mode, setMode] = useState<"edit" | "preview" | "split" | "render" | "source" | "pages" | "rich">(
    hangul && uiState?.mode === "pages" ? "edit" : uiState?.mode && ["edit", "preview", "split", "render", "source", "pages", "rich"].includes(uiState.mode) ? uiState.mode as "edit" | "preview" | "split" | "render" | "source" | "pages" | "rich" : richTextEditor ? "rich" : wordEditor ? "edit" : office ? "pages" : "edit",
  );
  useEffect(() => { onUiState?.({ mode }); }, [mode, onUiState]);
  const officeEditing = (wordEditor && mode === "edit") || (richTextEditor && mode === "rich");
  const officeRef = useRef<OfficeHandle>(null);
  const [officeStatus, setOfficeStatus] = useState<OfficeStatus>({ dirty: false, revision: null, conflict: null });
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
  const [includeDoc, setIncludeDoc] = useState(true);
  const [requestMode, setRequestMode] = useState<"edit" | "review">("edit");
  const [handoffTo, setHandoffTo] = useState<Session | null>(null);
  // Other documents mentioned with "@" (read as material), and a new document as the result.
  const [others, setOthers] = useState<string[]>([]);
  // Pictures and files pasted or dropped into the input below the document go with the request.
  const pending = usePendingFiles(
    (file) =>
      api.uploadAttachment(file).catch((error: unknown) => {
        onToast(error instanceof Error ? error.message : "파일을 올리지 못했습니다.");
        return null;
      }),
    artifactId,
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
    if (lease.ready) void load().catch((error: Error) => onToast(error.message));
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
            if (current !== "failed") onToast(`저장하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
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
      if (officeEditing && officeRef.current) await officeRef.current.leave();
      else {
        const submittedText = saving.current ? savingText.current : text;
        if (await save() === null) throw new Error("문서를 저장하지 못해 이동하지 않았습니다. 현재 편집 내용을 확인해 주세요.");
        if (!design && latestText.current !== submittedText) throw new Error("저장하는 동안 편집 내용이 바뀌어 이동을 보류했습니다. 다시 이동해 주세요.");
      }
      if (reason === "close" && lease.canWrite) await api.closeOfficePreview(artifactId);
    });
    return () => onLeaveGuard(null);
  }, [onLeaveGuard, officeEditing, save, text, design, editorView, onUiState, lease.canWrite, api, artifactId]);

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
  useEffect(() => { lease.report(dirty, (officeEditing ? officeStatus.revision : base?.revision) ?? designStatus.revision ?? artifact?.revision); }, [dirty, officeEditing, base?.revision, officeStatus.revision, designStatus.revision, artifact?.revision, lease.report]);
  useEffect(() => registerDocumentCommands(lease.viewId, {
    artifactId,
    control: async (request) => {
      if (!officeEditing) {
        if (request.cmd === "goto" && wordEditor) { setMode("edit"); return { status: "not_ready" }; }
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
  }), [artifactId, lease.viewId, dirty, save, text, design, officeEditing, wordEditor, lease.report]);

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
        onToast(error.message);
        modes?.onReview?.(null);
      });
    // Only when asked to show a specific proposal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusProposalId]);

  // "검토" in the mode bar follows the proposal compared here (opened from the bar or from a card).
  const comparing = compare?.proposal?.id ?? null;
  const reported = useRef<string | null>(null);
  const onReview = modes?.onReview;
  useEffect(() => {
    if (reported.current === comparing) return;
    reported.current = comparing;
    onReview?.(comparing);
    // A comparison needs the room: the drawer's peek folds away (a conversation laid open stays).
    if (comparing) setDrawer((current) => (current === "peek" ? "closed" : current));
  }, [comparing, onReview]);

  // Where the document was read comes back when this view returns from another mode.
  const bodyRef = useRef<HTMLDivElement>(null);
  useKeptPosition(bodyRef, `doc:${artifactId}`, { initial: uiState?.reading, onChange: (reading) => onUiState?.({ reading }) });

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
      onToast(error instanceof Error ? error.message : String(error));
    }
  };
  const discard = async (proposal: Proposal) => {
    await api.discardProposal(proposal.id).catch((error: Error) => onToast(error.message));
    setCompare(null);
  };

  // Leaving the editor view saves first; edits that cannot be saved keep it where it is.
  const changeMode = async (value: typeof mode) => {
    if (value === mode) return;
    if ((officeEditing || unsaved) && (await save()) === null) {
      onToast("저장하지 못한 편집이 있어 보기를 바꾸지 않았습니다. 위의 안내를 먼저 확인해 주세요.");
      return;
    }
    setMode(value);
  };
  // After a conflict: my edits become the next revision; the other one stays in the history.
  const keepMine = async () => {
    const conflictNow = officeStatus.conflict;
    if (!officeRef.current || !conflictNow) return;
    try {
      const latest = conflictNow.code === "disk_changed" ? (await api.adoptDisk(artifactId)).revision : artifact.revision;
      const saved = await officeRef.current.rebase(latest);
      onToast(saved === null ? "내 편집을 저장하지 못했습니다. 잠시 뒤 다시 해 보세요." : `내 편집을 새 판 r${saved}로 저장했습니다. 이전 판은 기록에 남아 있습니다.`);
    } catch (error) {
      onToast(error instanceof Error ? error.message : String(error));
    }
  };

  const readers = Object.entries(artifact.readBy)
    .map(([sessionId, revision]) => ({ session: state.sessions[sessionId], revision }))
    .filter((entry): entry is { session: Session; revision: number } => Boolean(entry.session));

  const sendTarget = handoffTo ?? session;
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
        : officeStatus.dirty
          ? "dirty"
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
                  .catch((error: Error) => onToast(error.message))
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
              onError={onToast}
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
          onError={onToast}
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
              onToast(error instanceof Error ? error.message : String(error));
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
            한글 문서의 글 보기입니다. 쪽 배치·표·메모를 편집하려면 ‘편집’을 누르세요.
          </div>
          <MarkdownEditor value={text} readOnly onChange={setText} onSelection={setSelection} images={docImages.handling} position={uiState} onPosition={onUiState} />
        </div>
      );
    }
    if (artifact.format === "html" && mode === "render") {
      return <HtmlView api={api} artifactId={artifactId} revision={base.revision} />;
    }
    const editor = <MarkdownEditor value={text} readOnly={!lease.canWrite} onChange={setText} onSelection={setSelection} onBlur={() => void save()} extensions={drawExtensions} onView={setEditorView} images={docImages.handling} position={uiState} onPosition={onUiState} />;
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

  // The input: in its place, or in "나란히" under both sides (or not here: the conversation has it).
  const place = (input: ReactNode) => (modes?.slot === undefined ? input : modes.slot ? createPortal(input, modes.slot) : null);

  return (
    <main className="document-view" data-editor-view={lease.viewId} data-editor-access={lease.canWrite ? "write" : "read"}>
      {tabs}
      <header className="doc-header">
        <button type="button" className="ghost-button" onClick={() => void save().then((revision) => { if (revision !== null) onBack(); })}>
          <Icon name="arrowLeft" size={15} /> 대화
        </button>
        <div className="doc-title">
          <FormatBadge format={artifact.format} />
          <span className="doc-name" title={artifact.path}>
            {artifact.name}
          </span>
        </div>
        <div className="doc-header-right">
          <OfficeFileMenu api={rootApi} workId={work.id} workspaceId={artifact.workspaceId}
            onExportPdf={officeEditing && ["docx", "pptx", "markdown", "html"].includes(artifact.format) ? () => officeRef.current?.exportPdf() : undefined}
            onExportDocx={officeEditing && artifact.format === "html" ? () => officeRef.current?.exportDocx() : undefined}
            sessionId={session?.workspaceId === artifact.workspaceId ? session?.id : undefined}
            cwd={state.workspaces[artifact.workspaceId ?? ""]?.cwd ?? work.cwd} sourceKey={artifact.id} pickFile={pickFile}
            beforeOpen={async () => await save() !== null} onOpenArtifact={onOpenArtifact} onToast={onToast} />
          {markdownDoc && (mode === "edit" || mode === "split") && !viewing && !compare && base ? (
            <button type="button" className="ghost-button draw-here" onClick={() => setDrawOpen(!drawOpen)} aria-expanded={drawOpen} title="여기에 그림 그리기 (Ctrl+Alt+G) · GPT Image (Codex)">
              <Icon name="image" size={14} /> 그림
            </button>
          ) : null}
          {artifact.format === "markdown" ? (
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
          {office || hangul || artifact.format === "pdf" ? (
            <button
              type="button"
              className="ghost-button"
              title="이 컴퓨터의 기본 앱에서 엽니다"
              onClick={() =>
                void api
                  .openExternal(artifactId)
                  .then((opened) => onToast(`${opened.app}에서 열었습니다. 저장하면 여기서 새 판으로 받을 수 있습니다.`))
                  .catch((error: Error) => onToast(error.message))
              }
            >
              <Icon name="file" size={14} /> 다른 앱으로 열기
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
        </div>
      </header>

      {legacyHangulDraft ? <div className="notice doc-legacy-draft" role="status">
        이전 버전에서 저장하지 않은 글 편집이 남아 있습니다(r{legacyHangulDraft.baseRevision}).
        <button type="button" className="button small" onClick={() => setCompare({ title: "이전 글 편집 복구본", before: base?.text ?? "", after: legacyHangulDraft.text, beforeLabel: `현재 r${artifact.revision}`, afterLabel: "복구본" })}>복구본 검토</button>
        <button type="button" className="button small" disabled={!lease.canWrite || artifact.revision !== legacyHangulDraft.baseRevision || officeStatus.dirty} onClick={() => {
          const draft = legacyHangulDraft;
          void api.saveArtifact(artifactId, draft.baseRevision, draft.text).then(() => {
            clearRecoveredDraft(draft); setLegacyHangulDraft(null); setCompare(null); onToast("이전 글 편집을 새 판으로 복구했습니다.");
          }).catch((error: Error) => onToast(error.message));
        }}>복구본을 새 판으로 저장</button>
        {artifact.revision !== legacyHangulDraft.baseRevision ? <span>문서가 바뀌어 자동 적용하지 않습니다. 복구본은 보관됩니다.</span> : null}
      </div> : null}

      {readers.length || artifact.diskState !== "same" ? (
        <div className="doc-readers">
          {readers.map(({ session: reader, revision }) => (
            <span key={reader.id} className={`reader-chip${revision === artifact.revision ? " current" : ""}`} style={accentStyle(lookOf(reader.provider))}>
              <EngineMark provider={reader.provider} size={13} /> {reader.purpose}이(가) 읽은 판 r{revision}
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
                      .catch((error: Error) => onToast(error.message))
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
                  onToast(error instanceof Error ? error.message : String(error));
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

      {canEditFormat && !lease.canWrite ? <div className="doc-access notice" role="status">
        {lease.error ?? (!lease.ready ? "문서 편집 권한을 확인하는 중…" : lease.registration?.writer ? "다른 탭이나 창에서 편집 중입니다. 이곳에서는 읽기만 할 수 있습니다." : "이 문서를 읽기 전용으로 보고 있습니다.")}
        {dirty ? " 저장되지 않은 입력은 이 탭에 유지했습니다." : ""}
        <button type="button" className="button small" onClick={() => void lease.claim()}>편집 권한 받기</button>
      </div> : null}
      <div className="doc-body" ref={bodyRef} inert={!lease.canWrite && everWriter.current && Boolean(design || officeEditing)}>
        {officeEditing && everWriter.current ? (
          <OfficeEditor ref={officeRef} api={api} artifact={artifact} access={lease.access()} sessionId={lease.registration?.view.sessionId ?? null} hidden={Boolean(compare || viewing)} onStatus={setOfficeStatus} onNotice={onToast} onCopied={onOpenArtifact}
            onPrepareAi={(revision) => lease.sync(false, revision)} onAiSettings={onAiSettings}
            onNewSession={async (revision) => {
              await lease.sync(false, revision);
              const next = await onNewSession();
              if (!next) throw new Error("새 세션을 만들지 못했습니다.");
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

      {place(<div className="column composer-area doc-composer">
        {session && drawer === "open" && !modes?.split ? (
          <ConversationSheet state={state} session={session} onClose={() => setDrawer("peek")} onAnswer={(itemId, decision) => onAnswer?.(session, itemId, decision)} />
        ) : null}
        {session && !modes?.split ? (
          <ConversationDrawer
            state={state}
            session={session}
            mode={drawer}
            onMode={setDrawer}
            onAnswer={(itemId, decision) => onAnswer?.(session, itemId, decision)}
            onOpenConversation={onBack}
          />
        ) : null}
        {modes?.bar}
        <Composer
          onFiles={pending.add}
          onDesktopPicture={() => api.clipboardPicture()}
          attachments={pending.count}
          draftKey={modes?.draftKey ?? `doc:${artifactId}`}
          placeholder={selection ? "이 부분에 요청하기" : "이 문서에 요청하기"}
          busy={Boolean(sendTarget && isBusy(sendTarget))}
          waiting={Boolean(sendTarget && (sendTarget.status === "running" || sendTarget.status === "starting"))}
          header={
            <div className="doc-chips">
              <PendingFiles files={pending.files} onRemove={(key) => pending.remove([key])} />
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
              {!handoffTo && includeDoc && editable && !create ? (
                <div className="segmented small" role="radiogroup" aria-label="요청 종류">
                  <button type="button" className={requestMode === "edit" ? "active" : ""} onClick={() => setRequestMode("edit")} title="AI가 작업 사본을 고치고 수정안으로 보여 줍니다">
                    수정 요청
                  </button>
                  <button type="button" className={requestMode === "review" ? "active" : ""} onClick={() => setRequestMode("review")} title="읽고 답만 합니다">
                    검토 요청
                  </button>
                </div>
              ) : null}
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
            // The answer will come up in the drawer, under the document.
            if (sent && !handoffTo) setDrawer((current) => (current === "open" ? current : "peek"));
            if (sent) {
              if (handoffTo) setHandoffTo(null);
              setOthers([]);
              references.clear();
              setCreate(null);
              done();
            }
            return sent;
          }}
          mentions={{ items: mentionItems, onPick: (item) => setOthers((current) => (current.includes(item.id) ? current : [...current, item.id])) }}
          target={
            <>
            <CreateTargetButton api={api} scope={{ sessionId: session?.id, workId: work.id, workspaceId: artifact.workspaceId }} onTemplate={setCreate} tools={state.tools} onPick={(format) => setCreate({ format, name: stemOf(artifact.name) })} />
            <div className="anchor">
              <button type="button" className="select-button" aria-label="참조 문서 붙이기" onClick={() => setAttachOpen(!attachOpen)}><Icon name="plus" size={14} /> 문서</button>
              <Popover open={attachOpen} onClose={() => setAttachOpen(false)} placement="above" align="right">
                <div className="menu-label">참조 문서 · 보내기 전에 저장 확인</div>
                {mentionItems.map((item) => <MenuItem key={item.id} active={others.includes(item.id)} hint={item.hint} onSelect={() => {
                  setOthers((current) => current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id]);
                  references.forget(item.id); setAttachOpen(false);
                }}>{item.name}</MenuItem>)}
                {!mentionItems.length ? <div className="menu-label">이 작업에 다른 문서가 없습니다.</div> : null}
              </Popover>
            </div>
            <div className="anchor">
              <button type="button" className="select-button" onClick={() => setTargetOpen(!targetOpen)}>
                {sendTarget ? <EngineMark provider={sendTarget.provider} size={14} /> : null}
                {handoffTo ? `다른 세션에 · ${handoffTo.purpose}` : session ? `${PROVIDER_LABEL[session.provider]} · ${session.purpose}` : "새 세션"}
                <Icon name={targetOpen ? "chevronUp" : "chevronDown"} size={14} />
              </button>
              <Popover open={targetOpen} onClose={() => setTargetOpen(false)} placement="above" align="right">
                {session ? (
                  <MenuItem
                    active={!handoffTo}
                    onSelect={() => {
                      setHandoffTo(null);
                      setTargetOpen(false);
                    }}
                  >
                    이 세션 · {session.purpose}
                  </MenuItem>
                ) : null}
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
            </>
          }
        />
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
      </div>)}
    </main>
  );
}
