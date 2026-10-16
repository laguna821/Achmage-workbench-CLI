import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon.tsx";

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
}) {
  const [text, setText] = useState(() => localStorage.getItem(DRAFT_PREFIX + draftKey) ?? "");
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

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
      if (await onSend(text.trim())) setText("");
    } finally {
      setSending(false);
      ref.current?.focus();
    }
  };

  return (
    <div className="composer" data-phase={waiting ? "waiting" : undefined}>
      {header ? <div className="composer-header">{header}</div> : null}
      <textarea
        ref={ref}
        className="composer-input"
        rows={1}
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
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
