import { useEffect, useRef, useState } from "react";
import type { PushConfiguration, PushSettings, PushStatus } from "../../../../packages/contracts/src/push.ts";
import type { Api } from "../api.ts";
import { disableMobilePush, enableMobilePush, pushCapability } from "../mobile-push.ts";
import { FeatureDialog, featureError, featureTime } from "./FeatureDialog.tsx";

export function MobilePushSettings({ api, hostId, remote = api.isRemote, onClose }: { api: Api; hostId?: string | null; remote?: boolean; onClose(): void }) {
  const [state, setState] = useState<PushStatus | PushSettings | null>(null), [config, setConfig] = useState<PushConfiguration>({ enabled: false, subject: "" });
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState(""), [rotateConfirm, setRotateConfirm] = useState(false);
  const live = useRef(true), pending = useRef(false);
  const refresh = async () => {
    const next = await api.request<PushStatus | PushSettings>("GET", remote ? "/api/push" : "/api/push/settings");
    if (hostId && next.hostId !== hostId) throw new Error("현재 연결과 알림 설정의 호스트가 다릅니다.");
    if (live.current) { setState(next); if ("config" in next) setConfig(next.config); }
    return next;
  };
  useEffect(() => {
    live.current = true; void refresh().catch(reason => { if (live.current) setError(featureError(reason)); });
    return () => { live.current = false; };
  }, [api, remote, hostId]);
  const perform = async (action: () => Promise<PushStatus | PushSettings>, message: string) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try { const next = await action(); if (live.current) { setState(next); if ("config" in next) setConfig(next.config); setNotice(message); } }
    catch (reason) { if (live.current) setError(featureError(reason)); }
    finally { pending.current = false; if (live.current) setBusy(false); }
  };
  const unavailable = remote ? pushCapability() : null, settings = state && "config" in state ? state : null;
  const permission = typeof Notification === "undefined" ? "지원 안 됨" : Notification.permission === "granted" ? "허용" : Notification.permission === "denied" ? "차단" : "요청 전";
  return <FeatureDialog title="모바일 알림" description="허용한 기기에 작업 완료·실패·확인 요청을 전달합니다." onClose={onClose}>
    {error ? <p className="notice notice-error compact" role="alert">{error}</p> : null}{notice ? <p role="status">{notice}</p> : null}
    <p className="sheet-hint">알림에는 대화·파일·프로젝트 이름을 넣지 않습니다. 누르면 해당 호스트에 연결하고 현재 권한으로 원문을 확인합니다. 알림을 열어도 승인 요청을 수락하지 않습니다.</p>
    {!state ? <p role="status">알림 설정 불러오는 중…</p> : remote ? <section className="feature-section">
      <h3>이 기기의 알림</h3><p>호스트 발송 {state.enabled ? "켜짐" : "꺼짐"} · 브라우저 권한 {permission}</p>
      <p>{state.device?.enabled ? `등록됨 · 구독 기한 ${featureTime(state.device.expiresAt)}` : "이 기기의 알림이 꺼져 있거나 등록 기한이 지났습니다."}</p>
      {unavailable ? <p className="notice compact">{unavailable}</p> : null}{state.device?.error ? <p role="status">{state.device.error}</p> : null}
      <div className="feature-actions"><button type="button" className="button small primary" disabled={busy || !!unavailable || !state.enabled || !state.publicKey} onClick={() => void perform(() => enableMobilePush(api, state), "이 기기의 알림을 등록했습니다.")}>{state.device?.enabled ? "알림 다시 등록" : "이 기기에서 알림 허용"}</button>
        <button type="button" className="button small" disabled={busy || !state.device?.enabled} onClick={() => void perform(() => disableMobilePush(api, state.hostId), "이 기기의 알림을 해제했습니다. 작업과 기기 연결은 유지됩니다.")}>이 기기 알림 해제</button></div>
      {!state.enabled ? <p className="sheet-hint">호스트 PC의 모바일 알림 설정에서 발송을 먼저 켜 주세요.</p> : null}
      <p className="sheet-hint">iPhone·iPad는 Safari에서 홈 화면에 추가한 앱으로 열어 주세요. HTTPS와 브라우저의 알림 권한이 필요합니다. 앱을 사용하는 동안 기존 동의를 바탕으로 최대 48시간의 구독을 갱신합니다. 만료되면 이 화면에서 다시 등록하세요.</p>
      <p className="sheet-hint">같은 앱에서 연결한 호스트별로 알림을 등록합니다. 호스트를 전환해도 다른 호스트의 알림 등록을 덮어쓰지 않습니다. 브라우저가 기기 인증정보를 유지하지 못하면 알림을 연 뒤 다시 연결해야 합니다.</p>
      {state.device?.lastDeliveryAt ? <p>최근 요청 {featureTime(state.device.lastDeliveryAt)} · {state.device.lastDelivery === "sent" ? "푸시 서비스 접수" : state.device.lastDelivery === "rejected" ? "접수 거절" : "결과 미확인"}</p> : null}
    </section> : <>
      <section className="feature-section"><h3>이 PC에서 모바일로 발송</h3>
        <form className="feature-form" onSubmit={event => { event.preventDefault(); void perform(() => api.request<PushSettings>("PUT", "/api/push/settings", config), "모바일 알림 발송 설정을 저장했습니다."); }}><fieldset disabled={busy}>
          <label className="feature-check"><input type="checkbox" checked={config.enabled} onChange={event => setConfig({ ...config, enabled: event.target.checked })} />연결한 기기로 알림 발송</label>
          <label>푸시 서비스에 제공할 연락처<input value={config.subject} placeholder="mailto:you@example.com 또는 https://…" required={config.enabled} maxLength={512} onChange={event => setConfig({ ...config, subject: event.target.value })} /></label>
          <p className="sheet-hint">기본은 꺼짐입니다. 발송 키는 운영체제 보안 저장소로 보호하며, 보안 저장소를 사용할 수 없으면 발송 설정을 완료하지 않습니다. 각 모바일 기기에서 연결·프로젝트 읽기 권한과 알림 허용을 따로 설정합니다.</p>
          <button className="button small primary" type="submit">발송 설정 저장</button>
        </fieldset></form>
        <p className="sheet-hint">작업 알림 설정과 세션 음소거를 따릅니다. 호스트가 실행 중이고 인터넷에 연결되어 있어야 전달할 수 있습니다. 발송 서비스 접수는 실제 기기 도착 확인과 다릅니다.</p>
      </section>
      <section className="feature-section"><h3>등록한 기기 알림</h3><div className="feature-cards">{settings?.devices.map(device => <article key={device.deviceId}>
        <strong>기기 {device.deviceId}</strong><p>{device.enabled ? "등록됨" : "해제·만료됨"} · 기한 {featureTime(device.expiresAt)}</p><p>최근 발송 요청 {featureTime(device.lastDeliveryAt)} · {device.lastDelivery === "sent" ? "서비스 접수" : device.lastDelivery === "rejected" ? "접수 거절" : device.lastDelivery === "unknown" ? "결과 미확인" : "없음"}</p>
        {device.error ? <p>{device.error}</p> : null}<button className="button small" type="button" disabled={busy || !device.enabled} onClick={() => void perform(() => api.request<PushSettings>("DELETE", `/api/push/devices/${encodeURIComponent(device.deviceId)}`), "선택한 기기의 알림을 해제했습니다.")}>이 기기 알림 해제</button>
      </article>)}{!settings?.devices.length ? <p>모바일 기기에서 연결한 뒤 알림을 허용하면 여기에 표시됩니다.</p> : null}</div></section>
      <section className="feature-section"><h3>발송 키 교체</h3><p className="sheet-hint">키를 교체하면 모든 기기의 알림 등록과 기존 알림 링크를 해제합니다. 각 기기에서 다시 등록해야 합니다.</p>
        <label className="feature-check"><input type="checkbox" checked={rotateConfirm} onChange={event => setRotateConfirm(event.target.checked)} />모든 기기의 알림 재등록이 필요한 것을 확인했습니다.</label>
        <button type="button" className="button small" disabled={busy || !state.configured || !rotateConfirm} onClick={() => void perform(async () => { const next = await api.request<PushSettings>("POST", "/api/push/rotate", {}); if (live.current) setRotateConfirm(false); return next; }, "발송 키를 교체했습니다. 각 기기에서 알림을 다시 등록해 주세요.")}>발송 키 교체</button>
      </section>
    </>}
    <div className="feature-actions"><button type="button" className="button small" disabled={busy} onClick={() => void perform(refresh, "알림 설정을 다시 불러왔습니다.")}>새로고침</button></div>
  </FeatureDialog>;
}
