import type { ReactNode } from "react";
import type { RowStateInfo } from "../../row-state.ts";
import { Icon } from "../Icon.tsx";
import { StateMark } from "../StateMark.tsx";

/**
 * One section of level 2 (대화, 문서, 웹): the fold head with the count after the name (and, folded, the
 * place and the most pressing state), the section's + key, then its rows or its one empty line. ONE
 * markup for every section, so 웹's rows (WebRows, unit B) and the others (ProjectLevel, unit A) cannot
 * drift apart.
 */
export function InsideSection({ id, label, count, folded, here, lead, onFold, addLabel, addMenu, onAdd, empty, children }: {
  id: string;
  label: string;
  count: number;
  folded: boolean;
  /** Folded, and the item on screen is in it. */
  here: boolean;
  /** Folded: the most pressing state inside (not 완료/예약). */
  lead: RowStateInfo | null;
  onFold: () => void;
  addLabel: string;
  /** The + key opens a menu (문서's kinds) rather than acting at once. */
  addMenu?: boolean;
  onAdd: (anchor: HTMLButtonElement) => void;
  /** The line shown when no row is shown (null: nothing). */
  empty: string | null;
  /** The shown rows (nothing when none). */
  children?: ReactNode;
}) {
  return (
    <section className={`nav-inside-section nav-inside-${id}`} aria-label={`${label} ${count}`}>
      <div className="nav-inside-head">
        <button type="button" className={`nav-fold${here ? " here" : ""}`} aria-expanded={!folded} aria-current={here ? "location" : undefined} title={folded ? `${label} 펼치기` : `${label} 접기`} onClick={onFold}>
          <Icon name={folded ? "chevronRight" : "chevronDown"} size={13} />
          <span>{label}</span>
          <span className="nav-count">{count}</span>
          {folded && lead ? <StateMark state={lead} size={14} /> : null}
        </button>
        <button type="button" className="icon-button small nav-inside-add" aria-label={addLabel} title={addLabel} aria-haspopup={addMenu ? "menu" : undefined} onClick={(event) => onAdd(event.currentTarget)}>
          <Icon name="plus" size={14} />
        </button>
      </div>
      {folded ? null : children ? (
        <div role="group" aria-label={label}>{children}</div>
      ) : (
        <div className="nav-inside-empty">{empty}</div>
      )}
    </section>
  );
}
