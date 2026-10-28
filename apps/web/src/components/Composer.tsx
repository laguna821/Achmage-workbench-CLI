import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { filterMentions, insertMention, mentionTriggerAt, relocateMentions, type MentionItem, type MentionSpan } from "../mention.ts";
import { FormatBadge } from "./DocCards.tsx";
import { Icon } from "./Icon.tsx";

/** Documents the `@` list offers, and what to do with a picked one (attach it to the request). */
export type ComposerMentions = { items: MentionItem[]; onPick: (item: MentionItem) => void };

const DRAFT_PREFIX = "workbench.draft.";

/**
 * The single input box. Enter sends, Shift+Enter breaks the line, and Enter while a Korean
 * syllable is still being composed never sends. Drafts survive switching work and reloads.
 * While the engine is working, a light trail orbits the box border (CMDS Achmage).
 */
export function Composer({
  draftKey,
  placeholder,
  busy,
  waiting,
  disabled,
  onSend,
  onStop,
  target,
  header,
  autoFocus,
  mentions,
}: {
  draftKey: string;
  placeholder: string;
  busy: boolean;
  waiting?: boolean;
  disabled?: boolean;
  onSend: (text: string) => Promise<boolean>;
  onStop?: () => void;
  target?: ReactNode;
  /** Chips above the text (documents, selection, receiving session). */
  header?: ReactNode;
  autoFocus?: boolean;
  /** `@` mentions of documents (Workbench documents of this work). */
  mentions?: ComposerMentions;
}) {
  const [text, setText] = useState(() => localStorage.getItem(DRAFT_PREFIX + draftKey) ?? "");
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const [spans, setSpans] = useState<MentionSpan[]>([]);
  const [caret, setCaret] = useState(0);
  const [composing, setComposing] = useState(false);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const pendingCaret = useRef<number | null>(null);
  const trigger = mentions ? mentionTriggerAt(text, caret, { spans, composing }) : null;
  const rows = trigger && trigger.start !== dismissed && mentions ? filterMentions(mentions.items, trigger.query).slice(0, 8) : [];
  const listOpen = rows.length > 0;

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

  const canSend = !busy && !disabled && !sending && text.trim().length > 0;

  const submit = async () => {
    if (!canSend) return;
    setSending(true);
    try {
      if (await onSend(text.trim())) {
        setText("");
        setSpans([]);
      }
    } finally {
      setSending(false);
      ref.current?.focus();
    }
  };

  return (
    <div className="composer" data-phase={waiting ? "waiting" : undefined}>
      {header ? <div className="composer-header">{header}</div> : null}
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
        placeholder={mentions ? `${placeholder} (@로 문서 붙이기)` : placeholder}
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.value;
          setSpans(relocateMentions(text, next, spans));
          setText(next);
          setCaret(event.target.selectionStart);
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={(event) => {
          setComposing(false);
          setCaret(event.currentTarget.selectionStart);
        }}
        onKeyDown={(event) => {
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
          void submit();
        }}
      />
      <div className="composer-bar">
        <div className="composer-left" />
        <div className="composer-right">
          {target}
          {busy && onStop ? (
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
