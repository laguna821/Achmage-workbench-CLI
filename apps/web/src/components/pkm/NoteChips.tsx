import { Icon } from "../Icon.tsx";
import { useOptionalPkm } from "./PkmContext.tsx";
import "../../styles/pkm.css";

/** Vault notes on a request: read-only references; a click opens the note in the mirror. */
export function NoteChips({ notes, onRemove }: { notes: { path: string; title: string }[]; onRemove?: (path: string) => void }) {
  const pkm = useOptionalPkm();
  if (!notes.length) return null;
  return (
    <div className="ref-chips note-chips">
      {notes.map((note) => (
        <span key={note.path} className="ref-chip note-chip" title={`볼트 노트 · 읽기 전용 · ${note.path}`}>
          <button type="button" className="note-chip-open" onClick={() => pkm?.open?.({ kind: "note", path: note.path })} disabled={!pkm?.open}>
            <Icon name="book" size={12} /> {note.title}
          </button>
          <span className="note-chip-role">읽기</span>
          {onRemove ? (
            <button type="button" onClick={() => onRemove(note.path)} aria-label="노트 빼기">
              <Icon name="x" size={11} />
            </button>
          ) : null}
        </span>
      ))}
    </div>
  );
}
