import { useEffect, useState } from "react";
import type { HostStatus } from "@workbench/contracts";
import type { Api } from "../api.ts";
import { SettingsRow } from "./SettingsSheet.tsx";

export function BackgroundHost({ api }: { api: Api }) {
  const [host, setHost] = useState<HostStatus | null>(null), [error, setError] = useState("");
  const [startup, setStartup] = useState<{ enabled: boolean; supported: boolean; label: string } | null>(null), [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void Promise.all([api.hostStatus(), api.request<typeof startup>("GET", "/api/host/autostart")]).then(([host, startup]) => { if (live) { setHost(host); setStartup(startup); } }).catch(error => { if (live) setError(String(error.message ?? error)); });
    return () => { live = false; };
  }, [api]);
  const service = host?.instance.mode === "service";
  return <>
    <SettingsRow label="창을 닫으면"
      state={host ? { text: service ? "창을 닫아도 계속" : "앱과 함께 멈춤" } : { text: "확인 중" }}
      hint={!host ? "확인하는 중입니다." : service ? "대화와 예약은 창을 닫아도 계속됩니다. 문서 편집기가 필요한 일은 창을 열어 두세요. 완전히 끝내려면 알림 영역의 아이콘에서 끝내기를 고르세요." : "지금은 앱을 닫으면 진행 중인 작업도 멈춥니다."}
      detail={error ? <p className="settings-note warn" role="alert">{error}</p> : null} />
    {startup?.supported ? <SettingsRow label="컴퓨터를 켜면 자동으로 시작" hint="켜 두면 로그인할 때 이 앱이 조용히 시작해 예약한 일을 이어 합니다."
      control={<label className="check-row switch-row settings-switch" data-component="toggle"><input type="checkbox" role="switch" aria-label="컴퓨터를 켜면 자동으로 시작" checked={startup.enabled} disabled={busy} onChange={event => {
        const enabled = event.target.checked; setBusy(true); setError("");
        void api.request<typeof startup>("PUT", "/api/host/autostart", { enabled }).then(setStartup).catch(error => setError(`자동 시작을 바꾸지 못했습니다. ${String(error.message ?? error)}`)).finally(() => setBusy(false));
      }} /></label>} /> : null}
  </>;
}
