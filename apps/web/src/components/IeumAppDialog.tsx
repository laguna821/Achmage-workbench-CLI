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
      <p>이음오피스는 Workbench 설치 과정에서 별도 앱으로 자동 설치·등록됩니다. 앱 목록에서 단독 실행하거나, <b>앱으로 열기</b>로 같은 파일을 편집하고 저장한 뒤 여기에서 이어갈 수 있습니다.</p>
      <p className="muted">자동 설정이 중단되면 여기서 다시 진행할 수 있습니다. 설치 중에도 내장 편집기는 사용할 수 있습니다.</p>
      {status?.available ? <p role="status">{status.registered ? "독립 앱 등록·연결됨" : "앱 확인됨"}{status.version ? ` · ${status.version}` : ""}<small className="new-document-path muted">{status.path}</small></p> : null}
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
