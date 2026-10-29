import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { groupKey, type GroupLook, type HomeView } from "@workbench/contracts";
import { GRAPH_SWATCHES } from "../../graph-settings.ts";
import { emojiColor } from "../../groups.ts";
import { Icon } from "../Icon.tsx";

// Pieces every grouped layout shares: a group's heading (its colour, count and fold), picking a
// group's colour (the stage palette and any #rrggbb, as in "단계 이름·색"; no native colour picker,
// which WebKitGTK may not offer), and the Bases Look switches as classes on the layout.

/** The classes a layout gets from its view's look; `--tint` is the tint's strength (rows inside a group take half). */
export function lookProps(look: GroupLook): { className: string; style: CSSProperties } {
  const names = ["grouped", look.border ? "look-border" : "", look.tint > 0 ? "look-tint" : "", look.heading ? "look-heading" : ""].filter(Boolean);
  return { className: names.join(" "), style: { "--tint": `${look.tint}%`, "--tint-soft": `${look.tint / 2}%` } as CSSProperties };
}

/** A group's colour as a CSS variable (nothing when it has none). */
export const groupStyle = (color: string | null): CSSProperties | undefined => (color ? ({ "--group": color } as CSSProperties) : undefined);

/** A view with one group folded or unfolded. */
export function toggleFold(view: HomeView, entry: string): HomeView {
  const folded = view.collapsed.includes(entry);
  return { ...view, collapsed: folded ? view.collapsed.filter((value) => value !== entry) : [...view.collapsed, entry] };
}

/** A view with a group's colour set (null: back to the colour it starts with). */
export function paintGroup(view: HomeView, key: string, id: string, color: string | null): HomeView {
  const colors = { ...view.look.colors };
  if (color) colors[groupKey(key, id)] = color;
  else delete colors[groupKey(key, id)];
  return { ...view, look: { ...view.look, colors } };
}

export type Paint = (key: string, group: { id: string; label: string; color: string | null }, x: number, y: number) => void;

/**
 * A group's heading: fold arrow, colour dot, name and count. Pressing it folds the group; a right
 * click picks its colour. `children` sit after it (e.g. "모두 읽음").
 */
export function GroupHead({
  as = "h2",
  className = "",
  label,
  count,
  color,
  folded,
  onToggle,
  onPaint,
  children,
}: {
  as?: "h2" | "h3" | "header" | "div";
  className?: string;
  label: string;
  count: number;
  color: string | null;
  folded: boolean;
  onToggle: () => void;
  onPaint?: (x: number, y: number) => void;
  children?: ReactNode;
}) {
  const Tag = as;
  return (
    <Tag className={`group-head${color ? " has-color" : ""} ${className}`} style={groupStyle(color)}>
      <button
        type="button"
        className="group-toggle"
        aria-expanded={!folded}
        title={`누르면 ${folded ? "펴기" : "접기"}${onPaint ? " · 오른쪽 클릭: 색" : ""}`}
        onClick={onToggle}
        onContextMenu={(event) => {
          if (!onPaint) return;
          // Home's own right click (the engine's look) is not this one.
          event.preventDefault();
          event.stopPropagation();
          onPaint(event.clientX, event.clientY);
        }}
      >
        <Icon name={folded ? "chevronRight" : "chevronDown"} size={14} className="group-chevron" />
        {/* A value that starts with a colour emoji (🟢 D) already shows its colour. */}
        {color && !emojiColor(label) ? <span className="group-dot" aria-hidden /> : null}
        <span className="group-label">{label}</span> <span className="home-count">{count}</span>
      </button>
      {children}
    </Tag>
  );
}

/** Swatches (the stage palette), "기본" (the colour it starts with), and a #rrggbb field. */
export function ColorPick({ value, base, label, onChange }: { value: string | null; base: string | null; label: string; onChange: (color: string | null) => void }) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => setDraft(value ?? ""), [value]);
  return (
    <div className="color-pick">
      <div className="color-swatches" role="radiogroup" aria-label={`${label} 색`}>
        <button
          type="button"
          role="radio"
          aria-checked={value === null}
          aria-label="기본 색"
          title={base ? "기본 색(값의 이모지·단계·폴더 색)" : "색 없음"}
          className={`color-swatch base${value === null ? " on" : ""}${base ? "" : " none"}`}
          style={base ? { background: base } : undefined}
          onClick={() => onChange(null)}
        />
        {GRAPH_SWATCHES.map((swatch) => (
          <button key={swatch} type="button" role="radio" aria-checked={value === swatch} aria-label={swatch} title={swatch} className={`color-swatch${value === swatch ? " on" : ""}`} style={{ background: swatch }} onClick={() => onChange(swatch)} />
        ))}
      </div>
      <input
        className="color-hex"
        value={draft}
        placeholder="#rrggbb"
        aria-label={`${label} 색 값`}
        spellCheck={false}
        maxLength={7}
        onChange={(event) => {
          const text = event.target.value.trim();
          if (!/^#?[0-9a-fA-F]{0,6}$/.test(text)) return;
          setDraft(text);
          if (!text) onChange(null);
          else if (/^#?[0-9a-fA-F]{6}$/.test(text)) onChange(`#${text.replace(/^#/, "").toLowerCase()}`);
        }}
        onBlur={() => setDraft(value ?? "")}
      />
    </div>
  );
}

type Painting = { key: string; id: string; label: string; base: string | null; x: number; y: number };

/**
 * Picking a group's colour from its heading (right click): a small panel at the pointer. Returns
 * the opener for the layouts and the panel to draw.
 */
export function usePaint(view: HomeView, onView: (view: HomeView) => void): { paint: Paint; panel: ReactNode } {
  const [open, setOpen] = useState<Painting | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const paint: Paint = useCallback((key, group, x, y) => setOpen({ key, id: group.id, label: group.label, base: group.color, x, y }), []);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(null);
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  const value = open ? (view.look.colors[groupKey(open.key, open.id)] ?? null) : null;
  const panel = open ? (
    <div
      ref={ref}
      className="group-paint"
      role="dialog"
      aria-label={`${open.label} 색`}
      style={{ left: Math.max(8, Math.min(open.x, window.innerWidth - 300)), top: Math.max(8, Math.min(open.y, window.innerHeight - 140)) }}
    >
      <div className="group-paint-head">
        <span className="group-paint-name">{open.label}</span>
        <span className="muted">묶음 색</span>
      </div>
      <ColorPick value={value} base={open.base} label={open.label} onChange={(color) => onView(paintGroup(view, open.key, open.id, color))} />
      {!view.look.border && !view.look.heading && !view.look.tint ? <p className="group-paint-hint">색은 모양 ▾의 테두리 · 옅은 바탕 · 머리 강조에 쓰입니다.</p> : null}
    </div>
  ) : null;
  return { paint, panel };
}

/** "N개 더 보기" under a list cut short. */
export function More({ hidden, onMore }: { hidden: number; onMore: () => void }) {
  return hidden > 0 ? (
    <button type="button" className="link home-more" onClick={onMore}>
      {hidden}개 더 보기
    </button>
  ) : null;
}
