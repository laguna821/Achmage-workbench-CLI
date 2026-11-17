import { useEffect, useState } from "react";
import type { Artifact } from "@workbench/contracts";
import { isPhoneWidth } from "./mobile-layout.ts";
import { isNewDocument } from "./doc-new.ts";

type Format = Artifact["format"];

// 설정 › 문서 도구 › 문서를 열 때 (doc-pages-first, point 3; the default since doc-default, the
// owner's ruling 2026-11-17 "기본값으로"): a document tab opens in 쪽 보기 first — its pages as
// pictures, a few MB — and the editor starts on the first wish to edit (the 편집 key, a double click
// in a page, typing with the page focused, 문서 AI); or in its editor at once when the person chose
// "편집기로 바로 열기". Kept on this device (window), like the other view preferences. A phone-width
// window keeps the editor as its default (its single window is untouched by doc-default).

export type DocOpen = "editor" | "pages";
const KEY = "workbench.docOpen";
const EVENT = "workbench:doc-open";

/**
 * What a window without a stored choice gets: 쪽 보기 first, except in a phone-width window (its single
 * window keeps the editor). By width only: WebKitGTK without a mouse (the rigs' Broadway display) says
 * `pointer: coarse` on a desktop window.
 */
export function defaultDocOpen(): DocOpen {
  return isPhoneWidth() ? "editor" : "pages";
}

export function readDocOpen(): DocOpen {
  try {
    const stored = localStorage.getItem(KEY);
    // "editor" is stored explicitly (a choice); "pages" stored by wave 32 stays valid.
    return stored === "editor" || stored === "pages" ? stored : defaultDocOpen();
  } catch {
    return defaultDocOpen();
  }
}

export function writeDocOpen(value: DocOpen) {
  try {
    localStorage.setItem(KEY, value);
  } catch {
    // Storage refused: the choice lasts for this window only.
  }
  window.dispatchEvent(new Event(EVENT));
}

export function useDocOpen(): [DocOpen, (value: DocOpen) => void] {
  const [value, setValue] = useState(readDocOpen);
  useEffect(() => {
    const changed = () => setValue(readDocOpen());
    window.addEventListener(EVENT, changed);
    window.addEventListener("storage", changed);
    return () => { window.removeEventListener(EVENT, changed); window.removeEventListener("storage", changed); };
  }, []);
  return [value, writeDocOpen];
}

/**
 * The view a tab of this format opens in when 쪽 보기 comes first, or null when the format has no
 * page view (it opens as before). Word, PowerPoint, Hangul: their pages. PDF: its own page view (미리보기).
 */
export function readingView(format: Format | undefined): "pages" | "preview" | null {
  // Not Excel: its printed page leaves formula results empty and has no grid (measured: a 합계 column
  // of formulas came out blank) — a picture that lies; it opens in its editor as before.
  if (format === "docx" || format === "pptx" || format === "hwpx" || format === "hwp") return "pages";
  if (format === "pdf") return "preview";
  return null;
}

/** What the tab remembers of its last visit: its view, and whether the person edited in it (`edited`). */
export type Remembered = { mode?: string; edited?: boolean } | undefined;

/**
 * The first view of a new tab or a woken one: 쪽 보기 when chosen and the tab was in the editor (or
 * nowhere yet); otherwise null (as before). Never: beside a conversation (`hosted`), for a new
 * document, or for a tab the person was editing in when it slept (point e: it wakes in its editor).
 */
export function firstView(choice: DocOpen, artifact: Pick<Artifact, "id" | "format" | "revision"> | undefined, remembered: Remembered, hosted: boolean, now = Date.now()): "pages" | "preview" | null {
  if (hosted || choice !== "pages") return null;
  const view = readingView(artifact?.format);
  if (!view || isNewDocument(artifact, now)) return null;
  if (remembered?.mode === "edit" && remembered.edited) return null;
  return !remembered?.mode || remembered.mode === "edit" || remembered.mode === view ? view : null;
}

/** A key that is typing (a character), not a shortcut or a move: an intent to edit the page. */
export function isTyping(event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }) {
  return event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
}

/** The settings row's words. */
export const DOC_OPEN_LABEL = "문서를 열 때";
export const DOC_OPEN_CHOICES: [DocOpen, string][] = [["pages", "쪽 보기로 먼저 열기"], ["editor", "편집기로 바로 열기"]];
/** The mark after the default choice's name. */
export const DOC_OPEN_DEFAULT_MARK = " (기본)";
export const DOC_OPEN_HINT = "쪽 보기는 쪽 그림이라 가볍게 열리지만(문서마다 몇 MB) 글자를 고를 수 없습니다. 두 번 누르거나 입력하면 편집기가 열립니다. 새 문서, 엑셀, 쪽 그림이 아직 없는 문서는 편집기로 엽니다.";
export const READING_LINE = "쪽 그림입니다. 글자를 고를 수는 없습니다. 고치려면 쪽을 두 번 누르거나 입력하세요.";
