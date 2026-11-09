import { RemotePeer, parseRemoteOffer } from "@workbench/client";
import {
  createHostConnectionStorage, createSessionHostCredentialStore, createMemoryHostCredentialStore,
  type HostConnectionsController, type HostConnectionsSnapshot, type SavedHostConnection,
} from "./host-connections.ts";

function credentials() { try { return createSessionHostCredentialStore(window.sessionStorage); } catch { return createMemoryHostCredentialStore(); } }
export class WorkbenchHostConnections implements HostConnectionsController {
  private readonly storage = createHostConnectionStorage({ credentials: credentials() });
  private value: HostConnectionsSnapshot = { hosts: this.storage.list(), activeHostId: null, phase: "local", credentialStorage: this.storage.credentialStorage };
  private readonly listeners = new Set<() => void>();
  private active: RemotePeer | null = null;
  private pairing: RemotePeer | null = null;
  private operation = 0;
  private gate: (() => Promise<void>) | null = null;
  getSnapshot = () => this.value;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  peer = () => this.active;
  setSwitchGuard(guard: (() => Promise<void>) | null) { this.gate = guard; }
  private publish(update: Partial<HostConnectionsSnapshot>) { this.value = { ...this.value, ...update, hosts: this.storage.list() }; for (const listener of this.listeners) listener(); }
  private attach(peer: RemotePeer, host: SavedHostConnection) {
    this.active?.close(); this.active = peer; this.pairing = null;
    peer.onStatus(status => {
      if (this.active !== peer) return;
      if (status.status === "connected" && status.authenticated) this.publish({ phase: "connected", message: undefined });
      else if (status.status === "connecting") this.publish({ phase: "connecting", message: "기기에 다시 연결하고 있습니다." });
      else if (status.status === "disconnected" || status.status === "closed") this.publish({ phase: "offline", message: status.reason || "연결이 끊겼습니다. 작업은 해당 PC에서 계속됩니다." });
    });
    this.publish({ activeHostId: host.hostId, phase: "connected", verificationCode: undefined, message: undefined });
  }
  connectOffer = async (text: string, label: string) => {
    const offer = parseRemoteOffer(text);
    await this.gate?.();
    const operation = ++this.operation;
    this.pairing?.close();
    const peer = new RemotePeer({ url: offer.workbench.endpoint, daemonPublicKeyB64: offer.daemonPublicKeyB64, serverId: offer.serverId });
    this.pairing = peer; this.publish({ phase: "connecting", message: undefined, verificationCode: undefined });
    try {
      await peer.connect();
      const ticket = await peer.rpc<import("@workbench/contracts").PairingRequestTicket>("pair", { offer: offer.workbench, name: label.trim() || "새 기기", platform: navigator.userAgent.slice(0, 160) });
      if (operation !== this.operation) throw new Error("연결 요청이 취소되었습니다.");
      this.publish({ phase: "awaiting-approval", verificationCode: ticket.verificationCode, message: "연결할 PC에서 같은 확인번호와 프로젝트 권한을 승인해 주세요." });
      while (Date.now() < ticket.expiresAt && operation === this.operation) {
        const result = await peer.rpc<import("@workbench/contracts").PairingCredentialResult>("claim", { requestId: ticket.requestId, claimToken: ticket.claimToken });
        if (result.status === "approved") {
          await peer.connect(result.credential);
          const host: SavedHostConnection = { hostId: offer.serverId, label: offer.workbench.label, endpoint: offer.workbench.endpoint, daemonPublicKeyB64: offer.daemonPublicKeyB64,
            deviceId: result.grant.deviceId, createdAt: Date.now(), lastConnectedAt: Date.now() };
          await this.storage.upsert(host, result.credential);
          if (operation !== this.operation) throw new Error("연결 요청이 취소되었습니다.");
          this.attach(peer, host); return host;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      throw new Error("연결 요청이 만료되었습니다. PC에서 새 연결 링크를 만들어 주세요.");
    } catch (error) {
      peer.close(); if (this.pairing === peer) this.pairing = null;
      if (operation === this.operation) this.publish({ phase: "error", message: error instanceof Error ? error.message : "연결하지 못했습니다.", verificationCode: undefined });
      throw error;
    }
  };
  selectHost = async (hostId: string) => {
    const host = this.storage.list().find(value => value.hostId === hostId);
    if (!host) throw new Error("저장된 기기를 찾지 못했습니다.");
    const credential = await this.storage.credential(hostId);
    if (!credential) throw new Error("이 탭에 남은 연결 권한이 없습니다. PC에서 새 연결 링크를 만들어 주세요.");
    await this.gate?.(); const operation = ++this.operation;
    this.pairing?.close(); this.pairing = null;
    const peer = new RemotePeer({ url: host.endpoint, daemonPublicKeyB64: host.daemonPublicKeyB64, serverId: host.hostId });
    this.publish({ phase: "connecting", verificationCode: undefined, message: undefined });
    try {
      await peer.connect(credential);
      if (operation !== this.operation) { peer.close(); return; }
      this.storage.touch(hostId); this.attach(peer, host);
    } catch (error) { peer.close(); this.publish({ phase: "error", message: error instanceof Error ? error.message : "기기에 연결하지 못했습니다." }); throw error; }
  };
  disconnect = async () => {
    await this.gate?.(); ++this.operation; this.pairing?.close(); this.pairing = null; this.active?.close(); this.active = null;
    this.publish({ activeHostId: null, phase: "local", verificationCode: undefined, message: undefined });
  };
  remove = async (hostId: string) => {
    if (this.value.activeHostId === hostId) await this.disconnect();
    await this.storage.remove(hostId); this.publish({});
  };
}
export const hostConnections = new WorkbenchHostConnections();
