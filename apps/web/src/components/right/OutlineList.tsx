import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { TranscriptItem } from "@workbench/contracts";
import { jumpInNote, outlineOf, useReadingAt } from "../../conversation/outline.ts";
import { AnchoredLayer } from "../ui/AnchoredLayer.tsx";
import { Icon } from "../Icon.tsx";

/** One line of an outline: a request (numbered, with its marks) or a heading (indented by level). */
export type OutlineEntry = { id: string; text: string; number?: number; level?: number; attention?: boolean; running?: boolean };

const nameOf = (entry: OutlineEntry) =>
  `${entry.number !== undefined ? `${entry.number} ` : ""}${entry.text}${entry.attention ? " · 확인 필요" : ""}${entry.running ? " · 진행 중" : ""}`;

/**
 * The outline as a list of buttons: one tab stop (the row in view, else the first), arrow keys,
 * Home/End, and digits to go to a request by its number. Enter or a click picks.
 */
export function OutlineList({ label, entries, current, onPick, className = "" }: { label: string; entries: OutlineEntry[]; current: string | null; onPick: (entry: OutlineEntry) => void; className?: string }) {
  const list = useRef<HTMLOListElement>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const typed = useRef<{ text: string; at: number }>({ text: "", at: 0 });
  const stop = entries.some((entry) => entry.id === focusId) ? focusId : entries.some((entry) => entry.id === current) ? current : entries[0]?.id ?? null;
  // The row in view stays in view in the list as the reader scrolls the note.
  useEffect(() => {
    if (!current) return;
    list.current?.querySelector<HTMLElement>(`[data-outline-id="${CSS.escape(current)}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [current]);
  const focusAt = (index: number) => {
    const entry = entries[Math.max(0, Math.min(entries.length - 1, index))];
    if (!entry) return;
    setFocusId(entry.id);
    list.current?.querySelector<HTMLElement>(`[data-outline-id="${CSS.escape(entry.id)}"]`)?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "ArrowDown") focusAt(index + 1);
    else if (event.key === "ArrowUp") focusAt(index - 1);
    else if (event.key === "Home") focusAt(0);
    else if (event.key === "End") focusAt(entries.length - 1);
    else if (/^\d$/.test(event.key)) {
      // "1", then "2" within a moment: request 12.
      const now = Date.now();
      const text = now - typed.current.at < 700 ? typed.current.text + event.key : event.key;
      typed.current = { text, at: now };
      const found = entries.findIndex((entry) => entry.number === Number(text));
      if (found >= 0) focusAt(found);
    } else return;
    event.preventDefault();
  };
  return (
    <nav className={`outline-list ${className}`} aria-label={label}>
      <ol ref={list}>
        {entries.map((entry, index) => (
          <li key={entry.id}>
            <button
              type="button"
              className="outline-row"
              data-outline-id={entry.id}
              data-level={entry.level}
              aria-label={nameOf(entry)}
              aria-current={entry.id === current ? "location" : undefined}
              tabIndex={entry.id === stop ? 0 : -1}
              onFocus={() => setFocusId(entry.id)}
              onKeyDown={(event) => onKeyDown(event, index)}
              onClick={() => onPick(entry)}
            >
              {entry.number !== undefined ? <span className="outline-no">{entry.number}</span> : null}
              <span className="outline-text">{entry.text}</span>
              {entry.attention ? <span className="dot dot-attention" title="확인 필요" /> : entry.running ? <span className="dot dot-active" title="진행 중" /> : null}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** A conversation's requests as outline entries, and the one being read. */
export function useRequestOutline(sessionId: string | null, items: TranscriptItem[] | undefined, running: boolean) {
  const entries = useMemo<OutlineEntry[]>(() => outlineOf(items ?? [], running).map((row) => ({ id: row.id, text: row.text, number: row.index, attention: row.attention, running: row.running })), [items, running]);
  const current = useReadingAt(sessionId ? `chat:${sessionId}` : null);
  return { entries, current };
}

/**
 * The request list where a conversation is shown small (a document's AI, a web tab's AI): those
 * placements have no right sidebar, so their head keeps a compact way to reach a request.
 */
export function RequestListButton({ sessionId, items, running }: { sessionId: string; items: TranscriptItem[] | undefined; running: boolean }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const { entries, current } = useRequestOutline(sessionId, items, running);
  if (entries.length < 3) return null;
  return (
    <>
      <button ref={anchor} type="button" className="icon-button small request-list-button" aria-label="요청 목록" title="요청 목록" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}>
        <Icon name="list" size={15} />
      </button>
      <AnchoredLayer open={open} onClose={() => setOpen(false)} anchor={anchor} align="end" label="요청 목록" className="request-list-layer" initialFocus="first">
        <OutlineList label="요청 목록" entries={entries} current={current} onPick={(entry) => { setOpen(false); jumpInNote(`chat:${sessionId}`, entry.id); }} />
      </AnchoredLayer>
    </>
  );
}
