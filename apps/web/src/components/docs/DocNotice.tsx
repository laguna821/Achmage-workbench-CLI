import { useRef, useState } from "react";
import { Icon, type IconName } from "../Icon.tsx";
import { AnchoredLayer } from "../ui/AnchoredLayer.tsx";
import { severest, type DocNotice, type NoticeKey, type NoticeTone } from "./doc-notices.ts";

const GLYPH: Record<NoticeTone, IconName> = { error: "alert", attention: "bell", info: "info" };

function Keys({ keys, first }: { keys: NoticeKey[]; first: boolean }) {
  if (!keys.length) return null;
  return (
    <span className="doc-notice-keys">
      {keys.map((key) => (
        <button key={key.label} type="button" className={`button small${key.primary && first ? " primary" : ""}`} disabled={key.disabled}
          title={key.disabled ? key.reason : undefined} onClick={key.run}>
          {key.label}
        </button>
      ))}
    </span>
  );
}

/** One notice as a line: the tone's glyph, the words, its keys. */
function NoticeRow({ notice, first }: { notice: DocNotice; first: boolean }) {
  return (
    <div className={`doc-notice-row${notice.hook ? ` ${notice.hook}` : ""}`} data-kind={notice.kind} data-tone={notice.tone}
      role={first ? (notice.tone === "error" ? "alert" : "status") : undefined}>
      <Icon name={GLYPH[notice.tone]} size={16} className="doc-notice-glyph" />
      <span className="doc-notice-text">{notice.text}</span>
      <Keys keys={notice.keys} first={first} />
    </div>
  );
}

/**
 * The document's one notice line under its head: the most urgent notice (the list is already in
 * precedence order, `orderNotices`), and "외 N건" opening the others, each with all its keys.
 */
export function DocNoticeLine({ notices }: { notices: DocNotice[] }) {
  const [open, setOpen] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  if (!notices.length) return null;
  const [first, ...rest] = notices;
  return (
    <div className="doc-notice" data-tone={first.tone} data-count={notices.length}>
      <NoticeRow notice={first} first />
      {rest.length ? (
        <>
          <button ref={more} type="button" className="text-button doc-notice-more" data-tone={severest(rest)} aria-haspopup="dialog" aria-expanded={open}
            aria-label={`알림 ${rest.length}건 더 보기${severest(rest) === "error" ? ", 오류 포함" : ""}`} onClick={() => setOpen(!open)}>
            외 {rest.length}건 <Icon name={open ? "chevronUp" : "chevronDown"} size={14} />
          </button>
          <AnchoredLayer open={open} onClose={() => setOpen(false)} anchor={more} align="end" label="이 문서의 다른 알림" className="doc-notice-list">
            {rest.map((notice, index) => <NoticeRow key={notice.id ?? `${notice.kind}-${index}`} notice={notice} first={false} />)}
          </AnchoredLayer>
        </>
      ) : null}
    </div>
  );
}
