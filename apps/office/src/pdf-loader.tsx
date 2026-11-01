import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Gateway, Init } from "./bridge.ts";
import type { PdfExtractResult, PdfLoaderStatus } from "../../../packages/contracts/src/pdf-loader.ts";
import { cancelOutput, commitOutput, openExport, prepareOutput } from "./output.ts";

let service: { init: Init; gateway: Gateway; revision(): number; flush(): Promise<boolean> };
export function configurePdfLoader(init: Init, gateway: Gateway, revision: () => number, flush: () => Promise<boolean>) { service = { init, gateway, revision, flush }; }
function Dialog({ close }: { close(): void }) {
  const [state, setState] = useState<PdfLoaderStatus | null>(null), [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [pages, setPages] = useState(""), [password, setPassword] = useState("");
  const [ocr, setOcr] = useState(false), [images, setImages] = useState(true);
  const [result, setResult] = useState<{ value: PdfExtractResult; revision: number } | null>(null);
  const running = useRef<AbortController | null>(null);
  const { init, gateway, revision, flush } = service;
  const call = <T,>(operation: string, request: Record<string, unknown> = {}, signal?: AbortSignal) => gateway.pdf<T>(init.artifact.id, revision(), operation, request, undefined, signal);
  const refresh = () => call<PdfLoaderStatus>("loader-state").then(setState).catch(e => setError(String(e)));
  useEffect(() => { void refresh(); const timer = setInterval(() => { void refresh(); }, 1500); return () => { clearInterval(timer); running.current?.abort(); }; }, []);
  const install = async (withOcr: boolean) => { setError(null); try { setState(await call<PdfLoaderStatus>("loader-install", { ocr: withOcr })); } catch (error) { setError(String(error)); } };
  const extract = async () => {
    setBusy(true); setError(null);
    const controller = running.current = new AbortController();
    try {
      const requested: number[] = [];
      if (pages.trim()) for (const part of pages.split(",")) {
        const match = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part); if (!match) throw new Error("쪽 범위는 1,3-5처럼 입력해 주세요.");
        const start = Number(match[1]), end = Number(match[2] ?? match[1]); if (start < 1 || end < start || end > 20000) throw new Error("쪽 범위를 확인해 주세요.");
        for (let p = start; p <= end; p++) requested.push(p);
      }
      if (!(await flush())) throw new Error("현재 PDF 편집을 먼저 저장해 주세요.");
      const snapshot = revision();
      const value = await call<PdfExtractResult>("extract", { ...(requested.length ? { pages: [...new Set(requested)] } : {}), ...(password ? { password } : {}), ocr, images }, controller.signal);
      setResult({ value, revision: snapshot });
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { running.current = null; setBusy(false); }
  };
  const save = async () => {
    if (!result) return; setBusy(true); setError(null);
    let plan: Awaited<ReturnType<typeof prepareOutput>> = null;
    try {
      plan = await prepareOutput(result.revision, "md", crypto.randomUUID(), { defaultName: init.artifact.name.replace(/\.pdf$/i, "-추출.md") });
      if (!plan) return;
      const saved = await commitOutput(plan.id, new TextEncoder().encode(result.value.markdown).buffer, "export", result.revision); plan = null;
      await openExport(saved.path); close();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { if (plan) await cancelOutput(plan.id).catch(() => {}); setBusy(false); }
  };
  const installing = state?.state === "installing";
  return <div className="pdf-modal-mask" onKeyDown={event => { event.stopPropagation(); if (event.key === "Escape" && !busy) close(); }}>
    <div className="pdf-modal" role="dialog" aria-modal="true" aria-label="PDF 추출·OCR" style={{ width: "min(680px, 92vw)", maxHeight: "90vh", overflow: "auto" }}>
      <h2>PDF 추출·OCR</h2>
      <p>본문·표·그림을 추출하고 스캔 문서의 글자를 읽습니다. 문서는 이 컴퓨터에서 처리합니다.</p>
      <p>OpenDataLoader {state?.version ?? ""} · 본문 추출 {state?.coreReady ? "준비됨" : "미설치"} · 한국어/영어 OCR {state?.ocrReady ? "준비됨" : "미설치"}</p>
      {!state?.ocrReady && <p>추가 도구와 OCR 모델은 최초 설치 때 내려받습니다. OCR에는 수 GB의 여유 공간이 필요할 수 있습니다.</p>}
      {state?.message && <p role="status" style={{ whiteSpace: "pre-wrap" }}>{state.message}{installing && state.percent !== null ? ` ${state.percent}%` : ""}</p>}
      {error && <p role="alert" className="pdf-convert-error">{error}</p>}
      <div className="pdf-modal-actions" style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
        {!state?.coreReady && <button className="pdf-modal-btn" disabled={!state?.supported || installing} onClick={() => void install(false)}>본문 추출 설치</button>}
        {!state?.ocrReady && <button className="pdf-modal-btn" disabled={!state?.supported || installing} onClick={() => void install(true)}>한국어·영어 OCR 설치</button>}
        {installing && <button className="pdf-modal-btn" onClick={() => { void call("loader-cancel").then(refresh); }}>설치 중단</button>}
        {state?.ocrReady && <button className="pdf-modal-btn" disabled={busy} onClick={() => { window.dispatchEvent(new Event("workbench:pdf-ocr-ready")); close(); }}>스캔 페이지 글자 읽기</button>}
      </div>
      {state?.coreReady && <>
        <label style={{ display: "block", marginTop: 16 }}>쪽 범위 <input aria-label="추출할 쪽 범위" placeholder="전체 · 예: 1,3-5" value={pages} disabled={busy} onChange={e => setPages(e.target.value)} /></label>
        <label style={{ display: "block", marginTop: 8 }}>PDF 암호 <input aria-label="PDF 추출 암호" type="password" autoComplete="off" placeholder="암호가 있는 문서만" value={password} disabled={busy} onChange={e => setPassword(e.target.value)} /></label>
        <label style={{ display: "block", marginTop: 8 }}><input type="checkbox" checked={images} disabled={busy} onChange={e => setImages(e.target.checked)} /> 그림을 결과 문서에 포함</label>
        <label style={{ display: "block", marginTop: 8 }}><input type="checkbox" checked={ocr} disabled={busy || !state.ocrReady} onChange={e => setOcr(e.target.checked)} /> 스캔·이미지 글자도 OCR로 추출</label>
        {result && <><p>{result.value.pages.length}쪽 · {result.value.blocks.length}개 본문 영역 추출</p><textarea aria-label="PDF 추출 미리보기" readOnly value={result.value.pages.map(p => `[${p.page}쪽]\n${p.text}`).join("\n\n")} style={{ width: "100%", boxSizing: "border-box", height: 160 }} /></>}
      </>}
      <div className="pdf-modal-actions">
        {busy && running.current && <button className="pdf-modal-btn" onClick={() => running.current?.abort()}>추출 중단</button>}
        <button autoFocus className="pdf-modal-btn" disabled={busy} onClick={close}>닫기</button>
        {state?.coreReady && <button className="pdf-modal-btn" disabled={busy || installing} onClick={() => void extract()}>{busy ? "처리 중…" : "본문·표·그림 추출"}</button>}
        {result && <button className="pdf-modal-btn" disabled={busy} onClick={() => void save()}>Markdown으로 저장·열기</button>}
      </div>
    </div>
  </div>;
}
export function PdfLoaderButton() {
  return <button className="ribbon-tab" title="PDF 본문·표·그림 추출과 한국어·영어 OCR" onClick={() => {
    if (document.querySelector("[data-pdf-loader-dialog]")) return;
    const node = document.createElement("div"); node.dataset.pdfLoaderDialog = "true"; document.body.append(node);
    const root = createRoot(node); const close = () => { root.unmount(); node.remove(); };
    root.render(<Dialog close={close} />);
  }}>추출·OCR</button>;
}
