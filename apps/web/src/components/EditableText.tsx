import { useEffect, useRef, useState } from "react";

/** Inline rename: Enter saves (never mid-composition), Esc cancels, blur saves. */
export function EditableText({
  value,
  onSave,
  onDone,
  className,
}: {
  value: string;
  onSave: (next: string) => void;
  onDone: () => void;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.select();
  }, []);
  const commit = () => {
    const next = draft.trim();
    if (next && next !== value) onSave(next);
    onDone();
  };
  return (
    <input
      ref={ref}
      className={`inline-edit ${className ?? ""}`}
      value={draft}
      autoFocus
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          onDone();
        }
      }}
    />
  );
}
