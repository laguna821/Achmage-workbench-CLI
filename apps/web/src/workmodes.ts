import { useEffect, useLayoutEffect, type ReactNode, type RefObject } from "react";
import type { Proposal } from "@workbench/contracts";
import type { State } from "./state.ts";

// Work screen modes (design 3.2), shown while a document of the work is open: 대화 · 문서 · 검토 ·
// 나란히 · 읽기 (Alt+1–5). The conversation stays the default; "나란히" is only ever chosen and is
// not restored when the app opens again (it lives in the view, never in the preferences).

export type WorkMode = "chat" | "doc" | "review" | "split" | "read";

export const WORK_MODES: { id: WorkMode; label: string; title: string }[] = [
  { id: "chat", label: "대화", title: "대화" },
  { id: "doc", label: "문서", title: "문서와 그 아래 대화 서랍" },
  { id: "review", label: "검토", title: "이 문서의 수정안 비교" },
  { id: "split", label: "나란히", title: "왼쪽 대화, 오른쪽 문서 · 입력창은 고른 쪽으로" },
  { id: "read", label: "읽기", title: "화면 가득 쪽 넘기며 읽기 · Esc로 돌아감" },
];

export type ModeView =
  | { kind: "work" }
  | { kind: "document"; artifactId: string; proposalId: string | null }
  | { kind: "split"; artifactId: string; draftKey: string; focus: "chat" | "doc" };

/** The mode a view is in (null for views without modes: home, archive). */
export function modeOf(view: { kind: string; proposalId?: string | null }, reading: boolean): WorkMode | null {
  if (reading) return "read";
  if (view.kind === "split") return "split";
  if (view.kind === "document") return view.proposalId ? "review" : "doc";
  if (view.kind === "work") return "chat";
  return null;
}

/**
 * The view a mode asks for. "나란히" starts with the input on the side the user came from, and both
 * sides share that side's draft, so nothing typed is lost by switching.
 */
export function viewFor(mode: Exclude<WorkMode, "read">, context: { docId: string; proposalId: string | null; from: WorkMode | null; chatDraft: string }): ModeView {
  if (mode === "chat") return { kind: "work" };
  if (mode === "split") {
    const fromChat = context.from === "chat";
    return { kind: "split", artifactId: context.docId, draftKey: fromChat ? context.chatDraft : `doc:${context.docId}`, focus: fromChat ? "chat" : "doc" };
  }
  return { kind: "document", artifactId: context.docId, proposalId: mode === "review" ? context.proposalId : null };
}

/** The proposal "검토" opens: the newest one waiting on the current revision, else the newest waiting one. */
export function reviewProposal(state: State, artifactId: string): Proposal | null {
  const artifact = state.artifacts[artifactId];
  const waiting = Object.values(state.proposals)
    .filter((proposal) => proposal.artifactId === artifactId && proposal.status === "pending")
    .sort((a, b) => b.createdAt - a.createdAt);
  return waiting.find((proposal) => proposal.baseRevision === artifact?.revision) ?? waiting[0] ?? null;
}

/** Alt+1–5 (by key position, so any keyboard layout works), never while a syllable is being composed. */
export function workModeKey(event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "isComposing" | "code" | "key">): WorkMode | null {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return null;
  const digit = /^Digit([1-5])$/.exec(event.code)?.[1] ?? (/^[1-5]$/.test(event.key) ? event.key : null);
  return digit ? WORK_MODES[Number(digit) - 1]!.id : null;
}

/** What the conversation and document views take from the mode they are shown in. */
export type ModeProps = {
  /** The mode bar, above the input. */
  bar?: ReactNode;
  /** "나란히": where the one input goes (this side has it), or null (the other side has it). */
  slot?: HTMLElement | null;
  /** "나란히": the draft both sides share. */
  draftKey?: string;
  /** "나란히": the conversation is beside the document (no drawer under it). */
  split?: boolean;
  /** The proposal the document's compare view shows ("검토"), null when it closes. */
  onReview?: (proposalId: string | null) => void;
  /** A window of its own for one session: no tabs of the work's other sessions. */
  single?: boolean;
};

// ── where the reader was: kept across mode switches (views unmount and come back) ─────────────

/** The page being read, or how far down; `top` is the exact offset when the same view comes back. */
export type ReadingPosition = { page: number | null; fraction: number; top?: number };

const PAGES = ".pdf-page, .hwpx-page, .office-page";
const SCROLLERS = ".cm-scroller, .doc-preview, .pdf-stage, .hwpx-stage, .office-pages, .doc-split > *";

/** What scrolls in a document's body: the candidate with the most to scroll. */
export function mainScroller(body: HTMLElement): HTMLElement {
  let best = body;
  let range = body.scrollHeight - body.clientHeight;
  for (const candidate of Array.from(body.querySelectorAll<HTMLElement>(SCROLLERS))) {
    const own = candidate.scrollHeight - candidate.clientHeight;
    if (own > range) {
      best = candidate;
      range = own;
    }
  }
  return best;
}

/** The page being read (paged documents: the one crossing 30% of the view), else how far down. */
export function readingPosition(body: HTMLElement | null): ReadingPosition {
  if (!body) return { page: null, fraction: 0 };
  const scroller = mainScroller(body);
  const pages = Array.from(body.querySelectorAll<HTMLElement>(PAGES));
  if (pages.length) {
    const line = scroller.getBoundingClientRect().top + scroller.clientHeight * 0.3;
    let page = 0;
    pages.forEach((element, index) => {
      if (element.getBoundingClientRect().top <= line) page = index;
    });
    return { page, fraction: pages.length > 1 ? page / (pages.length - 1) : 0 };
  }
  const range = scroller.scrollHeight - scroller.clientHeight;
  return { page: null, fraction: range > 0 ? Math.min(1, scroller.scrollTop / range) : 0, top: scroller.scrollTop };
}

/** Bring a document back to a position; false while it is not laid out far enough yet. */
export function restorePosition(body: HTMLElement, position: ReadingPosition): boolean {
  const pages = Array.from(body.querySelectorAll<HTMLElement>(PAGES));
  if (position.page !== null && pages.length) {
    const target = pages[Math.min(position.page, pages.length - 1)]!;
    const scroller = mainScroller(body);
    scroller.scrollTop += target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 8;
    return pages.length > position.page;
  }
  const scroller = mainScroller(body);
  const range = scroller.scrollHeight - scroller.clientHeight;
  if (range <= 0) return position.fraction === 0;
  // The same view at the same size lays out the same: the exact offset, once there is room for it.
  if (position.top !== undefined) {
    if (range < position.top) return false;
    scroller.scrollTop = position.top;
    return true;
  }
  scroller.scrollTop = position.fraction * range;
  return true;
}

const positions = new Map<string, ReadingPosition>();

/**
 * Keep where a document view was read (by `key`) while it is scrolled, and bring it back when the
 * view mounts again — after its content has loaded (editors and pages arrive a moment later).
 */
export function useKeptPosition(ref: RefObject<HTMLElement | null>, key: string) {
  useLayoutEffect(() => {
    const body = ref.current;
    if (!body) return;
    let frame = 0;
    const record = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => positions.set(key, readingPosition(body)));
    };
    body.addEventListener("scroll", record, true);
    return () => {
      cancelAnimationFrame(frame);
      body.removeEventListener("scroll", record, true);
    };
  }, [ref, key]);
  useEffect(() => {
    const body = ref.current;
    const saved = positions.get(key);
    if (!body || !saved || (saved.page === null && saved.fraction === 0)) return;
    let tries = 0;
    let timer = 0;
    const attempt = () => {
      if (restorePosition(body, saved) || ++tries > 40) return;
      timer = window.setTimeout(attempt, 100);
    };
    attempt();
    return () => window.clearTimeout(timer);
  }, [ref, key]);
}

/** Remember a reading position for a key (the reader hands back where it stopped). */
export const keepPosition = (key: string, position: ReadingPosition) => positions.set(key, position);

export const keptPosition = (key: string): ReadingPosition | null => positions.get(key) ?? null;
