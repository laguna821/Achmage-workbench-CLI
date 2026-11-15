/**
 * The document's ONE notice line (skin 2, unit C). Everything the document has to say under its
 * head (up to seven stacked strips before) is a notice; the line shows the most urgent one with its
 * keys, the others wait behind "외 N건". Nothing is dropped: every notice stays in the list with
 * every key it had.
 *
 * The order of precedence (first wins). Losing typed work comes first, then what needs the person,
 * then what limits what they can do here, then information:
 *  1. conflict         — the text could not be saved over a newer revision (unsaved edits at stake)
 *  2. editor-conflict  — the same, reported by the embedded editor (Word/PowerPoint/Excel/Hangul)
 *  3. save-failed      — the last save failed; the edits are kept here and in the local draft
 *  4. hangul-draft     — HWP safety net: a text edit from an earlier version was never saved
 *  5. hangul-warning   — HWP safety net: a save that may have lost something, or went unchecked
 *  6. viewing-revision — an older revision is on screen (read only)
 *  7. agent-waits      — the document's AI waits for an approval and its conversation is closed
 *  8. disk-changed     — the file on disk changed outside the app
 *  9. disk-missing     — the file is gone from disk
 * 10. read-only        — open for editing elsewhere (another tab or window), or no editing right
 * 11. agent-error      — the document's AI could not be reached
 * 12. dock-failed      — the Hangul editor's own AI dock did not come or go
 * 13. narrow           — the pane is too narrow for the embedded editor
 * 14. hangul-text      — the Hangul text view is a reading view
 * 15. readers          — which revision each conversation read
 */
export const NOTICE_ORDER = [
  "conflict",
  "editor-conflict",
  "save-failed",
  "hangul-draft",
  "hangul-warning",
  "viewing-revision",
  "agent-waits",
  "disk-changed",
  "disk-missing",
  "read-only",
  "agent-error",
  "dock-failed",
  "narrow",
  "hangul-text",
  "readers",
] as const;

export type DocNoticeKind = (typeof NOTICE_ORDER)[number];

/** error: work is at stake · attention: needs the person · info: what is so. */
export type NoticeTone = "error" | "attention" | "info";

export type NoticeKey = {
  label: string;
  run: () => void;
  /** The view's one filled key (only on the line's first notice, and only when nothing else holds it). */
  primary?: boolean;
  disabled?: boolean;
  /** Why it is disabled, said on the key. */
  reason?: string;
};

export type DocNotice = {
  kind: DocNoticeKind;
  tone: NoticeTone;
  /** What happened and what it means, in words (no codes, no revision tags). */
  text: string;
  keys: NoticeKey[];
  /** A class the notice was found by before it joined the line (scripts and tests keep finding it). */
  hook?: string;
  /** Several notices of one kind (one per reader) keep their own key. */
  id?: string;
};

export const TONE_OF: Record<DocNoticeKind, NoticeTone> = {
  conflict: "error",
  "editor-conflict": "error",
  "save-failed": "error",
  "hangul-draft": "attention",
  // A save that may have lost something is work at stake: it ranks with the errors (re-review 1).
  "hangul-warning": "error",
  "viewing-revision": "info",
  "agent-waits": "attention",
  "disk-changed": "attention",
  "disk-missing": "error",
  "read-only": "info",
  "agent-error": "error",
  "dock-failed": "attention",
  narrow: "info",
  "hangul-text": "info",
  readers: "info",
};

const TONE_RANK: Record<NoticeTone, number> = { error: 0, attention: 1, info: 2 };

/**
 * The notices in the order the line shows them: by tone first (an error before what needs the person,
 * before information — tech review T2: an older revision on screen hid "the file is gone"), then by
 * NOTICE_ORDER, stable within a kind.
 */
export function orderNotices(notices: Array<DocNotice | null | false | undefined | "" | 0>): DocNotice[] {
  const rank = (notice: DocNotice) => NOTICE_ORDER.indexOf(notice.kind);
  return notices
    .filter((notice): notice is DocNotice => Boolean(notice))
    .map((notice, index) => ({ notice, index }))
    .sort((a, b) => TONE_RANK[a.notice.tone] - TONE_RANK[b.notice.tone] || rank(a.notice) - rank(b.notice) || a.index - b.index)
    .map(({ notice }) => notice);
}

/** The most severe tone among notices ("외 N건" carries it). */
export function severest(notices: DocNotice[]): NoticeTone {
  return notices.reduce<NoticeTone>((worst, notice) => (TONE_RANK[notice.tone] < TONE_RANK[worst] ? notice.tone : worst), "info");
}

/** "1판" — a revision as people read it (never `r1`). */
export const revisionWord = (revision: number) => `${revision}판`;

/** "3줄 더함, 2줄 뺌" — a proposal's size in words (never `+3 −2`). */
export function linesWord(added: number, removed: number): string {
  const parts = [added ? `${added}줄 더함` : "", removed ? `${removed}줄 뺌` : ""].filter(Boolean);
  return parts.length ? parts.join(", ") : "바뀐 줄 없음";
}
