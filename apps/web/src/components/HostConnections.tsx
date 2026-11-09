import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { DeviceGrant, DevicePermission, PairingRequest } from "../../../../packages/contracts/src/devices.ts";
import {
  DEVICE_PERMISSION_LABELS, pairingHostPreview,
  type DeviceApprovalInput, type DeviceManagementState, type HostConnectionsController,
  type HostPairingOffer, type LocalDeviceApi, type LocalDeviceConfig,
} from "../host-connections.ts";
import { restoreSurfaceFocus } from "./controls/menu-navigation.ts";
import { Icon } from "./Icon.tsx";
import "../styles/host-connections.css";

export type HostConnectionsProps = {
  open: boolean;
  api: LocalDeviceApi;
  controller: HostConnectionsController;
  onClose(): void;
  localLabel?: string;
  localAvailable?: boolean;
  initialOffer?: string;
};

const time = (value: number) => new Date(value).toLocaleString("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const problemText = (error: unknown) => error instanceof Error ? error.message : String(error);
const PHASE_LABELS = {
  local: "현재 PC 사용 중", connecting: "연결 중…", "awaiting-approval": "호스트의 승인 대기",
  connected: "연결됨", offline: "연결 끊김", error: "연결 오류",
};
const LOCAL_STATUS: Record<string, string> = { disabled: "꺼짐", starting: "시작 중…", ready: "연결 준비됨", listening: "연결 대기 중", connected: "연결됨", offline: "연결 끊김", error: "오류" };

export function HostConnections(props: HostConnectionsProps) {
  return props.open ? <HostConnectionsDialog {...props} /> : null;
}

function HostConnectionsDialog({ api, controller, onClose, localLabel = "현재 PC", localAvailable = true, initialOffer = "" }: HostConnectionsProps) {
  const snapshot = useSyncExternalStore(useCallback(listener => controller.subscribe(listener), [controller]), useCallback(() => controller.getSnapshot(), [controller]));
  const local = localAvailable && snapshot.activeHostId === null;
  const dialog = useRef<HTMLDialogElement>(null), opener = useRef(document.activeElement), live = useRef(true), pending = useRef(false);
  const offerInput = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<DeviceManagementState | null>(null);
  const [config, setConfig] = useState<LocalDeviceConfig | null>(null);
  const [offer, setOffer] = useState<HostPairingOffer | null>(null);
  const [busy, setBusy] = useState(""), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [link, setLink] = useState(initialOffer), [deviceName, setDeviceName] = useState("");
  const [removeId, setRemoveId] = useState<string | null>(null), [now, setNow] = useState(Date.now);
  const preview = pairingHostPreview(link);
  const connecting = snapshot.phase === "connecting" || snapshot.phase === "awaiting-approval";

  useLayoutEffect(() => {
    const surface = dialog.current;
    surface?.showModal();
    return () => restoreSurfaceFocus(opener.current, surface);
  }, []);
  useEffect(() => {
    live.current = true;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => { live.current = false; clearInterval(timer); };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await api.state();
      if (live.current) { setState(next); setConfig(current => current ?? next.config); }
    } catch (reason) { if (live.current) setError(problemText(reason)); }
  }, [api]);
  useEffect(() => {
    if (!local) return;
    void refresh();
    const timer = setInterval(() => { if (!pending.current) void refresh(); }, 5_000);
    return () => clearInterval(timer);
  }, [local, refresh]);

  async function perform<T>(name: string, action: () => Promise<T>, done?: (value: T) => void) {
    if (pending.current) return;
    pending.current = true; setBusy(name); setError(""); setNotice("");
    try { const result = await action(); if (live.current) done?.(result); }
    catch (reason) { if (live.current) setError(problemText(reason)); }
    finally { pending.current = false; if (live.current) setBusy(""); }
  }
  const changed = (message: string) => { setNotice(message); void refresh(); };
  const saveConfig = () => {
    if (!config) return;
    void perform("config", () => api.configure(config), next => {
      setState(next); setConfig(next.config); setOffer(null); setNotice("원격 연결 설정을 저장했습니다.");
    });
  };
  const makeOffer = () => {
    setOffer(null);
    void perform("offer", () => api.createOffer(), next => { setOffer(next); setNotice("새 기기에서 링크를 연 뒤, 이 화면에서 연결을 승인하세요."); });
  };
  const copyOffer = async () => {
    if (!offer || offer.expiresAt <= Date.now()) return;
    try { await navigator.clipboard.writeText(offer.url); if (live.current) setNotice("연결 링크를 복사했습니다."); }
    catch { offerInput.current?.focus(); offerInput.current?.select(); setNotice("연결 링크를 선택했습니다. 복사 명령으로 복사해 주세요."); }
  };
  const disconnect = () => {
    // Cancellation remains available while connectOffer is waiting for approval.
    setError("");
    void controller.disconnect().catch(reason => { if (live.current) setError(problemText(reason)); });
  };
  const projects = [...new Map((state?.workspaces ?? []).map(project => [project.workId, project])).values()];

  return <dialog ref={dialog} className="host-connections-dialog" aria-labelledby="host-connections-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="host-connections-head">
      <div><h2 id="host-connections-title">기기 연결</h2><p role="status">{!localAvailable && snapshot.phase === "local" ? "연결할 호스트를 선택하세요" : PHASE_LABELS[snapshot.phase]}{snapshot.message ? ` · ${snapshot.message}` : ""}</p></div>
      <button type="button" className="icon-button" onClick={onClose} aria-label="기기 연결 닫기"><Icon name="x" size={18} /></button>
    </header>
    {error ? <p className="host-connections-error" role="alert">{error}</p> : null}
    {notice ? <p className="host-connections-notice" role="status">{notice}</p> : null}

    <section className="host-connections-section" aria-labelledby="saved-hosts-title">
      <h3 id="saved-hosts-title">사용할 호스트</h3>
      <ul className="host-connections-list">
        {localAvailable ? <li className="host-connection-row">
          <div className="host-connection-main"><strong>{localLabel}</strong><span>{local ? "선택됨" : "이 기기의 로컬 연결"}</span></div>
          <button type="button" className="button small" onClick={disconnect} disabled={local && !connecting}>이 PC 사용</button>
        </li> : null}
        {snapshot.hosts.map(host => <li key={host.hostId} className="host-connection-row">
          <div className="host-connection-main"><strong>{host.label}</strong><span>{host.endpoint}</span><small>{snapshot.activeHostId === host.hostId ? PHASE_LABELS[snapshot.phase] : host.lastConnectedAt ? `최근 연결 ${time(host.lastConnectedAt)}` : "저장된 연결"}</small></div>
          <div className="host-connection-actions">
            <button type="button" className="button small" disabled={!!busy || (snapshot.activeHostId === host.hostId && snapshot.phase === "connected")} onClick={() => void perform(`select:${host.hostId}`, () => controller.selectHost(host.hostId))}>사용하기</button>
            {snapshot.activeHostId === host.hostId ? <button type="button" className="text-button" onClick={disconnect}>연결 끊기</button> : null}
            <button type="button" className="text-button" disabled={!!busy} onClick={() => setRemoveId(removeId === host.hostId ? null : host.hostId)}>목록에서 삭제</button>
          </div>
          {removeId === host.hostId ? <div className="host-connection-confirm">
            <p>이 기기에 저장된 ‘{host.label}’ 연결 정보와 인증정보만 삭제합니다. 다른 호스트의 연결은 유지됩니다.</p>
            <button type="button" className="button danger small" disabled={!!busy} onClick={() => void perform(`remove:${host.hostId}`, () => controller.remove(host.hostId), () => { setRemoveId(null); setNotice("이 기기에서 해당 호스트 연결을 삭제했습니다."); })}>이 기기에서 삭제</button>
            <button type="button" className="text-button" onClick={() => setRemoveId(null)}>취소</button>
          </div> : null}
        </li>)}
      </ul>
      {!localAvailable && !snapshot.hosts.length ? <p className="muted">아직 저장된 호스트가 없습니다. 아래에서 연결 링크를 입력하세요.</p> : null}
    </section>

    <section className="host-connections-section" aria-labelledby="join-host-title">
      <h3 id="join-host-title">다른 PC에 연결</h3>
      <form className="host-connection-form" onSubmit={event => {
        event.preventDefault();
        void perform("connect", () => controller.connectOffer(link.trim(), deviceName.trim()), () => { setLink(""); setNotice("호스트에 연결했습니다."); });
      }}>
        <label>연결 링크<textarea value={link} onChange={event => setLink(event.target.value)} placeholder="호스트에서 만든 연결 링크를 붙여넣으세요" rows={2} autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={!!busy || connecting} required /></label>
        <label>이 기기의 이름<input value={deviceName} onChange={event => setDeviceName(event.target.value)} placeholder="예: 내 휴대폰" autoComplete="off" maxLength={80} disabled={!!busy || connecting} required /></label>
        {preview ? <div className="host-connection-identity"><span>대상 호스트 <code>{preview.hostId}</code></span><span>호스트 공개키 <code>{preview.daemonPublicKeyB64}</code></span></div> : null}
        <div className="host-connection-actions">
          <button type="submit" className="button primary" disabled={!!busy || connecting || !link.trim() || !deviceName.trim()}>연결 요청</button>
          <button type="button" className="button" disabled={!!busy || connecting || !controller.scan} title={controller.scan ? undefined : "이 환경에서는 휴대폰 카메라로 QR을 열거나 링크를 붙여넣으세요."} onClick={() => void perform("scan", () => controller.scan!(), value => { if (value) setLink(value); })}>QR 스캔</button>
          {connecting ? <button type="button" className="text-button" onClick={disconnect}>연결 요청 취소</button> : null}
        </div>
        {!controller.scan ? <p className="muted">휴대폰 카메라로 QR을 열거나 연결 링크를 붙여넣을 수 있습니다.</p> : null}
      </form>
      {snapshot.verificationCode ? <div className="host-connection-verification" role="status"><span>연결 확인번호</span><strong>{snapshot.verificationCode}</strong><p>호스트 화면에도 같은 번호가 표시되는지 확인한 뒤 승인하세요.</p></div> : null}
      {snapshot.credentialStorage === "session" ? <p className="muted">연결 인증정보는 현재 앱·브라우저 세션에 보관됩니다. 세션이 끝나면 다시 연결해야 할 수 있습니다.</p> : <p className="muted">연결 인증정보를 이 기기의 보안 저장소에 보관합니다.</p>}
    </section>

    <section className="host-connections-section" aria-labelledby="local-devices-title">
      <div className="host-connection-section-head"><h3 id="local-devices-title">이 PC에 연결 허용</h3><button type="button" className="text-button" disabled={!local || !!busy} onClick={() => void refresh()}>새로 고침</button></div>
      {!localAvailable ? <p className="muted">연결을 받을 PC의 Workbench에서 새 기기를 승인하고 연결 설정을 관리할 수 있습니다.</p> : !local ? <p className="muted">‘이 PC 사용’으로 돌아오면 원격 연결과 승인된 기기를 관리할 수 있습니다.</p> : !state || !config ? <p role="status">이 PC의 연결 상태를 불러오는 중…</p> : <>
        <p className="host-connection-local-status">{LOCAL_STATUS[state.status] ?? state.status}</p>
        {state.error ? <p role="alert" className="host-connections-error">{state.error}</p> : null}
        <form className="host-connection-form" onSubmit={event => { event.preventDefault(); saveConfig(); }}>
          <label className="host-connection-check"><input type="checkbox" checked={config.enabled} disabled={!!busy} onChange={event => setConfig({ ...config, enabled: event.target.checked })} />다른 기기의 연결 허용</label>
          <label>이 PC의 이름<input value={config.label ?? ""} maxLength={80} disabled={!!busy} onChange={event => setConfig({ ...config, label: event.target.value })} placeholder={localLabel} /></label>
          <details className="host-connection-network"><summary>연결 주소 설정</summary>
            <label>중계 서버 주소<input value={config.relayUrl ?? ""} disabled={!!busy} onChange={event => setConfig({ ...config, relayUrl: event.target.value })} placeholder="wss://…" autoCapitalize="none" spellCheck={false} /></label>
            <label>다른 기기에서 접속할 주소<input value={config.publicUrl ?? ""} disabled={!!busy} onChange={event => setConfig({ ...config, publicUrl: event.target.value })} placeholder="https://…" autoCapitalize="none" spellCheck={false} /></label>
            <div className="host-connection-fields"><label>수신 주소<input value={config.listenHost ?? ""} disabled={!!busy} onChange={event => setConfig({ ...config, listenHost: event.target.value })} placeholder="127.0.0.1" /></label>
              <label>포트 · 0은 자동<input type="number" min={0} max={65535} value={config.port ?? ""} disabled={!!busy} onChange={event => setConfig({ ...config, port: event.target.value ? Number(event.target.value) : undefined })} /></label></div>
            <p className="muted">휴대폰에서 QR로 웹 화면을 열려면 접속 가능한 앱 주소를 입력하세요. 수신 주소 127.0.0.1은 이 PC에서만 연결할 수 있습니다.</p>
          </details>
          <div className="host-connection-actions"><button type="submit" className="button" disabled={!!busy}>설정 저장</button><button type="button" className="button primary" disabled={!!busy || !state.config.enabled} onClick={makeOffer}>{busy === "offer" ? "만드는 중…" : "새 기기 연결 링크 만들기"}</button></div>
        </form>
        <div className="host-connection-identity"><span>호스트 <code>{state.hostId}</code></span><span>공개키 지문 <code>{state.hostFingerprint}</code></span></div>
        {offer ? <div className="host-connection-offer">
          <strong>{offer.expiresAt <= now ? "연결 링크가 만료되었습니다" : "한 번만 사용할 수 있는 연결 링크"}</strong>
          <p>{offer.expiresAt <= now ? "새 기기 연결 링크를 다시 만들어 주세요." : `${time(offer.expiresAt)}까지 사용할 수 있습니다. 연결 요청 후 이 PC에서 승인해야 합니다.`}</p>
          {offer.url.startsWith("workbench:") ? <p className="muted">웹 앱 주소가 설정되지 않은 링크입니다. 새 기기의 ‘다른 PC에 연결’에 붙여넣으세요. QR만으로 웹 화면을 열 수는 없습니다.</p> : null}
          {offer.expiresAt > now && offer.qrDataUrl && /^data:image\/(png|svg\+xml);/i.test(offer.qrDataUrl) ? <img className="host-connection-qr" src={offer.qrDataUrl} alt="새 기기에서 열 연결 QR 코드" /> : null}
          <label>연결 링크<input ref={offerInput} readOnly value={offer.url} aria-label="이 PC의 연결 링크" /></label>
          <button type="button" className="button small" disabled={offer.expiresAt <= now} onClick={() => void copyOffer()}><Icon name="copy" size={14} />링크 복사</button>
        </div> : null}
        <div className="host-connection-section-head"><h4>승인 대기</h4><span>{state.pending.length}개</span></div>
        {state.pending.length ? state.pending.map(request => <PendingDevice key={`${request.requestId}:${request.verificationCode}`} request={request} projects={projects} busy={!!busy} now={now}
          onApprove={input => void perform(`approve:${request.requestId}`, () => api.approve(request.requestId, input), () => { setOffer(null); changed("기기를 승인했습니다. 새 기기에서 연결을 마칠 수 있습니다."); })}
          onReject={() => void perform(`reject:${request.requestId}`, () => api.reject(request.requestId), () => changed("연결 요청을 거절했습니다."))} />) : <p className="muted">기기의 연결 요청이 오면 이름과 확인번호가 여기에 표시됩니다.</p>}
        <h4>승인한 기기</h4>
        {state.devices.length ? <ul className="host-connections-list">{state.devices.map(device => <DeviceRow key={device.deviceId} device={device} projects={projects} now={now} busy={!!busy}
          onRevoke={() => void perform(`revoke:${device.deviceId}`, () => api.revoke(device.deviceId), () => changed("해당 기기의 접근을 철회했습니다."))}
          onRotate={() => void perform(`rotate:${device.deviceId}`, () => api.rotate(device.deviceId), next => { setOffer(next); changed("기존 기기의 접근을 끊었습니다. 새 연결 링크로 다시 등록하세요."); })} />)}</ul> : <p className="muted">아직 승인한 기기가 없습니다.</p>}
      </>}
    </section>
    <footer className="host-connections-foot"><button type="button" className="button" onClick={onClose}>닫기</button></footer>
  </dialog>;
}

function PendingDevice({ request, projects, busy, now, onApprove, onReject }: {
  request: PairingRequest; projects: { workId: string; label: string }[]; busy: boolean; now: number;
  onApprove(input: DeviceApprovalInput): void; onReject(): void;
}) {
  const [confirmed, setConfirmed] = useState(false), [permissions, setPermissions] = useState<DevicePermission[]>(["read"]), [workIds, setWorkIds] = useState<string[]>([]);
  const selected = workIds.filter(id => projects.some(project => project.workId === id));
  const expired = request.expiresAt <= now;
  return <form className="host-connection-pending" aria-label={`${request.name} 연결 승인`} onSubmit={event => {
    event.preventDefault(); if (!busy && !expired && confirmed && selected.length && permissions.length) onApprove({ permissions, workIds: selected });
  }}>
    <div className="host-connection-section-head"><strong>{request.name}</strong><span>{request.platform ?? "기기 종류 미제공"}</span></div>
    <div className="host-connection-verification"><span>연결 확인번호</span><strong>{request.verificationCode}</strong><small>{expired ? "만료된 요청" : `${time(request.expiresAt)}까지 승인 가능`}</small></div>
    <fieldset disabled={busy || expired}>
      <label className="host-connection-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />새 기기에도 같은 확인번호가 표시되는 것을 확인했습니다</label>
      <fieldset><legend>접근할 프로젝트</legend>{projects.length ? projects.map(project => <label key={project.workId} className="host-connection-check"><input type="checkbox" checked={workIds.includes(project.workId)} onChange={event => setWorkIds(current => event.target.checked ? [...current, project.workId] : current.filter(id => id !== project.workId))} />{project.label}</label>) : <p className="muted">먼저 이 PC에 프로젝트를 만들어 주세요.</p>}</fieldset>
      <fieldset><legend>허용할 동작</legend>{(Object.keys(DEVICE_PERMISSION_LABELS) as DevicePermission[]).map(permission => <label key={permission} className="host-connection-check"><input type="checkbox" checked={permissions.includes(permission)} onChange={event => setPermissions(current => event.target.checked ? [...current, permission] : current.filter(item => item !== permission))} />{DEVICE_PERMISSION_LABELS[permission]}</label>)}</fieldset>
    </fieldset>
    <p className="muted">승인한 권한은 30일 후 만료됩니다.</p>
    <div className="host-connection-actions"><button type="submit" className="button primary small" disabled={busy || expired || !confirmed || !selected.length || !permissions.length}>선택한 범위로 승인</button><button type="button" className="text-button" disabled={busy} onClick={onReject}>거절</button></div>
  </form>;
}

function DeviceRow({ device, projects, now, busy, onRevoke, onRotate }: {
  device: DeviceGrant; projects: { workId: string; label: string }[]; now: number; busy: boolean; onRevoke(): void; onRotate(): void;
}) {
  const revoked = device.revokedAt !== null, expired = device.expiresAt !== null && device.expiresAt <= now;
  return <li className="host-connection-row">
    <div className="host-connection-main"><strong>{device.name}</strong><span>{revoked ? "접근 철회됨" : expired ? "권한 만료" : device.activatedAt === null ? "승인됨 · 새 기기의 연결 대기" : "승인됨"}{device.platform ? ` · ${device.platform}` : ""}</span>
      <small>{device.permissions.map(permission => DEVICE_PERMISSION_LABELS[permission]).join(" · ")}</small><small>{device.workIds.map(id => projects.find(project => project.workId === id)?.label ?? id).join(" · ") || "프로젝트 접근 없음"}</small>
      {device.expiresAt !== null ? <small>권한 만료 {time(device.expiresAt)}</small> : null}
    </div>
    {!revoked ? <div className="host-connection-actions"><button type="button" className="text-button" disabled={busy} onClick={onRevoke}>접근 철회</button><button type="button" className="text-button" disabled={busy} onClick={onRotate}>접근 끊고 새 링크</button></div> : null}
  </li>;
}
