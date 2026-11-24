import { useEffect, useRef, useState } from "react";

/** "비우면 자동 이름": the hint of a field whose emptied name asks the gateway for the automatic one. */
export const AUTO_NAME_HINT = "비우면 자동 이름";

/**
 * Inline rename: Enter saves (never mid-composition), Esc cancels, blur saves.
 * An emptied field:
 * - `empty`: saves "" and the gateway puts a name back (the automatic one, or `empty.restores`, a
 *   name it brings back — then nothing is saved when the name is that already); `empty.hint` is
 *   the field's placeholder.
 * - `emptyRefused`: the thing has no name to fall back on (a folder): Enter keeps the field open and
 *   says so (its placeholder becomes the line, aria-invalid); blur or Esc leaves the name as it was.
 * - neither: nothing is saved.
 */
export function EditableText({
  value,
  onSave,
  onDone,
  className,
  label,
  empty,
  emptyRefused,
}: {
  label?: string;
  value: string;
  onSave: (next: string) => void;
  onDone: () => void;
  className?: string;
  empty?: { hint: string; restores?: string };
  emptyRefused?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [refused, setRefused] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.select();
  }, []);
  const commit = () => {
    const next = draft.trim();
    if (next ? next !== value : empty !== undefined && value !== empty.restores) onSave(next);
    onDone();
  };
  return (
    <input
      ref={ref}
      className={`inline-edit ${className ?? ""}`}
      aria-label={label}
      aria-invalid={refused || undefined}
      value={draft}
      placeholder={refused ? emptyRefused : empty?.hint}
      autoFocus
      onChange={(event) => { setDraft(event.target.value); setRefused(false); }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Enter") {
          event.preventDefault();
          if (!draft.trim() && emptyRefused && !empty) { setDraft(""); setRefused(true); return; }
          commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          onDone();
        }
      }}
    />
  );
}
