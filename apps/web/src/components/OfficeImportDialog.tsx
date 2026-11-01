import { useEffect, useState } from "react";
import type { Api } from "../api.ts";
import type { OfficeImportPreview, OfficeImportResult } from "../../../../packages/contracts/src/office-import.ts";
import "../styles/office-settings.css";

export function OfficeImportDialog({ api, onClose }: { api: Api; onClose(): void }) {
  const [directory, setDirectory] = useState(""), [preview, setPreview] = useState<OfficeImportPreview | null>(null);
  const [ai, setAi] = useState(false), [keys, setKeys] = useState(true), [styles, setStyles] = useState(true);
  const [preferences, setPreferences] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [result, setResult] = useState<OfficeImportResult | null>(null);
  const fail = (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason));
  useEffect(() => { let live = true; void api.request<{ directory: string }>("GET", "/api/office-import/sources").then(value => { if (live) setDirectory(value.directory); }, reason => { if (live) fail(reason); }); return () => { live = false; }; }, [api]);
  const inspect = async () => {
    setBusy(true); setError(""); setResult(null); setPreview(null);
    try { const value = await api.request<OfficeImportPreview>("POST", "/api/office-import/preview", { directory }); setPreview(value); setAi(Boolean(value.ai && !value.ai.replacesCurrent)); setStyles(value.styles.some(style => !style.same)); setPreferences(Boolean(value.preferences && !value.preferences.replacesCurrent)); }
    catch (reason) { fail(reason); } finally { setBusy(false); }
  };
  const apply = async () => {
    if (!preview) return;
    setBusy(true); setError("");
    try { setResult(await api.request<OfficeImportResult>("POST", "/api/office-import/apply", { id: preview.id, ai, keys, styles, preferences })); }
    catch (reason) { fail(reason); } finally { setBusy(false); }
  };
  return <div className="office-settings-overlay"><section className="new-document-dialog office-import-dialog" role="dialog" aria-modal="true" aria-labelledby="office-import-title" style={{ margin: "auto" }}>
    <header><h2 id="office-import-title">이음오피스 설정 가져오기</h2><button className="icon-button" aria-label="가져오기 닫기" disabled={busy} onClick={onClose}>×</button></header>
    <p>기존 이음오피스의 AI 설정·API 키·문서 표시 설정·저장한 발표 스타일을 가져옵니다. 원본 파일은 그대로 둡니다.</p>
    <label>이음오피스 데이터 폴더<input value={directory} disabled={busy} onChange={event => { setDirectory(event.target.value); setPreview(null); setResult(null); }} /></label>
    <div className="office-import-actions"><button className="button" disabled={busy} onClick={() => {
      void import("@tauri-apps/plugin-dialog").then(dialog => dialog.open({ directory: true, multiple: false, title: "이음오피스 데이터 폴더" })).then(path => { if (typeof path === "string") { setDirectory(path); setPreview(null); setResult(null); } }).catch(fail);
    }}>폴더 선택</button><button className="button" disabled={busy || !directory.trim()} onClick={() => void inspect()}>가져올 항목 확인</button></div>
    {preview && !result && <div className="office-import-preview">
      {preview.ai && <><label className="office-import-choice"><input type="checkbox" checked={ai} disabled={busy} onChange={event => setAi(event.target.checked)} />AI 설정 가져오기 · {preview.ai.provider}</label>
        <p className="muted">{preview.ai.replacesCurrent ? "현재 Workbench AI 설정을 교체합니다. 이전 설정은 암호화해 백업합니다." : "새 AI 설정으로 저장합니다."} 자동 호출은 가져온 뒤 직접 켤 수 있습니다.</p>
        <label className="office-import-choice"><input type="checkbox" checked={keys} disabled={busy || !ai} onChange={event => setKeys(event.target.checked)} />API 키 포함 · {preview.ai.keys}개</label>
        {!!preview.ai.sealedKeys && <p className="muted">봉인된 키 {preview.ai.sealedKeys}개는 이 PC의 이음오피스 앱으로 읽습니다.{!preview.appAvailable && " 연결과 설정에서 이음오피스 앱을 먼저 연결하거나 키 포함을 해제해 주세요."}</p>}</>}
      {preview.preferences && <><label className="office-import-choice"><input type="checkbox" checked={preferences} disabled={busy} onChange={event => setPreferences(event.target.checked)} />문서 표시 설정 가져오기</label><p className="muted">작성자·AI 패널·문서 테마·자동 저장 중 원본에 있는 항목을 가져옵니다.{preview.preferences.replacesCurrent && " 현재 설정은 백업한 뒤 선택한 원본의 값으로 바꿉니다."}</p></>}
      {!!preview.styles.length && <><label className="office-import-choice"><input type="checkbox" checked={styles} disabled={busy} onChange={event => setStyles(event.target.checked)} />저장한 발표 스타일 · {preview.styles.length}개</label>
        <ul>{preview.styles.map((style, index) => <li key={index}>{style.name}{style.same ? " · 이미 있음" : style.targetName !== style.name ? ` → ${style.targetName}` : " · 추가"}</li>)}</ul></>}
      {preview.warnings.map((warning, index) => <p className="muted" key={index}>{warning}</p>)}
      <button className="button primary" disabled={busy || !ai && !styles && !preferences || ai && keys && !!preview.ai?.sealedKeys && !preview.appAvailable} onClick={() => void apply()}>{busy ? "가져오는 중…" : "선택한 항목 가져오기"}</button>
    </div>}
    {result && <div role="status"><p>AI 설정 {result.ai ? "가져옴" : "유지"} · 문서 표시 설정 {result.preferences ? "가져옴" : "유지"} · 스타일 {result.styles}개 추가 · 같은 스타일 {result.skipped}개 유지</p>{result.backup && <p className="muted new-document-path">이전 설정의 암호화 백업: {result.backup}</p>}{result.preferenceBackup && <p className="muted new-document-path">이전 문서 표시 설정 백업: {result.preferenceBackup}</p>}{result.errors.map((message, index) => <p key={index}>{message}</p>)}</div>}
    {error && <p role="alert">{error}</p>}
    <footer><button className="button" disabled={busy} onClick={onClose}>{result ? "완료" : "닫기"}</button></footer>
  </section></div>;
}
