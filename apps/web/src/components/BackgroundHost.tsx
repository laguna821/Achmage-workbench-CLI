import { useEffect, useState } from "react";
import type { HostStatus } from "@workbench/contracts";
import type { Api } from "../api.ts";

export function BackgroundHost({ api }: { api: Api }) {
  const [host, setHost] = useState<HostStatus | null>(null), [error, setError] = useState("");
  const [startup, setStartup] = useState<{ enabled: boolean; supported: boolean; label: string } | null>(null), [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void Promise.all([api.hostStatus(), api.request<typeof startup>("GET", "/api/host/autostart")]).then(([host, startup]) => { if (live) { setHost(host); setStartup(startup); } }).catch(error => { if (live) setError(String(error.message ?? error)); });
    return () => { live = false; };
  }, [api]);
  return <div className="connection">
    <div className="connection-head"><span className="connection-name">백그라운드 작업</span><span className="connection-state">{host ? host.instance.mode === "service" ? "앱 종료 후에도 유지" : "앱과 함께 종료" : "연결 확인 중"}</span></div>
    <div className="connection-meta muted">{host?.instance.mode === "service" ? "대화·터미널·예약은 창과 별도로 실행됩니다. 문서 편집기의 화면이 필요한 작업은 창을 유지해 주세요. 전체 종료는 트레이에서 선택할 수 있습니다." : "이 실행에서는 앱을 끝내면 호스트도 종료됩니다."}</div>
    {startup?.supported ? <label className="connection-meta"><input type="checkbox" checked={startup.enabled} disabled={busy} onChange={event => {
      const enabled = event.target.checked; setBusy(true); setError("");
      void api.request<typeof startup>("PUT", "/api/host/autostart", { enabled }).then(setStartup).catch(error => setError(String(error.message ?? error))).finally(() => setBusy(false));
    }} /> {startup.label}</label> : null}
    {error ? <div className="notice notice-error compact" role="alert">{error}</div> : null}
  </div>;
}
