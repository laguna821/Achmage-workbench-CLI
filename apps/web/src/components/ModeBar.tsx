import { useLayoutEffect, useRef, useState } from "react";
import "../styles/views.css";

export type ModeChoice<T extends string> = { id: T; label: string; title?: string; disabled?: boolean };

/**
 * A small segmented bar of view modes (home and the work screen). The pill under the chosen mode
 * slides to the next one, so the change reads as one thing moving, not a new screen.
 */
export function ModeBar<T extends string>({
  modes,
  value,
  onChange,
  label,
  keyHint,
  className,
}: {
  modes: ModeChoice<T>[];
  value: T;
  onChange: (mode: T) => void;
  label: string;
  /** How a mode is chosen from the keyboard, before its number ("" or "Alt+"). */
  keyHint: string;
  className?: string;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const element = bar.current;
    if (!element) return;
    const place = () => {
      const active = element.querySelector<HTMLElement>(`[data-mode="${value}"]`);
      setPill(active ? { left: active.offsetLeft, width: active.offsetWidth } : null);
    };
    place();
    // Labels change width when the look's font arrives or changes.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [value, modes.length]);
  return (
    <div ref={bar} className={`mode-bar ${className ?? ""}`} role="radiogroup" aria-label={label}>
      {pill ? <span className="mode-pill" style={{ transform: `translateX(${pill.left}px)`, width: pill.width }} aria-hidden /> : null}
      {modes.map((mode, index) => (
        <button
          key={mode.id}
          type="button"
          role="radio"
          data-mode={mode.id}
          aria-checked={mode.id === value}
          className={mode.id === value ? "active" : ""}
          disabled={mode.disabled}
          title={`${mode.title ?? mode.label} (${keyHint}${index + 1})`}
          onClick={() => onChange(mode.id)}
        >
          {mode.label}
        </button>
      ))}
    </div>
  );
}
