import type { ReactNode } from "react";
import "../../styles/bento.css";

export type CardProps = {
  /** First line: status dots, kind or format badges, small tags. */
  tags?: ReactNode;
  title: ReactNode;
  /** Up to two lines; the rest is cut with an ellipsis. */
  description?: ReactNode;
  /** Sub-items between the description and the footer (a short list, a progress line). */
  children?: ReactNode;
  /** Footer, left: who (an engine mark, a person) or what (a format). */
  footStart?: ReactNode;
  /** Footer, right: a time or a count. */
  footEnd?: ReactNode;
  /** Where the card leads; the whole card is then one button. */
  onOpen?: () => void;
  /** Accessible name of that button (default: its text). */
  label?: string;
  /** Tooltip. */
  hint?: string;
  className?: string;
};

/**
 * A card with one fixed anatomy, so the eye finds the same thing in the same place on every card:
 * tag line → title → two-line description → (sub-items) → hairline → footer (start | end).
 * Parts not given are left out. A card that leads somewhere is a single button (nothing
 * interactive inside it); otherwise it is an article.
 */
export function Card({ tags, title, description, children, footStart, footEnd, onOpen, label, hint, className = "" }: CardProps) {
  const body = (
    <>
      {tags ? <span className="ui-card-tags">{tags}</span> : null}
      <span className="ui-card-title">{title}</span>
      {description ? <span className="ui-card-text">{description}</span> : null}
      {children ? <span className="ui-card-more">{children}</span> : null}
      {footStart || footEnd ? (
        <span className="ui-card-foot">
          {footStart ? <span className="ui-card-foot-start">{footStart}</span> : <span />}
          {footEnd ? <span className="ui-card-foot-end">{footEnd}</span> : null}
        </span>
      ) : null}
    </>
  );
  if (onOpen) {
    return <button type="button" className={`ui-card ${className}`} aria-label={label} title={hint} onClick={onOpen}>{body}</button>;
  }
  return <article className={`ui-card ${className}`} aria-label={label} title={hint}>{body}</article>;
}
