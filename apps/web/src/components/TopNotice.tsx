import { useEffect, useRef, useState } from "react";
import { lifetime, type NoticeSlot } from "../top-notice.ts";
import { EngineMark } from "./EngineMark.tsx";
import { Icon } from "./Icon.tsx";

type Action = { label: string; run: () => void };

/**
 * The top bar's one status slot, in the title's place: an answer off screen, or the result of an action.
 * `standing`: a condition that lasts until one of its ways out is taken (a layout changed in another
 * window): no clock and no close, and its actions (`slot.action`, `more`) leave it to its cause.
 */
export function TopNotice({ slot, serial, onOpen, onClose, standing = false, more, className }: { slot: NoticeSlot; serial: number; onOpen: (id: string) => void; onClose: () => void; standing?: boolean; more?: Action; className?: string }) {
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false);
  // The app re-renders while engines stream; only a new notice or a released hold restarts the clock.
  const close = useRef(onClose); close.current = onClose;
  const stay = lifetime(slot);
  useEffect(() => {
    if (hovered || focused || standing) return;
    const timer = window.setTimeout(() => close.current(), stay);
    return () => window.clearTimeout(timer);
  }, [serial, stay, hovered, focused, standing]);
  const text = slot.kind === "completion" ? slot.completion.text : slot.text;
  const others = slot.kind === "completion" ? slot.completion.others.length : 0;
  return (
    <div className={`top-notice${className ? ` ${className}` : ""}`} data-kind={slot.kind} role={slot.kind === "error" ? "alert" : "status"}
      onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); }}>
      {slot.kind === "completion" ? <EngineMark provider={slot.completion.provider} size={14} /> : slot.kind === "error" ? <Icon name="alert" size={14} /> : null}
      <span className="top-notice-text" title={text}>{text}</span>
      {others ? <span className="top-notice-more" aria-label={`외 ${others}개`}>+{others}</span> : null}
      {slot.kind === "completion"
        ? <button type="button" className="top-notice-action" onClick={() => { onOpen(slot.completion.id); onClose(); }}>열기</button>
        : slot.action ? <button type="button" className="top-notice-action" onClick={() => { slot.action!.run(); if (!standing) onClose(); }}>{slot.action.label}</button> : null}
      {more ? <button type="button" className="top-notice-action" onClick={() => { more.run(); if (!standing) onClose(); }}>{more.label}</button> : null}
      {standing ? null : <button type="button" className="top-notice-close" aria-label="알림 닫기" title="닫기" onClick={onClose}><Icon name="x" size={12} /></button>}
    </div>
  );
}
