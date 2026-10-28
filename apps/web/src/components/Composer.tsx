import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { filterMentions, insertMention, mentionTriggerAt, relocateMentions, type MentionItem, type MentionSpan } from "../mention.ts";
import { pastedFiles } from "./Attachments.tsx";
import { showsNothing } from "./docs/image-paste.ts";
import { SlashList, rankCommands, slashQuery, type ComposerSlash } from "./SlashList.tsx";
import { FormatBadge } from "./DocCards.tsx";
import { Icon } from "./Icon.tsx";

/** Documents the `@` list offers, and what to do with a picked one (attach it to the request). */
export type ComposerMentions = { items: MentionItem[]; onPick: (item: MentionItem) => void };

const DRAFT_PREFIX = "workbench.draft.";
const DRAFT_EVENT = "workbench:draft";

/** Put text in an input box's draft (by its draft key), shown now if that box is on screen. */
export function writeDraft(draftKey: string, text: string) {
  localStorage.setItem(DRAFT_PREFIX + draftKey, text);
  window.dispatchEvent(new CustomEvent(DRAFT_EVENT, { detail: draftKey }));
}

/**
 * The single input box. Enter sends, Shift+Enter breaks the line, and Enter while a Korean
 * syllable is still being composed never sends. Drafts survive switching work and reloads.
 * While the engine is working, a light trail orbits the box border (CMDS Achmage), and the box
 * keeps taking requests: Enter steers into the running turn ("끼어들기"), Alt+Enter keeps the
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
}: {
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
}) {
  const [text, setText] = useState(() => localStorage.getItem(DRAFT_PREFIX + draftKey) ?? "");
  const [sending, setSending] = useState(false);
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

  useEffect(() => {
    setText(localStorage.getItem(DRAFT_PREFIX + draftKey) ?? "");
  }, [draftKey]);

  // A draft written for this box from elsewhere ("이 요청 전으로" puts the request back), whether
  // the box shows that draft already or switches to it after.
  useEffect(() => {
    const onDraft = (event: Event) => {
      if ((event as CustomEvent<string>).detail === draftKey) setText(localStorage.getItem(DRAFT_PREFIX + draftKey) ?? "");
    };
    window.addEventListener(DRAFT_EVENT, onDraft);
    return () => window.removeEventListener(DRAFT_EVENT, onDraft);
  }, [draftKey]);

  useEffect(() => {
    if (text) localStorage.setItem(DRAFT_PREFIX + draftKey, text);
    else localStorage.removeItem(DRAFT_PREFIX + draftKey);
  }, [draftKey, text]);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 280)}px`;
  }, [text]);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus, draftKey]);

  const canSend = !disabled && !sending && (text.trim().length > 0 || attachments > 0);

  const submit = async (mode: "auto" | "queue" = "auto") => {
    if (!canSend) return;
    setSending(true);
    try {
      if (await onSend(text.trim(), busy && !steerable ? "queue" : mode)) {
        setText("");
        setSpans([]);
      }
    } finally {
      setSending(false);
      ref.current?.focus();
    }
  };

  return (
    <div
      className="composer"
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
          <div className="menu-label">문서 붙이기 · 지금 판으로 고정</div>
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
        rows={1}
        value={text}
        placeholder={
          busy
            ? steerable
              ? "작업 중에도 보낼 수 있어요 · Enter 끼어들기 · Alt+Enter 끝나면 보내기"
              : "끝나면 이어서 보낼 요청 · Enter로 예약"
            : mentions
              ? `${placeholder} (@로 문서 붙이기)`
              : placeholder
        }
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.value;
          setSpans(relocateMentions(text, next, spans));
          setText(next);
          setCaret(event.target.selectionStart);
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
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
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={(event) => {
          setComposing(false);
          setCaret(event.currentTarget.selectionStart);
        }}
        onKeyDown={(event) => {
          if (slashOpen && !event.nativeEvent.isComposing && event.keyCode !== 229) {
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
          if (listOpen && !event.nativeEvent.isComposing && event.keyCode !== 229) {
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
          if (event.key !== "Enter" || event.shiftKey) return;
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          event.preventDefault();
          void submit(busy && event.altKey ? "queue" : "auto");
        }}
      />
      <div className="composer-bar">
        <div className="composer-left">{left}</div>
        <div className="composer-right">
          {target}
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
    </div>
  );
}
