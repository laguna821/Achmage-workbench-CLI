import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { App } from "./App.tsx";
import { Api, readToken, setMediaConnection } from "./api.ts";
import { HostConnections } from "./components/HostConnections.tsx";
import { hostConnections } from "./remote-hosts.ts";
import type { LocalDeviceApi } from "./host-connections.ts";
import { installMobileLayout } from "./mobile-layout.ts";
import { watchPushOpen, watchMobilePushLease, resolvePushOpen, acknowledgePushOpen, type PushOpenIntent } from "./mobile-push.ts";

export function ConnectedWorkbench() {
  useEffect(() => installMobileLayout(), []);
  const connections = useSyncExternalStore(hostConnections.subscribe, hostConnections.getSnapshot);
  const [pushIntent, setPushIntent] = useState<PushOpenIntent | null>(null);
  const [pushTarget, setPushTarget] = useState<{ id: string; nonce: string } | null>(null);
  const [pushError, setPushError] = useState("");
  const [pushAttempt, setPushAttempt] = useState(0);
  const reportPushError = useCallback((error: unknown) => setPushError(error instanceof Error ? error.message : "모바일 알림 상태를 확인하지 못했습니다."), []);
  useEffect(() => watchPushOpen(intent => { setPushIntent(intent); setPushTarget(null); setPushError(""); }, reportPushError), [reportPushError]);
  const [token] = useState(readToken);
  const [initialOffer, setInitialOffer] = useState(() => location.hash.startsWith("#offer=") ? location.href : "");
  const [open, setOpen] = useState(() => !token || location.hash.startsWith("#offer="));
  useEffect(() => {
    if (initialOffer && location.hash.startsWith("#offer=")) history.replaceState(null, "", location.pathname + location.search);
  }, [initialOffer]);
  const local = useMemo(() => new Api(token ?? ""), [token]);
  const management = useMemo<LocalDeviceApi>(() => ({
    state: () => local.request("GET", "/api/devices"),
    configure: input => local.request("PUT", "/api/devices/config", input),
    createOffer: () => local.request("POST", "/api/devices/offers", {}),
    approve: (id, input) => local.request("POST", "/api/devices/enrollments/" + encodeURIComponent(id) + "/approve", input),
    reject: id => local.request("POST", "/api/devices/enrollments/" + encodeURIComponent(id) + "/reject", {}),
    revoke: id => local.request("POST", "/api/devices/" + encodeURIComponent(id) + "/revoke", {}),
    rotate: id => local.request("POST", "/api/devices/" + encodeURIComponent(id) + "/rotate", {}),
  }), [local]);
  const peer = hostConnections.peer();
  const apiOverride = useMemo(() => {
    const connection = connections.activeHostId && peer ? { hostId: connections.activeHostId, peer } : null;
    setMediaConnection(connection);
    return connection ? new Api("", undefined, connection) : undefined;
  }, [connections.activeHostId, peer]);
  useEffect(() => {
    if (apiOverride && connections.activeHostId && connections.phase === "connected") return watchMobilePushLease(apiOverride, connections.activeHostId, undefined, reportPushError);
  }, [apiOverride, connections.activeHostId, connections.phase, reportPushError]);
  const guard = useCallback((value: (() => Promise<void>) | null) => hostConnections.setSwitchGuard(value), []);
  const selected = connections.hosts.find(host => host.hostId === connections.activeHostId);
  useEffect(() => {
    if (!pushIntent) return;
    let active = true;
    void (async () => {
      const current = hostConnections.getSnapshot();
      if (current.activeHostId !== pushIntent.hostId || current.phase !== "connected") await hostConnections.selectHost(pushIntent.hostId);
      if (!active) return;
      const peer = hostConnections.peer();
      if (!peer || hostConnections.getSnapshot().activeHostId !== pushIntent.hostId) throw new Error("알림이 도착한 기기에 먼저 연결해 주세요.");
      const result = await resolvePushOpen(new Api("", undefined, { hostId: pushIntent.hostId, peer }), pushIntent);
      if (active) { setPushError(""); setOpen(false); setPushTarget({ id: result.attentionId, nonce: `${pushIntent.id}:${pushAttempt}` }); }
    })().catch(error => { if (active) { setPushError(error instanceof Error ? error.message : "알림의 기기에 연결하지 못했습니다."); setOpen(true); } });
    return () => { active = false; };
  }, [pushIntent, pushAttempt]);
  const openedPush = useCallback((id: string) => {
    if (!pushIntent || pushTarget?.id !== id || connections.activeHostId !== pushIntent.hostId) return;
    void acknowledgePushOpen(pushIntent).then(() => {
      setPushIntent(current => current?.id === pushIntent.id ? null : current);
      setPushTarget(current => current?.nonce === pushTarget.nonce ? null : current); setPushError("");
    }).catch(reportPushError);
  }, [pushIntent, pushTarget, connections.activeHostId, reportPushError]);
  return <>
    {pushError ? <div role="status" className="connection-error">{pushError} {pushIntent ? <button type="button" className="button small" onClick={() => { setPushError(""); setPushAttempt(value => value + 1); }}>알림 다시 열기</button> : <button type="button" className="button small" onClick={() => setPushError("")}>닫기</button>}</div> : null}
    {token || peer ? <App key={connections.activeHostId ?? "local"} apiOverride={apiOverride} onConnections={() => setOpen(true)}
      attentionRequest={pushIntent?.hostId === connections.activeHostId ? pushTarget : null} onAttentionOpened={openedPush}
      connectionLabel={selected ? selected.label + (connections.phase === "connected" ? " · 연결됨" : " · 연결 확인") : "기기 연결"} registerHostSwitchGuard={guard} />
      : <main style={{ maxWidth: 560, margin: "12vh auto", padding: 24 }}><h1>Achmage Workbench</h1><p>작업 중인 PC에 연결해 대화와 파일을 이어서 보세요.</p><button type="button" className="primary-button" onClick={() => setOpen(true)}>기기 연결</button></main>}
    <HostConnections open={open} api={management} controller={hostConnections} localAvailable={!!token} initialOffer={initialOffer}
      onClose={() => { setOpen(false); setInitialOffer(""); }} />
  </>;
}
