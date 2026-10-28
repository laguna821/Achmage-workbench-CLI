import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap } from "@codemirror/view";
import { ASPECT_LABEL, IMAGE_ASPECTS, dirOf, markdownImageLink, placeBlock, relativePath, type Artifact, type ImageInfo, type ImageItem, type Session, type Work } from "@workbench/contracts";
import type { Api } from "../../api.ts";
import { newRequestId } from "../../format.ts";
import { cursorOf, imageInfo, inlineDrawings, rememberCursor, showDoc, takeQueued, useDrawChoice, useTemplates } from "../../imagegen.ts";
import { isBusy, type State } from "../../state.ts";
import { EngineMark } from "../EngineMark.tsx";
import { Icon } from "../Icon.tsx";
import "../../styles/imagegen.css";

// "여기에 그림 그리기": draw at the cursor of a Markdown document. While Codex draws, a mark sits
// where the picture will go (not part of the text, it moves with edits); the link goes in there
// when the picture is ready, as an ordinary edit (so it is saved as the next revision and can be
// undone). The mark survives switching views and leaving the document.

type Marker = { id: string; pos: number };

const addMarker = StateEffect.define<Marker>();
const dropMarker = StateEffect.define<string>();

class PendingWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const mark = document.createElement("span");
    mark.className = "cm-draw-pending";
    mark.textContent = "그림 그리는 중…";
    return mark;
  }
  ignoreEvent() {
    return true;
  }
}

const markers = StateField.define<Marker[]>({
  create: () => [],
  update(value, transaction) {
    let next = transaction.docChanged ? value.map((marker) => ({ ...marker, pos: transaction.changes.mapPos(marker.pos, 1) })) : value;
    for (const effect of transaction.effects) {
      if (effect.is(addMarker)) next = [...next.filter((marker) => marker.id !== effect.value.id), effect.value];
      else if (effect.is(dropMarker)) next = next.filter((marker) => marker.id !== effect.value);
    }
    return next;
  },
  provide: (field) =>
    EditorView.decorations.from(field, (value) =>
      Decoration.set(
        value.map((marker) => Decoration.widget({ widget: new PendingWidget(), side: 1 }).range(marker.pos)),
        true,
      ),
    ),
});

/** Editor behaviour for one document: the marks, where the cursor was, and Ctrl+Alt+G. */
export function drawExtension(artifactId: string): Extension {
  return [
    markers,
    EditorView.updateListener.of((update) => {
      const pending = inlineDrawings(artifactId);
      for (const marker of update.state.field(markers)) if (pending.has(marker.id)) pending.set(marker.id, marker.pos);
      // The end of a selection: a picture drawn from selected text goes after it.
      if (update.selectionSet) rememberCursor(artifactId, update.state.selection.main.to);
    }),
    keymap.of([
      {
        key: "Mod-Alt-g",
        run: (view) => {
          view.dom.dispatchEvent(new CustomEvent("workbench-draw", { bubbles: true }));
          return true;
        },
      },
    ]),
  ];
}

const firstLine = (text: string) => (text.split("\n").find((line) => line.trim()) ?? "").trim();

export function InlineDraw({
  api,
  state,
  work,
  session,
  artifact,
  view,
  ready,
  open,
  onOpen,
  onInsertText,
  onToast,
}: {
  api: Api;
  state: State;
  work: Work;
  /** The conversation the document talks to; the picture also shows there. */
  session: Session | null;
  artifact: Artifact;
  /** The editor on screen (null in the preview). */
  view: EditorView | null;
  /** The document's text has loaded. */
  ready: boolean;
  open: boolean;
  onOpen: (open: boolean) => void;
  /** Change the document's text without an editor on screen. */
  onInsertText: (change: (text: string) => string) => void;
  onToast: (message: string) => void;
}) {
  const pending = inlineDrawings(artifact.id);
  const [waiting, setWaiting] = useState(pending.size);
  const refresh = () => setWaiting(pending.size);
  const viewRef = useRef(view);
  viewRef.current = view;

  /** Put a block where the user left the cursor (or at `at`), as an edit of the document. */
  const insert = useCallback(
    (block: string, at: number | null) => {
      const editor = viewRef.current;
      if (editor) {
        const text = editor.state.doc.toString();
        const placed = placeBlock(text, at ?? cursorOf(artifact.id) ?? text.length, block);
        editor.dispatch({ changes: { from: placed.at, insert: placed.insert }, selection: { anchor: placed.cursor }, scrollIntoView: true });
      } else {
        onInsertText((text) => placeBlock(text, at ?? cursorOf(artifact.id) ?? text.length, block).text);
      }
    },
    [artifact.id, onInsertText],
  );

  // "현재 문서에 넣기" on a picture card puts it here while this document is on screen; what was
  // put in while it was not comes in now.
  useEffect(() => {
    if (!ready) return;
    for (const block of takeQueued(artifact.id)) insert(block, null);
    return showDoc({ artifactId: artifact.id, workId: work.id, insertAtCursor: (block) => insert(block, null) });
  }, [ready, artifact.id, work.id, insert, view]);

  // A new editor (another view, or back to the document): show the marks of drawings still going.
  useEffect(() => {
    if (!view || !pending.size) return;
    const length = view.state.doc.length;
    view.dispatch({ effects: [...pending].map(([id, pos]) => addMarker.of({ id, pos: Math.min(pos, length) })) });
  }, [view, pending]);

  // A drawing that ended: the link goes where its mark is, or the card says why it did not.
  const settle = useCallback(
    (info: ImageInfo) => {
      if (!pending.has(info.id)) return;
      const editor = viewRef.current;
      const at = editor?.state.field(markers, false)?.find((marker) => marker.id === info.id)?.pos ?? pending.get(info.id) ?? null;
      pending.delete(info.id);
      editor?.dispatch({ effects: dropMarker.of(info.id) });
      refresh();
      if (info.status === "done" && info.path) {
        insert(markdownImageLink(firstLine(info.brief), relativePath(dirOf(artifact.path), info.path)), at);
        onToast(`그림을 넣었습니다: ${info.relPath}`);
      } else {
        onToast(`그림을 그리지 못했습니다${info.error ? `: ${info.error}` : "."}`);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pending, insert, artifact.path, onToast],
  );

  const items = session ? state.transcripts[session.id]?.items : undefined;
  useEffect(() => {
    if (!ready || !pending.size || !items) return;
    for (const item of items) if (item.kind === "image" && (item as ImageItem).image.status !== "drawing") settle((item as ImageItem).image);
  }, [ready, items, settle, pending]);

  // Drawings whose card is not in a loaded conversation (another session became the shown one): ask.
  useEffect(() => {
    if (!ready || !waiting) return;
    const timer = window.setInterval(() => {
      for (const id of [...pending.keys()]) {
        void imageInfo(id)
          .then((info) => info.status !== "drawing" && settle(info))
          .catch(() => undefined);
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [ready, waiting, pending, settle]);

  // Ctrl+Alt+G in the editor.
  useEffect(() => {
    if (!view) return;
    const onDraw = () => onOpen(true);
    view.dom.addEventListener("workbench-draw", onDraw);
    return () => view.dom.removeEventListener("workbench-draw", onDraw);
  }, [view, onOpen]);

  const start = async (request: { brief: string; templateId: string | null; aspect: ImageInfo["aspect"]; transparent: boolean }) => {
    const editor = viewRef.current;
    // Where the user left the cursor; never placed in this document, the end of it.
    const at = cursorOf(artifact.id) ?? editor?.state.doc.length ?? null;
    // Codex draws; a busy Codex conversation hands the drawing to the work's drawing session.
    let origin = session;
    if (!origin) origin = await api.createSession(work.id, "codex", { purpose: "그림" });
    const via = origin.provider === "codex" && isBusy(origin) ? "helper" : null;
    const id = newRequestId();
    pending.set(id, at ?? Number.MAX_SAFE_INTEGER);
    if (editor) editor.dispatch({ effects: addMarker.of({ id, pos: Math.min(pending.get(id)!, editor.state.doc.length) }) });
    refresh();
    try {
      await api.draw(origin.id, { requestId: id, ...request, via, insertInto: artifact.id });
      return true;
    } catch (error) {
      pending.delete(id);
      editor?.dispatch({ effects: dropMarker.of(id) });
      refresh();
      onToast(`그림을 그리지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  return open ? <DrawHere view={view} at={cursorOf(artifact.id)} session={session} state={state} onClose={() => onOpen(false)} onStart={start} /> : null;
}

/** The small form at the cursor: what to draw, the template and shape, who draws. */
function DrawHere({
  view,
  at,
  session,
  state,
  onClose,
  onStart,
}: {
  view: EditorView | null;
  /** Where the picture goes (null: the end of the document). */
  at: number | null;
  session: Session | null;
  state: State;
  onClose: () => void;
  onStart: (request: { brief: string; templateId: string | null; aspect: ImageInfo["aspect"]; transparent: boolean }) => Promise<boolean>;
}) {
  const [choice, setChoice] = useDrawChoice();
  const templates = useTemplates();
  // The selected text is a good start for what to draw; the picture then goes after it.
  const [brief, setBrief] = useState(() => {
    const range = view?.state.selection.main;
    return range && !range.empty ? view!.state.sliceDoc(range.from, range.to).trim().slice(0, 1000) : "";
  });
  const [sending, setSending] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number }>({ left: 0, top: 0 });

  useLayoutEffect(() => {
    const height = box.current?.offsetHeight ?? 320;
    const caret = view ? view.coordsAtPos(Math.min(at ?? view.state.doc.length, view.state.doc.length)) : null;
    const anchor = caret ?? view?.dom.getBoundingClientRect() ?? { left: window.innerWidth / 2 - 180, top: 120, bottom: 120 };
    const left = Math.max(8, Math.min(anchor.left - 16, window.innerWidth - 368));
    const below = anchor.bottom + 8;
    setPlace({ left, top: below + height > window.innerHeight - 8 ? Math.max(8, anchor.top - height - 8) : below });
  }, [view, at]);

  const codex = session?.provider === "codex";
  const busy = session ? isBusy(session) : false;
  const who = !session
    ? "새 Codex 세션이 GPT Image로 그립니다."
    : codex
      ? busy
        ? `「${session.purpose}」 세션이 일하는 중이라 이 작업의 Codex 그림 세션이 그립니다.`
        : `「${session.purpose}」 Codex 세션이 GPT Image로 그립니다.`
      : "Claude는 그림을 그리지 못해 이 작업의 Codex 그림 세션이 그립니다. 그림은 Claude 대화에도 남습니다.";
  const submit = async () => {
    if (!brief.trim() || sending) return;
    setSending(true);
    const started = await onStart({ brief: brief.trim(), templateId: choice.templateId, aspect: choice.aspect, transparent: choice.transparent });
    setSending(false);
    if (started) {
      onClose();
      view?.focus();
    }
  };
  const unavailable = state.providers.codex?.imageGeneration === false;
  return (
    <div
      ref={box}
      className="inline-draw"
      role="dialog"
      aria-label="여기에 그림 그리기"
      style={{ left: place.left, top: place.top }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
          view?.focus();
        } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
          event.preventDefault();
          void submit();
        }
      }}
    >
      <div className="inline-draw-head">
        <Icon name="image" size={15} /> 여기에 그림 그리기
        <button type="button" className="icon-button small" onClick={onClose} aria-label="닫기" title="닫기 (Esc)">
          <Icon name="x" size={14} />
        </button>
      </div>
      <textarea autoFocus value={brief} onChange={(event) => setBrief(event.target.value)} rows={3} placeholder="무엇을 그릴까요? (Ctrl+Enter로 그리기)" aria-label="그릴 내용" />
      <div className="inline-draw-row">
        <span>템플릿</span>
        <select value={choice.templateId ?? ""} onChange={(event) => setChoice({ ...choice, templateId: event.target.value || null })} aria-label="템플릿">
          <option value="">없음</option>
          {(templates?.templates ?? []).map((template) => (
            <option key={template.id} value={template.id}>
              {template.name}
            </option>
          ))}
        </select>
      </div>
      <div className="inline-draw-row">
        <span>비율</span>
        <div className="segmented small" role="radiogroup" aria-label="비율">
          {IMAGE_ASPECTS.map((aspect) => (
            <button key={aspect} type="button" role="radio" aria-checked={choice.aspect === aspect} className={choice.aspect === aspect ? "active" : ""} onClick={() => setChoice({ ...choice, aspect })}>
              {ASPECT_LABEL[aspect]}
            </button>
          ))}
        </div>
        <label className="draw-check">
          <input type="checkbox" checked={choice.transparent} onChange={(event) => setChoice({ ...choice, transparent: event.target.checked })} /> 투명
        </label>
      </div>
      <div className={`draw-note${unavailable ? " warn" : ""}`}>
        <EngineMark provider="codex" size={13} /> {unavailable ? "이 컴퓨터의 Codex에서는 그림 기능을 쓸 수 없습니다." : who} 그림은 작업 폴더의 images/에 저장되고, 링크가 커서 자리에 들어갑니다.
      </div>
      <div className="inline-draw-actions">
        <button type="button" className="button small" onClick={onClose}>
          취소
        </button>
        <button type="button" className="button small primary" onClick={() => void submit()} disabled={!brief.trim() || sending || unavailable}>
          {sending ? "보내는 중…" : "그리기"}
        </button>
      </div>
    </div>
  );
}
