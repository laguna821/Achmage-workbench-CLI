import { useState, type DragEvent, type ReactNode } from "react";
import type { RowStateInfo } from "../../row-state.ts";
import { Icon } from "../Icon.tsx";
import { StateMark } from "../StateMark.tsx";

/**
 * One section of level 2 (대화, 문서, 웹): the fold head with the count after the name (and, folded, the
 * place and the most pressing state), the section's + key, then its rows or its one empty line. ONE
 * markup for every section, so 웹's rows (WebRows, unit B) and the others (ProjectLevel, unit A) cannot
 * drift apart.
 */
export function InsideSection({ id, label, count, folded, here, lead, onFold, addLabel, addMenu, onAdd, empty, children, tools, onFiles }: {
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
  /** More keys of the head, before the + (문서: "문서 불러오기…"). */
  tools?: ReactNode;
  /** Files dropped from the computer onto the section (문서: 불러오기). Row drags inside the app are not files. */
  onFiles?: (files: File[]) => void;
}) {
  const [over, setOver] = useState(false);
  const files = (event: DragEvent) => Boolean(onFiles) && Array.from(event.dataTransfer?.types ?? []).includes("Files");
  const drop = onFiles ? {
    onDragOver: (event: DragEvent) => { if (!files(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setOver(true); },
    onDragLeave: (event: DragEvent) => { if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setOver(false); },
    onDrop: (event: DragEvent) => { if (!files(event)) return; event.preventDefault(); setOver(false); const list = Array.from(event.dataTransfer.files); if (list.length) onFiles!(list); },
  } : {};
  return (
    <section className={`nav-inside-section nav-inside-${id}${over ? " hconv-drop" : ""}`} aria-label={`${label} ${count}`} {...drop}>
      <div className="nav-inside-head">
        <button type="button" className={`nav-fold${here ? " here" : ""}`} aria-expanded={!folded} aria-current={here ? "location" : undefined} title={folded ? `${label} 펼치기` : `${label} 접기`} onClick={onFold}>
          <Icon name={folded ? "chevronRight" : "chevronDown"} size={13} />
          <span>{label}</span>
          <span className="nav-count">{count}</span>
          {folded && lead ? <StateMark state={lead} size={14} /> : null}
        </button>
        {tools}
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
