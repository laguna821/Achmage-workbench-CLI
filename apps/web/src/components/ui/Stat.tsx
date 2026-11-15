import { Children, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import "../../styles/bento.css";

export type StatProps = {
  label: ReactNode;
  /** The value (or, while editing, the editor in its place). */
  children: ReactNode;
  /** "attention": the value asks for the person (a status dot before the label; the value stays ink). */
  tone?: "attention";
  /** The value becomes a button (edit it, go where it counts). */
  onActivate?: (event: MouseEvent<HTMLButtonElement>) => void;
  /** What the button does, read after "label: value" (e.g. "바꾸기"). */
  actionLabel?: string;
  /** Right click on the stat (more actions). */
  onContextMenu?: (event: MouseEvent<HTMLDivElement>) => void;
  /** `data-key`, to find a stat by what it shows. */
  dataKey?: string;
  hint?: string;
  /** The value as text, for the button's name when `children` is not plain text. */
  valueText?: string;
};

const plain = (node: ReactNode) => (typeof node === "string" || typeof node === "number" ? String(node) : "");

/** A label over its value, as dashboards show figures. Place it in a StatRow. */
export function Stat({ label, children, tone, onActivate, actionLabel, onContextMenu, dataKey, hint, valueText }: StatProps) {
  const text = valueText ?? plain(children);
  const name = onActivate && text ? `${plain(label)}: ${text}${actionLabel ? ` — ${actionLabel}` : ""}` : undefined;
  return (
    <div className="ui-stat" data-tone={tone} data-key={dataKey} title={hint} onContextMenu={onContextMenu}>
      <dt className="ui-stat-label">{tone ? <span className={`dot dot-${tone}`} aria-hidden /> : null}{label}</dt>
      <dd className="ui-stat-value">
        {onActivate ? <button type="button" className="ui-stat-button" aria-label={name} onClick={onActivate}>{children}</button> : children}
      </dd>
    </div>
  );
}

/** Columns for `count` stats at most `max` a row: as few rows as fit, spread evenly (9 → 5 + 4, never 8 + 1). */
export const statColumns = (count: number, max: number) => {
  const rows = Math.max(1, Math.ceil(count / max));
  return Math.max(1, Math.ceil(count / rows));
};

/**
 * Stats on equal columns, hairlines between them: up to 8 a row where the container is wide, else
 * up to 4 (bento.css picks by the container's width), rows filled evenly. `after` (a kept draft, a
 * line about the stats) follows the grid inside the same group, without taking a cell.
 */
export function StatRow({ label, children, after, className = "" }: { label: string; children: ReactNode; after?: ReactNode; className?: string }) {
  const count = Children.toArray(children).filter(Boolean).length;
  const style = { "--stat-cols-wide": String(statColumns(count, 8)), "--stat-cols": String(statColumns(count, 4)) } as CSSProperties;
  return (
    <div className={`ui-stat-row ${className}`} role="group" aria-label={label} style={style}>
      <dl className="ui-stat-track">{children}</dl>
      {after}
    </div>
  );
}
