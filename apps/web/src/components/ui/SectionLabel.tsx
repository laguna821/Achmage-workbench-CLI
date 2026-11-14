import { useCallback, useState, type ReactNode } from "react";
import { Icon, type IconName } from "../Icon.tsx";
import "../../styles/bento.css";

export type SectionLabelProps = {
  children: ReactNode;
  count?: number;
  icon?: IconName;
  /** With `onToggle`: the label is a button that folds the section. */
  collapsed?: boolean;
  onToggle?: () => void;
  /** The id of what folds (aria-controls). */
  controls?: string;
  /** Controls at the end of the line (outside the heading): "+ 결정", "모두 보기". */
  action?: ReactNode;
  level?: 2 | 3;
  className?: string;
};

/** A group label: 12px, 600, muted, with an optional count, fold arrow and trailing action. */
export function SectionLabel({ children, count, icon, collapsed, onToggle, controls, action, level = 2, className = "" }: SectionLabelProps) {
  const Heading = level === 2 ? "h2" : "h3";
  const inner = (
    <>
      {onToggle ? <Icon name={collapsed ? "chevronRight" : "chevronDown"} size={12} className="ui-section-chevron" /> : null}
      {icon ? <Icon name={icon} size={13} /> : null}
      <span className="ui-section-name">{children}</span>
      {count !== undefined ? <>{" "}<span className="ui-section-count">{count}</span></> : null}
    </>
  );
  return (
    <div className={`ui-section-label ${className}`}>
      <Heading className="ui-section-heading">
        {onToggle ? <button type="button" className="ui-section-toggle" aria-expanded={!collapsed} aria-controls={controls} onClick={onToggle}>{inner}</button> : inner}
      </Heading>
      {action ? <span className="ui-section-action">{action}</span> : null}
    </div>
  );
}

/** A section's fold, kept on this device under `key`. */
export function useSectionCollapsed(key: string, initial = false): [boolean, () => void] {
  const storageKey = `workbench.section.${key}`;
  const [collapsed, setCollapsed] = useState(() => {
    const saved = localStorage.getItem(storageKey);
    return saved === null ? initial : saved === "1";
  });
  const toggle = useCallback(() => {
    setCollapsed((value) => {
      localStorage.setItem(storageKey, value ? "0" : "1");
      return !value;
    });
  }, [storageKey]);
  return [collapsed, toggle];
}
