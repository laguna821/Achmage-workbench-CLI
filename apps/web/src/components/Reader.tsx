import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { isOfficeFormat, type Artifact } from "@workbench/contracts";
import type { Api } from "../api.ts";
import type { State } from "../state.ts";
import { designThumb, revisionText } from "../design.ts";
import { ObsidianMarkdown, obsidianComponents } from "../markdown/obsidian.tsx";
import { officePageImage, officePages } from "../office.ts";
import { pdfDocument, pdfPageImage } from "../pdfpages.ts";
import type { ReadingPosition } from "../workmodes.ts";
import { FormatBadge } from "./DocCards.tsx";
import { diagramComponents } from "./Diagram.tsx";
import { Icon } from "./Icon.tsx";
import { HtmlView } from "./docs/HtmlView.tsx";
import "../styles/views.css";

const DRAWN = obsidianComponents(diagramComponents());

// "읽기": the document as its reader sees it, filling the window, a page at a time. Paged formats
// show their real pages (office page images, Ieum Hangul pages, PDF.js, the design renderer); text is
// laid out in pages of the window's size. Esc returns to the mode before, at the same page.

type Content =
  | { kind: "flow"; text: string; markdown: boolean }
  | { kind: "pages"; count: number; image: (index: number, width: number) => Promise<string> }
  | { kind: "frame" }
  | { kind: "error"; message: string };

async function load(api: Api, state: State, artifact: Artifact): Promise<Content> {
  const revision = artifact.revision;
  if (artifact.format === "html") return { kind: "frame" };
  if (artifact.format === "pdf") {
    const pdf = await pdfDocument(api, artifact.id, revision);
    return { kind: "pages", count: pdf.numPages, image: (index, width) => pdfPageImage(pdf, index + 1, width) };
  }
  if (artifact.format === "design") {
    const parsed = JSON.parse(await revisionText(artifact.id, revision)) as { pages?: unknown[] };
    const count = Array.isArray(parsed.pages) ? parsed.pages.length : 1;
    return { kind: "pages", count, image: (index, width) => designThumb({ artifactId: artifact.id, revision }, index, Math.min(1600, Math.round(width))) };
  }
  if (isOfficeFormat(artifact.format) && state.tools?.ieumoffice.available) {
    const source = { artifactId: artifact.id, revision };
    const pages = await officePages(source);
    return { kind: "pages", count: pages.length, image: (index) => officePageImage(source, pages[index]!.page) };
  }
  if ((artifact.format === "hwpx" || artifact.format === "hwp") && state.tools?.hwp?.available) {
    const { pages } = await api.pages(artifact.id, revision);
    return { kind: "pages", count: pages.length, image: async (index) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(pages[index]!.svg)}` };
  }
  const { text } = await api.artifactText(artifact.id, revision);
  return { kind: "flow", text, markdown: artifact.format !== "text" };
}

/** One page image, fitted to the stage; the neighbours are drawn ahead. */
function PageImage({ content, index, width }: { content: Extract<Content, { kind: "pages" }>; index: number; width: number }) {
  const [image, setImage] = useState<{ index: number; url: string } | { index: number; error: string } | null>(null);
  useEffect(() => {
    let active = true;
    content.image(index, width).then(
      (url) => active && setImage({ index, url }),
      (error: Error) => active && setImage({ index, error: error.message }),
    );
    for (const near of [index + 1, index - 1]) if (near >= 0 && near < content.count) void content.image(near, width).catch(() => undefined);
    return () => {
      active = false;
    };
  }, [content, index, width]);
  if (!image || image.index !== index) return <div className="reader-wait">그리는 중…</div>;
  if ("error" in image) return <div className="reader-wait">{image.error}</div>;
  return <img className="reader-page" src={image.url} alt={`${index + 1}쪽`} />;
}

export default function Reader({ api, state, artifact, start, onClose }: { api: Api; state: State; artifact: Artifact; start: ReadingPosition; onClose: (position: ReadingPosition) => void }) {
  const [content, setContent] = useState<Content | null>(null);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const stage = useRef<HTMLDivElement>(null);
  const flow = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const placed = useRef(false);

  useEffect(() => {
    let active = true;
    load(api, state, artifact).then(
      (loaded) => active && setContent(loaded),
      (error: Error) => active && setContent({ kind: "error", message: error.message }),
    );
    return () => {
      active = false;
    };
    // The revision decides what is read; tool state only chooses how.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, artifact.id, artifact.revision]);

  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setSize({ width: element.clientWidth, height: element.clientHeight }));
    observer.observe(element);
    setSize({ width: element.clientWidth, height: element.clientHeight });
    return () => observer.disconnect();
  }, []);

  // Text pages: one column the width of a page; the columns that overflow are the next pages.
  const columnWidth = Math.max(280, Math.min(760, size.width - 96));
  const gap = 96;
  const measureFlow = useCallback(() => {
    const element = flow.current;
    if (!element) return;
    const count = Math.max(1, Math.round((element.scrollWidth + gap) / (columnWidth + gap)));
    setPages(count);
  }, [columnWidth]);
  useLayoutEffect(() => {
    if (content?.kind !== "flow") return;
    measureFlow();
    // Pictures and diagrams settle a moment later.
    const timers = [300, 1200].map((delay) => window.setTimeout(measureFlow, delay));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [content, size, measureFlow]);
  useEffect(() => {
    if (content?.kind === "pages") setPages(Math.max(1, content.count));
    else if (content?.kind === "frame" || content?.kind === "error") setPages(1);
  }, [content]);

  // Start where the document view was read.
  useEffect(() => {
    if (placed.current || !content || content.kind === "error") return;
    if (content.kind === "flow" && pages <= 1 && start.fraction > 0) return;
    placed.current = true;
    setPage(start.page !== null && content.kind === "pages" ? Math.min(start.page, pages - 1) : Math.round(start.fraction * (pages - 1)));
  }, [content, pages, start]);

  const shown = Math.min(page, pages - 1);
  useLayoutEffect(() => {
    if (flow.current) flow.current.scrollLeft = shown * (columnWidth + gap);
  }, [shown, columnWidth, pages]);

  const position = useCallback((): ReadingPosition => ({ page: content?.kind === "pages" ? shown : null, fraction: pages > 1 ? shown / (pages - 1) : 0 }), [content, shown, pages]);
  const close = useCallback(() => onClose(position()), [onClose, position]);
  const go = useCallback((next: number) => setPage(Math.max(0, Math.min(pages - 1, next))), [pages]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "Escape") {
        // Only the reader closes: nothing under it (an approval's Esc) hears this one.
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      const forward = event.key === "ArrowRight" || event.key === "PageDown" || (event.key === " " && !event.shiftKey);
      const back = event.key === "ArrowLeft" || event.key === "PageUp" || (event.key === " " && event.shiftKey);
      if (!forward && !back && event.key !== "Home" && event.key !== "End") return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Home") go(0);
      else if (event.key === "End") go(pages - 1);
      else go(shown + (forward ? 1 : -1));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close, go, pages, shown]);

  const paged = content?.kind === "flow" || content?.kind === "pages";
  return (
    <div className="reader" role="dialog" aria-modal="true" aria-label={`읽기 · ${artifact.name}`}>
      <header className="reader-bar">
        <FormatBadge format={artifact.format} />
        <span className="reader-name">{artifact.name}</span>
        <span className="muted">r{artifact.revision}</span>
        <span className="reader-spacer" />
        {paged ? (
          <>
            <button type="button" className="icon-button" onClick={() => go(shown - 1)} disabled={shown <= 0} aria-label="이전 쪽" title="이전 쪽 (←)">
              <Icon name="arrowLeft" size={16} />
            </button>
            <span className="reader-count" aria-live="polite">
              {shown + 1} / {pages}
            </span>
            <button type="button" className="icon-button" onClick={() => go(shown + 1)} disabled={shown >= pages - 1} aria-label="다음 쪽" title="다음 쪽 (→)">
              <Icon name="arrowRight" size={16} />
            </button>
          </>
        ) : null}
        <button type="button" className="text-button reader-close" onClick={close} title="읽기를 닫고 이전 화면으로">
          닫기 <kbd>Esc</kbd>
        </button>
      </header>
      <div
        ref={stage}
        className={`reader-stage kind-${content?.kind ?? "wait"}`}
        onClick={(event) => {
          if (!paged || (event.target as HTMLElement).closest("a, button")) return;
          const box = event.currentTarget.getBoundingClientRect();
          const x = (event.clientX - box.left) / box.width;
          if (x < 0.3) go(shown - 1);
          else if (x > 0.7) go(shown + 1);
        }}
      >
        {!content ? (
          <div className="reader-wait">여는 중…</div>
        ) : content.kind === "error" ? (
          <div className="reader-wait">{content.message}</div>
        ) : content.kind === "frame" ? (
          <div className="reader-frame">
            <HtmlView api={api} artifactId={artifact.id} revision={artifact.revision} />
          </div>
        ) : content.kind === "pages" ? (
          size.width ? <PageImage content={content} index={shown} width={Math.min(1600, size.width)} /> : null
        ) : (
          <div ref={flow} className="reader-flow" style={{ width: columnWidth, columnWidth, columnGap: gap, height: Math.max(200, size.height - 56) }}>
            {content.markdown ? (
              <div className="markdown">
                <ObsidianMarkdown components={DRAWN}>{content.text}</ObsidianMarkdown>
              </div>
            ) : (
              <div className="reader-plain">{content.text}</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
