import { useCallback, useEffect, useMemo, useRef, useState, type FocusEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { diffLines } from "diff";
import type { Components } from "react-markdown";
import { PROVIDER_LABEL, type ProjectPage, type ProjectWrite, type Session } from "@workbench/contracts";
import { ApiRequestError, type Api } from "../../api.ts";
import { clearRecoveredDraft, keepDraft, newestDraft } from "../../document-drafts.ts";
import { useDocumentSession } from "../../document-session.ts";
import { ObsidianMarkdown } from "../../markdown/obsidian.tsx";
import type { Note } from "../../top-notice.ts";
import { DiffView } from "../docs/DiffView.tsx";
import { MarkdownEditor } from "../docs/MarkdownEditor.tsx";
import { NoteWriteSkipped } from "./note-writes.ts";

// The note's own words, read and written in the same place. The body is read as runs — the
// stretches outside `## 결정` / `## 열린 질문` — and a click on one turns that run (only it) into
// its Markdown source, styled as the same note, with the caret where the reader clicked. Ctrl+Enter
// or leaving writes that run into the real file (a revision, "되돌리기" in the notice); every other
// byte stays, line endings included. Esc puts it back, and the dropped words can be brought back
// from the notice; while editing a copy is kept on this device in case the app closes. A change made
// meanwhile elsewhere is never overwritten: compare, keep mine, or take theirs. "원문 전체" edits
// the whole file the same way.

/** Lines added and removed between two texts, for the notice. */
export function lineCounts(before: string, after: string) {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(before, after)) {
    const lines = part.value.replace(/\n$/, "").split("\n").length;
    if (part.added) added += lines;
    else if (part.removed) removed += lines;
  }
  return { added, removed };
}

const lf = (text: string) => text.replace(/\r\n/g, "\n");

type Target = { kind: "run"; index: number; start: number; end: number; expected: string } | { kind: "source"; expected: string };
type Editing = { target: Target; eol: "\r\n" | "\n"; revision: number | null; caret: number; pointerY: number | null };
type Conflict = { page: ProjectPage };
/** A kept draft: where it was, the words it was started from (and their revision), and the words typed. */
type Kept = { kind: Target["kind"]; index: number; expected: string; draft: string; revision?: number | null };

/** The line ending a run is written with: its own, else the file's. */
const eolOf = (expected: string, source: string): "\r\n" | "\n" => (/\r\n/.test(expected) ? "\r\n" : /\n/.test(expected) ? "\n" : /\r\n/.test(source) ? "\r\n" : "\n");

/** Where the caret goes in a run's source for a click on its rendered text. */
function caretFor(event: ReactMouseEvent, runText: string): number {
  const lines = lf(runText).split("\n");
  const block = (event.target as HTMLElement).closest<HTMLElement>("[data-src-line]");
  const line = Math.min(Math.max(Number(block?.dataset.srcLine ?? 1), 1), lines.length);
  let offset = lines.slice(0, line - 1).reduce((sum, text) => sum + text.length + 1, 0);
  const source = lines[line - 1] ?? "";
  // The rendered text before the click, matched in the source line (marks such as `- ` or `**` differ).
  const doc = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null; caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };
  let caret: Range | null = null;
  if (doc.caretRangeFromPoint) caret = doc.caretRangeFromPoint(event.clientX, event.clientY);
  else if (doc.caretPositionFromPoint) {
    const point = doc.caretPositionFromPoint(event.clientX, event.clientY);
    if (point) { caret = document.createRange(); caret.setStart(point.offsetNode, point.offset); }
  }
  if (block && caret && block.contains(caret.startContainer)) {
    const before = document.createRange();
    before.setStart(block, 0);
    before.setEnd(caret.startContainer, caret.startOffset);
    const tail = before.toString().slice(-12);
    const found = tail ? source.indexOf(tail) : -1;
    offset += found >= 0 ? found + tail.length : 0;
  }
  return offset;
}

/** The caret at the end of a key's line in the front matter (for "원문에서 고치기"). */
function keyCaret(source: string, key: string): number {
  const lines = lf(source).split("\n");
  const heads = [`${key}:`, `${JSON.stringify(key)}:`, `'${key.replace(/'/g, "''")}':`];
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (index > 0 && /^(---|\.\.\.)\s*$/.test(lines[index]!)) break;
    if (heads.some((head) => lines[index]!.startsWith(head))) return offset + lines[index]!.length;
    offset += lines[index]!.length + 1;
  }
  return 0;
}

/** Who wrote the note's latest revision, in a sentence ("Codex · 슬라이드 정리가"). */
function whoWrote(page: ProjectPage, sessions: Record<string, Session>) {
  const session = page.note.lastSessionId ? sessions[page.note.lastSessionId] : undefined;
  if (page.note.lastAuthor === "engine") return session ? `${PROVIDER_LABEL[session.provider]} · ${session.purpose || "세션"}이` : "엔진이";
  if (page.note.lastAuthor === "external") return "앱 밖에서";
  return "다른 창에서";
}

export type NoteBodyControls = {
  /** Edit the note's words (the first run that has any). */
  start: () => void;
  /** Edit the whole file, the caret at `key` when given. */
  source: (key?: string) => void;
};

export function NoteBody({
  api: rootApi,
  workId,
  page,
  sessions,
  components,
  urlTransform,
  empty,
  controls,
  send,
  onWrote,
  onPage,
  onNotice,
  onError,
  onLeaveGuard,
}: {
  api: Api;
  workId: string;
  page: ProjectPage;
  sessions: Record<string, Session>;
  /** How the note's Markdown is drawn while reading. */
  components: Components;
  urlTransform: (url: string) => string;
  /** Shown instead when the note has no words yet. */
  empty: ReactNode;
  /** Filled with the functions the page's buttons and keys call. */
  controls: { current: NoteBodyControls | null };
  /** The page's one writer: sends `make` after the page's earlier writes, with the base for `seen`. */
  send: (seen: number | null, make: (base: number | null) => Promise<ProjectWrite>) => Promise<ProjectWrite>;
  /** A write landed; `change` is what the notice says. */
  onWrote: (write: ProjectWrite, change: string) => void;
  /** A newer page read while settling a conflict. */
  onPage: (page: ProjectPage) => void;
  /** An action notice in the top bar ("되살리기"). */
  onNotice: (note: Note) => void;
  onError: (error: unknown) => void;
  onLeaveGuard?: (guard: (() => Promise<void>) | null) => void;
}) {
  const note = page.note;
  const runs = useMemo(() => note.runs?.length ? note.runs : [{ start: 0, end: 0, text: note.body }], [note.runs, note.body]);
  const source = note.source ?? note.body;
  const broken = Boolean(note.problem);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [comparing, setComparing] = useState(false);
  const [recovery, setRecovery] = useState<ReturnType<typeof newestDraft>>(null);
  const area = useRef<HTMLDivElement>(null);
  const live = useRef({ draft, editing, saving, conflict });
  live.current = { draft, editing, saving, conflict };
  const draftKey = `project-note.${workId}`;
  const [viewKey] = useState(() => `view-${Math.random().toString(36).slice(2)}`);

  // While editing, this view holds the note's edit lease (one editor at a time across windows).
  const lease = useDocumentSession(rootApi, editing ? note.artifactId : null, null);
  const api = editing && note.artifactId ? lease.api : rootApi;
  // Read-only only when another window holds the note (or the lease failed), not while it is asked for.
  const held = Boolean(editing && note.artifactId && (lease.error || (lease.ready && !lease.canWrite)));
  const blocked = Boolean(editing && note.artifactId && !lease.canWrite);
  const baseText = editing ? lf(editing.target.expected) : "";
  useEffect(() => {
    if (editing && note.artifactId) void lease.report(draft !== baseText, editing.revision ?? undefined);
  }, [editing, note.artifactId, draft, baseText, lease.report]);

  // A copy on this device while editing (the app may close); offered again on return.
  const keepCopy = useCallback((of: Editing, words: string) => {
    const kept: Kept = { kind: of.target.kind, index: of.target.kind === "run" ? of.target.index : 0, expected: of.target.expected, draft: words, revision: of.revision };
    keepDraft(draftKey, viewKey, words === lf(of.target.expected) ? null : { baseRevision: of.revision ?? 1, text: JSON.stringify(kept), at: Date.now() });
  }, [draftKey, viewKey]);
  useEffect(() => {
    if (!editing) return;
    const timer = window.setTimeout(() => keepCopy(editing, draft), 300);
    return () => window.clearTimeout(timer);
  }, [editing, draft, keepCopy]);
  // The page going away (another project in this tab, the pane closed) keeps the latest words at once.
  useEffect(() => () => {
    if (live.current.editing) keepCopy(live.current.editing, live.current.draft);
  }, [keepCopy]);
  useEffect(() => {
    if (!editing) setRecovery(newestDraft(draftKey));
  }, [editing, draftKey]);

  /** The target for a kept draft against the note as it is now: its run if it still reads the same, else the same place. */
  const targetFor = useCallback((kind: Target["kind"], index: number, expected: string, from: ProjectPage = page): Target => {
    if (kind === "source") return { kind, expected: from.note.source ?? from.note.body };
    const list = from.note.runs?.length ? from.note.runs : [{ start: 0, end: 0, text: from.note.body }];
    const found = list.findIndex((run) => run.text === expected);
    const at = found >= 0 ? found : Math.min(index, list.length - 1);
    const run = list[at]!;
    return { kind, index: at, start: run.start, end: run.end, expected: run.text };
  }, [page]);

  const open = useCallback((target: Target, text: string, caret: number, pointerY: number | null = null) => {
    setDraft(text);
    setConflict(null);
    setComparing(false);
    setEditing({ target, eol: eolOf(target.expected, source), revision: note.exists ? note.revision : null, caret, pointerY });
  }, [note.exists, note.revision, source]);

  const editRun = useCallback((index: number, caret = 0, pointerY: number | null = null) => {
    if (live.current.editing || broken) return;
    const run = runs[index] ?? runs[0]!;
    open({ kind: "run", index, start: run.start, end: run.end, expected: run.text }, lf(run.text), caret, pointerY);
  }, [runs, broken, open]);
  const editSource = useCallback((key?: string) => {
    if (live.current.editing || broken) return;
    open({ kind: "source", expected: source }, lf(source), key ? keyCaret(source, key) : 0);
    requestAnimationFrame(() => area.current?.scrollIntoView?.({ block: "nearest" }));
  }, [source, open, broken]);
  const firstWords = Math.max(0, runs.findIndex((run) => run.text.trim()));
  controls.current = { start: () => editRun(firstWords, 0), source: editSource };

  const close = useCallback(() => {
    keepDraft(draftKey, viewKey, null);
    live.current = { ...live.current, editing: null };
    setEditing(null);
    setConflict(null);
    setComparing(false);
  }, [draftKey, viewKey]);

  /** Leave without writing; changed words can be brought back from the notice. */
  const discard = useCallback(() => {
    const current = live.current;
    if (!current.editing || current.saving) return;
    const { target } = current.editing;
    const dropped = current.draft;
    close();
    if (dropped === lf(target.expected)) return;
    const index = target.kind === "run" ? target.index : 0;
    onNotice({ text: "고치던 내용을 버렸습니다", action: { label: "되살리기", run: () => restore.current({ kind: target.kind, index, expected: target.expected, draft: dropped }) } });
  }, [close, onNotice]);
  const restore = useRef<(kept: Kept) => void>(() => undefined);
  // A kept draft (from the notice or from this device) is resumed only against the words it was
  // started from; if they changed since, it opens as a conflict and nothing is written until the
  // person compares and chooses.
  restore.current = (kept: Kept) => {
    if (live.current.editing) return;
    const target = targetFor(kept.kind, kept.index, kept.expected);
    if (target.expected === kept.expected) return open(target, kept.draft, kept.draft.length);
    open(target.kind === "run" ? { ...target, expected: kept.expected } : { kind: "source", expected: kept.expected }, kept.draft, kept.draft.length);
    setConflict({ page });
  };

  /** Write the draft over `target`; true when the note now holds it. */
  const write = useCallback(async (target: Target, revision: number | null): Promise<boolean> => {
    const current = live.current;
    const eol = current.editing?.eol ?? "\n";
    const text = eol === "\r\n" ? current.draft.replace(/\r?\n/g, "\r\n") : current.draft;
    setSaving(true);
    try {
      const written = await send(revision, (base) => (target.kind === "run"
        ? api.setProjectRun(workId, { index: target.index, expected: target.expected, text }, base)
        : api.setProjectSource(workId, text, base)));
      const { added, removed } = lineCounts(lf(target.expected), current.draft);
      onWrote(written, `${target.kind === "source" ? "노트 원문 고침" : "노트 본문 고침"} · +${added}줄 −${removed}줄`);
      if (live.current.draft === current.draft) close();
      return true;
    } catch (error) {
      // The page was left before this write's turn: nothing was sent, the words are kept on this device.
      if (error instanceof NoteWriteSkipped && error.why === "left") return false;
      // A stale write is refused, always (one waiting behind a refused write is not even sent); the person compares and chooses.
      if (error instanceof NoteWriteSkipped || (error instanceof ApiRequestError && error.status === 409 && (error.code === "note_changed" || error.code === "note_moved"))) {
        try {
          setConflict({ page: await rootApi.project(workId) });
        } catch (reload) {
          onError(reload);
        }
      } else onError(error);
      return false;
    } finally {
      setSaving(false);
    }
  }, [api, rootApi, workId, send, onWrote, onError, close]);

  // A write under way: leaving (blur, then the page's leave guard) waits for its outcome.
  const inflight = useRef<Promise<boolean> | null>(null);
  /** Leave the editor keeping the edit; unchanged words (whatever their line endings) write nothing. */
  const save = useCallback((): Promise<boolean> => {
    if (inflight.current) return inflight.current;
    const current = live.current;
    if (!current.editing) return Promise.resolve(true);
    if (current.conflict) return Promise.resolve(false);
    if (current.draft === lf(current.editing.target.expected)) {
      close();
      return Promise.resolve(true);
    }
    const run = write(current.editing.target, current.editing.revision).finally(() => {
      inflight.current = null;
    });
    inflight.current = run;
    return run;
  }, [close, write]);

  // Leaving the page writes the edit; a conflict (or a failed write) keeps the person here.
  useEffect(() => {
    onLeaveGuard?.(async () => {
      if (!live.current.editing && !inflight.current) return;
      if (!(await save())) throw new Error("프로젝트 노트의 편집을 쓰지 못했습니다. 노트에서 확인해 주세요.");
    });
    return () => onLeaveGuard?.(null);
  }, [onLeaveGuard, save]);

  // The editor is made once: its keys reach the latest save and discard through a ref.
  const actions = useRef({ save, discard });
  actions.current = { save, discard };
  const keys = useMemo(() => [Prec.highest(keymap.of([
    { key: "Mod-Enter", run: () => { void actions.current.save(); return true; } },
    { key: "Escape", run: () => { actions.current.discard(); return true; } },
  ]))], []);

  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null;
    if (next && area.current?.contains(next)) return;
    // The window lost focus (another app): the edit waits for the person to come back.
    if (!next && !document.hasFocus()) return;
    // Without the edit lease a changed draft stays open (the line above says why).
    if (blocked && live.current.draft !== baseText) return;
    void save();
  };

  /** The new editor: focused without a jump, the caret's line where the pointer was. */
  const placed = (view: EditorView | null) => {
    if (!view || !editing) return;
    view.contentDOM.focus({ preventScroll: true });
    const { caret, pointerY } = editing;
    requestAnimationFrame(() => {
      try {
        const scroller = area.current?.closest<HTMLElement>(".pn-scroll");
        const at = view.coordsAtPos(Math.min(caret, view.state.doc.length));
        if (scroller && at && pointerY !== null) scroller.scrollTop += (at.top + at.bottom) / 2 - pointerY;
        else view.dispatch({ effects: EditorView.scrollIntoView(Math.min(caret, view.state.doc.length), { y: "nearest" }) });
      } catch {
        // No layout (the editor is hidden or gone): nothing to align.
      }
    });
  };

  const recoveryLine = recovery && !editing ? (
    <div className="pn-edit-line pn-recovery" role="status">
      <span className="dot dot-attention" aria-hidden />
      <span>저장하지 않은 노트 편집이 남아 있습니다 · {new Date(recovery.at).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
      <span className="pn-edit-actions">
        <button type="button" className="button small" onClick={() => {
          try {
            const kept = JSON.parse(recovery.text) as Kept;
            clearRecoveredDraft(recovery);
            setRecovery(null);
            restore.current(kept);
          } catch {
            clearRecoveredDraft(recovery);
            setRecovery(null);
          }
        }}>이어서 고치기</button>
        <button type="button" className="button small" onClick={() => { clearRecoveredDraft(recovery); setRecovery(null); }}>버리기</button>
      </span>
    </div>
  ) : null;

  const editor = editing ? (
    <div className="pn-body-edit" ref={area} onBlur={onBlur} data-mode={editing.target.kind} data-saving={saving || undefined}>
      {held ? (
        <div className="pn-edit-line" role="status">
          <span>{lease.error ?? "다른 창의 편집 여부를 확인하고 있습니다."}</span>
          <button type="button" className="link small" onClick={() => void lease.claim()}>편집 권한 받기</button>
        </div>
      ) : null}
      {conflict ? (
        <div className="pn-edit-line pn-conflict" role="alert">
          <span className="dot dot-attention" aria-hidden />
          <span>그 사이 {whoWrote(conflict.page, sessions)} 노트를 바꿨습니다{conflict.page.note.revision ? ` (r${conflict.page.note.revision})` : ""}. 내 편집은 그대로 있습니다.</span>
          <span className="pn-edit-actions">
            <button type="button" className="button small" aria-pressed={comparing} onClick={() => setComparing(!comparing)}>비교</button>
            <button type="button" className="button small" onClick={() => {
              const theirs = conflict.page;
              const { target } = editing;
              const next = targetFor(target.kind, target.kind === "run" ? target.index : 0, target.expected, theirs);
              setConflict(null);
              const seen = theirs.note.exists ? theirs.note.revision : null;
              setEditing({ ...editing, target: next, revision: seen });
              onPage(theirs);
              void write(next, seen);
            }}>내 것으로 쓰기</button>
            <button type="button" className="button small" onClick={() => {
              onPage(conflict.page);
              discard();
            }}>저쪽 것 받기</button>
          </span>
        </div>
      ) : null}
      {conflict && comparing ? (() => {
        const theirs = targetFor(editing.target.kind, editing.target.kind === "run" ? editing.target.index : 0, editing.target.expected, conflict.page);
        return <DiffView before={lf(theirs.expected)} after={draft} beforeLabel={`저쪽 r${conflict.page.note.revision ?? "?"}`} afterLabel="내 편집" />;
      })() : null}
      <div className="pn-editor">
        <MarkdownEditor look="note" value={draft} readOnly={held} onChange={setDraft} onSelection={() => undefined} extensions={keys}
          position={{ cursor: { anchor: Math.min(editing.caret, draft.length), head: Math.min(editing.caret, draft.length) } }} onView={placed} />
      </div>
      <div className="pn-edit-foot">
        <span className="pn-edit-hint">{saving ? "쓰는 중…" : editing.target.kind === "source" ? "원문 전체 · Ctrl+Enter 또는 밖을 누르면 저장 · Esc 취소" : "Ctrl+Enter 또는 밖을 누르면 저장 · Esc 취소"}</span>
        <span className="pn-edit-actions">
          <button type="button" className="button small" disabled={saving} onClick={discard}>취소</button>
          <button type="button" className="button small primary" disabled={saving || blocked || Boolean(conflict)} onClick={() => void save()}>저장</button>
        </span>
      </div>
    </div>
  ) : null;

  if (editing?.target.kind === "source") return <>{editor}</>;
  const editingRun = editing?.target.kind === "run" ? editing.target.index : -1;
  const shown = runs.map((run, index) => ({ run, index })).filter(({ run, index }) => run.text.trim() || index === editingRun);
  return (
    <div
      className="pn-body-read"
      data-broken={broken || undefined}
      tabIndex={editing ? -1 : 0}
      aria-label={broken ? "노트 본문" : "노트 본문 — 누르면 그 자리에서 고칩니다"}
      onKeyDown={(event) => {
        if (editing || event.target !== event.currentTarget || event.nativeEvent.isComposing) return;
        if (event.key === "Enter") {
          event.preventDefault();
          editRun(firstWords, 0);
        }
      }}
    >
      {recoveryLine}
      {shown.length ? shown.map(({ run, index }) => index === editingRun ? <div key={`edit-${index}`}>{editor}</div> : (
        <div
          key={`${index}-${run.start}`}
          className="pn-run"
          data-run={index}
          onClick={(event) => {
            if (editing || broken) return;
            if ((event.target as HTMLElement).closest("a, button, input, label, summary")) return;
            if ((window.getSelection()?.toString() ?? "").trim()) return;
            editRun(index, caretFor(event, run.text), event.clientY);
          }}
        >
          <div className="markdown pn-markdown"><ObsidianMarkdown components={components} urlTransform={urlTransform} sourceLines>{lf(run.text)}</ObsidianMarkdown></div>
        </div>
      )) : (
        <div className="pn-run" data-run={firstWords} onClick={() => !broken && editRun(firstWords, 0)}>{empty}</div>
      )}
    </div>
  );
}
