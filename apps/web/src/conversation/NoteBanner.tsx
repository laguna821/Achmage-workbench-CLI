import type { ReactNode } from "react";

/**
 * One line in a note: why it is as it is, and its way out as a button when there is one. The same
 * line for an archived conversation, an AI whose document was removed and an imported record.
 */
export function NoteBanner({ children, action, tail, label }: { children: ReactNode; action?: { label: string; run: () => void; disabled?: boolean }; tail?: ReactNode; label?: string }) {
  return (
    <div className="note-banner" role="status" aria-label={label}>
      <span className="dot" aria-hidden />
      <span className="note-banner-text">{children}</span>
      {tail}
      {action ? <button type="button" className="button small" disabled={action.disabled} onClick={action.run}>{action.label}</button> : null}
    </div>
  );
}
