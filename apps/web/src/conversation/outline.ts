import { useSyncExternalStore } from "react";
import type { TranscriptItem } from "@workbench/contracts";

// A note's outline outside the note: the conversation's requests (or a Markdown document's
// headings), which one the reader is in, and a way to jump there. The note writes where it is read
// and registers its jump; the right sidebar (and the compact request list of embedded
// conversations) read and call them. Keys: `chat:<sessionId>`, `doc:<artifactId>`.

export type OutlineRow = { id: string; index: number; text: string; attention: boolean; running: boolean };
export type Heading = { line: number; level: number; text: string };

/** The first line of a request, without the Markdown marks that start it. */
export function firstLine(text: string) {
  const line = text.split("\n").find((entry) => entry.trim()) ?? text;
  return line.replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, "").trim();
}

/** The requests, numbered as the note numbers them (every request block counts). */
export function outlineOf(items: TranscriptItem[], running: boolean): OutlineRow[] {
  const rows: OutlineRow[] = [];
  let ended = false;
  for (const item of items) {
    if (item.kind === "user") {
      rows.push({ id: item.id, index: rows.length + 1, text: firstLine(item.text) || "첨부한 파일", attention: false, running: false });
      ended = false;
    } else if (!rows.length) continue;
    else if (item.kind === "approval" && item.decision === null) rows[rows.length - 1]!.attention = true;
    else if (item.kind === "turnEnd") ended = true;
  }
  const last = rows[rows.length - 1];
  if (last && running && !ended) last.running = true;
  return rows;
}

/** ATX headings outside YAML front matter and fenced code. */
export function headingsOf(text: string): Heading[] {
  const lines = text.split("\n");
  const headings: Heading[] = [];
  let at = 0;
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line));
    if (close > 0) at = close + 1;
  }
  let fence: string | null = null;
  for (; at < lines.length; at++) {
    const line = lines[at]!;
    const marker = /^\s{0,3}(```|~~~)/.exec(line)?.[1];
    if (marker) { fence = fence === null ? marker : fence === marker ? null : fence; continue; }
    if (fence) continue;
    const match = /^\s{0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/.exec(line);
    if (match) headings.push({ line: at, level: match[1]!.length, text: match[2]!.replace(/[*_`]/g, "").trim() });
  }
  return headings;
}

// ── where each note is being read ──
const reading = new Map<string, string | null>();
const readers = new Set<() => void>();
let version = 0;
const subscribe = (listener: () => void) => { readers.add(listener); return () => { readers.delete(listener); }; };

/** The note says which entry the reader is in (null: above the first one). */
export function setReadingAt(key: string, id: string | null) {
  if ((reading.get(key) ?? null) === id) return;
  reading.set(key, id);
  version += 1;
  for (const listener of readers) listener();
}

export function useReadingAt(key: string | null): string | null {
  useSyncExternalStore(subscribe, () => version, () => version);
  return key ? reading.get(key) ?? null : null;
}

// ── jumping into a note ──
export type NoteTarget = { element: () => HTMLElement | null; jump: (id: string, hint?: string) => void };
const targets = new Map<string, Set<NoteTarget>>();

export function registerNoteTarget(key: string, target: NoteTarget) {
  const set = targets.get(key) ?? new Set<NoteTarget>();
  set.add(target);
  targets.set(key, set);
  return () => {
    set.delete(target);
    if (!set.size && targets.get(key) === set) targets.delete(key);
  };
}

/** Jump in the note's copy on screen, the focused pane's when it is open twice. */
export function jumpInNote(key: string, id: string, hint?: string): boolean {
  const shown = [...(targets.get(key) ?? [])].filter((target) => {
    const element = target.element();
    return Boolean(element?.isConnected && !element.closest("[hidden]"));
  });
  const chosen = shown.find((target) => target.element()!.closest('[data-pane-active="true"]')) ?? shown[0];
  chosen?.jump(id, hint);
  return Boolean(chosen);
}
