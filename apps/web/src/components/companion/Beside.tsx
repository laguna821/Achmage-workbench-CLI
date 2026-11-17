import { withParticle } from "@workbench/contracts";
import { createContext, useContext, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { AGENT_COLUMN_MIN, CHAT_MIN, COLUMN_GAP, besideFit, clampRatio } from "../../companion.ts";
import { usePhoneLayout } from "../../mobile-layout.ts";
import { Icon } from "../Icon.tsx";
import "../../styles/companion.css";

// What the arrangements on screen ask the right sidebar to leave them: for each one that is side
// by side now, the width its two columns need beyond a pane's own minimum. The sidebar docks only
// while the panes keep their minimum plus this; otherwise it lies over (components/right).
const rooms = new Map<symbol, number>();
const watchers = new Set<() => void>();
const watchRooms = (changed: () => void) => { watchers.add(changed); return () => { watchers.delete(changed); }; };
export const besideRoom = () => [...rooms.values()].reduce((sum, room) => sum + room, 0);
export const useBesideRoom = () => useSyncExternalStore(watchRooms, besideRoom);

/**
 * 곁 화면: a conversation column on the left, what it is about (a document, a web page) on the
 * right — the one arrangement for a conversation with its document, a document with its AI and a
 * web page with its AI. Either side may be absent; a side that stays keeps its identity (it is
 * never remounted when the other comes or goes).
 *
 * Side by side only while both keep their minimum width (measured). Otherwise `over` lies over
 * the other, which is never squeezed: a document or page fills the tab over its conversation.
 * A document's or page's own AI (`over: "chat"`), release unit A:
 * - on a desktop it narrows to its own minimum (AGENT_COLUMN_MIN) beside what it is about; when even
 *   that does not fit, the pane shows ONE AT A TIME with a visible two-way key (the AI, the document)
 *   — never a sheet over the document, never a silent swap;
 * - on a phone (touch, or a window under 40rem) it REPLACES what it is about, full width, with ONE way
 *   back: the back key at its top (or Esc); its own close key is not drawn (useBesideReplaces).
 * What is behind stays mounted, hidden (its place, its edits).
 */
const Replaces = createContext(false);
/** True inside an AI that replaces its document on a phone: the back key is its one way back. */
export const useBesideReplaces = () => useContext(Replaces);
export function Beside({ chat, content, over, chatMin = CHAT_MIN, contentMin = CHAT_MIN, ratio, onRatio, resetRatio = 0.4, chatLabel, contentLabel, backLabel, onDismiss, onCovered }: {
  chat: ReactNode | null;
  content: ReactNode | null;
  /** Which side is the companion: the one that lies over the other when both do not fit. */
  over: "chat" | "content";
  chatMin?: number;
  contentMin?: number;
  /** The conversation's share of the width, and where a new one is kept. */
  ratio: number;
  onRatio: (ratio: number) => void;
  /** The share a double press on the handle goes back to. */
  resetRatio?: number;
  chatLabel: string;
  contentLabel: string;
  /** What the back key names when the AI replaces it on a narrow screen (a document's name); else contentLabel. */
  backLabel?: string;
  /** Close the companion (the scrim under a conversation laid over). */
  onDismiss?: () => void;
  /** The conversation is covered by what lies over it (true), or back on screen (false). */
  onCovered?: (covered: boolean) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [live, setLive] = useState<number | null>(null);
  const both = chat !== null && content !== null;
  useLayoutEffect(() => {
    const element = host.current;
    if (!element || !both) return;
    const measure = () => setWidth(element.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [both]);
  // The last decision, so the arrangement does not flip at the threshold.
  const was = useRef<"beside" | "over">("beside");
  const shown = clampRatio(live ?? ratio);
  // A tab sent behind another measures 0: the last measured width stands while it is hidden, so it
  // keeps its arrangement and the app still knows whether its conversation is covered. A pane never
  // measured is taken as side by side (nothing said covered).
  const measured = useRef(0);
  if (width > 0) measured.current = width;
  const phone = usePhoneLayout();
  // A document's AI on a desktop gives up width before it gives up its place beside the document.
  const columnMin = over === "chat" && !phone ? Math.min(chatMin, AGENT_COLUMN_MIN) : chatMin;
  const fit = both ? besideFit({ width: width || measured.current, chatMin: columnMin, contentMin, ratio: shown, was: was.current }) : null;
  if (fit) was.current = fit.mode;
  const laidOver = fit?.mode === "over";
  const replaces = laidOver && over === "chat" && phone;
  // Desktop, no room for both: one at a time, chosen by the pane's own key. The AI just opened is in front.
  const oneAtATime = laidOver && over === "chat" && !phone;
  const [front, setFront] = useState<"chat" | "content">("chat");
  const hadChat = useRef(chat !== null);
  if ((chat !== null) !== hadChat.current) { hadChat.current = chat !== null; if (chat !== null && front !== "chat") setFront("chat"); }
  // Side by side and measured (a tab behind has no width): the two minimums are this pane's need.
  const room = fit?.mode === "beside" && width > 0 ? columnMin + COLUMN_GAP + contentMin - CHAT_MIN : 0;
  const [self] = useState(() => Symbol("beside"));
  useLayoutEffect(() => {
    if (!room) return;
    rooms.set(self, room);
    watchers.forEach((changed) => changed());
    return () => { rooms.delete(self); watchers.forEach((changed) => changed()); };
  }, [self, room]);
  const covered = laidOver ? (over === "chat" ? (oneAtATime && front === "content" ? "chat" : "content") : "chat") : null;

  // A conversation under its companion is not on screen: the app is told (and told again when it is back).
  const chatCovered = covered === "chat";
  const tellCovered = useRef(onCovered);
  tellCovered.current = onCovered;
  useLayoutEffect(() => {
    if (!chatCovered) return;
    tellCovered.current?.(true);
    return () => tellCovered.current?.(false);
  }, [chatCovered]);

  const drag = (event: ReactPointerEvent) => {
    event.preventDefault();
    const box = host.current?.getBoundingClientRect();
    if (!box || box.width <= COLUMN_GAP) return;
    let latest = shown;
    const onMove = (move: PointerEvent) => {
      latest = clampRatio((move.clientX - box.left) / (box.width - COLUMN_GAP));
      setLive(latest);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setLive(null);
      onRatio(latest);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  const nudge = (event: ReactKeyboardEvent) => {
    const step = event.key === "ArrowLeft" ? -0.02 : event.key === "ArrowRight" ? 0.02 : 0;
    if (!step) return;
    event.preventDefault();
    onRatio(clampRatio(shown + step));
  };

  // On a phone Esc in the AI goes back to the document, as its back key does (unless something inside used it).
  const escapeBack = (event: ReactKeyboardEvent) => {
    if (!replaces || !onDismiss || event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return;
    event.preventDefault();
    onDismiss();
  };
  const otherName = backLabel ?? contentLabel;
  const aiName = chatLabel.replace(/\s*대화$/, "");

  // Keyed children of one parent: a side keeps its place in the tree while the other comes and goes.
  return (
    <div ref={host} className="beside" data-fit={fit ? fit.mode : "single"} data-over={over} data-narrow={replaces ? "replace" : oneAtATime ? "one" : undefined} data-front={oneAtATime ? front : undefined}>
      {oneAtATime ? (
        <div key="switch" className="segmented beside-switch" role="group" aria-label="한 번에 하나씩 보기">
          <button type="button" className={`beside-switch-key${front === "chat" ? " active" : ""}`} aria-pressed={front === "chat"} onClick={() => setFront("chat")}>
            <Icon name="chat" size={16} /><span>{aiName}</span>
          </button>
          <button type="button" className={`beside-switch-key${front === "content" ? " active" : ""}`} aria-pressed={front === "content"} onClick={() => setFront("content")}>
            <Icon name="file" size={16} /><span className="beside-back-name">{otherName}</span>
          </button>
        </div>
      ) : null}
      {chat !== null ? (
        <section key="chat" className="beside-chat" aria-label={chatLabel} inert={covered === "chat"} aria-hidden={covered === "chat" ? true : undefined}
          data-covers-web={laidOver && over === "chat" && covered !== "chat" ? "" : undefined} onKeyDown={escapeBack}
          style={fit?.mode === "beside" ? (fit.chat === null ? { flex: `0 0 ${Math.round(shown * 100)}%` } : { flex: `0 0 ${fit.chat}px` }) : undefined}>
          {replaces && onDismiss ? (
            <button type="button" className="ghost-button small beside-back" onClick={onDismiss} aria-label={`${withParticle(`${backLabel ?? contentLabel}`, "으로/로")} 돌아가기`}>
              <Icon name="chevronLeft" size={16} /><span className="beside-back-name">{backLabel ?? contentLabel}</span>
            </button>
          ) : null}
          <Replaces.Provider value={replaces && Boolean(onDismiss)}>{chat}</Replaces.Provider>
        </section>
      ) : null}
      {fit?.mode === "beside" ? (
        <div key="divider" className="beside-divider" role="separator" aria-orientation="vertical" aria-label={`${withParticle(`${chatLabel}`, "와/과")} ${contentLabel} 사이`} aria-valuenow={Math.round(shown * 100)} aria-valuemin={20} aria-valuemax={70}
          tabIndex={0} onPointerDown={drag} onKeyDown={nudge} onDoubleClick={() => onRatio(resetRatio)} title="끌어서 너비 조절 · 두 번 누르면 처음 너비" />
      ) : null}
      {content !== null ? (
        <section key="content" className="beside-content" aria-label={contentLabel} inert={covered === "content"} aria-hidden={covered === "content" ? true : undefined}>
          {content}
        </section>
      ) : null}
    </div>
  );
}

/** A column width kept on this device (a document's or a web page's AI beside it). */
export function useStoredRatio(key: string, fallback: number): [number, (ratio: number) => void] {
  const [ratio, setRatio] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(key));
      return saved > 0 && saved < 1 ? saved : fallback;
    } catch { return fallback; }
  });
  return [ratio, (next: number) => {
    setRatio(next);
    try { localStorage.setItem(key, String(next)); } catch { /* kept for this view only */ }
  }];
}
