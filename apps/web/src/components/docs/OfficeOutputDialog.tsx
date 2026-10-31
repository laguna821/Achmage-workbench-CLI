import { useEffect, useState } from "react";
import type { Artifact } from "@workbench/contracts";
import type { OfficeOutputFormat, OfficeOutputPlan } from "../../../../../packages/contracts/src/office-output.ts";
import type { Api } from "../../api.ts";

/** Destination selection lives in the trusted parent, never in third-party editor code. */
export function OfficeOutputDialog({ api, artifact, revision, format, onChoose, onCancel }: { api: Api; artifact: Artifact; revision: number; format: OfficeOutputFormat; onChoose(plan: OfficeOutputPlan): void; onCancel(): void }) {
  const [kind, setKind] = useState(format);
  const [path, setPath] = useState(artifact.path.replace(/\.[^.\\/]+$/, format === "pdf" && artifact.format !== "pdf" ? ".pdf" : ` 사본.${format}`));
  const [plan, setPlan] = useState<Awaited<ReturnType<Api["prepareOfficeOutput"]>> | null>(null);
  const [replace, setReplace] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const change = (value: string) => { setPath(value); setPlan(null); setReplace(false); setError(""); };
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) { event.stopPropagation(); onCancel(); } }; window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key); }, [busy, onCancel]);
  const save = async () => {
    setBusy(true); setError("");
    try {
      const prepared = plan ?? await api.prepareOfficeOutput(artifact.id, revision, path);
      if (prepared.format !== kind) throw new Error(`파일 이름의 확장자를 .${kind}(으)로 지정하세요.`);
      if (prepared.exists && !replace) { setPlan(prepared); return; }
      onChoose({ id: prepared.id, path: prepared.path, format: prepared.format, replace });
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); }
  };
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && onCancel()}>
    <form className="stage-dialog office-output-dialog" role="dialog" aria-modal="true" aria-label={format === "pdf" ? "PDF로 저장" : "다른 이름으로 저장"} onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <header className="template-head"><h2>{format === "pdf" ? "PDF로 저장" : "다른 이름으로 저장"}</h2></header>
      <p className="sheet-hint">현재 편집 내용을 저장합니다.</p>
      {format === "hwp" || format === "hwpx" ? <label>파일 형식 <select aria-label="저장 형식" value={kind} disabled={busy} onChange={(event) => { const next = event.target.value as "hwp" | "hwpx"; setKind(next); change(path.replace(/\.(hwp|hwpx)$/i, `.${next}`)); }}><option value="hwpx">한글 HWPX</option><option value="hwp">한글 HWP</option></select></label> : null}
      <label className="column">파일 경로<input className="sheet-input" aria-label="저장할 파일 경로" autoFocus value={path} disabled={busy} onChange={(event) => change(event.target.value)} /></label>
      {"__TAURI_INTERNALS__" in window ? <button type="button" className="button small" disabled={busy} onClick={() => { void import("@tauri-apps/plugin-dialog").then(({ save }) => save({ defaultPath: path, filters: [{ name: kind.toUpperCase(), extensions: [kind] }] })).then((picked) => { if (picked) change(picked); }).catch((error) => setError(String(error))); }}>위치 선택…</button> : null}
      {plan?.exists ? <label className="sheet-hint"><input type="checkbox" checked={replace} onChange={(event) => setReplace(event.target.checked)} /> 기존 파일을 백업한 뒤 바꾸기 ({plan.size.toLocaleString()} 바이트)</label> : null}
      {error ? <p role="alert">{error}</p> : null}
      <footer className="stage-foot"><span className="stage-spacer" /><button type="button" className="button small" disabled={busy} onClick={onCancel}>취소</button><button type="submit" className="button small primary" disabled={busy || !path.trim() || !!plan?.exists && !replace}>저장</button></footer>
    </form>
  </div>;
}
