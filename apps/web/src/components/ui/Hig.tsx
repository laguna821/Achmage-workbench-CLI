import { useId, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Icon, type IconName } from "../Icon.tsx";

/** React adapter for the vendored HIG Kit. React owns focus/state instead of kit.js DOM mutation. */
export function IconButton({ icon, label, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string }) {
  return <button type="button" className={`hk-btn hk-btn--plain hk-btn--icon hig-icon-button ${className}`} aria-label={label} title={label} {...props}><Icon name={icon} size={18} /></button>;
}

export function Segmented<T extends string>({ value, onChange, options, label, className = "", tabs = false }: {
  value: T; onChange: (value: T) => void; options: readonly { value: T; label: ReactNode }[];
  label: string; className?: string; tabs?: boolean;
}) {
  const id = useId();
  return <div className={`hk-seg ${className}`} role={tabs ? "tablist" : "radiogroup"} aria-label={label} onKeyDown={event => {
    const i = options.findIndex(option => option.value === value);
    const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : ["ArrowRight", "ArrowDown"].includes(event.key) ? (i + 1) % options.length : ["ArrowLeft", "ArrowUp"].includes(event.key) ? (i - 1 + options.length) % options.length : -1;
    if (next < 0) return;
    event.preventDefault(); onChange(options[next].value);
    document.getElementById(`${id}-${next}`)?.focus();
  }}>{options.map((option, i) => <button className="hk-seg__item" key={option.value} id={`${id}-${i}`} type="button" role={tabs ? "tab" : "radio"} aria-selected={tabs ? value === option.value : undefined} aria-checked={tabs ? undefined : value === option.value} tabIndex={value === option.value ? 0 : -1} onClick={() => onChange(option.value)}>{option.label}</button>)}</div>;
}
