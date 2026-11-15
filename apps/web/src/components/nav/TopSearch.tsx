import { useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../Icon.tsx";

const PLACEHOLDER = "프로젝트, 대화, 문서 찾기";
/** The least air between the field and what stands left or right of it in the bar (--space-sm). */
const AIR = 8;

/**
 * Where the field stands: centred on the WINDOW when the bar has room on both sides (the owner's
 * 01-dashboard), else where the bar's grid puts it (between the clusters). It moves by `translate`
 * only, so the bar's layout and the tab order never change. Returns the offset applied (px).
 */
export function centreOnWindow(field: HTMLElement, bar: HTMLElement, windowWidth: number) {
  field.style.removeProperty("translate");
  const box = field.getBoundingClientRect();
  if (!box.width) return 0;
  const left = Math.max(-Infinity, ...[...bar.querySelectorAll<HTMLElement>(".topbar-left, .topbar-title, .topbar-title-edit, .top-notice:not(.layout-problem)")].map((node) => node.getBoundingClientRect()).filter((rect) => rect.width).map((rect) => rect.right));
  const right = Math.min(Infinity, ...[...bar.querySelectorAll<HTMLElement>(".topbar-right")].map((node) => node.getBoundingClientRect()).filter((rect) => rect.width).map((rect) => rect.left));
  const want = Math.round(windowWidth / 2 - box.width / 2);
  if (want < left + AIR || want + box.width > right - AIR) return 0;
  const offset = want - Math.round(box.left);
  if (offset) field.style.setProperty("translate", `${offset}px 0`);
  return offset;
}

/**
 * The top bar's search field (release unit A, item 4; the owner's draft 01-dashboard.png): a quiet field in
 * the bar's centre on every place. It is the door to the existing palette — the first thing typed opens it
 * with that text (a Hangul syllable once composed); a click, Enter or ↓ opens it as it is. Tab passes
 * through. Ctrl+K and the rail's 찾기 are unchanged; at ≤ 760 px the field is not drawn (the rail's 찾기).
 */
export function TopSearch({ shortcut, onOpen }: { shortcut: string; onOpen: (typed: string) => void }) {
  const [text, setText] = useState("");
  const composing = useRef(false);
  const field = useRef<HTMLLabelElement>(null);
  useLayoutEffect(() => {
    const element = field.current, bar = element?.closest<HTMLElement>(".topbar");
    if (!element || !bar) return;
    let frame = 0;
    const place = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => centreOnWindow(element, bar, window.innerWidth)); };
    place();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    for (const node of [bar, ...bar.querySelectorAll<HTMLElement>(".topbar-left, .topbar-title, .topbar-right")]) observer?.observe(node);
    window.addEventListener("resize", place);
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); window.removeEventListener("resize", place); };
  });
  const open = (typed: string) => {
    setText("");
    onOpen(typed);
  };
  return (
    <label ref={field} className="top-search">
      <Icon name="search" size={16} />
      <input
        type="search"
        value={text}
        placeholder={PLACEHOLDER}
        aria-label={PLACEHOLDER}
        title={`${PLACEHOLDER} (${shortcut})`}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => {
          const value = event.target.value;
          if (composing.current) setText(value);
          else if (value) open(value);
        }}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={(event) => {
          composing.current = false;
          const value = (event.target as HTMLInputElement).value || event.data;
          if (value) open(value);
        }}
        onClick={() => open(text)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter" || event.key === "ArrowDown") { event.preventDefault(); open(text); }
        }}
      />
      <kbd aria-hidden>{shortcut}</kbd>
    </label>
  );
}
