import { useEffect, useRef, useState } from "react";
import { getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "./pdf-text-layer.css";
import type { Api } from "../../api.ts";
import type { EditorSelection } from "./MarkdownEditor.tsx";

GlobalWorkerOptions.workerSrc = workerUrl;

function Page({ pdf, number, width, selected, onToggle }: { pdf: PDFDocumentProxy; number: number; width: number; selected: boolean; onToggle: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const textLayer = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(number <= 2);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  // Pages render when they come near the screen.
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new IntersectionObserver((entries) => entries.some((entry) => entry.isIntersecting) && setVisible(true), { rootMargin: "800px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !canvas.current || !textLayer.current) return;
    let cancelled = false;
    let task: { cancel: () => void } | null = null;
    void (async () => {
      const page = await pdf.getPage(number);
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      const scale = width / base.width;
      const viewport = page.getViewport({ scale });
      const ratio = window.devicePixelRatio || 1;
      const target = canvas.current!;
      target.width = Math.floor(viewport.width * ratio);
      target.height = Math.floor(viewport.height * ratio);
      target.style.width = `${viewport.width}px`;
      target.style.height = `${viewport.height}px`;
      setSize({ width: viewport.width, height: viewport.height });
      const renderTask = page.render({ canvas: target, viewport: page.getViewport({ scale: scale * ratio }) });
      task = renderTask;
      await renderTask.promise.catch(() => undefined);
      if (cancelled) return;
      const layer = textLayer.current!;
      layer.replaceChildren();
      layer.style.setProperty("--scale-factor", String(scale));
      layer.style.setProperty("--total-scale-factor", String(scale));
      await new TextLayer({ textContentSource: page.streamTextContent(), container: layer, viewport }).render();
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, number, width, visible]);

  return (
    <div className={`pdf-page${selected ? " selected" : ""}`} ref={box} data-page={number} style={size ? { width: size.width, height: size.height } : { width, height: width * 1.41 }}>
      <canvas ref={canvas} />
      <div className="textLayer" ref={textLayer} />
      <label className="pdf-page-pick" title="이 페이지 고르기">
        <input type="checkbox" checked={selected} onChange={onToggle} /> {number}
      </label>
    </div>
  );
}

/** PDF.js view with text selection; page edits go through PDFCraft and make a new file. */
export function PdfView({
  api,
  artifactId,
  revision,
  onSelection,
  onEdit,
}: {
  api: Api;
  artifactId: string;
  revision: number;
  onSelection: (selection: EditorSelection) => void;
  onEdit: (edit: { rotate?: { pages: number[]; degrees: number }[]; delete?: number[] }) => Promise<void>;
}) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(760);

  useEffect(() => {
    let cancelled = false;
    let task: ReturnType<typeof getDocument> | null = null;
    setPdf(null);
    api
      .raw(artifactId, revision)
      .then((data) => {
        if (cancelled) return null;
        task = getDocument({ data: new Uint8Array(data) });
        return task.promise;
      })
      .then((document) => {
        if (document && !cancelled) setPdf(document);
      })
      .catch((reason: Error) => !cancelled && setError(reason.message));
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [api, artifactId, revision]);

  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(Math.min(900, Math.max(320, element.clientWidth - 64))));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onSelect = () => {
      const selection = window.getSelection();
      const text = selection?.toString().trim() ?? "";
      const anchor = selection?.anchorNode?.parentElement?.closest<HTMLElement>(".pdf-page");
      if (!text || !anchor || !stage.current?.contains(anchor)) return;
      onSelection({ from: 0, to: 0, text, label: `${anchor.dataset.page}쪽 선택` });
    };
    document.addEventListener("selectionchange", onSelect);
    return () => document.removeEventListener("selectionchange", onSelect);
  }, [onSelection]);

  const pages = [...picked].sort((a, b) => a - b);
  const run = async (edit: { rotate?: { pages: number[]; degrees: number }[]; delete?: number[] }) => {
    setBusy(true);
    try {
      await onEdit(edit);
      setPicked(new Set());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pdf-view">
      <div className="doc-tools">
        <span className="muted">{pdf ? `${pdf.numPages}쪽 · r${revision}` : "불러오는 중…"}</span>
        <span className="doc-tools-sep" />
        <span className="muted">{pages.length ? `${pages.join(", ")}쪽 고름` : "페이지를 고르면 회전·삭제"}</span>
        <button type="button" className="button small" disabled={!pages.length || busy} onClick={() => void run({ rotate: [{ pages, degrees: 90 }] })}>
          오른쪽으로 돌리기
        </button>
        <button type="button" className="button small" disabled={!pages.length || busy || (pdf ? pages.length >= pdf.numPages : true)} onClick={() => void run({ delete: pages })}>
          삭제
        </button>
        <span className="muted">결과는 새 파일로 저장 (PDFCraft)</span>
      </div>
      <div className="pdf-stage" ref={stage}>
        {error ? <div className="notice notice-error">{error}</div> : null}
        {pdf
          ? Array.from({ length: pdf.numPages }, (_, index) => (
              <Page
                key={`${revision}:${index}`}
                pdf={pdf}
                number={index + 1}
                width={width}
                selected={picked.has(index + 1)}
                onToggle={() =>
                  setPicked((current) => {
                    const next = new Set(current);
                    if (next.has(index + 1)) next.delete(index + 1);
                    else next.add(index + 1);
                    return next;
                  })
                }
              />
            ))
          : null}
      </div>
    </div>
  );
}
