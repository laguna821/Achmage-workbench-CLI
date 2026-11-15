import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Api } from "../../api.ts";
import { nearTranscriptEnd } from "../../conversation/reading-anchor.ts";

/**
 * "원문": the conversation as the Markdown file it is — the very text "마크다운 복사" gives, front
 * matter and all. Read-only; fetched again when `pulse` changes (an item completed, the turn ended).
 */
export function RawNote({ api, sessionId, pulse, head, running = false }: { api: Pick<Api, "exportMarkdown">; sessionId: string; pulse: string; head?: ReactNode; running?: boolean }) {
  const [text, setText] = useState<{ sessionId: string; markdown: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  // It opens at the front matter; a reader who went to the end follows the note as it grows.
  const atEnd = useRef(false);
  useEffect(() => {
    let live = true;
    api.exportMarkdown(sessionId, { target: "text" })
      .then((result) => { if (live) { setText({ sessionId, markdown: result.markdown }); setFailed(false); } })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [api, sessionId, pulse]);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && atEnd.current && text) element.scrollTop = element.scrollHeight;
  }, [text]);
  const shown = text?.sessionId === sessionId ? text.markdown : null;
  return (
    <div className="transcript-wrap">
      <div className="transcript raw-note" role="region" aria-label="대화 원문" tabIndex={0} ref={scroller}
        onScroll={(event) => { atEnd.current = nearTranscriptEnd(event.currentTarget); }}>
        <div className="column transcript-inner">
          {head}
          {shown !== null ? <pre className="raw-note-text">{shown}</pre> : null}
          {/* Items land here once complete; until the turn ends the page must not look finished. */}
          {shown !== null && running ? <p className="raw-note-pending" role="status">답을 받는 중입니다 · 끝난 부분부터 이어 붙습니다</p> : null}
          {shown !== null ? null
            : <div className="empty-hint" role="status">{failed ? "원문을 불러오지 못했습니다." : "원문을 불러오는 중…"}</div>}
        </div>
      </div>
    </div>
  );
}
