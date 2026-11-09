import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { App } from "./App.tsx";
import { Api, readToken, setMediaConnection } from "./api.ts";
import { HostConnections } from "./components/HostConnections.tsx";
import { hostConnections } from "./remote-hosts.ts";
import type { LocalDeviceApi } from "./host-connections.ts";

export function ConnectedWorkbench() {
  const connections = useSyncExternalStore(hostConnections.subscribe, hostConnections.getSnapshot);
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
  const guard = useCallback((value: (() => Promise<void>) | null) => hostConnections.setSwitchGuard(value), []);
  const selected = connections.hosts.find(host => host.hostId === connections.activeHostId);
  return <>
    {token || peer ? <App key={connections.activeHostId ?? "local"} apiOverride={apiOverride} onConnections={() => setOpen(true)}
      connectionLabel={selected ? selected.label + (connections.phase === "connected" ? " · 연결됨" : " · 연결 확인") : "기기 연결"} registerHostSwitchGuard={guard} />
      : <main style={{ maxWidth: 560, margin: "12vh auto", padding: 24 }}><h1>Achmage Workbench</h1><p>작업 중인 PC에 연결해 대화와 파일을 이어서 보세요.</p><button type="button" className="primary-button" onClick={() => setOpen(true)}>기기 연결</button></main>}
    <HostConnections open={open} api={management} controller={hostConnections} localAvailable={!!token} initialOffer={initialOffer}
      onClose={() => { setOpen(false); setInitialOffer(""); }} />
  </>;
}
