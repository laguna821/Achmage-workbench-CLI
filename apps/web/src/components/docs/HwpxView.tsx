import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { Artifact } from "@workbench/contracts";
import type { Api } from "../../api.ts";

type Page = { page: number; width: number; height: number; svg: string };

/** A finger moved far enough sideways, quickly enough and mostly sideways: the next or previous page. */
export function swipeStep(dx: number, dy: number, ms: number): -1 | 0 | 1 {
  if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.5 || ms > 800) return 0;
  return dx < 0 ? 1 : -1;
}
export const ZOOM_MIN = 1, ZOOM_MAX = 4;
/** Two fingers apart → nearer: the zoom follows the ratio of their distances, within 1×–4×. */
export function pinchZoom(base: number, startDistance: number, distance: number): number {
  if (!(startDistance > 0) || !(distance > 0)) return base;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(base * (distance / startDistance) * 100) / 100));
}
const coarse = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;

/**
 * Saved Hangul pages rendered by the same Ieum rhwp engine as the document editor.
 * Shown as images (never inline SVG), so document content cannot run anything in the app.
 * On a touch screen (a phone opening the PC's 작업실) the pages are read one at a time: swipe for
 * the next or previous page, pinch (or double-tap) to zoom, and pan the zoomed page with one finger.
 */
export function HwpxView({ api, artifact, revision }: { api: Api; artifact: Artifact; revision: number }) {
  const [pages, setPages] = useState<Page[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [touch] = useState(coarse);

  useEffect(() => {
    let cancelled = false;
    setPages(null);
    setError(null);
    api
      .pages(artifact.id, revision)
      .then((result) => {
        // A preview of an older revision never replaces the newer one.
        if (!cancelled && result.revision === revision) setPages(result.pages);
      })
      .catch((reason: Error) => !cancelled && setError(reason.message));
    return () => {
      cancelled = true;
    };
  }, [api, artifact.id, revision]);

  const image = (page: Page, style?: CSSProperties) => <img
    key={`${revision}:${page.page}`}
    className="hwpx-page"
    alt={`${page.page}쪽`}
    draggable={false}
    src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(page.svg)}`}
    style={{ aspectRatio: `${page.width} / ${page.height}`, ...style }}
  />;
  return (
    <div className={`hwpx-view${touch ? " hwpx-touch" : ""}`}>
      <div className="doc-tools">
        <span className="muted">
          {pages ? `${pages.length}쪽, ${revision}판` : error ? "쪽을 그리지 못했습니다" : "쪽을 그리는 중"}
        </span>
      </div>
      {touch && pages?.length ? <TouchPages key={revision} pages={pages} image={image} /> : <div className="hwpx-stage">
        {error ? <div className="notice notice-error">{error}</div> : null}
        {pages?.map((page) => image(page))}
      </div>}
      {touch && error ? <div className="notice notice-error">{error}</div> : null}
    </div>
  );
}

function TouchPages({ pages, image }: { pages: Page[]; image(page: Page, style?: CSSProperties): ReactNode }) {
  const [index, setIndex] = useState(0), [zoom, setZoom] = useState(1);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ x: number; y: number; at: number; pinch?: { distance: number; base: number } } | null>(null);
  const lastTap = useRef(0);
  const go = (step: number) => { setIndex((current) => Math.min(pages.length - 1, Math.max(0, current + step))); setZoom(1); };
  const distance = () => { const [a, b] = [...pointers.current.values()]; return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0; };
  const down = (event: ReactPointerEvent) => {
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2) gesture.current = { x: event.clientX, y: event.clientY, at: Date.now(), pinch: { distance: distance(), base: zoom } };
    else if (pointers.current.size === 1) gesture.current = { x: event.clientX, y: event.clientY, at: Date.now() };
  };
  const move = (event: ReactPointerEvent) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const pinch = gesture.current?.pinch;
    if (pinch && pointers.current.size === 2) setZoom(pinchZoom(pinch.base, pinch.distance, distance()));
  };
  const up = (event: ReactPointerEvent) => {
    const start = gesture.current;
    pointers.current.delete(event.pointerId);
    if (!start || pointers.current.size) return;
    gesture.current = null;
    if (start.pinch) return;
    const dx = event.clientX - start.x, dy = event.clientY - start.y, ms = Date.now() - start.at;
    // A zoomed page pans with the finger (the stage scrolls natively); swipes turn pages only at 1×.
    if (zoom === 1) { const step = swipeStep(dx, dy, ms); if (step) { go(step); return; } }
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
      const now = Date.now();
      if (now - lastTap.current < 300) { setZoom((current) => current > 1 ? 1 : 2); lastTap.current = 0; }
      else lastTap.current = now;
    }
  };
  const page = pages[index]!;
  return <div className="hwpx-touch-reader">
    <div className="hwpx-touch-stage" role="group" aria-roledescription="쪽 넘기기" aria-label={`${page.page}쪽 / ${pages.length}쪽`} tabIndex={0}
      data-zoom={zoom} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={(event) => { pointers.current.delete(event.pointerId); gesture.current = null; }}
      onKeyDown={(event) => { if (event.key === "ArrowRight" || event.key === "PageDown") { event.preventDefault(); go(1); } else if (event.key === "ArrowLeft" || event.key === "PageUp") { event.preventDefault(); go(-1); } }}>
      {image(page, { width: `${zoom * 100}%`, maxWidth: "none" })}
    </div>
    <div className="hwpx-touch-bar">
      <button type="button" className="button" disabled={index === 0} onClick={() => go(-1)} aria-label="이전 쪽">이전</button>
      <span className="muted" aria-live="polite">{page.page} / {pages.length}쪽{zoom > 1 ? ` · ${Math.round(zoom * 100)}%` : ""}</span>
      {zoom > 1 ? <button type="button" className="text-button" onClick={() => setZoom(1)}>원래 크기</button> : null}
      <button type="button" className="button" disabled={index === pages.length - 1} onClick={() => go(1)} aria-label="다음 쪽">다음</button>
    </div>
  </div>;
}
