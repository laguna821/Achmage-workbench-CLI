import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { COVER_MARK_MS, coverFit, type Cover, type CoverKind } from "../../doc-cover.ts";

/**
 * The document's first page over its editor while the editor boots (doc-pages-first, point 1):
 * the picture of the revision being opened, where the editor will draw that page. A quiet
 * "여는 중" mark joins it only when the boot takes longer than COVER_MARK_MS. A click or key on it
 * is not lost silently: the mark says the editor is starting (input is not replayed into the
 * editor — it would land wherever the editor's own cursor starts).
 */
export function DocCover({ cover, kind, name }: { cover: Cover; kind: CoverKind; name: string }) {
  const root = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
  const [slow, setSlow] = useState(false);
  const [asked, setAsked] = useState(false);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = () => setBox({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), COVER_MARK_MS);
    return () => window.clearTimeout(timer);
  }, []);
  const fit = box ? coverFit(kind, box, cover) : null;
  const said = asked ? "편집기를 여는 중입니다. 곧 입력할 수 있습니다." : "여는 중";
  return (
    <div ref={root} className={`doc-cover kind-${kind}`} data-cover-revision={cover.revision} tabIndex={-1} aria-busy="true" aria-label={`${name} · 편집기를 여는 중`}
      onPointerDown={() => setAsked(true)} onKeyDown={(event) => { if (!event.metaKey && !event.ctrlKey && !event.altKey) setAsked(true); }}>
      {fit ? (
        <>
          <img className="doc-cover-page" src={cover.url} alt="" draggable={false}
            style={{ left: fit.left, top: fit.top, width: fit.width, height: fit.height }} />
          {/* The editor's chrome over the page, as in the editor (a long page runs under the status bar). */}
          <div className="doc-cover-rail" style={{ top: fit.band, width: fit.rail, bottom: fit.status }} />
          <div className="doc-cover-band" style={{ height: fit.band }} />
          <div className="doc-cover-status" style={{ height: fit.status }} />
        </>
      ) : null}
      {slow || asked ? <div className={`doc-cover-mark${asked ? " asked" : ""}`} role="status">{said}</div> : null}
    </div>
  );
}
