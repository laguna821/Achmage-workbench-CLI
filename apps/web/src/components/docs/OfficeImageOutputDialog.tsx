import { useEffect, useState } from "react";

/** The parent chooses a directory; the original exporter creates its own new folder inside it. */
export function OfficeImageOutputDialog({ initialPath, onChoose }: { initialPath: string; onChoose(path: string | null): void }) {
  const [path, setPath] = useState(initialPath), [error, setError] = useState("");
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onChoose(null); } }; window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key); }, [onChoose]);
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onChoose(null)}>
    <form className="stage-dialog office-output-dialog" role="dialog" aria-modal="true" aria-label="PNG 그림으로 내보내기" onSubmit={(event) => { event.preventDefault(); if (path.trim()) onChoose(path); }}>
      <header className="template-head"><h2>PNG 그림으로 내보내기</h2></header>
      <p className="sheet-hint">선택한 폴더 안에 새 결과 폴더를 만들고, 문서의 각 페이지를 PNG 그림으로 저장합니다.</p>
      <label className="column">저장 폴더<input className="sheet-input" aria-label="그림을 저장할 폴더" autoFocus value={path} onChange={(event) => setPath(event.target.value)} /></label>
      {"__TAURI_INTERNALS__" in window ? <button type="button" className="button small" onClick={() => { void import("@tauri-apps/plugin-dialog").then(({ open }) => open({ directory: true, multiple: false, defaultPath: path })).then((picked) => { if (typeof picked === "string") setPath(picked); }).catch((error) => setError(String(error))); }}>폴더 선택…</button> : null}
      {error ? <p role="alert">{error}</p> : null}
      <footer className="stage-foot"><span className="stage-spacer" /><button type="button" className="button small" onClick={() => onChoose(null)}>취소</button><button type="submit" className="button small primary" disabled={!path.trim()}>그림으로 저장</button></footer>
    </form>
  </div>;
}
