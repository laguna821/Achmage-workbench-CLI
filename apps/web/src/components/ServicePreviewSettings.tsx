import { useState } from "react";
import type { WorkspaceServicePreviewSettings } from "@workbench/contracts";
import type { Api } from "../api.ts";

export function ServicePreviewSettings({ api }: { api: Api }) {
  const [settings, setSettings] = useState<WorkspaceServicePreviewSettings | null>(null), [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const load = async () => {
    if (settings || busy) return;
    setBusy(true); setError("");
    try { const value = await api.servicePreviewSettings(); setSettings(value); setUrl(value.publicBaseUrl ?? ""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  if (api.isRemote) return null;
  return <details className="service-preview-settings" onToggle={event => { if (event.currentTarget.open) void load(); }}>
    <summary>휴대폰에서 개발 서버 화면 열기</summary>
    <p className="muted">기기 연결을 켠 뒤 미리보기용 HTTPS 도메인을 등록하세요. 예: preview.example.com. 이 주소의 모든 하위 도메인을 이 PC의 기기 연결 포트로 전달하도록 DNS와 프록시를 설정해야 합니다.</p>
    <form onSubmit={event => { event.preventDefault(); if (busy) return; setBusy(true); setError(""); void api.configureServicePreview(url.trim() || null).then(value => { setSettings(value); setUrl(value.publicBaseUrl ?? ""); }).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setBusy(false)); }}>
      <label>미리보기 HTTPS 주소<input type="url" placeholder="https://preview.example.com" value={url} disabled={busy || !settings} onChange={event => setUrl(event.target.value)} /></label>
      <button className="button small" disabled={busy || !settings}>{busy ? "저장 중…" : url.trim() ? "주소 저장" : "미리보기 연결 끄기"}</button>
    </form>
    {settings ? <p className="muted">{settings.message} 기기 연결용 중계 서버만 사용하는 경우에는 이 웹 화면 주소를 따로 설정해야 합니다.</p> : null}
    {error ? <p className="workspace-service-error" role="alert">{error}</p> : null}
  </details>;
}
