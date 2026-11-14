import type { ReactNode } from "react";
import { Icon, type IconName } from "../Icon.tsx";

/**
 * A note's title line, the same for every note (conversation, project): its kind icon, the title
 * (or, while it is renamed, the field in its place) and the note's tools at the end.
 */
export function NoteTitle({ icon, title, hint, onDoubleClick, editor, tools, hook }: {
  icon: IconName;
  /** An extra class the checks find this kind's title by (no style of its own). */
  hook?: string;
  title: string;
  hint?: string;
  onDoubleClick?: () => void;
  /** The rename field, shown instead of the title. */
  editor?: ReactNode;
  tools?: ReactNode;
}) {
  return (
    <div className="note-head-title">
      <Icon name={icon} size={20} className="note-kind" />
      {editor ?? <h1 className={hook ? `note-title ${hook}` : "note-title"} title={hint ?? title} onDoubleClick={onDoubleClick}>{title}</h1>}
      {tools ? <div className="note-head-tools">{tools}</div> : null}
    </div>
  );
}
