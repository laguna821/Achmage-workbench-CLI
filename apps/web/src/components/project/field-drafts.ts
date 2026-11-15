import { useMemo, useSyncExternalStore } from "react";
import type { PropertyType } from "@workbench/contracts";

// What is typed into a project page's fields (a property, + 결정, + 질문), kept on this device until
// it is written or put away, so switching tabs, closing the pane, reloading or opening another field
// never drops it. This is the one store those inputs read their text from: a field shows what is
// kept here, and everything kept here is shown somewhere on its note's page. Each entry is kept
// under the note it was typed for, with the revision of the note the person saw while typing — a
// restored entry is sent with that revision, so a note changed since is a question, not an
// overwrite. The body has its own copy (document-drafts.ts).

export type FieldDraft = {
  text: string;
  /** The note's revision the person saw while typing (null: no file yet). */
  baseRevision: number | null;
  /** A property chosen in "+ 속성" that had no value yet: its kind. */
  added?: PropertyType;
};

/** The base of an entry that does not say one: never the note's revision, so writing it always asks. */
export const UNKNOWN_BASE = -1;

const prefix = (workId: string) => `workbench.projectField.${workId}.`;

// What the browser's storage refused to take (private mode, quota). It is read before the storage:
// what was typed last is the truth, never an older text the storage still holds. It does not
// survive a reload, which the page says once (`storageRefusing`, `claimStorageNotice`).
const memory = new Map<string, string>();
let refusing = false;
let noticed = false;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  // Another window of the app changed what is kept.
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
};

function raw(key: string): string | null {
  const held = memory.get(key);
  if (held !== undefined) return held;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function parse(stored: string | null): FieldDraft | null {
  if (stored === null) return null;
  try {
    const value = JSON.parse(stored) as Partial<FieldDraft> | null;
    if (value && typeof value === "object" && typeof value.text === "string") {
      const base = value.baseRevision;
      return { text: value.text, baseRevision: base === null || Number.isSafeInteger(base) ? (base as number | null) : UNKNOWN_BASE, ...(typeof value.added === "string" ? { added: value.added } : {}) };
    }
  } catch {
    // Not an entry of this shape: its words are still the person's.
  }
  return stored ? { text: stored, baseRevision: UNKNOWN_BASE } : null;
}

export function readField(workId: string, field: string): FieldDraft | null {
  return parse(raw(prefix(workId) + field));
}

/** Keep `draft` for the field of that note (null: nothing kept). */
export function keepField(workId: string, field: string, draft: FieldDraft | null) {
  const key = prefix(workId) + field;
  const value = draft ? JSON.stringify(draft) : null;
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    memory.delete(key);
    if (value !== null) refusing = false;
  } catch {
    // A failed local copy must not stop typing or writing.
    if (value === null) memory.delete(key);
    else {
      memory.set(key, value);
      refusing = true;
    }
  }
  changed();
}

/** Whether what is typed now is held only until a reload (the browser's storage refused it). */
export function useStorageRefusing(): boolean {
  return useSyncExternalStore(subscribe, () => refusing);
}

/** True once per window: the page that gets it tells the person. */
export function claimStorageNotice(): boolean {
  if (noticed) return false;
  noticed = true;
  return true;
}

/** The stored entries of a note whose field names start with `start`, as one string (a stable snapshot). */
function snapshot(workId: string, start: string): string {
  const head = prefix(workId) + start;
  const found = new Map<string, string>();
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)!;
      const stored = key.startsWith(head) ? localStorage.getItem(key) : null;
      if (stored !== null) found.set(key, stored);
    }
  } catch {
    // Only what memory holds.
  }
  for (const [key, stored] of memory) if (key.startsWith(head)) found.set(key, stored);
  return JSON.stringify([...found].sort(([a], [b]) => (a < b ? -1 : 1)));
}

const entries = (workId: string, listed: string) =>
  (JSON.parse(listed) as [string, string][]).flatMap(([key, stored]) => {
    const draft = parse(stored);
    return draft ? [{ field: key.slice(prefix(workId).length), draft }] : [];
  });

/** The kept fields of a note whose names start with `start` (e.g. "prop:"). */
export function keptFields(workId: string, start: string): { field: string; draft: FieldDraft }[] {
  return entries(workId, snapshot(workId, start));
}

/** What is kept for one field, following every change to it. */
export function useField(workId: string, field: string): FieldDraft | null {
  const stored = useSyncExternalStore(subscribe, () => raw(prefix(workId) + field));
  return useMemo(() => parse(stored), [stored]);
}

/** The kept fields of a note whose names start with `start`, following every change to them. */
export function useKeptFields(workId: string, start: string): { field: string; draft: FieldDraft }[] {
  const listed = useSyncExternalStore(subscribe, () => snapshot(workId, start));
  return useMemo(() => entries(workId, listed), [workId, listed]);
}
