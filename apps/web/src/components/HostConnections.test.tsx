// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HostConnections } from "./HostConnections.tsx";
import {
  createHostConnectionStorage, createSessionHostCredentialStore, pairingHostPreview,
  type DeviceManagementState, type HostConnectionsController, type HostConnectionsSnapshot,
  type HostPairingOffer, type LocalDeviceApi, type SavedHostConnection,
} from "../host-connections.ts";
import type { DeviceGrant } from "../../../../packages/contracts/src/devices.ts";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  localStorage.clear(); sessionStorage.clear();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const saved = (hostId: string): SavedHostConnection => ({ hostId, label: `PC ${hostId}`, endpoint: `wss://${hostId}.example`, daemonPublicKeyB64: `public-${hostId}`, deviceId: `device-${hostId}`, createdAt: 1, lastConnectedAt: null });
function fixture(remote = false, changes: { state?: Partial<DeviceManagementState>; snapshot?: Partial<HostConnectionsSnapshot>; offer?: Partial<HostPairingOffer> } = {}) {
  const now = Date.now();
  const state: DeviceManagementState = {
    config: { enabled: true, listenHost: "127.0.0.1", port: 0 }, hostId: "local", hostFingerprint: "public-fingerprint", status: "ready", devices: [],
    workspaces: [{ workId: "work-a", label: "연구 A" }, { workId: "work-b", label: "연구 B" }],
    pending: [{ requestId: "request-1", hostId: "local", name: "내 휴대폰", platform: "web", verificationCode: "123456", createdAt: now, expiresAt: now + 60_000, status: "pending", deviceId: null }],
    ...changes.state,
  };
  const approve = vi.fn(async () => undefined), readState = vi.fn(async () => state);
  const revoke = vi.fn(async () => undefined), forget = vi.fn(async () => undefined);
  const offer: HostPairingOffer = { offerId: "offer-1", hostId: "local", token: "single-use-token", createdAt: now, expiresAt: now + 60_000, url: "workbench://connect/#offer=abc", qrDataUrl: null, ...changes.offer };
  const api: LocalDeviceApi = {
    state: readState, configure: vi.fn(async () => state), approve, reject: vi.fn(async () => undefined), revoke, remove: forget,
    createOffer: vi.fn(async () => offer), rotate: vi.fn(),
  };
  const snapshot: HostConnectionsSnapshot = { hosts: remote ? [saved("a"), saved("b")] : [], activeHostId: remote ? "a" : null, phase: remote ? "connected" : "local", credentialStorage: "session", ...changes.snapshot };
  const remove = vi.fn(async () => undefined), disconnect = vi.fn(async () => undefined);
  const controller: HostConnectionsController = { getSnapshot: () => snapshot, subscribe: () => () => {}, connectOffer: vi.fn(async () => undefined), selectHost: vi.fn(async () => undefined), disconnect, remove };
  return { api, controller, approve, readState, remove, disconnect, revoke, forget };
}
const grant = (deviceId: string, changes: Partial<DeviceGrant> = {}): DeviceGrant => ({
  deviceId, hostId: "local", name: "내 휴대폰", platform: "web", permissions: ["read"], workIds: ["work-a"], createdAt: 1, approvedAt: Date.UTC(2026, 10, 9, 3),
  activatedAt: Date.UTC(2026, 10, 9, 3), expiresAt: Date.now() + 86_400_000, revokedAt: null, credentialVersion: 1, lastRotatedAt: null, rememberedAt: null, ...changes,
});

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

// ── M01: the phone stays approved, the same phone registers again, no address a phone can reach ──

async function open(f: ReturnType<typeof fixture>, props: Partial<Parameters<typeof HostConnections>[0]> = {}) {
  await act(async () => { render(<HostConnections open api={f.api} controller={f.controller} onClose={() => {}} {...props} />); });
}
async function requestConnection() {
  fireEvent.change(screen.getByLabelText("이 기기의 이름"), { target: { value: "내 휴대폰" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "연결 요청" })));
}

it("asks to remember this device only when the person ticks it: off by default", async () => {
  const f = fixture(false, { snapshot: { canRemember: true } });
  await open(f, { localAvailable: false, initialOffer: "https://app.example/#offer=pasted" });
  const remember = screen.getByLabelText("이 기기 기억하기") as HTMLInputElement;
  expect(remember.checked).toBe(false);
  await requestConnection();
  expect(f.controller.connectOffer).toHaveBeenLastCalledWith("https://app.example/#offer=pasted", "내 휴대폰", { remember: false });
});

it("passes the person's choice to remember with the connection request and says what it means", async () => {
  const f = fixture(false, { snapshot: { canRemember: true } });
  await open(f, { localAvailable: false, initialOffer: "https://app.example/#offer=pasted" });
  fireEvent.click(screen.getByLabelText("이 기기 기억하기"));
  expect(screen.getByText(/함께 쓰는 기기에서는 켜지 마세요/)).toBeTruthy();
  await requestConnection();
  expect(f.controller.connectOffer).toHaveBeenLastCalledWith("https://app.example/#offer=pasted", "내 휴대폰", { remember: true });
});

it("does not offer remembering where it cannot be kept, or where the OS keychain already keeps it", async () => {
  const blocked = fixture(false, { snapshot: { canRemember: false } });
  await open(blocked, { localAvailable: false });
  expect((screen.getByLabelText("이 기기 기억하기") as HTMLInputElement).disabled).toBe(true);
  cleanup();
  const native = fixture(false, { snapshot: { credentialStorage: "native" } });
  await open(native, { localAvailable: false });
  expect(screen.queryByLabelText("이 기기 기억하기")).toBeNull();
  expect(screen.getByText(/보안 저장소에 보관/)).toBeTruthy();
});

it("marks the PCs this browser remembers in its own list", async () => {
  const f = fixture(true, { snapshot: { hosts: [{ ...saved("a"), remembered: true }, saved("b")], canRemember: true } });
  await open(f);
  expect(within(screen.getByText("PC a").closest("li")!).getByText(/이 브라우저에 기억됨/)).toBeTruthy();
  expect(within(screen.getByText("PC b").closest("li")!).queryByText(/이 브라우저에 기억됨/)).toBeNull();
});

it("tells the owner before approving that the device will stay connected, and shows remembered devices with their date and a way to end them", async () => {
  const since = Date.UTC(2026, 10, 9, 3);
  const f = fixture(false, { state: {
    pending: [{ requestId: "request-1", hostId: "local", name: "새 태블릿", platform: "web", verificationCode: "123456", createdAt: Date.now(), expiresAt: Date.now() + 60_000, status: "pending", deviceId: null, remember: true, previousDeviceId: null }],
    devices: [grant("device-kept", { rememberedAt: since }), grant("device-tab", { name: "회의실 PC" }),
      grant("device-expired", { name: "만료된 휴대폰", rememberedAt: since, expiresAt: Date.now() - 1 }), grant("device-revoked", { name: "철회한 휴대폰", rememberedAt: since, revokedAt: 5 })],
  } });
  await open(f);
  // Said as what the device declared, with the bounds the PC really enforces.
  const banner = within(screen.getByRole("form", { name: "새 태블릿 연결 승인" })).getByText(/이 기기는 연결을 기억하겠다고 알려 왔습니다/);
  expect(banner.textContent).toContain("만료(30일)나 철회 전까지");
  const kept = screen.getByText("내 휴대폰").closest("li")!, plain = screen.getByText("회의실 PC").closest("li")!;
  const line = within(kept).getByText(/연결을 기억하겠다고 알린 기기/).textContent!;
  expect(line).toContain(new Date(since).toLocaleString("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }));
  expect(line).toContain("승인");
  // Not shown for a device that said nothing, nor once the approval is over.
  for (const row of [plain, screen.getByText("만료된 휴대폰").closest("li")!, screen.getByText("철회한 휴대폰").closest("li")!]) expect(within(row).queryByText(/기억하겠다고 알린/)).toBeNull();
  expect(document.body.textContent).not.toMatch(/기억된 기기|이 기기는 연결을 기억합니다/);
  // Once, under the list: a device that said nothing may keep its connection too.
  expect(screen.getAllByText(/기억 여부는 기기가 알려 온 것입니다/)).toHaveLength(1);
  expect(screen.getByText(/기억 여부는 기기가 알려 온 것입니다/).textContent).toContain("쓰지 않는 기기는 ‘접근 철회’하세요");
  await act(async () => fireEvent.click(within(kept).getByRole("button", { name: "접근 철회" })));
  expect(f.revoke).toHaveBeenCalledExactlyOnceWith("device-kept");
});

it("offers to remove the earlier approval the device names when it registers again, and removes only what the owner leaves ticked", async () => {
  const f = fixture(false, { state: {
    pending: [{ requestId: "request-1", hostId: "local", name: "내 휴대폰", platform: "web", verificationCode: "123456", createdAt: Date.now(), expiresAt: Date.now() + 60_000, status: "pending", deviceId: null, remember: false, previousDeviceId: "device-old" }],
    devices: [grant("device-old"), grant("device-same-name", { approvedAt: Date.UTC(2026, 9, 1, 3) }), grant("device-other", { name: "회의실 PC" })],
  } });
  await open(f);
  const form = within(screen.getByRole("form", { name: "내 휴대폰 연결 승인" }));
  const earlier = within(form.getByRole("group", { name: "같은 기기의 이전 승인 정리" })).getAllByRole("checkbox") as HTMLInputElement[];
  // The one the device named is ticked; one that only shares its name is offered, not assumed; others are not listed.
  expect(earlier.map(box => box.checked)).toEqual([true, false]);
  expect(form.getByText(/확인된 사실은 아닙니다/)).toBeTruthy();
  fireEvent.click(form.getByLabelText("새 기기에도 같은 확인번호가 표시되는 것을 확인했습니다"));
  fireEvent.click(form.getByLabelText("연구 A"));
  await act(async () => fireEvent.click(form.getByRole("button", { name: "선택한 범위로 승인" })));
  expect(f.approve).toHaveBeenCalledExactlyOnceWith("request-1", { permissions: ["read"], workIds: ["work-a"], replaces: ["device-old"] });
});

it("keeps the earlier approval when the owner unticks it", async () => {
  const f = fixture(false, { state: {
    pending: [{ requestId: "request-1", hostId: "local", name: "내 휴대폰", platform: "web", verificationCode: "123456", createdAt: Date.now(), expiresAt: Date.now() + 60_000, status: "pending", deviceId: null, remember: false, previousDeviceId: "device-old" }],
    devices: [grant("device-old")],
  } });
  await open(f);
  const form = within(screen.getByRole("form", { name: "내 휴대폰 연결 승인" }));
  fireEvent.click(within(form.getByRole("group", { name: "같은 기기의 이전 승인 정리" })).getByRole("checkbox"));
  fireEvent.click(form.getByLabelText("새 기기에도 같은 확인번호가 표시되는 것을 확인했습니다"));
  fireEvent.click(form.getByLabelText("연구 A"));
  await act(async () => fireEvent.click(form.getByRole("button", { name: "선택한 범위로 승인" })));
  expect(f.approve).toHaveBeenCalledExactlyOnceWith("request-1", { permissions: ["read"], workIds: ["work-a"] });
});

it("lets the owner take an ended device off the list, and not one that still has access", async () => {
  const f = fixture(false, { state: { pending: [], devices: [grant("device-live"), grant("device-ended", { name: "예전 휴대폰", revokedAt: 5 })] } });
  await open(f);
  expect(within(screen.getByText("내 휴대폰").closest("li")!).queryByRole("button", { name: "목록에서 지우기" })).toBeNull();
  await act(async () => fireEvent.click(within(screen.getByText("예전 휴대폰").closest("li")!).getByRole("button", { name: "목록에서 지우기" })));
  expect(f.forget).toHaveBeenCalledExactlyOnceWith("device-ended");
});

it("says plainly that no phone can reach this PC yet instead of showing a QR it could not open", async () => {
  // Even if a gateway handed out a QR for the app-only link, it is not shown.
  const f = fixture(false, { state: { status: "listening", port: 41733, phoneUrl: null, pending: [] }, offer: { qrDataUrl: "data:image/png;base64,AAAA" } });
  await open(f);
  const notice = screen.getByRole("status", { name: "휴대폰에서 닿을 주소" });
  expect(notice.textContent).toContain("아직 휴대폰에서 닿을 주소가 없습니다");
  expect(notice.textContent).toContain("41733");
  expect(notice.textContent).toContain("https");
  expect(screen.queryByRole("button", { name: "새 기기 연결 링크 만들기" })).toBeNull();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "붙여넣기용 링크 만들기" })));
  expect(screen.queryByRole("img", { name: "새 기기에서 열 연결 QR 코드" })).toBeNull();
  expect(screen.getByText(/휴대폰은 이 링크를 열 수 없습니다/)).toBeTruthy();
  expect((screen.getByLabelText("이 PC의 연결 링크") as HTMLInputElement).value).toBe("workbench://connect/#offer=abc");
});

it("shows the QR when there is an address a phone can open, and no notice", async () => {
  const f = fixture(false, { state: { status: "listening", port: 41733, phoneUrl: "https://desk.tailnet.example", pending: [] },
    offer: { url: "https://desk.tailnet.example/#offer=abc", qrDataUrl: "data:image/png;base64,AAAA" } });
  await open(f);
  expect(screen.queryByRole("status", { name: "휴대폰에서 닿을 주소" })).toBeNull();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "휴대폰으로 찍을 QR 만들기" })));
  expect(screen.getByRole("img", { name: "새 기기에서 열 연결 QR 코드" })).toBeTruthy();
});

it("does not call a switched-off PC unreachable", async () => {
  const f = fixture(false, { state: { status: "disabled", config: { enabled: false, listenHost: "127.0.0.1", port: 0 }, port: null, phoneUrl: null, pending: [] } });
  await open(f);
  expect(screen.queryByRole("status", { name: "휴대폰에서 닿을 주소" })).toBeNull();
});

it("says in one line what a page opened over plain http cannot do and what to do instead", async () => {
  const secure = Object.getOwnPropertyDescriptor(window, "isSecureContext");
  Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
  try {
    const f = fixture();
    await open(f, { localAvailable: false });
    const notice = screen.getByRole("status", { name: "http로 연 페이지" });
    expect(notice.textContent).toContain("카메라");
    expect(notice.textContent).toContain("알림");
    expect(notice.textContent).toContain("연결 링크를 붙여넣");
    // Remembering is not offered there either, and the line says where it is.
    expect((screen.getByLabelText("이 기기 기억하기") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/https 주소로 열면 켤 수 있습니다/)).toBeTruthy();
  } finally {
    if (secure) Object.defineProperty(window, "isSecureContext", secure); else delete (window as { isSecureContext?: boolean }).isSecureContext;
  }
  cleanup();
  const f = fixture();
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  try {
    await open(f, { localAvailable: false });
    expect(screen.queryByRole("status", { name: "http로 연 페이지" })).toBeNull();
  } finally {
    if (secure) Object.defineProperty(window, "isSecureContext", secure); else delete (window as { isSecureContext?: boolean }).isSecureContext;
  }
});

// ── M01 fix round 1 ──────────────────────────────────────────────────────────────────────────

const again = (previousDeviceId: string) => ({ requestId: "request-1", hostId: "local", name: "내 휴대폰", platform: "web", verificationCode: "123456", createdAt: Date.now(), expiresAt: Date.now() + 60_000, status: "pending" as const, deviceId: null, remember: false, previousDeviceId });
async function approveShown(form: ReturnType<typeof within>) {
  fireEvent.click(form.getByLabelText("새 기기에도 같은 확인번호가 표시되는 것을 확인했습니다"));
  fireEvent.click(form.getByLabelText("연구 A"));
  await act(async () => fireEvent.click(form.getByRole("button", { name: "선택한 범위로 승인" })));
}

it("does not tick an active device with another name for removal just because the new device names it", async () => {
  const f = fixture(false, { state: { pending: [again("device-victim")], devices: [grant("device-victim", { name: "교수님 태블릿" })] } });
  await open(f);
  const form = within(screen.getByRole("form", { name: "내 휴대폰 연결 승인" }));
  const offered = within(form.getByRole("group", { name: "같은 기기의 이전 승인 정리" })).getAllByRole("checkbox") as HTMLInputElement[];
  expect(offered.map(box => box.checked)).toEqual([false]);
  expect(form.getByText(/이 기기가 자기 이전 승인이라고 알려 왔지만 이름이 다릅니다/)).toBeTruthy();
  await approveShown(form);
  expect(f.approve).toHaveBeenCalledExactlyOnceWith("request-1", { permissions: ["read"], workIds: ["work-a"] });
});

it("ticks the named earlier approval when it is already over, whatever its name", async () => {
  const f = fixture(false, { state: { pending: [again("device-over")], devices: [grant("device-over", { name: "예전 이름", revokedAt: 5 })] } });
  await open(f);
  const form = within(screen.getByRole("form", { name: "내 휴대폰 연결 승인" }));
  expect((within(form.getByRole("group", { name: "같은 기기의 이전 승인 정리" })).getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
  expect(form.queryByText(/이름이 다릅니다/)).toBeNull();
  await approveShown(form);
  expect(f.approve).toHaveBeenCalledExactlyOnceWith("request-1", { permissions: ["read"], workIds: ["work-a"], replaces: ["device-over"] });
  cleanup();
  const expired = fixture(false, { state: { pending: [again("device-old")], devices: [grant("device-old", { name: "예전 이름", expiresAt: Date.now() - 1 })] } });
  await open(expired);
  expect((within(screen.getByRole("group", { name: "같은 기기의 이전 승인 정리" })).getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
});

it("says why remembering is not offered: this PC's own address, or storage the browser will not give", async () => {
  const opened = (url: string) => (globalThis as unknown as { jsdom: { reconfigure(options: { url: string }): void } }).jsdom.reconfigure({ url });
  try {
    opened("http://127.0.0.1:41000/");
    await open(fixture(false, { snapshot: { canRemember: false } }), { localAvailable: false });
    expect((screen.getByLabelText("이 기기 기억하기") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/이 PC 자신의 주소로 연 페이지에서는 연결을 기억하지 않습니다/)).toBeTruthy();
    cleanup();
    opened("https://desk.example/");
    await open(fixture(false, { snapshot: { canRemember: false } }), { localAvailable: false });
    expect(screen.getByText(/이 브라우저는 저장소를 쓸 수 없어 기억할 수 없습니다/)).toBeTruthy();
    expect(screen.queryByText(/이 PC 자신의 주소/)).toBeNull();
  } finally { opened("http://localhost:3000/"); }
});

// On the PC the dialog answers "how do I use this PC from my phone" first; joining another PC is
// the phone's (or a second PC's) side and stays folded until it is what the person is doing.
const headings = () => screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
const other = () => document.querySelector("details.host-connections-other") as HTMLDetailsElement | null;

it("on this PC, starts with using it from the phone: the messenger first, then the QR this PC makes", async () => {
  const f = fixture(false, { state: { pending: [] } });
  const onMessenger = vi.fn();
  await act(async () => { render(<HostConnections open api={f.api} controller={f.controller} onClose={() => {}} onMessenger={onMessenger} />); });
  expect(headings()[0]).toBe("휴대폰에서 이 PC 쓰기");
  expect(headings().indexOf("휴대폰·다른 기기를 이 PC에 직접 연결")).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: "휴대폰 메신저 열기" }));
  expect(onMessenger).toHaveBeenCalledTimes(1);
});

it("on this PC, joining another PC (link, camera, QR picture) is folded away below", async () => {
  const f = fixture(false, { state: { pending: [] } });
  await act(async () => { render(<HostConnections open api={f.api} controller={f.controller} onClose={() => {}} />); });
  expect(other()).not.toBeNull();
  expect(other()!.open).toBe(false);
  expect(within(other()!).getByRole("heading", { level: 3, name: "다른 PC에 연결", hidden: true })).toBeTruthy();
  expect(within(other()!).getByRole("button", { name: "QR 스캔", hidden: true })).toBeTruthy();
  // Nothing about joining sits outside the fold.
  expect(headings().slice(0, 2)).not.toContain("다른 PC에 연결");
});

it("opens that fold by itself when it is what the person is doing: a saved PC, a link they arrived with", async () => {
  const withHosts = fixture(true);
  await act(async () => { render(<HostConnections open api={withHosts.api} controller={withHosts.controller} onClose={() => {}} />); });
  expect(other()!.open).toBe(true);
  cleanup();
  const withLink = fixture(false, { state: { pending: [] } });
  await act(async () => { render(<HostConnections open api={withLink.api} controller={withLink.controller} onClose={() => {}} initialOffer="workbench://connect/#offer=abc" />); });
  expect(other()!.open).toBe(true);
});

it("in a browser with no PC of its own, joining a PC is the whole dialog: nothing folded, no phone section", async () => {
  const f = fixture(false, { state: { pending: [] } });
  await act(async () => { render(<HostConnections open api={f.api} controller={f.controller} onClose={() => {}} localAvailable={false} />); });
  expect(other()).toBeNull();
  expect(headings()).not.toContain("휴대폰에서 이 PC 쓰기");
  expect(headings()).toContain("다른 PC에 연결");
});

it("names the button after what it makes: a QR to scan with the phone when a phone can reach this PC", async () => {
  const f = fixture(false, { state: { pending: [], status: "listening", phoneUrl: "https://pc.example.ts.net" } as Partial<DeviceManagementState> });
  await act(async () => { render(<HostConnections open api={f.api} controller={f.controller} onClose={() => {}} />); });
  expect(screen.getByRole("button", { name: "휴대폰으로 찍을 QR 만들기" })).toBeTruthy();
});
