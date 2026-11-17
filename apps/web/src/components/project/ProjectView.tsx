import { withParticle } from "@workbench/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { ItemIcon } from "../ItemIcon.tsx";
import { PROVIDER_LABEL, type ProjectEvent, type ProjectPage, type ProjectSummary, type ProjectWrite, type Session, type StoppedPlace, type Work } from "@workbench/contracts";
import type { Components } from "react-markdown";
import { ApiRequestError, type Api } from "../../api.ts";
import { ago } from "../../format.ts";
import { neighbours } from "../../graph.ts";
import { ObsidianMarkdown, obsidianComponents, obsidianUrlTransform } from "../../markdown/obsidian.tsx";
import { continueSession, duration, entryParts, markProjectSeen, projectSeenAt } from "../../project.ts";
import type { State } from "../../state.ts";
import type { MenuEntry, MenuRequest } from "../ContextMenu.tsx";
import { diagramComponents } from "../Diagram.tsx";
import { EngineMark } from "../EngineMark.tsx";
import { EditableText } from "../EditableText.tsx";
import { LoadingView } from "../Skeleton.tsx";
import { Icon, type IconName } from "../Icon.tsx";
import { docPictureComponents } from "../ImageGen.tsx";
import { SectionLabel, useSectionCollapsed } from "../ui/SectionLabel.tsx";
import { DiffView } from "../docs/DiffView.tsx";
import { NoteTitle } from "../note/NoteTitle.tsx";
import { claimStorageNotice, keepField, readField, useField, useStorageRefusing, type FieldDraft } from "./field-drafts.ts";
import { NoteBody, type NoteBodyControls } from "./NoteBody.tsx";
import { isStale, NoteWriteSkipped, sendNoteWrite } from "./note-writes.ts";
import { machineRow, shownValue, useNoteProperties, type PropertyConflict, type PropertyWrite, type WriteOutcome } from "./PropertiesPanel.tsx";
import { StageDialog } from "./StageDialog.tsx";
import { TemplateDialog } from "./TemplateDialog.tsx";
import "../../styles/project.css";

// "프로젝트 = 노트 한 장" (Skin 2, S6): a project's page IS its note, read top to bottom in one column
// (Linear's project overview as the study): the name (renamed in place) and its one-line summary;
// the properties as aligned rows with a fixed label column (every key, changed where it is shown,
// with the project's folder and work folder among them); the figures as ONE quiet line, each a way
// to the list's section; the note's own words; 결정 and 열린 질문 as ruled lists; 기록 as ruled time
// rows; 연결 as a ruled list; 자세히 and "엔진이 아는 것" behind disclosures at the end. The
// conversations, documents and web pages are NOT repeated here as cards: the list's level 2 holds
// them (the figures put the list on them).
// Every write is a revision of the real Markdown file, with "되돌리기" in the top-bar notice.

type Toast = { text: string; kind?: "info" | "error"; action?: { label: string; run: () => void } };

const DRAWN = diagramComponents();
/** Source links of decisions (`workbench://session/…`) stay links here. */
const keepSources = (url: string) => (url.startsWith("workbench://") ? url : obsidianUrlTransform(url));
const BY_LABEL: Record<string, string> = { user: "나", claude: "Claude", codex: "Codex", external: "앱 밖" };
/** A record row's time: today the hour, earlier the date (the day heads are gone; the time says it). */
function eventWhen(at: number, now = Date.now()) {
  const date = new Date(at);
  const today = new Date(now);
  const time = date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (date.toDateString() === today.toDateString()) return time;
  const yesterday = new Date(now - 86_400_000);
  if (date.toDateString() === yesterday.toDateString()) return `어제 ${time}`;
  return `${date.getMonth() + 1}.${date.getDate()} ${time}`;
}

/** Keys whose text reads as the project's one-line summary (drawn under the title). */
const SUMMARY_KEYS = ["요약", "한 줄 요약", "설명", "summary", "description"];
/** 기록 rows shown before "더 보기". */
const RECORD_ROWS = 12;

/**
 * A line to add (a decision, an open question). Typed text is never dropped: its text is what the
 * draft store keeps for `field` of `note` (both bound when the field opens, with the revision the
 * person saw while typing — the base it is written from, also after a reload). Leaving the field
 * keeps it (nothing is written), Enter writes it (not while Hangul is composed) and removes only what
 * was written — text typed while the write was on its way stays — a refusal keeps it with the
 * reason, Esc puts it away behind a 되살리기 notice.
 */
export function AddInput({ note, field, revision, placeholder, label, onAdd, onDiscard, onClose }: { note: string; field: string; revision: number | null; placeholder: string; label: string; onAdd: (value: string, base: number | null, note: string) => Promise<WriteOutcome>; onDiscard: (draft: FieldDraft) => void; onClose: () => void }) {
  // Kept text is restored without taking the focus (see LineInput).
  const [bound] = useState(() => ({ note, field, restored: readField(note, field) !== null }));
  const kept = useField(bound.note, bound.field);
  const value = kept?.text ?? "";
  const [problem, setProblem] = useState<string | null>(null);
  const busy = useRef(false);
  const setValue = (text: string) => keepField(bound.note, bound.field, text ? { text, baseRevision: kept ? kept.baseRevision : revision } : null);
  const put = async () => {
    const current = readField(bound.note, bound.field);
    const sent = current?.text.trim() ?? "";
    if (busy.current || !current || !sent) return;
    busy.current = true;
    const outcome = await onAdd(sent, current.baseRevision, bound.note);
    busy.current = false;
    const now = readField(bound.note, bound.field);
    if ("refused" in outcome) {
      setProblem(outcome.refused);
      // The note as it is now was shown with the reason: the line is next sent from that revision.
      if (outcome.shown !== undefined && now) keepField(bound.note, bound.field, { ...now, baseRevision: outcome.shown });
      return;
    }
    const rest = now ? (now.text.trim().startsWith(sent) ? now.text.trim().slice(sent.length).trimStart() : now.text) : "";
    keepField(bound.note, bound.field, rest ? { text: rest, baseRevision: outcome.revision } : null);
  };
  const away = () => {
    const current = readField(bound.note, bound.field);
    keepField(bound.note, bound.field, null);
    if (current?.text.trim()) onDiscard(current);
    onClose();
  };
  const onKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      void put();
    } else if (event.key === "Escape") {
      event.preventDefault();
      away();
    }
  };
  return (
    <div className="pn-add-line">
      <span className="pn-field">
        <input className="pn-input pn-add-input" autoFocus={!bound.restored} aria-label={placeholder} aria-invalid={problem ? true : undefined} value={value} placeholder={placeholder}
          onChange={(event) => { setValue(event.target.value); setProblem(null); }} onKeyDown={onKey} />
        {problem ? <span className="pn-field-problem" role="alert" aria-label={label}>{problem}</span> : null}
      </span>
      <button type="button" className="icon-button small" aria-label="그만두기" title="그만두기 (Esc)" onClick={away}><Icon name="x" size={14} /></button>
    </div>
  );
}

/** A line kept from before that cannot be added now (the note's properties do not read): shown, to copy or put away. */
function KeptLine({ label, draft, onCopied, onDrop }: { label: string; draft: FieldDraft; onCopied: () => void; onDrop: () => void }) {
  return (
    <p className="pn-kept pn-kept-line" data-kept={label}>
      <span className="pn-meta-key">{label}</span>
      <span className="pn-kept-text">{draft.text}</span>
      <button type="button" className="link small" aria-label={`${label} 복사`} onClick={() => { void navigator.clipboard?.writeText(draft.text); onCopied(); }}>복사</button>
      <button type="button" className="link small" aria-label={`${label} 버리기`} onClick={onDrop}>버리기</button>
    </p>
  );
}

type ProjectViewProps = {
  onLeaveGuard?: (guard: (() => Promise<void>) | null) => void;
  onCreate?: (anchor: HTMLButtonElement) => void;
  api: Api;
  state: State;
  workId: string;
  onOpenSession: (session: Session, itemId?: string | null) => void;
  onOpenDocument: (artifactId: string, proposalId: string | null) => void;
  /** Another project's page ("연결"). */
  onOpenProject?: (work: Work) => void;
  /** A vault note (the notes the engines read). */
  onOpenNote?: (path: string) => void;
  onToast: (toast: Toast) => void;
  onError: (error: unknown) => void;
  openMenu: (request: MenuRequest) => void;
  /** Skin 2: put the list column on this project's section (the figures' 대화 N, 문서 N, 웹 N). */
  onShowInList?: (section: "chats" | "docs" | "web") => void;
  /** The desktop app opens a folder in the system's file manager. */
  onOpenFolder?: (path: string) => void;
};

/**
 * A project's page. Each note gets a page of its own: when the same place goes on to show another
 * project, nothing open, typed, asked or loaded for the first one carries over into it.
 */
export function ProjectView(props: ProjectViewProps) {
  // The key carries weight: fields and add lines bind their note themselves, but the body editor,
  // the pickers and the conflict lines are page state that only this remount keeps to one note.
  return <ProjectNotePage key={props.workId} {...props} />;
}

function ProjectNotePage({
  api,
  state,
  workId,
  onOpenSession,
  onOpenDocument,
  onOpenProject,
  onOpenNote,
  onToast,
  onOpenFolder,
  onError,
  openMenu,
  onLeaveGuard,
  onCreate,
  onShowInList,
}: ProjectViewProps) {
  const work: Work | undefined = state.works[workId];
  const [page, setPage] = useState<ProjectPage | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [recordAll, setRecordAll] = useState(false);
  const [allEvents, setAllEvents] = useState<ProjectEvent[] | null>(null);
  // "지난번 본 뒤": what came after the person last left this page (on this device).
  const [seenBefore, setSeenBefore] = useState<number | null>(null);
  useEffect(() => {
    setSeenBefore(projectSeenAt(workId));
    const leave = () => markProjectSeen(workId);
    window.addEventListener("beforeunload", leave);
    return () => {
      window.removeEventListener("beforeunload", leave);
      leave();
    };
  }, [workId]);
  // The add fields the person opened (each keeps its own text; a field with kept text is open too).
  const [adding, setAdding] = useState({ decision: false, question: false });
  const keptLine = { decision: useField(workId, "add:decision"), question: useField(workId, "add:question") };
  const addOpen = { decision: adding.decision || keptLine.decision !== null, question: adding.question || keptLine.question !== null };
  // Property writes refused because the note changed since the person saw it, by key: they choose, key by key.
  // `theirs` is the key's value at revision `shown` — the revision "내 것으로 쓰기" is then sent from, so a
  // value that came after it is asked about again instead of being written over unseen.
  const [keyConflicts, setKeyConflicts] = useState<Record<string, PropertyConflict>>({});
  const dropConflict = (key: string) => setKeyConflicts(({ [key]: _answered, ...rest }) => rest);
  const [stagesOpen, setStagesOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [recordFolded, toggleRecord] = useSectionCollapsed("project.record");
  const [detailsFolded, toggleDetails] = useSectionCollapsed("project.details", true);
  const [cardFolded, toggleCard] = useSectionCollapsed("project.card", true);
  const [linksFolded, toggleLinks] = useSectionCollapsed("project.links");
  const body = useRef<NoteBodyControls | null>(null);
  const [comparingBroken, setComparingBroken] = useState(false);
  const version = `${state.pkm[`project:${workId}`] ?? 0}:${state.pkm["project:*"] ?? 0}`;
  // "연결": every project's tags and links, to find this one's neighbours (관련, shared tags).
  const [summaries, setSummaries] = useState<ProjectSummary[]>([]);
  // Tag completion: the vault's tags (asked for when tags are first edited), then other projects' and works'.
  const [vaultTags, setVaultTags] = useState<string[] | null>(null);
  const tagChoices = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const tag of [...(vaultTags ?? []), ...summaries.flatMap((summary) => summary.tags), ...Object.values(state.works).flatMap((entry) => entry.tags ?? [])]) {
      if (seen.has(tag.toLowerCase())) continue;
      seen.add(tag.toLowerCase());
      out.push(tag);
    }
    return out;
  }, [vaultTags, summaries, state.works]);
  useEffect(() => {
    api.projects().then(setSummaries).catch(() => setSummaries([]));
  }, [api, version]);
  // What the page shows of sessions and files changes with them; refetched shortly after.
  const sessions = useMemo(() => Object.values(state.sessions).filter((session) => session.workId === workId && !session.archivedAt), [state.sessions, workId]);
  const files = useMemo(() => Object.values(state.artifacts).filter((artifact) => artifact.workId === workId && artifact.role !== "project-note"), [state.artifacts, workId]);
  const pulse = `${sessions.map((session) => `${session.id}:${session.status}:${session.updatedAt}`).join("|")}#${files.map((artifact) => `${artifact.id}:${artifact.revision}`).join("|")}`;

  // Reading the note failed before anything was shown: said in the page's place, with 다시 시도.
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.project(workId).then((next) => { setPage(next); setLoadError(null); }).catch((error: unknown) => {
      setLoadError(error instanceof Error ? error.message : String(error));
      onError(error);
    });
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

  // One writer per note (note-writes.ts): the page's writes go one after another, each sent with the
  // revision the person saw, carried forward over the person's own writes that landed since (so they
  // never conflict with themselves), and refused by the gateway when anything else changed the note.
  // A write names the note it is for — the one its field was opened on — and is sent only while this
  // page shows that note: otherwise nothing is written and what was typed stays kept under its note.
  const shown = useRef(true);
  useEffect(() => {
    shown.current = true;
    return () => {
      shown.current = false;
    };
  }, []);
  const send = useCallback(<T,>(note: string, seen: number | null, make: (base: number | null) => Promise<T>, revisionOf: (result: T) => number | null, evenWhenLeft = false): Promise<T> =>
    sendNoteWrite(api, note, seen, make, revisionOf, evenWhenLeft ? undefined : () => (shown.current ? workId : null)), [api, workId]);
  const revisionOfPage = (shownPage: ProjectPage) => (shownPage.note.exists ? (shownPage.note.revision ?? null) : null);
  const sendWrite = useCallback((note: string, seen: number | null, make: (base: number | null) => Promise<ProjectWrite>) => send(note, seen, make, (write) => revisionOfPage(write.page)), [send]);

  /** A write landed: show the page it returned and a notice that says what changed and can undo it (from the revision it made). */
  const wrote = useCallback(
    (write: ProjectWrite, change?: string) => {
      setPage(write.page);
      if (!write.token) return;
      const text = change ?? write.summary;
      const made = revisionOfPage(write.page);
      onToast({
        text: write.created ? `프로젝트 노트를 만들었습니다 · ${text}` : text,
        // The notice names its write: its undo is sent even after this page was left.
        action: { label: "되돌리기", run: () => void send(workId, made, (base) => api.undoProject(workId, write.token, base), revisionOfPage, true).then(setPage).catch(refused) },
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, workId, onToast, onError, send],
  );
  /** A refused write: the note changed since it was shown — show it as it is now, and say so. One not sent (behind a refused one, or after the page was left) was already answered. */
  const refused = (error: unknown) => {
    if (error instanceof NoteWriteSkipped) return;
    if (isStale(error)) load();
    onError(error);
  };
  /** A one-click write to the note this page shows. */
  const run = (seen: number | null, make: (base: number | null) => Promise<ProjectWrite>) => void sendWrite(workId, seen, make).then((write) => wrote(write)).catch(refused);
  /** Write a typed line for `note` and say what came of it (the caller keeps what was typed when refused). */
  const attempt = async (note: string, seen: number | null, make: (base: number | null) => Promise<ProjectWrite>): Promise<WriteOutcome> => {
    try {
      const write = await sendWrite(note, seen, make);
      wrote(write);
      return { revision: revisionOfPage(write.page) };
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 409 && error.code === "note_changed") {
        // Show the note as it is now; the line is then sent from the revision shown.
        const fresh = await api.project(workId).catch(() => null);
        if (fresh) setPage(fresh);
        return { refused: "그 사이 노트가 바뀌었습니다. 바뀐 노트를 보여 드렸으니 확인한 뒤 Enter로 다시 남기거나 Esc로 그만두세요.", ...(fresh ? { shown: revisionOfPage(fresh) } : {}) };
      }
      return { refused: error instanceof Error ? error.message : String(error) };
    }
  };
  // The browser's storage took no more: what is typed stays in its field and is written as usual, but not over a reload. Said once.
  const unkept = useStorageRefusing();
  useEffect(() => {
    if (unkept && claimStorageNotice()) onToast({ kind: "error", text: "이 기기에 쓰던 글을 남겨 둘 공간이 없습니다. 지금 쓰는 글은 칸에 그대로 있고 쓸 수 있지만, 다시 불러오면 남지 않습니다." });
  }, [unkept, onToast]);
  /** Put typed text away behind a notice that brings it back into its field. */
  const discardLine = (section: "decision" | "question", draft: FieldDraft) => onToast({ text: "고치던 내용을 버렸습니다", action: { label: "되살리기", run: () => keepField(workId, `add:${section}`, draft) } });

  // What the person sees: the note's revision, or no file at all (null) — every write carries it.
  const seenRevision = page?.note.exists ? (page.note.revision ?? null) : null;
  /**
   * Write a property; the notice is the gateway's (the value as written). Resolves to the revision
   * it made, or why it was refused (shown where it was typed when `inline`, else in the top bar).
   */
  const writeProperty = async (write: PropertyWrite): Promise<WriteOutcome> => {
    const { note, key, type, change } = write;
    const values = write.values ?? null;
    const seen = write.base === undefined ? seenRevision : write.base;
    try {
      const written = await sendWrite(note, seen, (base) => (type === "stage" || key === "단계" ? api.setProjectStage(note, values?.[0] ?? null, base) : (change ? api.setProjectProperty(note, key, values, type, base, change) : api.setProjectProperty(note, key, values, type, base))));
      wrote(written);
      dropConflict(key);
      return { revision: revisionOfPage(written.page) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof NoteWriteSkipped) return { refused: message };
      if (error instanceof ApiRequestError && error.status === 409 && error.code === "note_changed") {
        // The note changed since the person saw it: show both values and let them choose.
        const fresh = await api.project(workId).catch(() => null);
        if (fresh) setPage(fresh);
        const row = fresh?.rows?.find((entry) => entry.key === key);
        // Shown as the page shows that property ("12월 1일", not "2026-12-01").
        const theirs = !fresh ? "읽지 못했습니다" : row?.present ? shownValue(row) || "값 없음" : "없음";
        // Without a fresh read nothing newer was shown: the answer goes from the refused base again.
        setKeyConflicts((current) => ({ ...current, [key]: { write, message, theirs, shown: fresh ? revisionOfPage(fresh) : seen } }));
        return { refused: "그 사이 다른 곳에서 바뀌었습니다. 아래에서 고르세요.", asked: true };
      }
      if (!write.inline) onError(error);
      return { refused: message };
    }
  };
  // The folder the project is filed in, as a path of names (the list's level 1 folders).
  const folderTrail: string[] = [];
  for (let id = work?.folderId ?? null; id; id = state.folders[id]?.parentId ?? null) {
    const folder = state.folders[id];
    if (!folder) break;
    folderTrail.unshift(folder.name);
  }
  const properties = useNoteProperties({
    ledeKeys: SUMMARY_KEYS,
    facts: work ? [
      { key: "folder", label: "폴더", icon: "folder", value: <span className="pn-prop-text">{folderTrail.length ? folderTrail.join(" / ") : "분류 없음"}</span> },
      {
        // Release unit A: no raw path on the page — the two things a teacher does with it (the path in the tooltip).
        key: "cwd", label: "작업 폴더", icon: "folderOpen", title: work.cwd,
        value: (
          <span className="pn-fact-keys">
            {onOpenFolder ? <button type="button" className="text-button pn-fact-copy" aria-label="작업 폴더 열기" onClick={() => onOpenFolder(work.cwd)}>폴더 열기</button> : null}
            <button type="button" className="text-button pn-fact-copy" aria-label="작업 폴더 경로 복사" onClick={() => { void navigator.clipboard?.writeText(work.cwd); onToast({ text: "작업 폴더 경로를 복사했습니다" }); }}>경로 복사</button>
          </span>
        ),
      },
    ] : [],
    // A note whose front matter does not read shows the last readable revision's properties, read-only.
    rows: (page?.note.problem ? page.lastReadable?.rows : page?.rows) ?? [],
    machine: page && !page.note.problem ? machineRow(page.note) : null,
    readOnly: Boolean(page?.note.problem),
    revision: seenRevision,
    workId,
    onNotice: onToast,
    onSource: (key) => body.current?.source(key),
    // The raw note is the page's own "원문 전체" (not offered while the properties do not read).
    onRaw: page?.note.problem ? undefined : () => body.current?.source(),
    conflicts: keyConflicts,
    onSettle: (key, mine) => void settleConflict(key, mine),
    knownKeys: page?.knownKeys ?? [],
    stages: page?.stages ?? [],
    tagChoices,
    projectNames: Object.values(state.works).filter((entry) => entry.id !== workId && !entry.archivedAt).map((entry) => entry.title),
    onWrite: writeProperty,
    onKind: (key, type) => void api.setPropertyType(key, type).then(() => load(), onError),
    onStages: () => setStagesOpen(true),
    onWantTags: () => {
      if (vaultTags === null) api.vaultTags().then((list) => setVaultTags(list.map((entry) => entry.tag)), () => setVaultTags([]));
    },
    openMenu,
  });
  /** The person answered a property conflict: what is kept for that key's typed value follows the answer. */
  const settleConflict = async (key: string, mine: boolean) => {
    const conflict = keyConflicts[key];
    if (!conflict) return;
    const { write } = conflict;
    const field = `prop:${key}`;
    // A picker's change (one item added or removed) has no typed text behind it.
    const typed = !write.change;
    if (!mine) {
      dropConflict(key);
      if (!typed) return;
      // Theirs: the typed value is put away, behind a notice that brings it back.
      const draft = readField(workId, field);
      keepField(workId, field, null);
      properties.close(key);
      if (draft) onToast({ text: "고치던 내용을 버렸습니다", action: { label: "되살리기", run: () => keepField(workId, field, draft) } });
      return;
    }
    // Mine: the same change, written over the revision whose value the line shows — if the note
    // changed again since, it is refused again and the line shows the newer value (a refusal for
    // another reason is said in the top bar).
    const outcome = await writeProperty({ ...write, base: conflict.shown, inline: false });
    if ("refused" in outcome || !typed) return;
    const draft = readField(workId, field);
    // Text typed on since stays in its field, from the revision this write made.
    if (draft && draft.text.trim() !== (write.values?.[0] ?? "").trim()) return keepField(workId, field, { text: draft.text, baseRevision: outcome.revision });
    keepField(workId, field, null);
    properties.close(key);
  };

  // A decision's "원문" link (`workbench://session/<id>#<item>`) opens that conversation at that reply.
  const sourceLink = useMemo<Components["a"]>(
    () =>
      function SourceLink({ href, children }) {
        const match = /^workbench:\/\/session\/([^#]+)(?:#(.+))?$/.exec(href ?? "");
        if (!match) return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
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
  if (!page && loadError) {
    return (
      <main className="project-view">
        <div className="pn-scroll"><div className="pn-column">
          <div className="pn-error" role="alert">
            <p className="pn-error-head">프로젝트 노트를 읽지 못했습니다.</p>
            <p className="pn-empty">게이트웨이에 다시 연결되면 읽을 수 있습니다. 노트 파일은 그대로 있습니다.</p>
            <button type="button" className="button small" onClick={load}>다시 시도</button>
            <details className="pn-error-detail"><summary>자세히</summary><code>{loadError}</code></details>
          </div>
        </div></div>
      </main>
    );
  }
  if (!page) return <LoadingView label="프로젝트 노트를 읽는 중" shape="document" />;

  const { note, facts, stages } = page;
  const next = continueSession(work, sessions);
  // What the list's level 2 holds (the figures count them; document AIs belong to their document, web AIs to the web).
  const chats = sessions.filter((session) => !session.documentAgent && !session.pageAgent);
  const webs = sessions.filter((session) => session.pageAgent);

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
  const projectMenu = (anchor: HTMLElement) => {
    const box = anchor.getBoundingClientRect();
    const items: MenuEntry[] = [
      { kind: "item", label: "이름 바꾸기", icon: "edit", onSelect: () => setRenaming(true) },
      // A note whose front matter does not read offers no writes but the revert.
      ...(note.problem ? [] : [
        { kind: "item" as const, label: "노트 고치기", icon: "edit" as const, hint: "E", onSelect: () => body.current?.start() },
        { kind: "item" as const, label: "원문 전체", icon: "text" as const, onSelect: () => body.current?.source() },
      ]),
      ...(note.artifactId ? [{ kind: "item" as const, label: "노트를 문서로 열기 (판과 비교)", icon: "page" as const, onSelect: () => onOpenDocument(note.artifactId!, null) }] : []),
      ...(!note.exists && page.noteTemplate ? [{ kind: "item" as const, label: `「${page.noteTemplate.folderName}」 템플릿으로 노트 만들기`, icon: "file" as const, onSelect: () => void api.initializeProjectNote(workId).then((write) => wrote(write)).catch(onError) }] : []),
      { kind: "separator" },
      { kind: "item", label: "속성 템플릿…", icon: "list", onSelect: () => setTemplateOpen(true) },
      { kind: "item", label: "단계 편집…", icon: "palette", onSelect: () => setStagesOpen(true) },
      { kind: "separator" },
      { kind: "item", label: "노트 경로 복사", icon: "copy", onSelect: () => void navigator.clipboard?.writeText(note.path) },
      { kind: "item", label: "폴더 경로 복사", icon: "copy", onSelect: () => void navigator.clipboard?.writeText(work.cwd) },
    ];
    openMenu({ x: box.left, y: box.bottom + 4, title: work.title, items });
  };

  const openEvent = (event: ProjectEvent) => {
    if (event.artifactId) return onOpenDocument(event.artifactId, event.proposalId ?? null);
    const session = event.sessionId ? state.sessions[event.sessionId] : null;
    if (session) onOpenSession(session, event.itemId ?? null);
  };
  const events = allEvents ?? page.events;
  const record = [...events].sort((a, b) => b.at - a.at);
  const recordShown = recordAll ? record : record.slice(0, RECORD_ROWS);
  const attentionSession = facts.attentionSessionId ? state.sessions[facts.attentionSessionId] : undefined;
  const entry = (text: string) => {
    const { date, rest } = entryParts(text);
    return (
      <>
        <span className="pn-entry-text"><ObsidianMarkdown components={pictures} urlTransform={keepSources}>{rest}</ObsidianMarkdown></span>
        {date ? <time className="pn-entry-date" dateTime={date}>{Number(date.slice(5, 7))}.{Number(date.slice(8, 10))}</time> : null}
      </>
    );
  };
  const links = neighbours(
    Object.values(state.works).filter((entry) => !entry.archivedAt).map((entry) => {
      const summary = summaries.find((other) => other.workId === entry.id);
      return { id: entry.id, title: entry.title, tags: summary?.tags ?? entry.tags ?? [], related: summary?.related ?? [], sessions: 0 };
    }),
    workId,
  ).filter((link) => state.works[link.id]);
  /** A line kept from before, on a note that does not read: shown, not offered for writing. */
  const keptLineOf = (section: "decision" | "question", draft: FieldDraft) => (
    <KeptLine label={section === "decision" ? "쓰다 만 결정" : "쓰다 만 질문"} draft={draft} onCopied={() => onToast({ text: "복사했습니다" })} onDrop={() => { keepField(workId, `add:${section}`, null); discardLine(section, draft); }} />
  );
  /** Who changed the note from the last readable revision on. */
  const brokenBy = (last: NonNullable<ProjectPage["lastReadable"]>) => {
    if (last.author === "engine") {
      const session = last.sessionId ? state.sessions[last.sessionId] : undefined;
      return session ? `${PROVIDER_LABEL[session.provider]} 대화 「${session.purpose}」에서` : "엔진이";
    }
    return last.author === "external" ? "앱 밖(Obsidian, 동기화 등)에서" : "이 앱에서";
  };
  /** One figure of the quiet line: a number and its word, a way somewhere when it has one. */
  const figure = (key: string, label: string, value: ReactNode, run?: (anchor: HTMLElement) => void, tone?: "attention", hint?: string) =>
    run ? (
      <button key={key} type="button" className={`pn-figure${tone ? ` tone-${tone}` : ""}`} data-figure={key} title={hint} onClick={(event) => run(event.currentTarget)}>
        <span className="pn-figure-label">{label}</span> <span className="pn-figure-value">{value}</span>
      </button>
    ) : (
      <span key={key} className="pn-figure" data-figure={key} title={hint}><span className="pn-figure-label">{label}</span> <span className="pn-figure-value">{value}</span></span>
    );
  const showIn = (section: "chats" | "docs" | "web") => (onShowInList ? () => onShowInList(section) : undefined);
  const blank = !chats.length && !files.length && !webs.length;

  return (
    <main
      className="project-view"
      data-screen="S02"
      data-note-revision={note.revision ?? undefined}
      onKeyDown={(event) => {
        // "E" anywhere on the page outside a field opens the note's words for editing.
        const target = event.target as HTMLElement;
        if (event.key.toLowerCase() !== "e" || event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing) return;
        if (target.closest("input, textarea, select, [contenteditable=true], .ui-menu")) return;
        event.preventDefault();
        body.current?.start();
      }}
    >
      <div className="pn-scroll">
        <div className="pn-column">
          <header className="pn-head">
            <NoteTitle
              icon="project"
              title={work.title}
              hook="project-title"
              hint="두 번 눌러 이름 바꾸기"
              onDoubleClick={() => setRenaming(true)}
              editor={renaming ? <EditableText className="note-title-edit" label="프로젝트 이름" value={work.title} onSave={(title) => void api.updateWork(workId, { title }).catch(onError)} onDone={() => setRenaming(false)} /> : undefined}
              tools={
                <>
                  {next ? (
                    <button type="button" className="button small project-continue" onClick={() => onOpenSession(next)} title="이 프로젝트에서 이어서 하기">
                      <EngineMark provider={next.provider} size={14} /> 이어서: {next.purpose || "대화"}
                    </button>
                  ) : null}
                  {onCreate ? <button type="button" className="button small" aria-haspopup="menu" title="이 프로젝트에서 새 대화, 문서, 웹" onClick={(event) => onCreate(event.currentTarget)}><Icon name="plus" size={14} /> 새로 만들기</button> : null}
                  <button type="button" className="icon-button small" title="프로젝트 메뉴" aria-label="프로젝트 메뉴" aria-haspopup="menu" onClick={(event) => projectMenu(event.currentTarget)}>
                    <Icon name="dots" size={16} />
                  </button>
                </>
              }
            />
          </header>

          {properties.block}
          {/* A note that does not read: said right under the properties it explains (the last readable revision's). */}
          {note.problem ? (
            <div className="project-engine-edit pn-broken" role="alert">
              <Icon name="alert" size={16} />
              <span>
                {note.problem.replace(/\.?$/, ".")}
                {page.lastReadable ? ` ${brokenBy(page.lastReadable)} 바뀐 뒤로 읽히지 않습니다. 마지막으로 읽힌 r${page.lastReadable.revision}의 속성을 보여 줍니다.` : " 읽힌 적이 있는 판이 없습니다."}
              </span>
              {page.lastReadable ? (
                <>
                  <button type="button" className="link small" aria-pressed={comparingBroken} onClick={() => setComparingBroken(!comparingBroken)}>비교</button>
                  <button type="button" className="link small" onClick={() => run(seenRevision, (base) => api.revertProjectNoteTo(workId, page.lastReadable!.revision, base))}>r{withParticle(`${page.lastReadable.revision}`, "으로/로")} 되돌리기</button>
                </>
              ) : null}
            </div>
          ) : null}
          {note.problem && page.lastReadable && comparingBroken ? <DiffView before={page.lastReadable.text.replace(/\r\n/g, "\n")} after={page.lastReadable.current.replace(/\r\n/g, "\n")} beforeLabel={`r${page.lastReadable.revision} (읽힘)`} afterLabel="지금" /> : null}

          {/* The figures: ONE quiet line; each puts the list (or the place) on what it counts. */}
          <div className="pn-figures" role="group" aria-label="현황">
            {figure("chats", "대화", chats.length, showIn("chats"), undefined, onShowInList ? "목록에서 이 프로젝트의 대화 보기" : undefined)}
            {figure("docs", "문서", files.length, showIn("docs"), undefined, onShowInList ? "목록에서 이 프로젝트의 문서 보기" : undefined)}
            {webs.length ? figure("web", "웹", webs.length, showIn("web"), undefined, onShowInList ? "목록에서 이 프로젝트의 웹 보기" : undefined) : null}
            {facts.attention ? figure("attention", "확인 필요", facts.attention, () => attentionSession && onOpenSession(attentionSession), "attention", "확인이 필요한 대화 열기") : null}
            {facts.stopped.length ? figure("stopped", "멈춘 곳", facts.stopped.length, stoppedMenu, "attention", facts.stopped.map((place) => place.text).join("\n")) : null}
            {facts.proposals ? figure("proposals", "수정안", facts.proposals, () => facts.proposalArtifactId && onOpenDocument(facts.proposalArtifactId, facts.proposalId), "attention", "검토할 수정안 열기") : null}
            {facts.running ? figure("running", "진행 중", facts.running, showIn("chats")) : null}
            {figure("activity", "마지막 활동", facts.lastActivity ? ago(facts.lastActivity) || "방금" : "없음")}
          </div>
          {blank ? (
            <div className="pn-start" role="status">
              <p>이 프로젝트에 아직 대화와 문서가 없습니다. 첫 대화를 시작하거나 문서를 만들면 왼쪽 목록에 모입니다.</p>
              {onCreate ? <button type="button" className="button small" aria-haspopup="menu" onClick={(event) => onCreate(event.currentTarget)}><Icon name="plus" size={14} /> 첫 대화나 문서 만들기</button> : null}
            </div>
          ) : null}

          {note.lastAuthor === "engine" && !note.problem ? (
            <div className="project-engine-edit" role="status">
              <Icon name="edit" size={16} />
              <span>
                {note.lastSessionId && state.sessions[note.lastSessionId] ? `${PROVIDER_LABEL[state.sessions[note.lastSessionId]!.provider]} 대화 「${state.sessions[note.lastSessionId]!.purpose}」에서` : "엔진이"} 프로젝트 노트를 바꿨습니다 (r{note.revision}).
              </span>
              {note.artifactId ? <button type="button" className="link small" onClick={() => onOpenDocument(note.artifactId!, null)}>비교</button> : null}
              <button type="button" className="link small" onClick={() => run(seenRevision, (base) => api.revertProjectNote(workId, base))}>되돌리기</button>
            </div>
          ) : null}

          <section className="pn-block pn-body" aria-label="노트">
            <SectionLabel action={note.problem ? null : <button type="button" className="link small" onClick={() => body.current?.start()} title="노트 고치기 (E)">고치기</button>}>노트</SectionLabel>
            <NoteBody
              api={api}
              workId={workId}
              page={page}
              sessions={state.sessions}
              controls={body}
              components={pictures}
              urlTransform={keepSources}
              empty={
                <p className="pn-empty">
                  {note.problem ? "아직 적은 것이 없습니다." : note.exists ? "아직 적은 것이 없습니다. 눌러서 씁니다." : "아직 노트 파일이 없습니다. 눌러서 쓰면 이 폴더에 만들어집니다."}
                  {!note.exists && page.noteTemplate ? <button type="button" className="link small pn-from-template" onClick={() => void api.initializeProjectNote(workId).then((write) => wrote(write)).catch(onError)}>「{page.noteTemplate.folderName}」 템플릿으로 시작</button> : null}
                </p>
              }
              send={(seen, make) => sendWrite(workId, seen, make)}
              onWrote={wrote}
              onPage={setPage}
              onNotice={onToast}
              onError={onError}
              onLeaveGuard={onLeaveGuard}
            />
          </section>

          <section className="pn-block pn-entries" aria-label="결정과 열린 질문">
            <div className="pn-ruled" data-entries="decision">
              <SectionLabel count={note.decisions.length} action={note.problem ? null : <button type="button" className="link small" onClick={() => setAdding((open) => ({ ...open, decision: true }))}>+ 결정</button>}>결정</SectionLabel>
              {note.decisions.length ? <ul className="pn-list">{note.decisions.map((item) => <li key={item.line} className="project-entry"><Icon name="check" size={16} />{entry(item.text)}</li>)}</ul> : null}
              {addOpen.decision && !note.problem ? <AddInput note={workId} field="add:decision" revision={seenRevision} placeholder="정한 것 (Enter)" label="결정 남기기" onAdd={(value, seen, bound) => attempt(bound, seen, (base) => api.addProjectEntry(bound, { section: "decision", text: value, baseRevision: base }))} onDiscard={(draft) => discardLine("decision", draft)} onClose={() => setAdding((open) => ({ ...open, decision: false }))} /> : null}
              {keptLine.decision && note.problem ? keptLineOf("decision", keptLine.decision) : null}
              {!note.decisions.length && !addOpen.decision && !note.problem ? <p className="pn-empty">대화의 답에서 "결정으로 남기기"를 누르면 여기에 모입니다. <button type="button" className="link small" onClick={() => setAdding((open) => ({ ...open, decision: true }))}>직접 남기기</button></p> : null}
            </div>
            <div className="pn-ruled" data-entries="question">
              <SectionLabel count={note.questions.filter((item) => !item.done).length} action={note.problem ? null : <button type="button" className="link small" onClick={() => setAdding((open) => ({ ...open, question: true }))}>+ 질문</button>}>열린 질문</SectionLabel>
              {note.questions.length ? (
                <ul className="pn-list">
                  {note.questions.map((item) => (
                    <li key={item.line} className={`project-entry question${item.done ? " done" : ""}`}>
                      <input type="checkbox" checked={item.done} disabled={Boolean(note.problem)} aria-label={item.done ? "다시 열기" : "닫기"} onChange={(event) => { const done = event.target.checked; run(seenRevision, (base) => api.setProjectQuestion(workId, item.line, done, base, item.text)); }} />
                      {entry(item.text)}
                    </li>
                  ))}
                </ul>
              ) : null}
              {addOpen.question && !note.problem ? <AddInput note={workId} field="add:question" revision={seenRevision} placeholder="열린 질문 (Enter)" label="질문 남기기" onAdd={(value, seen, bound) => attempt(bound, seen, (base) => api.addProjectEntry(bound, { section: "question", text: value, baseRevision: base }))} onDiscard={(draft) => discardLine("question", draft)} onClose={() => setAdding((open) => ({ ...open, question: false }))} /> : null}
              {keptLine.question && note.problem ? keptLineOf("question", keptLine.question) : null}
              {!note.questions.length && !addOpen.question && !note.problem ? <p className="pn-empty">열린 질문이 없습니다. <button type="button" className="link small" onClick={() => setAdding((open) => ({ ...open, question: true }))}>질문 남기기</button></p> : null}
            </div>
            {note.problem ? <p className="pn-empty">노트의 속성을 고치거나 되돌린 뒤에 결정과 질문을 더할 수 있습니다.</p> : null}
          </section>

          <section className="pn-group pn-ruled" aria-label="기록">
            <SectionLabel
              collapsed={recordFolded}
              onToggle={toggleRecord}
              controls="pn-record"
              count={events.length}
              action={
                <>
                  {seenBefore && events.some((event) => event.at > seenBefore) ? <span className="pn-fresh" title={`${new Date(seenBefore).toLocaleString("ko-KR")}에 본 뒤`}>지난번 본 뒤 {events.filter((event) => event.at > seenBefore).length}</span> : null}
                  {recordFolded ? null : <button type="button" className="link small" onClick={() => (allEvents ? setAllEvents(null) : api.projectEvents(workId).then(setAllEvents).catch(onError))}>{allEvents ? "이번 주만" : "전체 기록"}</button>}
                </>
              }
            >
              {allEvents ? "전체 기록" : "이번 주 기록"}
            </SectionLabel>
            {recordFolded ? null : record.length ? (
              <div id="pn-record">
                <ul className="pn-events">
                  {recordShown.map((event) => (
                    <li key={event.id} className={`pn-event kind-${event.kind}${seenBefore && event.at > seenBefore ? " fresh" : ""}`}>
                      <button type="button" className="pn-event-main" onClick={() => openEvent(event)}>
                        <time className="pn-event-time" dateTime={new Date(event.at).toISOString()} title={new Date(event.at).toLocaleString("ko-KR")}>{eventWhen(event.at)}</time>
                        <span className={`pn-event-by by-${event.by ?? "none"}`}>{event.by === "claude" || event.by === "codex" ? <EngineMark provider={event.by} size={14} /> : null}{BY_LABEL[event.by ?? ""] ?? ""}</span>
                        <span className="pn-event-text">{event.text}</span>
                      </button>
                      {!note.problem && event.kind !== "decision" && event.kind !== "question" && event.kind !== "stage" && event.kind !== "worktree" ? (
                        <button type="button" className="pn-event-keep" title="이 줄을 결정으로 남기기" onClick={() => run(seenRevision, (base) => api.addProjectEntry(workId, { section: "decision", text: event.text, sessionId: event.sessionId, itemId: event.itemId ?? null, baseRevision: base }))}>결정으로</button>
                      ) : null}
                      {!note.problem && event.kind === "link" ? (
                        <button type="button" className="pn-event-keep" title="이 줄을 열린 질문으로 남기기" onClick={() => run(seenRevision, (base) => api.addProjectEntry(workId, { section: "question", text: event.text, sessionId: event.sessionId, itemId: event.itemId ?? null, baseRevision: base }))}>질문으로</button>
                      ) : null}
                    </li>
                  ))}
                </ul>
                {record.length > recordShown.length ? <button type="button" className="link small pn-more" onClick={() => setRecordAll(true)}>{record.length - recordShown.length}개 더 보기</button> : null}
              </div>
            ) : <p className="pn-empty" id="pn-record">아직 기록이 없습니다. "새로 만들기"로 이 프로젝트의 첫 대화를 시작하세요.</p>}
          </section>

          {links.length ? (
            <section className="pn-group pn-ruled" aria-label="연결">
              <SectionLabel collapsed={linksFolded} onToggle={toggleLinks} controls="pn-links" count={links.length}>연결</SectionLabel>
              {linksFolded ? null : (
                <ul className="pn-links" id="pn-links">
                  {links.map((link) => {
                    const other = state.works[link.id]!;
                    return (
                      <li key={link.id}>
                        <button type="button" className="pn-link" onClick={() => onOpenProject?.(other)} title={`${other.title} 프로젝트 노트 열기`}>
                          <ItemIcon kind="project" size={16} />
                          <span className="pn-link-title">{other.title}</span>
                          <span className="pn-link-why">{link.by === "related" ? "관련" : link.tags.map((tag) => `#${tag}`).join(" ")}</span>
                          <time className="pn-link-when">{ago(other.updatedAt) || "방금"}</time>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          ) : null}

          <section className="pn-group pn-ruled" aria-label="자세히">
            <SectionLabel collapsed={detailsFolded} onToggle={toggleDetails} controls="pn-details">자세히</SectionLabel>
            {detailsFolded ? null : (
              <dl className="pn-details" id="pn-details">
                <div><dt>대화</dt><dd>{facts.sessions}{Object.entries(facts.engines).map(([provider, count]) => <span key={provider} className="pn-detail-part"><EngineMark provider={provider as keyof typeof PROVIDER_LABEL} size={14} />{PROVIDER_LABEL[provider as keyof typeof PROVIDER_LABEL]} {count}</span>)}</dd></div>
                <div><dt>모델</dt><dd title={facts.models.join(", ")}>{facts.models.join(", ") || "없음"}</dd></div>
                <div><dt>요청</dt><dd>{facts.requests}회<span className="pn-detail-part">{duration(facts.turnMs)}</span></dd></div>
                <div><dt>파일 판</dt><dd>{facts.files}<span className="pn-detail-part">사람 {facts.revisions.user}</span><span className="pn-detail-part">AI {facts.revisions.engine}</span>{facts.revisions.external ? <span className="pn-detail-part">앱 밖 {facts.revisions.external}</span> : null}</dd></div>
                <div><dt>예약</dt><dd>{facts.schedules}</dd></div>
                <div><dt>격리 사본</dt><dd>{facts.worktrees}</dd></div>
                <div><dt>시작</dt><dd>{new Date(facts.createdAt).toLocaleDateString("ko-KR")}</dd></div>
                {facts.branch ? <div><dt>가지</dt><dd className="pn-path">{facts.branch}</dd></div> : null}
                <div><dt>작업 폴더</dt><dd className="pn-path" title="작업 폴더">{facts.folder.replace(/^\/home\/[^/]+/, "~")}</dd></div>
                <div><dt>노트 파일</dt><dd className="pn-path" title="노트 파일">{note.path}</dd></div>
              </dl>
            )}
          </section>

          <section className="pn-group pn-ruled project-card" aria-label="엔진이 아는 것">
            <SectionLabel collapsed={cardFolded} onToggle={toggleCard} controls="pn-card" count={page.readNotes?.length || undefined}>엔진이 아는 것</SectionLabel>
            {cardFolded ? null : (
              <div id="pn-card">
                <p className="pn-empty">새 대화는 이 맥락 카드를 받습니다.{page.readNotes?.length ? ` 엔진이 스스로 읽은 노트 ${page.readNotes.length}개가 아래에 있습니다.` : ""}</p>
                <pre>{page.card}</pre>
                {page.readNotes?.length ? (
                  <ul className="pn-read-notes">
                    {page.readNotes.map((read) => (
                      <li key={read.path}>
                        {onOpenNote ? <button type="button" className="link" title={read.path} onClick={() => onOpenNote(read.path)}>{read.title}</button> : <span title={read.path}>{read.title}</span>}
                        <span className="muted">대화 {read.sessions}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            )}
          </section>
        </div>
      </div>
      {stagesOpen ? <StageDialog api={api} stages={stages} onClose={() => setStagesOpen(false)} onSaved={() => load()} onError={onError} /> : null}
      {templateOpen ? <TemplateDialog api={api} onClose={() => setTemplateOpen(false)} onSaved={() => load()} onError={onError} /> : null}
    </main>
  );
}

/** A long path cut in the middle (skin 2): the start and the last folder stay readable — "~/Dropbox/…/강의 준비" —
 *  and the whole path is the title and the accessible name. */
export function MiddlePath({ path, full }: { path: string; full: string }) {
  const cut = path.lastIndexOf("/", path.length - 2);
  const head = cut > 0 ? path.slice(0, cut + 1) : "";
  const tail = cut > 0 ? path.slice(cut + 1) : path;
  return (
    <span className="pn-prop-text middle-path" title={full} aria-label={full}>
      {head ? <span className="middle-path-head" aria-hidden>{head}</span> : null}
      <span className="middle-path-tail" aria-hidden>{tail}</span>
    </span>
  );
}
