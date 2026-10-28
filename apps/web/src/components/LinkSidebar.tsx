import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";
import { LINK_REASON_LABEL, type SessionLink } from "@workbench/contracts";
import { goalLine, hopsText, linkOfSession, participantName, useLinks } from "../links.ts";
import "../styles/links.css";

/** "⇄ 3/6" on the sidebar row of a session in a live link. */
export function LinkBadge({ sessionId }: { sessionId: string }) {
  const { state } = useLinks();
  const link = linkOfSession(state, sessionId);
  if (!link) return null;
  const paused = link.state === "paused";
  const others = link.participants.filter((id) => id !== sessionId).map((id) => participantName(state.sessions[id]));
  return (
    <span
      className={`linked-badge${paused ? " paused" : ""}`}
      title={`세션 잇기 ${hopsText(link)}${paused ? ` · ${link.reason ? LINK_REASON_LABEL[link.reason] : "멈춤"}` : ""} · 상대: ${others.join(", ")} · 목표: ${goalLine(link.goal, 80)}`}
    >
      ⇄ {hopsText(link)}
    </span>
  );
}

type Line = { id: string; top: number; height: number; ticks: number[]; dot: { from: number; to: number; key: string } | null; paused: boolean };

/**
 * A thin bracket along the right edge of the tree joining the rows of each live link's sessions (a
 * work row stands for a session folded inside it). On each hand-over a dot runs once along it from
 * the session that answered to the next one (not with reduced motion: see links.css).
 */
export function LinkLines({ tree }: { tree: RefObject<HTMLDivElement | null> }) {
  const { state } = useLinks();
  const [lines, setLines] = useState<Line[]>([]);
  const live = Object.values(state.links).filter((link) => link.state !== "ended");

  // Measured after every render of the tree (rows fold, move and appear), only while a link is live.
  useLayoutEffect(() => {
    const element = tree.current;
    if (!element || !live.length) {
      setLines((current) => (current.length ? [] : current));
      return;
    }
    const box = element.getBoundingClientRect();
    const centre = (sessionId: string) => {
      const session = state.sessions[sessionId];
      const row =
        element.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(sessionId)}"]`) ??
        (session ? element.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(session.workId)}"]`) : null);
      if (!row) return null;
      const rect = row.getBoundingClientRect();
      return Math.round(rect.top - box.top + rect.height / 2);
    };
    const next: Line[] = [];
    for (const link of live) {
      const ys = link.participants.map(centre);
      const known = [...new Set(ys.filter((y): y is number => y !== null))].sort((a, b) => a - b);
      if (known.length < 2) continue;
      const top = known[0]!;
      const height = known[known.length - 1]! - top;
      const to = ys[link.turn];
      const from = ys[(link.turn - 1 + link.participants.length) % link.participants.length];
      const dot = link.state === "active" && link.hops > 1 && to != null && from != null && to !== from ? { from: from - top, to: to - top, key: `${link.id}:${link.hops}` } : null;
      next.push({ id: link.id, top, height, ticks: known.map((y) => y - top), dot, paused: link.state === "paused" });
    }
    const key = (list: Line[]) => JSON.stringify(list);
    setLines((current) => (key(current) === key(next) ? current : next));
  });

  // Rows move when the window or the sidebar is resized.
  useLayoutEffect(() => {
    const element = tree.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setLines((current) => [...current]));
    observer.observe(element);
    return () => observer.disconnect();
  }, [tree]);

  if (!lines.length) return null;
  return (
    <div className="linked-lines" aria-hidden>
      {lines.map((line, index) => (
        <div key={line.id} className={`linked-line${line.paused ? " paused" : ""}`} style={{ top: line.top, height: line.height, right: 2 + index * 5 } as CSSProperties}>
          {line.ticks.map((tick) => (
            <span key={tick} className="linked-tick" style={{ top: tick }} />
          ))}
          {line.dot ? <span key={line.dot.key} className="linked-dot" style={{ "--from": `${line.dot.from}px`, "--to": `${line.dot.to}px` } as CSSProperties} /> : null}
        </div>
      ))}
    </div>
  );
}

/** Whether two sessions can be linked now (neither is in a live link already). */
export const linkable = (links: SessionLink[], ids: string[]) => !links.some((link) => link.state !== "ended" && link.participants.some((id) => ids.includes(id)));
