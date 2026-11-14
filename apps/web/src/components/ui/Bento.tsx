import { Children, isValidElement, type ReactNode } from "react";
import "../../styles/bento.css";

/** One grid cell spanning `span` columns (it falls back to one column where fewer fit). */
export function BentoCell({ span = 1, children, className = "" }: { span?: 1 | 2 | 3; children: ReactNode; className?: string }) {
  return <div role="listitem" className={`ui-bento-cell ${className}`} data-span={span}>{children}</div>;
}

/**
 * The management screens' grid: 8px gutters, cells of one row equally tall, and a column count
 * taken from the container's own width (`@container`), so a 4- or 9-pane cell gets fewer columns
 * than the full window. `max` caps the columns. Each child becomes one cell; wrap a child in
 * `BentoCell` to span. No children: nothing is drawn.
 */
export function Bento({ label, max = 3, children, className = "" }: { label: string; max?: 1 | 2 | 3 | 4; children: ReactNode; className?: string }) {
  const cells = Children.toArray(children).filter(Boolean);
  if (!cells.length) return null;
  return (
    <div className={`ui-bento ${className}`} data-max={max}>
      <div className="ui-bento-grid" role="list" aria-label={label}>
        {cells.map((child, index) => (isValidElement(child) && child.type === BentoCell ? child : <BentoCell key={isValidElement(child) && child.key !== null ? child.key : index}>{child}</BentoCell>))}
      </div>
    </div>
  );
}
