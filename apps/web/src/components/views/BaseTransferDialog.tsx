import { useEffect, useMemo, useRef, useState } from "react";
import { VIEW_LIMITS, type HomeView } from "@workbench/contracts";
import type { Api } from "../../api.ts";
import { exportBase, importBase, type BaseImport } from "../../base-interop.ts";
import { Icon } from "../Icon.tsx";

export function BaseTransferDialog({ mode, view, remaining, api, onImport, onClose }: { mode: "import" | "export"; view: HomeView; remaining: number; api?: Api; onImport: (views: HomeView[]) => void; onClose: () => void }) {
  const exported = useMemo(() => exportBase(view), [view]);
  const [source, setSource] = useState(mode === "export" ? exported.source : "");
  const [preview, setPreview] = useState<BaseImport | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState("");
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, [onClose, busy]);
  const parse = (text = source) => {
    try {
      const next = importBase(text); setPreview(next); setSelected(new Set(next.entries.flatMap((entry, index) => entry.view ? [index] : []))); setError("");
    } catch (error) { setPreview(null); setSelected(new Set()); setError(error instanceof Error ? error.message : String(error)); }
  };
  const save = async () => {
    setBusy(true); setError("");
    try {
      const name = `${view.name.replace(/[\\/:*?"<>|]/g, "_") || "프로젝트"}.base`;
      if ("__TAURI_INTERNALS__" in window && api) {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const path = await save({ defaultPath: name, filters: [{ name: "Obsidian Bases", extensions: ["base"] }] });
        if (!path) return;
        const result = await api.exportBase(path, source); setSaved(result.path);
      } else {
        const url = URL.createObjectURL(new Blob([source], { type: "application/yaml;charset=utf-8" }));
        const link = document.createElement("a"); link.href = url; link.download = name; link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000); setSaved(name);
      }
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); }
  };
  const title = mode === "import" ? "Bases 가져오기" : "Bases 내보내기";
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
    <section className="stage-dialog base-transfer-dialog" role="dialog" aria-modal="true" aria-label={title}>
      <header className="template-head"><h2>{title}</h2><button type="button" className="icon-button small" aria-label="닫기" disabled={busy} onClick={onClose}><Icon name="x" size={15} /></button></header>
      {mode === "import" ? <>
        <p className="sheet-hint">.base 파일의 보기를 프로젝트 노트에 적용합니다. 기존 보기와 원본 파일은 유지합니다.</p>
        <button type="button" className="button small" onClick={() => file.current?.click()}>.base 파일 선택</button>
        <input ref={file} type="file" hidden accept=".base,.yaml,.yml" onChange={(event) => {
          const picked = event.target.files?.[0]; event.target.value = "";
          if (!picked) return;
          if (picked.size > 256_000) { setError("256KB 이하의 파일을 선택해 주세요."); return; }
          void picked.text().then((text) => { setSource(text); parse(text); }, (error: unknown) => setError(String(error)));
        }} />
      </> : <p className="sheet-hint">「{view.name}」 보기를 새 .base 파일로 저장합니다. 프로젝트 노트가 같은 Obsidian 보관함에 있어야 그곳에서도 표시됩니다.</p>}
      <textarea className="sheet-input base-source" aria-label="Bases YAML" spellCheck={false} value={source} readOnly={mode === "export"} maxLength={256_000} onChange={(event) => { setSource(event.target.value); setPreview(null); }} placeholder={'views:\n  - type: table\n    name: 프로젝트\n    order:\n      - file.name\n      - note.단계'} />
      {mode === "import" ? <button type="button" className="button small" onClick={() => parse()}>보기 확인</button> : null}
      {error ? <p role="alert" className="base-issue">{error}</p> : null}
      {(mode === "export" ? exported.warnings : preview?.warnings ?? []).map((warning) => <p key={warning} className="sheet-hint">{warning}</p>)}
      {preview ? <div className="base-import-entries">{preview.entries.map((entry, index) => <div key={index} className="base-import-entry">
        <label><input type="checkbox" disabled={!entry.view} checked={selected.has(index)} onChange={() => setSelected((before) => { const next = new Set(before); if (next.has(index)) next.delete(index); else next.add(index); return next; })} /> {entry.name}</label>
        {entry.issues.map((issue) => <p key={issue} className="base-issue">{issue}</p>)}
        {entry.warnings.map((warning) => <p key={warning} className="sheet-hint">{warning}</p>)}
      </div>)}</div> : null}
      {mode === "import" && selected.size > remaining ? <p role="alert" className="base-issue">보기는 {VIEW_LIMITS.views}개까지입니다. {remaining}개 이하로 선택해 주세요.</p> : null}
      {saved ? <p role="status">저장했습니다: {saved}</p> : null}
      <footer className="stage-foot"><span className="stage-spacer" /><button type="button" className="button small" onClick={onClose} disabled={busy}>닫기</button>
        {mode === "export" ? <button type="button" className="button small primary" disabled={busy} onClick={() => void save()}>새 파일로 저장</button> : <button type="button" className="button small primary" disabled={!preview || !selected.size || selected.size > remaining} onClick={() => { onImport(preview!.entries.flatMap((entry, index) => selected.has(index) && entry.view ? [entry.view] : [])); onClose(); }}>선택한 보기 추가</button>}
      </footer>
    </section>
  </div>;
}
