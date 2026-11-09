// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HostConnections } from "./HostConnections.tsx";
import {
  createHostConnectionStorage, createSessionHostCredentialStore, pairingHostPreview,
  type DeviceManagementState, type HostConnectionsController, type HostConnectionsSnapshot,
  type LocalDeviceApi, type SavedHostConnection,
} from "../host-connections.ts";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  localStorage.clear(); sessionStorage.clear();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const saved = (hostId: string): SavedHostConnection => ({ hostId, label: `PC ${hostId}`, endpoint: `wss://${hostId}.example`, daemonPublicKeyB64: `public-${hostId}`, deviceId: `device-${hostId}`, createdAt: 1, lastConnectedAt: null });
function fixture(remote = false) {
  const now = Date.now();
  const state: DeviceManagementState = {
    config: { enabled: true, listenHost: "127.0.0.1", port: 0 }, hostId: "local", hostFingerprint: "public-fingerprint", status: "ready", devices: [],
    workspaces: [{ workId: "work-a", label: "연구 A" }, { workId: "work-b", label: "연구 B" }],
    pending: [{ requestId: "request-1", hostId: "local", name: "내 휴대폰", platform: "web", verificationCode: "123456", createdAt: now, expiresAt: now + 60_000, status: "pending", deviceId: null }],
  };
  const approve = vi.fn(async () => undefined), readState = vi.fn(async () => state);
  const api: LocalDeviceApi = {
    state: readState, configure: vi.fn(async () => state), approve, reject: vi.fn(async () => undefined), revoke: vi.fn(async () => undefined),
    createOffer: vi.fn(), rotate: vi.fn(),
  };
  const snapshot: HostConnectionsSnapshot = { hosts: remote ? [saved("a"), saved("b")] : [], activeHostId: remote ? "a" : null, phase: remote ? "connected" : "local", credentialStorage: "session" };
  const remove = vi.fn(async () => undefined), disconnect = vi.fn(async () => undefined);
  const controller: HostConnectionsController = { getSnapshot: () => snapshot, subscribe: () => () => {}, connectOffer: vi.fn(async () => undefined), selectHost: vi.fn(async () => undefined), disconnect, remove };
  return { api, controller, approve, readState, remove, disconnect };
}

it("requires the matching code and explicit project scope before granting only the selected actions", async () => {
  const f = fixture();
  await act(async () => { render(<HostConnections open api={f.api} controller={f.controller} onClose={() => {}} />); });
  expect(screen.getByText("123456")).toBeTruthy();
  const approve = screen.getByRole("button", { name: "선택한 범위로 승인" }) as HTMLButtonElement;
  expect(approve.disabled).toBe(true);
  fireEvent.click(screen.getByLabelText("새 기기에도 같은 확인번호가 표시되는 것을 확인했습니다"));
  expect(approve.disabled).toBe(true);
  fireEvent.click(screen.getByLabelText("연구 A"));
  fireEvent.click(screen.getByLabelText("터미널 사용"));
  await act(async () => { fireEvent.click(approve); fireEvent.click(approve); });
  expect(f.approve).toHaveBeenCalledExactlyOnceWith("request-1", { permissions: ["read", "terminal"], workIds: ["work-a"] });
});

it("keeps local device management unavailable remotely and deletes only the chosen saved host", async () => {
  const f = fixture(true);
  await act(async () => { render(<HostConnections open api={f.api} controller={f.controller} onClose={() => {}} />); });
  expect(f.readState).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("다른 기기의 연결 허용")).toBeNull();
  const row = screen.getByText("PC b").closest("li")!;
  fireEvent.click(within(row).getByRole("button", { name: "목록에서 삭제" }));
  await act(async () => fireEvent.click(within(row).getByRole("button", { name: "이 기기에서 삭제" })));
  expect(f.remove).toHaveBeenCalledExactlyOnceWith("b");
  expect(f.disconnect).not.toHaveBeenCalled();
});

it("accepts the initial mobile link without connecting automatically or polling an unavailable local host", async () => {
  const f = fixture();
  await act(async () => { render(<HostConnections open localAvailable={false} initialOffer="https://app.example/#offer=pasted" api={f.api} controller={f.controller} onClose={() => {}} />); });
  expect((screen.getByLabelText("연결 링크") as HTMLTextAreaElement).value).toBe("https://app.example/#offer=pasted");
  expect(f.controller.connectOffer).not.toHaveBeenCalled(); expect(f.readState).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "이 PC 사용" })).toBeNull();
});

it("separates credentials from public metadata and removes only one remote credential", async () => {
  const store = createHostConnectionStorage({ metadata: localStorage, credentials: createSessionHostCredentialStore(sessionStorage) });
  sessionStorage.setItem("workbench.token", "local-owner");
  await store.upsert({ ...saved("a"), credential: "must-not-leak" } as SavedHostConnection, "secret-a");
  await store.upsert(saved("b"), "secret-b");
  const publicRecords = localStorage.getItem("workbench.host-connections.v1")!;
  expect(publicRecords).not.toContain("secret"); expect(publicRecords).not.toContain("must-not-leak");
  await store.remove("a");
  expect(store.list().map(host => host.hostId)).toEqual(["b"]);
  expect(await store.credential("a")).toBeNull(); expect(await store.credential("b")).toBe("secret-b");
  expect(sessionStorage.getItem("workbench.token")).toBe("local-owner");
});

it("previews the host with the original Paseo offer parser without retaining enrollment secrets", () => {
  const payload = { v: 2, serverId: "pc", daemonPublicKeyB64: "public-key", relay: { endpoint: "relay.example:443", useTls: true }, workbench: { token: "single-use-secret" } };
  const offer = `https://app.example/#offer=${btoa(JSON.stringify(payload))}`;
  expect(pairingHostPreview(offer)).toEqual({ hostId: "pc", daemonPublicKeyB64: "public-key", endpoint: "relay.example:443" });
  expect(pairingHostPreview("https://app.example/#offer=unfinished")).toBeNull();
});
