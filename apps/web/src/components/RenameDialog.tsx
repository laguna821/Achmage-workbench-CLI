import { useLayoutEffect, useRef, useState } from "react";
import { restoreSurfaceFocus } from "./controls/menu-navigation.ts";

// A new name for something without a row to rename in place (a document's AI conversation).
// `note`: one plain line under the field (a document's: the extension stays, the file is renamed).
export function RenameDialog({ title, value, note, onSave, onClose }: { title: string; value: string; note?: string; onSave(name: string): Promise<void>; onClose(): void }) {
  const [name, setName] = useState(value), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const opener = useRef<Element | null>(typeof document === "undefined" ? null : document.activeElement);
  useLayoutEffect(() => () => restoreSurfaceFocus(opener.current, null), []);
  const save = () => {
    const next = name.trim();
    if (!next || next === value) return onClose();
    setBusy(true); setError("");
    void onSave(next).then(onClose, reason => { setError(reason instanceof Error ? reason.message : String(reason)); setBusy(false); });
  };
  return <div className="modal-backdrop" onMouseDown={event => !busy && event.target === event.currentTarget && onClose()} onKeyDown={event => !busy && event.key === "Escape" && onClose()}>
    <form className="nav-dialog" role="dialog" aria-modal="true" aria-label={title} onSubmit={event => { event.preventDefault(); save(); }}>
      <h2>{title}</h2>
      <input value={name} onChange={event => setName(event.target.value)} aria-label="이름" autoFocus disabled={busy} aria-describedby={note ? "rename-dialog-note" : undefined} />
      {note ? <p id="rename-dialog-note">{note}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <div className="nav-dialog-foot">
        <button type="button" className="button" disabled={busy} onClick={onClose}>취소</button>
        <button type="submit" className="button primary" disabled={busy}>바꾸기</button>
      </div>
    </form>
  </div>;
}
