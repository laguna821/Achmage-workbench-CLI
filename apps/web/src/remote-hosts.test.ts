// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import type { RemotePeer } from "@workbench/client";
import { createBrowserHostCredentialStore, createHostConnectionStorage } from "./host-connections.ts";
import { platformHostCredentials } from "./native-host-credentials.ts";
import { WorkbenchHostConnections } from "./remote-hosts.ts";

/** The address the page was opened by. jsdom starts on http://localhost:3000. */
const openedBy = (url: string) => (globalThis as unknown as { jsdom: { reconfigure(options: { url: string }): void } }).jsdom.reconfigure({ url });
beforeEach(() => { openedBy("https://desk.example/"); localStorage.clear(); sessionStorage.clear(); });

// A stand-in device credential in the real shape. It never leaves this file.
const CREDENTIAL = "wbd.11111111-1111-4111-8111-111111111111.1." + "k".repeat(43);
const KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
const OTHER_KEY = Buffer.from(new Uint8Array(32).fill(9)).toString("base64");

/** The link a PC shows, in the shape the gateway writes it. */
function link(publicKey = KEY) {
  const data = {
    v: 2, serverId: "desk", daemonPublicKeyB64: publicKey, relay: { endpoint: "desk.example:443", useTls: true }, minimumSecurityMode: "protected",
    workbench: { version: 1, endpoint: "wss://desk.example/workbench", offerId: "offer-1", token: "single-use-token-0123456789", expiresAt: Date.now() + 60_000, label: "연구실 PC" },
  };
  return "https://desk.example/#offer=" + Buffer.from(JSON.stringify(data)).toString("base64url");
}

type Script = { deviceId?: string; rememberedAt?: number | null; connect?: (credential?: string) => Promise<unknown> };
/** The PC's side of one connection: it approves at once and hands out the credential. */
function pc(script: Script = {}) {
  const grant = { deviceId: script.deviceId ?? "device-1", ...(script.rememberedAt === undefined ? {} : { rememberedAt: script.rememberedAt }) };
  const peer = {
    connect: vi.fn(script.connect ?? (async () => ({ grant }))),
    rpc: vi.fn(async (op: string, _fields?: Record<string, unknown>) => op === "pair"
      ? { requestId: "request-1", claimToken: "claim-token", verificationCode: "123456", expiresAt: Date.now() + 60_000 }
      : { status: "approved", grant, credential: CREDENTIAL }),
    onStatus: vi.fn(() => () => {}), close: vi.fn(),
  };
  return peer;
}
/** One browser tab: new objects over the same browser storage, as after the page is opened again. */
function tab(peer: ReturnType<typeof pc>) {
  const storage = createHostConnectionStorage({ metadata: localStorage, credentials: createBrowserHostCredentialStore(sessionStorage, localStorage) });
  return new WorkbenchHostConnections({ storage, createPeer: () => peer as unknown as RemotePeer });
}
const everything = (storage: Storage) => Object.keys(storage).map(key => storage.getItem(key)).join("\n");
const paired = (peer: ReturnType<typeof pc>) => peer.rpc.mock.calls.find(call => call[0] === "pair")![1]!;

it("keeps the approval after the tab or app is closed when the person asked this device to remember it", async () => {
  const first = pc({ rememberedAt: 1_000 }), firstTab = tab(first);
  expect(firstTab.getSnapshot()).toMatchObject({ credentialStorage: "session", canRemember: true });
  await firstTab.connectOffer(link(), "내 휴대폰", { remember: true });
  expect(paired(first)).toMatchObject({ name: "내 휴대폰", remember: true });
  expect(firstTab.getSnapshot()).toMatchObject({ phase: "connected", hosts: [{ hostId: "desk", deviceId: "device-1", remembered: true }] });
  // The list of PCs is public metadata; the credential is never written into it.
  expect(localStorage.getItem("workbench.host-connections.v1")).not.toContain(CREDENTIAL);

  sessionStorage.clear(); // the tab was closed
  const nextDay = pc({ rememberedAt: 1_000 }), nextTab = tab(nextDay);
  expect(nextTab.getSnapshot().hosts).toMatchObject([{ hostId: "desk", remembered: true }]);
  await nextTab.selectHost("desk");
  expect(nextDay.connect).toHaveBeenCalledExactlyOnceWith(CREDENTIAL);
  expect(nextDay.rpc).not.toHaveBeenCalled(); // no new pairing, no approval at the PC
  expect(nextTab.getSnapshot()).toMatchObject({ phase: "connected", activeHostId: "desk" });
});

it("behaves as before when the person did not ask: the credential stays in the tab and is gone when it closes", async () => {
  const first = pc({ rememberedAt: null }), firstTab = tab(first);
  await firstTab.connectOffer(link(), "내 휴대폰");
  expect(paired(first).remember).toBe(false);
  expect(firstTab.getSnapshot().hosts).toMatchObject([{ hostId: "desk", remembered: false }]);
  expect(everything(sessionStorage)).toContain(CREDENTIAL);
  expect(everything(localStorage)).not.toContain(CREDENTIAL);

  sessionStorage.clear();
  const nextDay = pc(), nextTab = tab(nextDay);
  await expect(nextTab.selectHost("desk")).rejects.toThrow("저장된 연결 권한이 없습니다");
  expect(nextDay.connect).not.toHaveBeenCalled();
});

it("does not keep the credential when the PC did not record this device as remembered", async () => {
  // A PC that does not know about remembered devices answers without rememberedAt.
  const first = pc(), firstTab = tab(first);
  await firstTab.connectOffer(link(), "내 휴대폰", { remember: true });
  expect(firstTab.getSnapshot().hosts).toMatchObject([{ hostId: "desk", remembered: false }]);
  expect(everything(localStorage)).not.toContain(CREDENTIAL);
  expect(everything(sessionStorage)).toContain(CREDENTIAL);
});

it("names its earlier approval when it registers again with the same PC, and never to a PC with another key", async () => {
  await tab(pc({ rememberedAt: 1_000 })).connectOffer(link(), "내 휴대폰", { remember: true });
  const again = pc({ deviceId: "device-2", rememberedAt: 2_000 });
  await tab(again).connectOffer(link(), "내 휴대폰", { remember: true });
  expect(paired(again).previousDeviceId).toBe("device-1");
  // The same name with a different public key is another machine: it is told nothing.
  const stranger = pc({ deviceId: "device-3", rememberedAt: 3_000 });
  await tab(stranger).connectOffer(link(OTHER_KEY), "내 휴대폰", { remember: true });
  expect(paired(stranger)).not.toHaveProperty("previousDeviceId");
});

it("forgets the kept credential when the PC answers that the approval was ended, and keeps it through other failures", async () => {
  await tab(pc({ rememberedAt: 1_000 })).connectOffer(link(), "내 휴대폰", { remember: true });
  sessionStorage.clear();
  const offline = tab(pc({ connect: async () => { throw new Error("연결할 수 없습니다."); } }));
  await expect(offline.selectHost("desk")).rejects.toThrow("연결할 수 없습니다.");
  expect(everything(localStorage)).toContain(CREDENTIAL);

  const revoked = tab(pc({ connect: async () => { throw Object.assign(new Error("이 기기 연결이 만료되거나 해제되었습니다."), { status: 401 }); } }));
  await expect(revoked.selectHost("desk")).rejects.toThrow();
  expect(everything(localStorage)).not.toContain(CREDENTIAL);
  expect(revoked.getSnapshot()).toMatchObject({ phase: "error", hosts: [{ hostId: "desk", remembered: false }] });
  expect(revoked.getSnapshot().message).toContain("새 연결 링크");
});

it("removes the kept credential with the PC when the person deletes it from this device", async () => {
  const connections = tab(pc({ rememberedAt: 1_000 }));
  await connections.connectOffer(link(), "내 휴대폰", { remember: true });
  expect(everything(localStorage)).toContain(CREDENTIAL);
  await connections.remove("desk");
  expect(everything(localStorage)).not.toContain(CREDENTIAL);
  expect(everything(sessionStorage)).not.toContain(CREDENTIAL);
  expect(connections.getSnapshot()).toMatchObject({ hosts: [], phase: "local" });
});

it("offers no remembering where the browser has no lasting storage", async () => {
  const peer = pc({ rememberedAt: 1_000 });
  const storage = createHostConnectionStorage({ metadata: localStorage, credentials: createBrowserHostCredentialStore(sessionStorage, null) });
  const connections = new WorkbenchHostConnections({ storage, createPeer: () => peer as unknown as RemotePeer });
  expect(connections.getSnapshot().canRemember).toBe(false);
  await connections.connectOffer(link(), "내 휴대폰", { remember: true });
  expect(paired(peer).remember).toBe(false);
  expect(everything(localStorage)).not.toContain(CREDENTIAL);
});

it("keeps nothing after the tab closes on a page opened over plain http, even when asked", async () => {
  // Over http the page's own code can be replaced on the way: a lasting credential is not left there.
  const secure = Object.getOwnPropertyDescriptor(window, "isSecureContext");
  const restore = () => { if (secure) Object.defineProperty(window, "isSecureContext", secure); else delete (window as { isSecureContext?: boolean }).isSecureContext; };
  Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
  try {
    const store = platformHostCredentials();
    expect(store.canRemember).toBe(false);
    await store.set("desk", CREDENTIAL, { remember: true });
    expect(everything(localStorage)).not.toContain(CREDENTIAL);
    expect(await store.get("desk")).toBe(CREDENTIAL);
  } finally { restore(); }
  sessionStorage.clear();
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  try {
    const store = platformHostCredentials();
    expect(store.canRemember).toBe(true);
    await store.set("desk", CREDENTIAL, { remember: true });
    expect(everything(localStorage)).toContain(CREDENTIAL);
  } finally { restore(); }
});

it("does not keep a connection on a page opened by this PC's own address, where the desktop app has its keychain", async () => {
  // A loopback page is a secure context, but its address belongs to whatever program holds that port.
  for (const own of ["http://127.0.0.1:41000/", "http://localhost:41000/", "http://[::1]:41000/"]) {
    openedBy(own);
    const store = platformHostCredentials();
    expect(store.canRemember, own).toBe(false);
    await store.set("desk", CREDENTIAL, { remember: true });
    expect(everything(localStorage), own).not.toContain(CREDENTIAL);
    expect(await store.get("desk")).toBe(CREDENTIAL);
    sessionStorage.clear();
  }
  openedBy("https://desk.tailnet.example/");
  expect(platformHostCredentials().canRemember).toBe(true);
});

// ── M01: opening the page again connects by itself (no tap on 사용하기) ────────────────────────────

it("M01: a remembered phone opening the page again connects by itself, to the PC the page came from", async () => {
  await tab(pc({ rememberedAt: 1_000 })).connectOffer(link(), "내 휴대폰", { remember: true });
  sessionStorage.clear(); // the next day
  const nextDay = pc({ rememberedAt: 1_000 }), nextTab = tab(nextDay);
  expect(await nextTab.resume("desk.example")).toBe("desk");
  expect(nextDay.connect).toHaveBeenCalledExactlyOnceWith(CREDENTIAL);
  expect(nextTab.getSnapshot()).toMatchObject({ phase: "connected", activeHostId: "desk" });
  // Already connected: nothing more.
  expect(await nextTab.resume("desk.example")).toBeNull();
});

it("M01: without a credential (not remembered, tab closed) nothing is tried and the list waits for a new link", async () => {
  await tab(pc()).connectOffer(link(), "내 휴대폰");
  sessionStorage.clear();
  const nextDay = pc(), nextTab = tab(nextDay);
  expect(await nextTab.resume("desk.example")).toBeNull();
  expect(nextDay.connect).not.toHaveBeenCalled();
  expect(nextTab.getSnapshot()).toMatchObject({ phase: "local", activeHostId: null });
});

it("M01: a credential the PC ended is dropped at the automatic try, as it was at the tap", async () => {
  await tab(pc({ rememberedAt: 1_000 })).connectOffer(link(), "내 휴대폰", { remember: true });
  sessionStorage.clear();
  const ended = pc({ connect: async () => { throw Object.assign(new Error("revoked"), { status: 401 }); } }), nextTab = tab(ended);
  expect(await nextTab.resume("desk.example")).toBe("desk");
  expect(nextTab.getSnapshot()).toMatchObject({ phase: "error", message: expect.stringContaining("연결 권한이 끝났습니다") });
  expect(everything(localStorage)).not.toContain(CREDENTIAL);
});

it("a PC reached through Tailscale that cannot be reached says the road is what to check", async () => {
  const tailnetLink = () => {
    const data = { v: 2, serverId: "desk", daemonPublicKeyB64: KEY, relay: { endpoint: "desk.tail1a2b.ts.net:443", useTls: true }, minimumSecurityMode: "protected",
      workbench: { version: 1, endpoint: "wss://desk.tail1a2b.ts.net/workbench", offerId: "offer-1", token: "single-use-token-0123456789", expiresAt: Date.now() + 60_000, label: "연구실 PC" } };
    return "https://desk.tail1a2b.ts.net/#offer=" + Buffer.from(JSON.stringify(data)).toString("base64url");
  };
  openedBy("https://desk.tail1a2b.ts.net/");
  await tab(pc({ rememberedAt: 1_000 })).connectOffer(tailnetLink(), "내 휴대폰", { remember: true });
  sessionStorage.clear();
  const gone = pc({ connect: async () => { throw new Error("WebSocket error"); } }), nextTab = tab(gone);
  await nextTab.resume("desk.tail1a2b.ts.net");
  expect(nextTab.getSnapshot().message).toBe("PC에 닿지 않습니다. 이 휴대폰과 PC의 테일스케일이 켜져 있는지 확인하세요. 작업은 PC에서 계속됩니다.");
  // While connected, a dropped connection says the same.
  const live = pc({ rememberedAt: 1_000 }); let report: ((status: { status: string }) => void) | undefined;
  live.onStatus.mockImplementation(((listener: (status: { status: string }) => void) => { report = listener; return () => {}; }) as never);
  const liveTab = tab(live);
  await liveTab.selectHost("desk").catch(() => {});
  report?.({ status: "disconnected" });
  expect(liveTab.getSnapshot()).toMatchObject({ phase: "offline", message: expect.stringContaining("테일스케일이 켜져 있는지") });
});
