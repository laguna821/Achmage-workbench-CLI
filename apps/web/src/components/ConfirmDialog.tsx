import { useState } from "react";

// One question before a step that cannot be taken back or that stops work: Esc or 취소 leaves
// everything as it was; the action's failure stays in the dialog.

export function ConfirmDialog({ title, lines, confirmLabel, busyLabel, tone = "danger", onConfirm, onClose, alternative }: {
  title: string;
  /** "primary" for a step that keeps things (저장하고 계속); "danger" for one that removes. */
  tone?: "danger" | "primary";
  lines: string[];
  confirmLabel: string;
  busyLabel?: string;
  onConfirm(): Promise<unknown>;
  onClose(): void;
  /** A second way through (e.g. 저장하지 않고 옮기기), between 취소 and the main action. */
  alternative?: { label: string; busyLabel?: string; run(): Promise<unknown> };
}) {
  const [busy, setBusy] = useState<"confirm" | "alternative" | false>(false), [error, setError] = useState("");
  const start = (which: "confirm" | "alternative", action: () => Promise<unknown>) => {
    setBusy(which); setError("");
    void action().then(onClose, reason => { setError(reason instanceof Error ? reason.message : String(reason)); setBusy(false); });
  };
  return <div className="modal-backdrop" onMouseDown={event => !busy && event.target === event.currentTarget && onClose()} onKeyDown={event => !busy && event.key === "Escape" && onClose()}>
    <div className="nav-dialog" role="dialog" aria-modal="true" aria-label={title}>
      <h2>{title}</h2>
      {lines.map(line => <p key={line} style={{ overflowWrap: "anywhere" }}>{line}</p>)}
      {error ? <p role="alert">{error}</p> : null}
      <div className="nav-dialog-foot">
        <button type="button" className="button" disabled={Boolean(busy)} onClick={onClose} autoFocus>취소</button>
        {alternative ? <button type="button" className="button" disabled={Boolean(busy)} onClick={() => start("alternative", alternative.run)}>{busy === "alternative" ? alternative.busyLabel ?? `${alternative.label} 중…` : alternative.label}</button> : null}
        <button type="button" className={`button ${tone}`} disabled={Boolean(busy)} onClick={() => start("confirm", onConfirm)}>{busy === "confirm" ? busyLabel ?? `${confirmLabel} 중…` : confirmLabel}</button>
      </div>
    </div>
  </div>;
}
