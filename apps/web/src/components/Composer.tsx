import type { Provider } from "@workbench/contracts";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { filterMentions, insertMention, mentionTriggerAt, relocateMentions, type MentionItem, type MentionSpan } from "../mention.ts";
import { pastedFiles } from "./Attachments.tsx";
import { showsNothing } from "./docs/image-paste.ts";
import { SlashList, rankCommands, slashQuery, type ComposerSlash } from "./SlashList.tsx";
import { FormatBadge } from "./DocCards.tsx";
import { Icon } from "./Icon.tsx";
import { DRAFT_EVENT, persistDraft, readDraft, readDraftSelection, saveDraftSelection } from "../draft.ts";
import { isImeComposingKeyboardEvent } from "../../../../vendor/paseo/mobile-web/keyboard-ime.ts";
import { resolveMessageInputEnterAction } from "../../../../vendor/paseo/mobile-web/enter-action.ts";
import { compactInput } from "../mobile-layout.ts";
import { pickedFiles } from "../mobile-platform.ts";
import { MenuItem, Popover } from "./Popover.tsx";
import { VoiceInput } from "./VoiceInput.tsx";
import { appendVoiceTranscript, type VoiceScope } from "../voice/capture.ts";

export { writeDraft } from "../draft.ts";

/** Documents the `@` list offers, and what to do with a picked one (attach it to the request). */
export type ComposerMentions = { items: MentionItem[]; onPick: (item: MentionItem) => void };

/**
 * The single input box. Enter sends, Shift+Enter breaks the line, and Enter while a Korean
 * syllable is still being composed never sends. Drafts survive switching work and reloads.
 * The input keeps taking requests while the engine works: Enter steers into the running turn ("끼어들기"), Alt+Enter keeps the
 * request for when the turn ends ("끝나면 보내기").
 */
export function Composer({
  draftKey,
  placeholder,
  busy,
  waiting,
  disabled,
  steerable,
  onSend,
  onStop,
  target,
  header,
  autoFocus,
  mentions,
  left,
  onFiles,
  onDesktopPicture,
  attachments = 0,
  slash,
  voiceScope,
  voiceReply,
  tools,
  provider,
}: {
  /** The engine this input sends to: drawn as the line above it, so it must match the engine chip inside. */
  provider?: Provider;
  draftKey: string;
  placeholder: string;
  busy: boolean;
  waiting?: boolean;
  disabled?: boolean;
  /** While busy: the engine can take a request into the running turn (otherwise requests wait). */
  steerable?: boolean;
  onSend: (text: string, mode?: "auto" | "queue") => Promise<boolean>;
  onStop?: () => void;
  target?: ReactNode;
  /** Chips above the text (documents, selection, receiving session). */
  header?: ReactNode;
  autoFocus?: boolean;
  /** `@` mentions of documents (Workbench documents of this work). */
  mentions?: ComposerMentions;
  /** Controls at the left of the bar (access, context). */
  left?: ReactNode;
  /** Files pasted (Ctrl+V) or dropped on the box, to go with the next request. */
  onFiles?: (files: File[]) => void;
  /**
   * The desktop clipboard's picture, asked for when a paste shows the page nothing (WebKitGTK, the
   * desktop app's view, keeps picture data from pages: a pasted screenshot arrives empty).
   */
  onDesktopPicture?: () => Promise<File | null>;
  /** Files already with the request: it can go without text. */
  attachments?: number;
  /** "/" at the start: the engine's commands and skills. */
  slash?: ComposerSlash;
  voiceScope?: VoiceScope;
  voiceReply?: string;
  /** Optional request tools, disclosed together without crowding the main controls. */
  tools?: ReactNode;
}) {
  const [compactControls, setCompactControls] = useState(() => window.matchMedia?.("(max-width: 743px)").matches ?? false);
  useEffect(() => {
    const query = window.matchMedia?.("(max-width: 743px)");
    if (!query) return;
    const update = () => setCompactControls(query.matches);
    update(); query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);
  const [draft, setDraft] = useState(() => ({ key: draftKey, text: readDraft(draftKey) }));
  const text = draft.key === draftKey ? draft.text : readDraft(draftKey);
  const composingRef = useRef(false);
  const [draftProblem, setDraftProblem] = useState(false);
  const currentDraft = useRef({ key: draftKey, text });
  if (!composingRef.current || currentDraft.current.key !== draftKey) currentDraft.current = { key: draftKey, text };
  const setText = (next: string) => {
    currentDraft.current = { key: draftKey, text: next };
    if (ref.current && !composingRef.current && ref.current.value !== next) ref.current.value = next;
    setDraft({ key: draftKey, text: next });
    setDraftProblem(!persistDraft(draftKey, next));
  };
  const [sending, setSending] = useState(false);
  const [voiceEpoch, setVoiceEpoch] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const [spans, setSpans] = useState<MentionSpan[]>([]);
  const [caret, setCaret] = useState(0);
  const [composing, setComposing] = useState(false);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [dropping, setDropping] = useState(false);
  const pendingCaret = useRef<number | null>(null);
  const trigger = mentions ? mentionTriggerAt(text, caret, { spans, composing }) : null;
  const rows = trigger && trigger.start !== dismissed && mentions ? filterMentions(mentions.items, trigger.query).slice(0, 8) : [];
  // "/" at the start of the request: commands and skills (asked for when first needed).
  const [slashDismissed, setSlashDismissed] = useState<string | null>(null);
  const typed = slash && !composing ? slashQuery(text, caret) : null;
  const slashOpen = typed !== null && slashDismissed !== text.slice(0, caret);
  const slashRows = slashOpen && slash?.items ? rankCommands(slash.items, typed) : [];
  const wantsCommands = slashOpen && slash?.items === null;
  useEffect(() => {
    if (wantsCommands) slash?.onOpen();
  }, [wantsCommands]);
  const listOpen = !slashOpen && rows.length > 0;
  const pickCommand = (name: string) => {
    const inserted = `/${name} `;
    pendingCaret.current = inserted.length;
    setText(inserted + text.slice(caret));
    setActive(0);
  };

  useLayoutEffect(() => {
    if (pendingCaret.current === null || !ref.current) return;
    ref.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
    setCaret(pendingCaret.current);
    pendingCaret.current = null;
  }, [text]);

  const pick = (item: MentionItem) => {
    if (!trigger || !mentions) return;
    const inserted = insertMention(text, trigger, item.name);
    setSpans([...relocateMentions(text, inserted.value, spans), inserted.span]);
    pendingCaret.current = inserted.caret;
    setText(inserted.value);
    setActive(0);
    mentions.onPick(item);
  };

  useLayoutEffect(() => {
    const element = ref.current;
    const saved = readDraft(draftKey);
    composingRef.current = false;
    setText(saved);
    setSpans([]);
    const selection = readDraftSelection(draftKey, saved);
    if (element) {
      element.value = saved;
      element.setSelectionRange(selection?.start ?? saved.length, selection?.end ?? saved.length);
      element.scrollTop = selection?.scrollTop ?? 0;
    }
    setCaret(selection?.start ?? saved.length);
    setComposing(false);
    setDismissed(null);
    setSlashDismissed(null);
    pendingCaret.current = null;
    return () => {
      if (!element) return;
      persistDraft(draftKey, element.value);
      saveDraftSelection(draftKey, { text: element.value, start: element.selectionStart, end: element.selectionEnd, scrollTop: element.scrollTop });
    };
  }, [draftKey]);

  // Like Paseo's web input, the DOM owns an active IME composition. Only settled text or an
  // explicit external draft replacement writes back to the textarea.
  useLayoutEffect(() => {
    if (ref.current && !composingRef.current && ref.current.value !== text) ref.current.value = text;
  }, [text, draftKey]);

  // A draft written for this box from elsewhere ("이 요청 전으로" puts the request back), whether
  // the box shows that draft already or switches to it after.
  useEffect(() => {
    const onDraft = (event: Event) => {
      if ((event as CustomEvent<string>).detail === draftKey && !composingRef.current) setText(readDraft(draftKey));
    };
    window.addEventListener(DRAFT_EVENT, onDraft);
    return () => window.removeEventListener(DRAFT_EVENT, onDraft);
  }, [draftKey]);

  useEffect(() => {
    const flush = () => {
      const element = ref.current;
      if (!element || currentDraft.current.key !== draftKey) return;
      persistDraft(draftKey, element.value);
      saveDraftSelection(draftKey, { text: element.value, start: element.selectionStart, end: element.selectionEnd, scrollTop: element.scrollTop });
    };
    const visibility = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", visibility);
    return () => { window.removeEventListener("pagehide", flush); document.removeEventListener("visibilitychange", visibility); };
  }, [draftKey]);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const fit = () => {
      element.style.height = "auto";
      element.style.height = `${Math.min(element.scrollHeight, 280)}px`;
    };
    let width = element.getBoundingClientRect().width;
    fit();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
      const next = element.getBoundingClientRect().width;
      if (next === width) return;
      width = next;
      fit();
    });
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [text]);

  useEffect(() => {
    if (autoFocus && !compactInput()) ref.current?.focus({ preventScroll: true });
  }, [autoFocus, draftKey]);

  const canSend = !disabled && !sending && !composing && (text.trim().length > 0 || attachments > 0);

  const submit = async (mode: "auto" | "queue" = "auto") => {
    if (!canSend || composingRef.current) return;
    const submitted = { key: draftKey, text };
    setVoiceEpoch(current => current + 1);
    setSending(true);
    try {
      if (await onSend(text.trim(), busy && !steerable ? "queue" : mode)) {
        // A late send receipt belongs to the submitted draft, never the tab opened meanwhile.
        if (currentDraft.current.key === submitted.key && currentDraft.current.text === submitted.text) {
          setText("");
          setSpans([]);
        } else if (currentDraft.current.key !== submitted.key && readDraft(submitted.key) === submitted.text) {
          persistDraft(submitted.key, "");
        }
      }
    } finally {
      setSending(false);
      if (currentDraft.current.key === submitted.key && !compactInput()) ref.current?.focus({ preventScroll: true });
    }
  };

  return (
    <div
      className="composer hig-composer"
      aria-label="메시지 작성"
      data-provider={provider}
      data-phase={waiting ? "waiting" : undefined}
      data-drop={dropping ? "" : undefined}
      onDragOver={(event) => {
        if (!onFiles || disabled || !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDropping(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={(event) => {
        setDropping(false);
        if (!onFiles || disabled || !event.dataTransfer.files.length) return;
        event.preventDefault();
        onFiles(Array.from(event.dataTransfer.files));
        ref.current?.focus();
      }}
    >
      {dropping ? <div className="composer-drop">놓으면 요청에 붙입니다</div> : null}
      {header ? <div className="composer-header">{header}</div> : null}
      {slashOpen ? <SlashList rows={slashRows} loading={slash?.items === null} active={Math.min(active, Math.max(0, slashRows.length - 1))} onPick={(item) => pickCommand(item.name)} /> : null}
      {listOpen ? (
        <div className="mention-list" role="listbox" aria-label="문서 멘션">
          <div className="menu-label">문서 붙이기 · 보내기 전에 저장 확인</div>
          {rows.map((item, index) => (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={index === Math.min(active, rows.length - 1)}
              className={`mention-row${index === Math.min(active, rows.length - 1) ? " active" : ""}`}
              onMouseDown={(event) => {
                event.preventDefault();
                pick(item);
              }}
            >
              <FormatBadge format={item.format} />
              <span className="mention-name">{item.name}</span>
              <span className="mention-hint">{item.hint ?? (item.group === "open" ? "열린 문서" : "")}</span>
            </button>
          ))}
        </div>
      ) : null}
      <textarea
        ref={ref}
        className="composer-input"
        aria-label="요청 입력"
        rows={1}
        defaultValue={text}
        enterKeyHint={compactInput() ? "enter" : "send"}
        placeholder={
          busy && !compactInput()
            ? steerable
              ? "작업 중에도 요청을 이어 쓰세요"
              : "끝나면 보낼 요청을 쓰세요"
            : mentions
              ? `${placeholder} (@로 문서 붙이기)`
              : placeholder
        }
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.value;
          if (composingRef.current) {
            currentDraft.current = { key: draftKey, text: next };
            setDraftProblem(!persistDraft(draftKey, next));
            return;
          }
          setSpans(relocateMentions(text, next, spans));
          setText(next);
          setCaret(event.target.selectionStart);
        }}
        onSelect={(event) => {
          const element = event.currentTarget;
          setCaret(element.selectionStart);
          saveDraftSelection(draftKey, { text: element.value, start: element.selectionStart, end: element.selectionEnd, scrollTop: element.scrollTop });
        }}
        onPaste={(event) => {
          if (!onFiles) return;
          const files = pastedFiles(event.clipboardData);
          if (files.length) {
            event.preventDefault();
            onFiles(files);
          } else if (onDesktopPicture && showsNothing(event.clipboardData)) {
            event.preventDefault();
            void onDesktopPicture()
              .then((file) => file && onFiles([file]))
              .catch(() => undefined);
          }
        }}
        onCompositionStart={() => { composingRef.current = true; setComposing(true); }}
        onCompositionEnd={(event) => {
          composingRef.current = false;
          const next = event.currentTarget.value;
          setSpans(relocateMentions(text, next, spans));
          setText(next);
          setComposing(false);
          setCaret(event.currentTarget.selectionStart);
        }}
        onKeyDown={(event) => {
          if (composingRef.current || isImeComposingKeyboardEvent(event.nativeEvent)) return;
          if (slashOpen) {
            if ((event.key === "ArrowDown" || event.key === "ArrowUp") && slashRows.length) {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              setActive((current) => (Math.min(current, slashRows.length - 1) + step + slashRows.length) % slashRows.length);
              return;
            }
            if ((event.key === "Enter" || event.key === "Tab") && slashRows.length && !event.shiftKey) {
              event.preventDefault();
              pickCommand(slashRows[Math.min(active, slashRows.length - 1)]!.name);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setSlashDismissed(text.slice(0, caret));
              return;
            }
          }
          if (listOpen) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              setActive((current) => (Math.min(current, rows.length - 1) + step + rows.length) % rows.length);
              return;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              event.preventDefault();
              pick(rows[Math.min(active, rows.length - 1)]);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setDismissed(trigger?.start ?? null);
              return;
            }
          }
          if (event.key !== "Enter") return;
          const action = resolveMessageInputEnterAction({
            submitOnEnter: !compactInput(), sendShortcut: "enter", shiftKey: event.shiftKey,
            metaKey: event.metaKey, ctrlKey: event.ctrlKey, isAgentRunning: busy,
            onQueue: steerable ? () => undefined : undefined,
          });
          if (action === null) return;
          event.preventDefault();
          void submit(busy && (event.altKey || action === "alternate-send") ? "queue" : "auto");
        }}
      />
      {draftProblem ? <p className="composer-file-problem" role="status">이 브라우저에 초안을 저장하지 못했습니다. 창을 닫기 전에 복사해 주세요.</p> : null}
      <div className="composer-bar">
        <div className="composer-left">
          {onFiles ? <AttachmentPicker draftKey={draftKey} disabled={disabled || sending} onFiles={onFiles} /> : null}
          {!compactControls ? left : null}
          {voiceScope ? <VoiceInput key={draftKey} draftId={draftKey} scope={voiceScope} resetVersion={voiceEpoch} reply={voiceReply} disabled={disabled || sending || composing} onApply={(captureDraft, transcript) => {
        const next = appendVoiceTranscript(currentDraft.current, captureDraft, transcript);
        if (next === null || disabled || sending || composing) return false;
        setSpans(relocateMentions(currentDraft.current.text, next, spans)); setText(next); setCaret(next.length); pendingCaret.current = next.length;
        ref.current?.focus({ preventScroll: true }); return true;
      }} /> : null}
          {tools || compactControls && (left || target) ? <details className="composer-tools" onKeyDown={event => {
            if (event.key !== "Escape" || event.defaultPrevented) return;
            event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus();
          }}>
            <summary title="계획, 그림, 브라우저와 문서 도구"><Icon name="tool" size={15} /><span>도구</span><Icon name="chevronDown" size={13} /></summary>
            <div className="composer-tools-panel"><span className="composer-tools-label">다음 요청 설정</span><div className="composer-tools-controls">{compactControls ? <>{left}{target}</> : null}{tools}</div></div>
          </details> : null}
        </div>
        <div className="composer-right">
          {!compactControls ? target : null}
          {busy && (text.trim() || attachments > 0) ? (
            <>
              {steerable ? (
                <button type="button" className="ghost-button small queue-button" onClick={() => void submit("queue")} disabled={!canSend} title="작업이 끝나면 이어서 보내기 (Alt+Enter)">
                  끝나면 보내기
                </button>
              ) : null}
              <button
                type="button"
                className="icon-button primary steer-button"
                onClick={() => void submit(steerable ? "auto" : "queue")}
                disabled={!canSend}
                title={steerable ? "끼어들기: 하던 작업에 지금 전하기 (Enter)" : "끝나면 보내기 (Enter)"}
                aria-label={steerable ? "끼어들기" : "끝나면 보내기"}
              >
                <Icon name={steerable ? "send" : "bell"} size={18} />
              </button>
              {onStop ? (
                <button type="button" className="icon-button stop-secondary" onClick={onStop} title="중단" aria-label="중단">
                  <Icon name="stop" size={16} />
                </button>
              ) : null}
            </>
          ) : busy && onStop ? (
            <button type="button" className="icon-button primary" onClick={onStop} title="중단" aria-label="중단">
              <Icon name="stop" size={18} />
            </button>
          ) : (
            <button type="button" className="icon-button primary" onClick={() => void submit()} disabled={!canSend} title="보내기 (Enter)" aria-label="보내기">
              <Icon name="send" size={18} />
            </button>
          )}
        </div>
      </div>
      {busy ? <div className="composer-status" role="status"><span className="spinner small" aria-hidden />{waiting ? "응답 중" : "작업 중"}<span>{steerable ? "Enter로 지금 전하기 · Alt+Enter로 끝나면 보내기" : "새 요청은 차례대로 보냅니다"}</span></div> : null}
    </div>
  );
}

function AttachmentPicker({ draftKey, disabled, onFiles }: { draftKey: string; disabled?: boolean; onFiles(files: File[]): void }) {
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const photos = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const chosenFor = useRef<string | null>(null);
  const currentKey = useRef(draftKey);
  currentKey.current = draftKey;
  useEffect(() => { setOpen(false); setProblem(null); }, [draftKey]);
  const choose = (element: HTMLInputElement | null) => {
    chosenFor.current = draftKey;
    setOpen(false); setProblem(null);
    element?.click();
  };
  const selected = (element: HTMLInputElement) => {
    const files = element.files ? pickedFiles(element.files) : [];
    element.value = "";
    if (!files.length) return;
    if (disabled) { setProblem("입력이 가능해지면 파일을 다시 선택해 주세요."); return; }
    if (chosenFor.current !== currentKey.current) {
      setProblem("파일을 고르는 동안 대화가 바뀌었습니다. 이 대화에서 다시 선택해 주세요.");
      return;
    }
    onFiles(files);
  };
  return <span className="composer-file-picker">
    <button type="button" className="select-button" disabled={disabled} aria-label="사진 또는 파일 첨부" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(value => !value)}>
      <Icon name="file" size={15} /> 첨부
    </button>
    <Popover open={open} onClose={() => setOpen(false)} placement="above" role="menu" label="사진 또는 파일 첨부">
      <MenuItem onSelect={() => choose(photos.current)}>사진 보관함에서 선택</MenuItem>
      <MenuItem onSelect={() => choose(camera.current)}>사진 촬영</MenuItem>
      <MenuItem onSelect={() => choose(input.current)}>파일 선택</MenuItem>
      <p className="menu-label">파일마다 최대 25MB · 선택한 대화에만 첨부</p>
    </Popover>
    <input ref={input} type="file" multiple hidden tabIndex={-1} onChange={event => selected(event.currentTarget)} />
    <input ref={photos} type="file" accept="image/*" multiple hidden tabIndex={-1} onChange={event => selected(event.currentTarget)} />
    <input ref={camera} type="file" accept="image/*" capture="environment" hidden tabIndex={-1} onChange={event => selected(event.currentTarget)} />
    {problem ? <span className="composer-file-problem" role="alert">{problem}</span> : null}
  </span>;
}
