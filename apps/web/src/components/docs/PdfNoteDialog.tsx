import { useEffect, useState } from "react";

export function PdfNoteDialog({ initialPath, onChoose }: { initialPath: string; onChoose(path: string | null): void }) {
  const [path, setPath] = useState(initialPath), [error, setError] = useState("");
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onChoose(null); } }; window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key); }, [onChoose]);
  return <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && onChoose(null)}>
    <form className="stage-dialog pdf-note-dialog" role="dialog" aria-modal="true" aria-label="PDF 노트 연결" onSubmit={event => { event.preventDefault(); if (path.trim()) onChoose(path); }}>
      <header className="template-head"><h2>PDF 노트 연결</h2></header>
      <p className="sheet-hint">이 PDF의 인용과 읽기 메모를 모을 Markdown 노트입니다. 기존 파일을 고르면 내용을 유지하고, 파일이 없으면 새로 만듭니다.</p>
      <label className="column">노트 파일<input className="sheet-input" aria-label="PDF 노트 파일" autoFocus value={path} onChange={event => setPath(event.target.value)} /></label>
      {"__TAURI_INTERNALS__" in window ? <button type="button" className="button small" onClick={() => { void import("@tauri-apps/plugin-dialog").then(({ save }) => save({ title: "PDF 노트 파일 고르기", defaultPath: path, filters: [{ name: "Markdown", extensions: ["md"] }] })).then(picked => { if (picked) setPath(picked); }).catch(error => setError(String(error))); }}>파일 위치 선택…</button> : null}
      {error ? <p role="alert">{error}</p> : null}
      <footer className="stage-foot"><span className="stage-spacer" /><button type="button" className="button small" onClick={() => onChoose(null)}>취소</button><button type="submit" className="button small primary" disabled={!path.trim()}>노트 연결</button></footer>
    </form>
  </div>;
}
