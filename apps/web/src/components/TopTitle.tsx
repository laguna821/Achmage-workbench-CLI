import { useState } from "react";
import { AUTO_NAME_HINT, EditableText } from "./EditableText.tsx";

/**
 * The top bar's name of what is on screen. A button only where pressing it renames what it names
 * (`rename`: the project a conversation, document or project tab belongs to, as the conversation tab
 * always did); elsewhere a plain name (웹, 보관함, the phone page). 0.5.6 round 2: it used to look like a
 * button on every tab and do nothing on most.
 */
export function TopTitle({ kind, title, rename, inert, onEditing }: {
  /** The kind word before the name ("프로젝트", "대화", "문서", "웹"), or null. */
  kind?: string | null;
  title: string;
  rename?: { value: string; label: string; onRename: (next: string) => void };
  /** Faded out under a notice: out of the tab order and not operable until it returns. */
  inert?: boolean;
  /** The field is open (the bar keeps its notices away meanwhile). */
  onEditing?: (editing: boolean) => void;
}) {
  const [editing, setEditingState] = useState(false);
  const setEditing = (next: boolean) => { setEditingState(next); onEditing?.(next); };
  if (editing && rename) {
    return <EditableText className="topbar-title-edit" label={rename.label} value={rename.value} empty={{ hint: AUTO_NAME_HINT }} onSave={rename.onRename} onDone={() => setEditing(false)} />;
  }
  const inner = <>{kind ? <span className="shell-location-kind">{kind}</span> : null}<span>{title}</span></>;
  if (!rename) return <div className="topbar-title static" inert={inert}>{inner}</div>;
  return (
    <button type="button" className="topbar-title" inert={inert} title={`눌러서 ${rename.label} 바꾸기`} onClick={() => setEditing(true)}>
      {inner}
    </button>
  );
}
