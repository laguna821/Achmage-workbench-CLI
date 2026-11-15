import { useEffect, useId, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from "react";
import { Icon, type IconName } from "../Icon.tsx";

/** React adapter for the vendored HIG Kit. React owns focus/state instead of kit.js DOM mutation. */
export function IconButton({ icon, label, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string }) {
  return <button type="button" className={`hk-btn hk-btn--plain hk-btn--icon hig-icon-button ${className}`} aria-label={label} title={label} {...props}><Icon name={icon} size={18} /></button>;
}

export type SegmentOption<T extends string> = { value: T; label: ReactNode; title?: string; disabled?: boolean };

/**
 * The one segmented control: equal cells and a raised indicator that slides to the chosen cell
 * (kit `.hk-seg__indicator`, placed by `--_n`/`--_i`). It slides only after its first placement.
 */
export function Segmented<T extends string>({ value, onChange, options, label, className = "", tabs = false, id: base, controls }: {
  value: T; onChange: (value: T) => void; options: readonly SegmentOption<T>[];
  label: string; className?: string; tabs?: boolean;
  /** Ids of the cells are `<id>-<index>` (a tab panel names itself by its tab). */
  id?: string;
  /** As tabs: the id of the panel they control. */
  controls?: string;
}) {
  const own = useId();
  const id = base ?? own;
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const chosen = options.findIndex(option => option.value === value);
  const style = { "--_n": options.length, "--_i": Math.max(0, chosen) } as CSSProperties;
  return <div className={`hk-seg ${className}`} data-hk="" data-ready={ready ? "" : undefined} style={style} role={tabs ? "tablist" : "radiogroup"} aria-label={label} onKeyDown={event => {
    const step = event.key === "Home" || ["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : event.key === "End" || ["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 0;
    if (!step) return;
    let next = event.key === "Home" ? -1 : event.key === "End" ? options.length : chosen;
    for (let tries = 0; tries < options.length; tries++) {
      next = (next + step + options.length) % options.length;
      if (!options[next]!.disabled) break;
    }
    if (options[next]!.disabled || next === chosen) return event.preventDefault();
    event.preventDefault(); onChange(options[next]!.value);
    document.getElementById(`${id}-${next}`)?.focus();
  }}>
    {chosen >= 0 ? <span className="hk-seg__indicator" aria-hidden /> : null}
    {options.map((option, i) => <button className="hk-seg__item" key={option.value} id={`${id}-${i}`} type="button" data-value={option.value} title={option.title} disabled={option.disabled}
      role={tabs ? "tab" : "radio"} aria-selected={tabs ? value === option.value : undefined} aria-controls={tabs ? controls : undefined} aria-checked={tabs ? undefined : value === option.value}
      tabIndex={value === option.value ? 0 : -1} onClick={() => onChange(option.value)}>{option.label}</button>)}
  </div>;
}
