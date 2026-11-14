import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { Proposal } from "@workbench/contracts";
import type { State } from "./state.ts";
import type { TabUiState } from "./panes.ts";
import { viewDocument } from "./companion.ts";

// Work screen modes (design 3.2), by key while a document of the work is open: 대화 · 문서 · 검토 ·
// 나란히 · 읽기 (Alt+1–5). Each is also a control where the thing is: the companion's × (대화) and
// "탭으로 넓게 열기" (문서), a proposal's 미리보기 (검토), a file card or the note's ⋯ in the
// conversation (나란히: the document beside its conversation), the document head's 읽기.

export type WorkMode = "chat" | "doc" | "review" | "split" | "read";

export const WORK_MODES: { id: WorkMode; label: string; title: string }[] = [
  { id: "chat", label: "대화", title: "대화만" },
  { id: "doc", label: "문서", title: "문서를 탭으로 넓게" },
  { id: "review", label: "검토", title: "이 문서의 수정안 비교" },
  { id: "split", label: "나란히", title: "대화 옆에 문서" },
  { id: "read", label: "읽기", title: "화면 가득 쪽 넘기며 읽기 · Esc로 돌아감" },
];

type ModeViewOf = { kind: string; proposalId?: string | null; beside?: unknown };

/** The mode a view is in (null for views without modes: home, archive). */
export function modeOf(view: ModeViewOf, reading: boolean): WorkMode | null {
  if (reading) return "read";
  if (view.kind === "document") return view.proposalId ? "review" : "doc";
  if (view.kind === "work") return viewDocument(view) ? "split" : "chat";
  return null;
}

/**
 * The document the modes are about, or null for none: the document the view shows (its own tab's,
 * or the conversation's companion); else a document of the project open in a tab now (the one
 * shown last, else the newest tab). A document shown once and closed since does not count.
 */
export function modeDocument(view: { kind: string; artifactId?: unknown; beside?: unknown }, openTabs: string[], remembered: string | undefined): string | null {
  const shown = viewDocument(view);
  if (shown) return shown;
  return remembered && openTabs.includes(remembered) ? remembered : (openTabs[openTabs.length - 1] ?? null);
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

/** Alt+1–5 switch the work screen's modes (also from inside the input). */
export function useWorkModeKeys(enabled: boolean, onMode: (mode: WorkMode) => void) {
  const latest = useRef(onMode);
  latest.current = onMode;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      const mode = workModeKey(event);
      if (!mode) return;
      event.preventDefault();
      latest.current(mode);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}

/** What the conversation view takes from where it is shown. */
export type ModeProps = {
  /** A window of its own for one session: no tabs of the work's other sessions. */
  single?: boolean;
  /** One of several panes, or beside a companion: the input waits to be clicked (taking the focus would pull it from elsewhere). */
  paned?: boolean;
  /** Conversations and documents share the workspace's group tab bar. */
  groupedTabs?: boolean;
  uiState?: TabUiState;
  onUiState?: (ui: TabUiState) => void;
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
export function useKeptPosition(ref: RefObject<HTMLElement | null>, key: string, persisted?: { initial?: ReadingPosition; onChange?: (position: ReadingPosition) => void }) {
  const persistence = useRef(persisted);
  persistence.current = persisted;
  useLayoutEffect(() => {
    const body = ref.current;
    if (!body) return;
    let frame = 0;
    const record = () => {
      if (body.closest(".pane[hidden]")) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { const position = readingPosition(body); positions.set(key, position); persistence.current?.onChange?.(position); });
    };
    body.addEventListener("scroll", record, true);
    return () => {
      cancelAnimationFrame(frame);
      body.removeEventListener("scroll", record, true);
    };
  }, [ref, key]);
  useEffect(() => {
    const body = ref.current;
    const saved = persistence.current?.initial ?? positions.get(key);
    if (!body || !saved || (saved.page === null && saved.fraction === 0 && !saved.top)) return;
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
