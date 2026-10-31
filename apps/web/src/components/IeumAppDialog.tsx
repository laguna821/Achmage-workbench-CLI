import { useEffect, useState } from "react";
import type { ToolStatus } from "@workbench/contracts";
import type { Api } from "../api.ts";
import { Icon } from "./Icon.tsx";

export function IeumAppDialog({ api, status, onClose }: { api: Api; status?: ToolStatus; onClose: () => void }) {
  const [path, setPath] = useState(status?.path ?? ""), [error, setError] = useState("");
  const [linking, setLinking] = useState(false);
  useEffect(() => {
    const refresh = () => { void api.refreshTools().catch(() => undefined); };
    refresh(); window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [api]);
  const fail = (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason));
  return <div className="office-settings-overlay">
    <section className="new-document-dialog" role="dialog" aria-modal="true" aria-labelledby="ieum-app-title" style={{ margin: "auto" }}>
      <header><h2 id="ieum-app-title">이음오피스 앱 연결</h2><button type="button" className="icon-button" aria-label="이음오피스 연결 닫기" onClick={onClose}><Icon name="x" size={18} /></button></header>
      <p>문서를 별도 이음오피스 앱에서도 편집하려면 설치해 주세요. Workbench의 <b>앱으로 열기</b>에서 같은 파일을 열고, 저장하면 여기에서도 최신 내용으로 이어집니다.</p>
      <p className="muted">Workbench 안의 편집기는 지금도 사용할 수 있습니다. 별도 앱 설치는 선택 사항입니다.</p>
      {status?.available ? <p role="status">연결됨{status.version ? ` · ${status.version}` : ""}<small className="new-document-path muted">{status.path}</small></p> : null}
      <button type="button" className="button primary" disabled={status?.busy} onClick={() => { setError(""); void api.installIeumOffice().catch(fail); }}>{status?.busy ? "설치 중…" : status?.available ? "최신 공식 버전으로 업데이트" : "최신 공식 버전 설치·연결"}</button>
      {status?.message ? <p role="status">{status.message}</p> : null}
      <details style={{ marginTop: 20 }}><summary>이미 설치한 앱 직접 연결</summary>
        <form onSubmit={(event) => {
          event.preventDefault(); setLinking(true); setError("");
          void api.request("POST", "/api/tools/ieumoffice/link", { path }).then(() => api.refreshTools()).catch(fail).finally(() => setLinking(false));
        }}>
          <label>이음오피스 앱 위치<input value={path} placeholder="IeumOffice.exe 또는 IeumOffice.app 위치" onChange={(event) => setPath(event.target.value)} /></label>
          <button type="submit" className="button" disabled={!path.trim() || linking || status?.busy}>이 앱 연결</button>
        </form>
      </details>
      {error ? <p role="alert">{error}</p> : null}
      <footer><button type="button" className="button" onClick={onClose}>{status?.available ? "완료" : "나중에"}</button></footer>
    </section>
  </div>;
}
