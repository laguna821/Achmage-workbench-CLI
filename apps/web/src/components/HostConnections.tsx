import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { DeviceGrant, DevicePermission, PairingRequest } from "../../../../packages/contracts/src/devices.ts";
import {
  DEVICE_PERMISSION_LABELS, pairingHostPreview, rememberLimit,
  type DeviceApprovalInput, type DeviceManagementState, type HostConnectionsController,
  type HostPairingOffer, type LocalDeviceApi, type LocalDeviceConfig,
} from "../host-connections.ts";
import { restoreSurfaceFocus } from "./controls/menu-navigation.ts";
import { Icon } from "./Icon.tsx";
import { QrScanner } from "./QrScanner.tsx";
import { TailscalePanel } from "./TailscalePanel.tsx";
import { NoteBanner } from "../conversation/NoteBanner.tsx";
import { PathDetail } from "./SettingsSheet.tsx";
import { Segmented } from "./ui/Hig.tsx";
import { MESSENGER_NEEDS, PHONE_PAGE_SETUP } from "./phone-words.ts";
import { parseRemoteOffer } from "@workbench/client";
import "../styles/host-connections.css";

export type HostConnectionsProps = {
  open: boolean;
  api: LocalDeviceApi;
  controller: HostConnectionsController;
  onClose(): void;
  localLabel?: string;
  localAvailable?: boolean;
  initialOffer?: string;
  /** Opens the phone messenger set-up (this PC only): the easiest way to use this PC from a phone. */
  onMessenger?: () => void;
  /** Opens a fixed page (Tailscale's download and admin pages) in the browser. */
  openExternal?: (url: string) => Promise<void> | void;
};

const time = (value: number) => new Date(value).toLocaleString("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const problemText = (error: unknown) => error instanceof Error ? error.message : String(error);
const PHASE_LABELS = {
  local: "이 PC를 쓰는 중", connecting: "연결하는 중", "awaiting-approval": "그 PC의 승인을 기다리는 중",
  connected: "연결됨", offline: "연결 끊김", error: "연결하지 못함",
};
const LOCAL_STATUS: Record<string, string> = { disabled: "꺼짐", starting: "켜는 중", ready: "연결 준비됨", listening: "연결을 기다리는 중", connected: "연결됨", offline: "연결 끊김", error: "문제가 있음" };
/** The permissions in words without middle dots (the shared labels keep theirs for older screens). */
const PERMISSION_WORDS: Record<DevicePermission, string> = { ...DEVICE_PERMISSION_LABELS, read: "대화와 파일 읽기" };
/** What failed, said before the reason (p5): the action's name is known here, the reason comes from the PC. */
const FAILED: Record<string, string> = {
  config: "설정을 저장하지 못했습니다.", offer: "연결 QR을 만들지 못했습니다.", connect: "연결하지 못했습니다.", scan: "QR을 읽지 못했습니다.",
  approve: "승인하지 못했습니다.", reject: "거절하지 못했습니다.", revoke: "연결을 끊지 못했습니다.", rotate: "새 링크를 만들지 못했습니다.",
  remove: "목록에서 지우지 못했습니다.", select: "그 PC로 바꾸지 못했습니다.",
};
const failedWords = (name: string, reason: string) => `${FAILED[name.split(":")[0]!] ?? "하지 못했습니다."} ${reason} 다시 해 보고, 그래도 안 되면 앱을 다시 여세요.`;

export function HostConnections(props: HostConnectionsProps) {
  return props.open ? <HostConnectionsDialog {...props} /> : null;
}

/** 기기 연결 as its own dialog: the fallback page, a link someone arrived with, the top bar's PC name. */
function HostConnectionsDialog(props: HostConnectionsProps) {
  const dialog = useRef<HTMLDialogElement>(null), opener = useRef(document.activeElement);
  const scanning = useRef<() => boolean>(() => false);
  useLayoutEffect(() => {
    const surface = dialog.current;
    surface?.showModal();
    return () => restoreSurfaceFocus(opener.current, surface);
  }, []);
  return <dialog ref={dialog} className="host-connections-dialog" aria-labelledby="host-connections-title" onCancel={event => { event.preventDefault(); if (!scanning.current()) props.onClose(); }}>
    <header className="host-connections-head">
      <h2 id="host-connections-title">기기 연결</h2>
      <button type="button" className="icon-button" onClick={props.onClose} aria-label="기기 연결 닫기"><Icon name="x" size={18} /></button>
    </header>
    <HostConnectionsPanel {...props} scanning={scanning} />
    <footer className="host-connections-foot"><button type="button" className="button" onClick={props.onClose}>닫기</button></footer>
  </dialog>;
}

/**
 * 기기 연결 itself: in 설정 › 휴대폰과 다른 기기, and inside the dialog above. Using this PC from a
 * phone comes first, as numbered steps (what you do on the phone, what you see here).
 */
export function HostConnectionsPanel({ api, controller, localLabel = "현재 PC", localAvailable = true, initialOffer = "", onMessenger, openExternal, scanning }: Omit<HostConnectionsProps, "open" | "onClose"> & { scanning?: { current: () => boolean } }) {
  const snapshot = useSyncExternalStore(useCallback(listener => controller.subscribe(listener), [controller]), useCallback(() => controller.getSnapshot(), [controller]));
  const local = localAvailable && snapshot.activeHostId === null;
  const live = useRef(true), pending = useRef(false);
  const offerInput = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<DeviceManagementState | null>(null);
  const [config, setConfig] = useState<LocalDeviceConfig | null>(null);
  const [offer, setOffer] = useState<HostPairingOffer | null>(null);
  const [busy, setBusy] = useState(""), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [link, setLink] = useState(initialOffer), [deviceName, setDeviceName] = useState("");
  const [scanOpen, setScanOpen] = useState(false), [remember, setRemember] = useState(false);
  const [otherOpen, setOtherOpen] = useState(false);
  const network = useRef<HTMLDetailsElement>(null), publicAddress = useRef<HTMLInputElement>(null);
  // Remembering is asked of a browser only; the desktop app's keychain always keeps the credential.
  const canRemember = snapshot.canRemember === true;
  // Plain http is not a secure context: the browser withholds the camera and notifications there.
  const limit = rememberLimit(), insecure = limit === "http";
  const [removeId, setRemoveId] = useState<string | null>(null), [now, setNow] = useState(Date.now);
  const preview = pairingHostPreview(link);
  const connecting = snapshot.phase === "connecting" || snapshot.phase === "awaiting-approval";
  useEffect(() => { if (connecting || busy) setScanOpen(false); }, [connecting, busy]);

  // Escape closes the camera first, the dialog only after.
  if (scanning) scanning.current = () => { if (!scanOpen) return false; setScanOpen(false); return true; };
  useEffect(() => {
    live.current = true;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => { live.current = false; clearInterval(timer); };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await api.state();
      if (live.current) { setState(next); setConfig(current => current ?? next.config); }
    } catch (reason) { if (live.current) setError(`이 PC의 연결 상태를 읽지 못했습니다. ${problemText(reason)} 잠시 뒤 새로 고침을 누르세요.`); }
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
    catch (reason) { if (live.current) setError(failedWords(name, problemText(reason))); }
    finally { pending.current = false; if (live.current) setBusy(""); }
  }
  const changed = (message: string) => { setNotice(message); void refresh(); };
  // 테일스케일 켜기/끄기 changed the connection settings themselves: the form shows them as they now are.
  const settingsChanged = () => { void api.state().then(next => { if (live.current) { setState(next); setConfig(next.config); setOffer(null); } }).catch(() => {}); };
  const saveConfig = () => {
    if (!config) return;
    void perform("config", () => api.configure(config), next => {
      setState(next); setConfig(next.config); setOffer(null); setNotice("연결 설정을 저장했습니다.");
    });
  };
  const makeOffer = () => {
    setOffer(null);
    void perform("offer", () => api.createOffer(), next => { setOffer(next); setNotice("휴대폰으로 QR을 찍거나 링크를 연 뒤, 아래 3단계에서 승인하세요."); });
  };
  const copyOffer = async () => {
    if (!offer || offer.expiresAt <= Date.now()) return;
    try { await navigator.clipboard.writeText(offer.url); if (live.current) setNotice("연결 링크를 복사했습니다."); }
    catch { offerInput.current?.focus(); offerInput.current?.select(); setNotice("연결 링크를 선택했습니다. 복사 명령으로 복사해 주세요."); }
  };
  const disconnect = () => {
    // Cancellation remains available while connectOffer is waiting for approval.
    setError("");
    void controller.disconnect().catch(reason => { if (live.current) setError(failedWords("connect", problemText(reason))); });
  };
  const projects = [...new Map((state?.workspaces ?? []).map(project => [project.workId, project])).values()];
  // Remote access is on, yet nothing a phone could open leads here: only this PC can connect.
  const phoneUrl = state?.phoneUrl ?? null;
  const unreachable = !!state && state.config.enabled && state.status === "listening" && !phoneUrl;
  const showAddress = () => { if (network.current) network.current.open = true; publicAddress.current?.focus(); };

  // On this PC people open this to use the PC from a phone: that comes first. Joining another PC
  // (a link, the camera, a QR picture) is the other side's job — a phone's browser, a second PC —
  // and stays folded here unless it is what the person is doing.
  const joining = !local || snapshot.hosts.length > 0 || connecting || !!initialOffer || !!snapshot.verificationCode;
  const hostsSection = <>
    <section className="host-connections-section" aria-labelledby="saved-hosts-title">
      <h3 id="saved-hosts-title">쓸 PC</h3>
      <ul className="host-connections-list">
        {localAvailable ? <li className="host-connection-row">
          <div className="host-connection-main"><strong>{localLabel}</strong><span>{local ? "지금 쓰는 중" : "이 기기 자신"}</span></div>
          <div className="host-connection-actions"><button type="button" className="button small" onClick={disconnect} disabled={local && !connecting}>이 PC 사용</button></div>
        </li> : null}
        {snapshot.hosts.map(host => <li key={host.hostId} className="host-connection-row">
          <div className="host-connection-main"><strong>{host.label}</strong><span>{snapshot.activeHostId === host.hostId ? PHASE_LABELS[snapshot.phase] : host.lastConnectedAt ? `마지막 연결 ${time(host.lastConnectedAt)}` : "저장해 둔 PC"}</span>
            {host.remembered ? <small>이 브라우저에 기억됨: 탭을 닫아도 다시 승인받지 않습니다</small> : null}
            <PathDetail value={host.endpoint} label="주소 보기" /></div>
          <div className="host-connection-actions">
            <button type="button" className="button small" disabled={!!busy || (snapshot.activeHostId === host.hostId && snapshot.phase === "connected")} onClick={() => void perform(`select:${host.hostId}`, () => controller.selectHost(host.hostId))}>사용하기</button>
            {snapshot.activeHostId === host.hostId ? <button type="button" className="text-button" onClick={disconnect}>연결 끊기</button> : null}
            <button type="button" className="text-button" disabled={!!busy} onClick={() => setRemoveId(removeId === host.hostId ? null : host.hostId)}>목록에서 삭제</button>
          </div>
          {removeId === host.hostId ? <div className="host-connection-confirm" role="group" aria-label={`${host.label} 삭제 확인`}>
            <p>이 기기에 저장한 ‘{host.label}’ 연결 정보만 지웁니다. 다른 PC의 연결은 그대로입니다.</p>
            <div className="host-connection-actions"><button type="button" className="button small" onClick={() => setRemoveId(null)}>취소</button>
              <button type="button" className="button danger small" disabled={!!busy} onClick={() => void perform(`remove:${host.hostId}`, () => controller.remove(host.hostId), () => { setRemoveId(null); setNotice("이 기기에서 그 PC의 연결을 지웠습니다."); })}>이 기기에서 삭제</button></div>
          </div> : null}
        </li>)}
      </ul>
      {!localAvailable && !snapshot.hosts.length ? <p className="muted">아직 저장한 PC가 없습니다. 아래에 그 PC에서 받은 연결 링크를 넣으세요.</p> : null}
    </section>
  </>;
  const joinSection = <>
    <section className="host-connections-section" aria-labelledby="join-host-title">
      <h3 id="join-host-title">다른 PC에 연결</h3>
      {insecure ? <NoteBanner label="http로 연 페이지">이 페이지는 암호화되지 않은 http 주소로 열려 카메라 QR 스캔과 알림을 쓸 수 없습니다. 연결 링크를 붙여넣거나 QR 그림을 골라 연결하세요.</NoteBanner> : null}
      <form className="host-connection-form" onSubmit={event => {
        event.preventDefault();
        setScanOpen(false);
        void perform("connect", () => controller.connectOffer(link.trim(), deviceName.trim(), { remember: remember && canRemember }), () => { setLink(""); setNotice("그 PC에 연결했습니다."); });
      }}>
        <label>연결 링크<textarea value={link} onChange={event => setLink(event.target.value)} placeholder="그 PC에서 만든 연결 링크를 붙여넣으세요" rows={2} autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={!!busy || connecting} required /></label>
        <label>이 기기의 이름<input value={deviceName} onChange={event => setDeviceName(event.target.value)} placeholder="예: 내 휴대폰" autoComplete="off" maxLength={80} disabled={!!busy || connecting} required /></label>
        {preview ? <details className="settings-path"><summary>연결할 PC 확인</summary><code>{`PC ${preview.hostId}\n공개키 ${preview.daemonPublicKeyB64}`}</code></details> : null}
        {snapshot.credentialStorage === "session" ? <>
          <label className="host-connection-check"><input type="checkbox" checked={remember && canRemember} disabled={!canRemember || !!busy || connecting} onChange={event => setRemember(event.target.checked)} />이 기기 기억하기</label>
          <p className="muted">{!canRemember ? (insecure ? "http 주소로 연 페이지에서는 연결을 기억하지 않습니다. https 주소로 열면 켤 수 있습니다. 지금은 탭이나 앱을 닫으면 PC에서 다시 승인받아야 합니다."
            : limit === "loopback" ? "이 PC 자신의 주소로 연 페이지에서는 연결을 기억하지 않습니다. 탭이나 앱을 닫으면 PC에서 다시 승인받아야 합니다."
            : "이 브라우저는 저장소를 쓸 수 없어 기억할 수 없습니다. 탭이나 앱을 닫으면 PC에서 다시 승인받아야 합니다.")
            : remember ? "탭이나 앱을 닫아도 다시 승인받지 않고 연결합니다. 연결 권한이 이 브라우저에 저장되므로 함께 쓰는 기기에서는 켜지 마세요. 기기를 잃어버리면 PC의 ‘연결 끊기’로 바로 끊을 수 있습니다."
            : "끄면 연결 권한이 이 탭에만 보관됩니다. 탭이나 앱을 닫으면 PC에서 다시 승인받아야 합니다."}</p>
        </> : <p className="muted">연결 권한을 이 기기의 보안 저장소에 보관합니다.</p>}
        <div className="host-connection-actions">
          <button type="button" className="button" disabled={!!busy || connecting} aria-expanded={scanOpen} onClick={() => setScanOpen(value => !value)}>QR 스캔</button>
          {controller.scan ? <button type="button" className="text-button" disabled={!!busy || connecting} onClick={() => void perform("scan", async () => { const value = await controller.scan!(); if (value) parseRemoteOffer(value); return value; }, value => { if (value) { setLink(value); setScanOpen(false); } })}>기기의 QR 스캐너 사용</button> : null}
          {connecting ? <button type="button" className="text-button" onClick={disconnect}>연결 요청 취소</button> : null}
          <button type="submit" className="button primary" disabled={!!busy || connecting || !link.trim() || !deviceName.trim()}>연결 요청</button>
        </div>
        {scanOpen ? <QrScanner onOffer={value => { setLink(value); setScanOpen(false); setError(""); setNotice("QR에서 연결할 PC를 읽었습니다. 기기 이름을 확인한 뒤 연결 요청을 누르세요."); }} onClose={() => setScanOpen(false)} /> : null}
        <p className="muted">카메라를 쓰기 어려우면 QR 그림을 고르거나 연결 링크를 붙여넣으세요.</p>
      </form>
      {snapshot.verificationCode ? <div className="host-connection-verification" role="status"><span>연결 확인번호</span><strong>{snapshot.verificationCode}</strong><p>그 PC 화면에도 같은 번호가 보이는지 확인한 뒤 승인하세요.</p></div> : null}
    </section>
  </>;
  const step = (n: number, title: string, body: ReactNode, done = false) => <li className={`device-step${done ? " done" : ""}`}>
    <span className="device-step-no" aria-hidden>{n}</span>
    <div className="device-step-body"><h4>{title}</h4>{body}</div>
  </li>;
  const localSection = <>
    <section className="host-connections-section" aria-labelledby="local-devices-title">
      <div className="host-connection-section-head"><h3 id="local-devices-title">{localAvailable ? "휴대폰 화면으로 직접 열기" : "이 PC에 연결 허용"}</h3><button type="button" className="text-button" disabled={!local || !!busy} onClick={() => void refresh()}>새로 고침</button></div>
      {!localAvailable ? <p className="muted">연결을 받을 PC의 앱에서 새 기기를 승인하고 연결 설정을 바꿀 수 있습니다.</p> : !local ? <p className="muted">‘이 PC 사용’으로 돌아오면 이 PC의 연결과 승인한 기기를 관리할 수 있습니다.</p> : !state || !config ? <p role="status">이 PC의 연결 상태를 읽는 중입니다.</p> : <>
        <p className="host-connection-local-status">지금 상태: {LOCAL_STATUS[state.status] ?? state.status}</p>
        {state.error ? <p role="alert" className="host-connections-error">이 PC가 연결을 받지 못하고 있습니다. {state.error} 아래 1단계의 설정을 확인한 뒤 저장하세요.</p> : null}
        <ol className="device-steps">
          {step(1, "이 PC가 연결을 받게 합니다", <form className="host-connection-form" onSubmit={event => { event.preventDefault(); saveConfig(); }}>
            <label className="host-connection-check"><input type="checkbox" checked={config.enabled} disabled={!!busy} onChange={event => setConfig({ ...config, enabled: event.target.checked })} />다른 기기의 연결 허용</label>
            <label>이 PC의 이름<input value={config.label ?? ""} maxLength={80} disabled={!!busy} onChange={event => setConfig({ ...config, label: event.target.value })} placeholder={localLabel} /></label>
            {unreachable ? <NoteBanner label="휴대폰에서 닿을 주소" action={{ label: "주소 넣기", run: showAddress }}>
              <strong>아직 휴대폰에서 닿을 주소가 없습니다.</strong> {onlyHere(state.config.listenHost) ? "지금은 이 PC 안에서만 연결을 받습니다. " : ""}휴대폰이 열 수 있는 이 PC의 주소(예: https://내PC주소{state.port ? `:${state.port}` : ""})를 ‘다른 기기에서 접속할 주소’에 넣으면 휴대폰으로 찍을 QR이 만들어집니다. 주소를 만드는 방법은 학교 전산 담당에게 물어보세요.
            </NoteBanner> : null}
            <details ref={network} className="host-connection-network"><summary>연결 주소 설정</summary>
              <label>중계 서버 주소<input value={config.relayUrl ?? ""} disabled={!!busy} onChange={event => setConfig({ ...config, relayUrl: event.target.value })} placeholder="wss://…" autoCapitalize="none" spellCheck={false} /></label>
              <label>다른 기기에서 접속할 주소<input ref={publicAddress} value={config.publicUrl ?? ""} disabled={!!busy} onChange={event => setConfig({ ...config, publicUrl: event.target.value })} placeholder="https://…" autoCapitalize="none" spellCheck={false} /></label>
              <div className="host-connection-fields"><div className="host-connection-listen"><span id="listen-host-label">받는 주소</span>
                {/* The gateway accepts four values (service.ts); a stored ::1 or :: stays as it is until the person picks the other side. */}
                <Segmented label="받는 주소" value={onlyHere(config.listenHost) ? "here" : "network"} options={[{ value: "here", label: "이 PC 안에서만" }, { value: "network", label: "같은 네트워크에서도" }]}
                  onChange={(next) => { if (busy || next === (onlyHere(config.listenHost) ? "here" : "network")) return; setConfig({ ...config, listenHost: next === "here" ? "127.0.0.1" : "0.0.0.0" }); }} /></div>
                <label>포트 (0이면 처음 정한 포트)<input type="number" min={0} max={65535} value={config.port ?? ""} disabled={!!busy} onChange={event => setConfig({ ...config, port: event.target.value ? Number(event.target.value) : undefined })} /></label></div>
              <p className="muted">휴대폰에서 QR로 화면을 열려면 휴대폰이 닿을 수 있는 주소가 필요합니다. 받는 주소가 ‘이 PC 안에서만’이면 휴대폰은 연결할 수 없습니다. 포트는 앱을 다시 시작해도 그대로이며, 바꾸면 이미 연결한 기기의 주소도 바뀝니다.</p>
              <PathDetail value={`PC ${state.hostId}\n공개키 지문 ${state.hostFingerprint}${state.port ? `\n포트 ${state.port}` : ""}`} label="이 PC의 식별 정보" />
            </details>
            <div className="host-connection-actions"><button type="submit" className="button" disabled={!!busy}>설정 저장</button></div>
          </form>, state.config.enabled)}
          {step(2, phoneUrl ? "휴대폰 카메라로 QR을 찍습니다" : "새 기기에서 열 링크를 만듭니다", <>
            <p className="muted">{phoneUrl ? "QR을 만들고, 휴대폰 카메라로 찍으면 휴대폰 브라우저에 이 화면이 열립니다. 휴대폰에 앱을 설치할 필요는 없습니다." : "휴대폰이 닿을 주소가 없으면 링크를 만들어 다른 기기의 앱에 붙여넣습니다."}</p>
            <div className="host-connection-actions"><button aria-busy={busy === "offer" ? true : undefined} type="button" className={unreachable ? "button" : "button primary"} disabled={!!busy || !state.config.enabled} onClick={makeOffer}>{busy === "offer" ? "만드는 중…" : unreachable ? "붙여넣기용 링크 만들기" : phoneUrl ? "휴대폰으로 찍을 QR 만들기" : "새 기기 연결 링크 만들기"}</button></div>
            {offer ? <div className="host-connection-offer">
              {offer.expiresAt > now && /^https?:\/\//i.test(offer.url) && offer.qrDataUrl && /^data:image\/(png|svg\+xml);/i.test(offer.qrDataUrl) ? <img className="host-connection-qr" src={offer.qrDataUrl} alt="새 기기에서 열 연결 QR 코드" /> : null}
              <p><strong>{offer.expiresAt <= now ? "연결 링크의 시간이 지났습니다." : "한 번만 쓰는 연결 링크입니다."}</strong> {offer.expiresAt <= now ? "다시 만들어 주세요." : `${time(offer.expiresAt)}까지 쓸 수 있습니다.`}</p>
              {/^https?:\/\//i.test(offer.url) ? null : <p className="muted">휴대폰은 이 링크를 열 수 없습니다. 다른 PC의 앱에서 ‘다른 PC에 연결’에 붙여넣을 때만 쓰세요.</p>}
              <details className="settings-path host-connection-link" open={!offer.qrDataUrl || !/^https?:\/\//i.test(offer.url)}><summary>링크로 보내기</summary>
                <label>연결 링크<input ref={offerInput} readOnly value={offer.url} aria-label="이 PC의 연결 링크" /></label>
                <button type="button" className="button small" disabled={offer.expiresAt <= now} onClick={() => void copyOffer()}><Icon name="copy" size={14} />링크 복사</button>
              </details>
            </div> : null}
          </>, Boolean(offer))}
          {step(3, "휴대폰에 나온 숫자와 같은지 보고 승인합니다", <>
            {state.pending.length ? state.pending.map(request => <PendingDevice key={`${request.requestId}:${request.verificationCode}`} request={request} projects={projects} devices={state.devices} busy={!!busy} now={now}
              onApprove={input => void perform(`approve:${request.requestId}`, () => api.approve(request.requestId, input), () => { setOffer(null); changed("승인했습니다. 휴대폰에서 연결이 마무리됩니다."); })}
              onReject={() => void perform(`reject:${request.requestId}`, () => api.reject(request.requestId), () => changed("연결 요청을 거절했습니다."))} />)
              : <p className="muted">휴대폰에서 연결을 요청하면 그 기기의 이름과 여섯 자리 확인번호가 여기에 나옵니다.</p>}
          </>)}
        </ol>
      </>}
    </section>
    {localAvailable && local && state ? <section className="host-connections-section" aria-labelledby="devices-title">
      <div className="host-connection-section-head"><h3 id="devices-title">연결한 기기</h3><span className="muted">{state.devices.length}</span></div>
      {state.devices.length ? <ul className="host-connections-list">{state.devices.map(device => <DeviceRow key={device.deviceId} device={device} projects={projects} now={now} busy={!!busy}
        onRemove={() => void perform(`remove:${device.deviceId}`, () => api.remove(device.deviceId), () => changed("그 기기를 목록에서 지웠습니다."))}
        onRevoke={() => void perform(`revoke:${device.deviceId}`, () => api.revoke(device.deviceId), () => changed("그 기기의 연결을 끊었습니다."))}
        onRotate={() => void perform(`rotate:${device.deviceId}`, () => api.rotate(device.deviceId), next => { setOffer(next); changed("그 기기의 연결을 끊었습니다. 새 링크로 다시 등록하세요."); })} />)}</ul> : <p className="muted">아직 연결한 기기가 없습니다. 위의 세 단계로 휴대폰을 연결하세요.</p>}
      {state.devices.length ? <p className="muted">같은 기기를 다시 등록하면 승인할 때 이전 승인을 함께 정리할 수 있습니다. 기억 여부는 기기가 알려 온 것입니다. 어느 기기든 권한이 끝나기 전까지는 연결할 수 있으니, 쓰지 않는 기기는 ‘연결 끊기’를 누르세요.</p> : null}
    </section> : null}
  </>;
  const phoneSection = <section className="host-connections-section host-connections-phone" aria-labelledby="phone-use-title">
    <h3 id="phone-use-title">휴대폰에서 이 PC 쓰기</h3>
    <ul className="host-connection-ways">
      {onMessenger ? <li className="host-connection-way">
        <div><strong>메신저로 <span className="host-connection-easy">가장 쉬움</span></strong>
          <p>텔레그램이나 Slack 대화로 이 PC의 AI에게 일을 시키고 결과를 받습니다. {MESSENGER_NEEDS}</p></div>
        <button type="button" className="button primary" onClick={onMessenger}>휴대폰 메신저 열기</button>
      </li> : null}
      {api.tailscale && local ? <li className="host-connection-way">
        <div><strong>테일스케일로 <span className="host-connection-easy">작업실 화면 그대로</span></strong>
          <p>이 PC와 휴대폰에 테일스케일을 설치해 같은 계정으로 로그인하면, 휴대폰 브라우저에 이 작업실 화면이 그대로 열립니다. 내 기기들끼리만 통합니다.</p></div>
        <button type="button" className="button" onClick={() => document.getElementById("tailscale-title")?.scrollIntoView({ block: "start", behavior: "smooth" })}>테일스케일 안내 보기</button>
      </li> : null}
      <li className="host-connection-way">
        <div><strong>휴대폰 화면으로 직접 열기</strong>
          <p>이 PC가 만든 QR을 휴대폰 카메라로 찍으면 휴대폰 브라우저에 이 화면이 열립니다. {PHONE_PAGE_SETUP}</p></div>
        <button type="button" className="button" onClick={() => document.getElementById("local-devices-title")?.scrollIntoView({ block: "start", behavior: "smooth" })}>아래 단계 보기</button>
      </li>
    </ul>
  </section>;

  return <div className="host-connections-panel">
    <p className="host-connections-phase" role="status">{!localAvailable && snapshot.phase === "local" ? "연결할 PC를 고르세요." : `${PHASE_LABELS[snapshot.phase]}${snapshot.message ? `: ${snapshot.message}` : ""}`}</p>
    {error ? <p className="host-connections-error" role="alert">{error}</p> : null}
    {notice ? <p className="host-connections-notice" role="status">{notice}</p> : null}
    {localAvailable ? <>
      {phoneSection}
      {local && api.tailscale ? <TailscalePanel api={api} openExternal={openExternal} onChanged={settingsChanged} /> : null}
      {localSection}
      <details className="host-connections-other" open={otherOpen || joining} onToggle={event => setOtherOpen(event.currentTarget.open)}>
        <summary><strong>이 기기에서 다른 PC 쓰기</strong><span>이 앱을 다른 PC의 화면으로 쓸 때만 엽니다. 휴대폰에서 이 PC를 쓰려면 위쪽을 보세요.</span></summary>
        {hostsSection}
        {joinSection}
      </details>
    </> : <>
      {hostsSection}
      {joinSection}
      {localSection}
    </>}
  </div>;
}

/** The gateway's default: connections from this PC only (127.0.0.1 or ::1). */
const onlyHere = (listenHost: string | undefined) => !listenHost || listenHost === "127.0.0.1" || listenHost === "::1";

function PendingDevice({ request, projects, devices, busy, now, onApprove, onReject }: {
  request: PairingRequest; projects: { workId: string; label: string }[]; devices: DeviceGrant[]; busy: boolean; now: number;
  onApprove(input: DeviceApprovalInput): void; onReject(): void;
}) {
  const [confirmed, setConfirmed] = useState(false), [permissions, setPermissions] = useState<DevicePermission[]>(["read"]), [workIds, setWorkIds] = useState<string[]>([]);
  const selected = workIds.filter(id => projects.some(project => project.workId === id));
  const expired = request.expiresAt <= now;
  // The same device registering again. The protocol has no proof of identity: the device may name
  // its earlier approval (a hint), and entries with the same name are offered, never assumed.
  const named = request.previousDeviceId ? devices.find(device => device.deviceId === request.previousDeviceId) : undefined;
  const earlier = [...(named ? [named] : []), ...devices.filter(device => device !== named && device.name.trim() === request.name.trim())];
  // The named entry is ticked only when removing it costs nothing (its approval is already over) or
  // its name agrees with the claim. An active device under another name is offered, never assumed:
  // anyone holding a link could name it.
  const over = (device: DeviceGrant) => device.revokedAt !== null || (device.expiresAt !== null && device.expiresAt <= now);
  const agrees = !!named && (over(named) || named.name.trim() === request.name.trim());
  const [replaces, setReplaces] = useState<string[] | null>(null);
  const removing = (replaces ?? (named && agrees ? [named.deviceId] : [])).filter(id => earlier.some(device => device.deviceId === id));
  return <form className="host-connection-pending" aria-label={`${request.name} 연결 승인`} onSubmit={event => {
    event.preventDefault(); if (!busy && !expired && confirmed && selected.length && permissions.length) onApprove({ permissions, workIds: selected, ...(removing.length ? { replaces: removing } : {}) });
  }}>
    <div className="host-connection-section-head"><strong>{request.name}</strong><span>{request.platform ?? "기기 종류 모름"}</span></div>
    {request.remember ? <NoteBanner label="연결을 기억하겠다고 알린 기기">이 기기는 연결을 기억하겠다고 알려 왔습니다. 승인하면 30일이 지나거나 연결을 끊기 전까지 다시 승인 없이 연결할 수 있습니다.</NoteBanner> : null}
    <div className="host-connection-verification"><span>휴대폰에 나온 숫자와 같은지 보세요</span><strong>{request.verificationCode}</strong><small>{expired ? "시간이 지난 요청입니다. 휴대폰에서 다시 요청하세요." : `${time(request.expiresAt)}까지 승인할 수 있습니다`}</small></div>
    <fieldset disabled={busy || expired}>
      <label className="host-connection-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />새 기기에도 같은 확인번호가 표시되는 것을 확인했습니다</label>
      <fieldset><legend>접근할 프로젝트</legend>{projects.length ? projects.map(project => <label key={project.workId} className="host-connection-check"><input type="checkbox" checked={workIds.includes(project.workId)} onChange={event => setWorkIds(current => event.target.checked ? [...current, project.workId] : current.filter(id => id !== project.workId))} />{project.label}</label>) : <p className="muted">먼저 이 PC에 프로젝트를 만들어 주세요.</p>}</fieldset>
      <fieldset><legend>허용할 동작</legend>{(Object.keys(DEVICE_PERMISSION_LABELS) as DevicePermission[]).map(permission => <label key={permission} className="host-connection-check"><input type="checkbox" checked={permissions.includes(permission)} onChange={event => setPermissions(current => event.target.checked ? [...current, permission] : current.filter(item => item !== permission))} />{PERMISSION_WORDS[permission]}</label>)}</fieldset>
      {earlier.length ? <fieldset><legend>같은 기기의 이전 승인 정리</legend>
        {earlier.map(device => <label key={device.deviceId} className="host-connection-check"><input type="checkbox" checked={removing.includes(device.deviceId)} onChange={event => setReplaces(event.target.checked ? [...removing, device.deviceId] : removing.filter(id => id !== device.deviceId))} />{device.name} ({time(device.approvedAt)} 승인{device.revokedAt !== null ? ", 연결 끊김" : device.expiresAt !== null && device.expiresAt <= now ? ", 권한 끝남" : ""})</label>)}
        <p className="muted">{named && agrees ? "이 기기가 전에 받은 승인이라고 알려 온 항목을 골라 두었습니다. 기기가 알려 온 것일 뿐 확인된 사실은 아닙니다. "
          : named ? "이 기기가 자기 이전 승인이라고 알려 왔지만 이름이 다릅니다. 지금 쓰는 다른 기기일 수 있으니 같은 기기가 맞을 때만 고르세요. "
          : "이름이 같은 기기입니다. 같은 기기인지는 알 수 없습니다. "}고른 항목은 승인과 함께 목록에서 지워지고 그 기기의 연결은 끊깁니다. 이전 권한은 넘겨받지 않습니다.</p>
      </fieldset> : null}
    </fieldset>
    <p className="muted">승인한 권한은 30일 뒤 끝납니다.</p>
    <div className="host-connection-actions"><button type="button" className="button small" disabled={busy} onClick={onReject}>거절</button><button type="submit" className="button primary small" disabled={busy || expired || !confirmed || !selected.length || !permissions.length}>선택한 범위로 승인</button></div>
  </form>;
}

function DeviceRow({ device, projects, now, busy, onRevoke, onRotate, onRemove }: {
  device: DeviceGrant; projects: { workId: string; label: string }[]; now: number; busy: boolean; onRevoke(): void; onRotate(): void; onRemove(): void;
}) {
  const revoked = device.revokedAt !== null, expired = device.expiresAt !== null && device.expiresAt <= now;
  const state = revoked ? "연결 끊김" : expired ? "권한 끝남" : device.activatedAt === null ? "승인함, 그 기기에서 연결을 기다리는 중" : "연결됨";
  const seen = device.activatedAt ?? device.approvedAt;
  return <li className="host-connection-row device-row">
    <div className="host-connection-main"><strong>{device.name}</strong>
      <span>{state}{device.platform ? `, ${device.platform}` : ""}{revoked ? "" : `, ${device.activatedAt ? "처음 연결" : "승인"} ${time(seen)}`}</span>
      <small>할 수 있는 일: {device.permissions.map(permission => PERMISSION_WORDS[permission]).join(", ")}</small>
      <small>프로젝트: {device.workIds.map(id => projects.find(project => project.workId === id)?.label ?? id).join(", ") || "없음"}</small>
      {device.expiresAt !== null && !revoked ? <small>권한 끝나는 날 {time(device.expiresAt)}</small> : null}
      {device.rememberedAt && !revoked && !expired ? <small>연결을 기억하겠다고 알린 기기 ({time(device.rememberedAt)} 승인)</small> : null}
    </div>
    <div className="host-connection-actions">
      {!revoked ? <><button type="button" className="button small" disabled={busy} onClick={onRevoke}>연결 끊기</button><button type="button" className="text-button" disabled={busy} onClick={onRotate}>끊고 새 링크 만들기</button></> : null}
      {revoked || expired ? <button type="button" className="text-button" disabled={busy} onClick={onRemove}>목록에서 지우기</button> : null}
    </div>
  </li>;
}
