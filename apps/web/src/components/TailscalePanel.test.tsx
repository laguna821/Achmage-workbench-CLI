// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { STANDING, TailscalePanel } from "./TailscalePanel.tsx";
import { HostConnections } from "./HostConnections.tsx";
import type { HostConnectionsController, LocalDeviceApi, TailscaleState, DeviceManagementState } from "../host-connections.ts";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

const ADDRESS = "https://desk.tail1a2b.ts.net";
const ON = ["serve", "--https=443", "http://127.0.0.1:41733"], OFF = ["serve", "--https=443", "off"];
const S = {
  missing: { ours: false, state: "missing", downloadUrl: "https://tailscale.com/download", port: 41733 },
  nodaemon: { ours: false, state: "stopped", backend: "NoDaemon", port: 41733 },
  login: { ours: false, state: "needs-login", backend: "NeedsLogin", port: 41733 },
  magic: { ours: false, state: "no-https", reason: "magicdns", machine: "desk.tail1a2b.ts.net", adminUrl: "https://console.tailscale.com/admin/dns", port: 41733 },
  https: { ours: false, state: "no-https", reason: "https", machine: "desk.tail1a2b.ts.net", adminUrl: "https://console.tailscale.com/admin/dns", port: 41733 },
  ready: { ours: false, state: "ready", address: ADDRESS, command: ON, commandLine: "tailscale " + ON.join(" "), port: 41733 },
  taken: { ours: false, state: "taken", address: ADDRESS, by: "http://127.0.0.1:3000", port: 41733 },
  funnel: { ours: false, state: "funnel", address: ADDRESS, port: 41733 },
  on: { ours: true, state: "on", address: ADDRESS, command: ON, commandLine: "tailscale " + ON.join(" "), seenAt: null, port: 41733 },
  seen: { ours: true, state: "on", address: ADDRESS, command: ON, commandLine: "tailscale " + ON.join(" "), seenAt: Date.UTC(2026, 10, 17, 3), port: 41733 },
  lost: { ours: true, lost: true, state: "stopped", backend: "Stopped", port: 41733 },
  opening: { ours: true, state: "opening", address: ADDRESS, command: ON, commandLine: "tailscale " + ON.join(" "), port: 41733 },
  background: { ours: false, state: "background", address: ADDRESS, command: OFF, commandLine: "tailscale " + OFF.join(" "), port: 41733 },
  closed: { ours: true, lost: true, retrying: true, why: "테일스케일 Serve가 끝났습니다. (테일스케일의 답: <b>HTTPS</b> is off)", state: "ready", address: ADDRESS, command: ON, commandLine: "tailscale " + ON.join(" "), port: 41733 },
} satisfies Record<string, TailscaleState>;

function api(sequence: TailscaleState[], extra: Partial<LocalDeviceApi> = {}) {
  let index = 0;
  const tailscale = vi.fn(async () => sequence[Math.min(index++, sequence.length - 1)]!);
  const value: LocalDeviceApi = {
    state: vi.fn(), configure: vi.fn(), approve: vi.fn(), reject: vi.fn(), revoke: vi.fn(), remove: vi.fn(), rotate: vi.fn(),
    createOffer: vi.fn(async () => ({ offerId: "o", hostId: "h", token: "t", createdAt: 1, expiresAt: Date.now() + 60_000, url: ADDRESS + "/#offer=abc", qrDataUrl: "data:image/png;base64,AAAA" })),
    tailscale, tailscaleOn: vi.fn(async () => S.on), tailscaleOff: vi.fn(async () => S.ready), ...extra,
  };
  return value;
}
const mount = async (value: LocalDeviceApi, props: Partial<Parameters<typeof TailscalePanel>[0]> = {}) => {
  await act(async () => { render(<TailscalePanel api={value} {...props} />); });
};
const heading = () => screen.getByRole("heading", { level: 4 }).textContent;
const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;

it("not installed: what it is in one sentence, the official download page, and 설치했어요 · 다시 확인", async () => {
  const open = vi.fn(async () => {});
  const value = api([S.missing, S.ready]);
  await mount(value, { openExternal: open });
  expect(heading()).toBe("이 PC에 테일스케일이 없습니다");
  expect(screen.getByText(/내 기기들끼리만 통하는 사설 연결망/)).toBeTruthy();
  fireEvent.click(button("설치 안내 열기"));
  expect(open).toHaveBeenCalledWith("https://tailscale.com/download");
  await act(async () => { fireEvent.click(button("설치했어요 · 다시 확인")); });
  expect(heading()).toBe("이 PC의 작업실을 내 테일스케일 안에서만 열기");
});

it("stopped and logged out: says so and the one thing to do", async () => {
  await mount(api([S.nodaemon]));
  expect(heading()).toBe("테일스케일이 꺼져 있습니다");
  expect(screen.getByText(/테일스케일 앱을 열어 켜 주세요/)).toBeTruthy();
  cleanup();
  await mount(api([S.login]));
  expect(heading()).toBe("테일스케일에 로그인되어 있지 않습니다");
  expect(screen.getByText(/같은 계정으로 로그인해야/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "켜기" })).toBeNull();
});

it("logged in without HTTPS: this PC's tailnet name, the one setting, and the admin page link", async () => {
  const open = vi.fn(async () => {});
  await mount(api([S.magic]), { openExternal: open });
  expect(heading()).toBe("테일스케일의 MagicDNS가 꺼져 있습니다");
  expect(screen.getByText("desk.tail1a2b.ts.net")).toBeTruthy();
  fireEvent.click(button("관리 페이지 열기"));
  expect(open).toHaveBeenCalledWith("https://console.tailscale.com/admin/dns");
  cleanup();
  await mount(api([S.https]));
  expect(screen.getByText(/HTTPS Certificates\(HTTPS 인증서\)를 켠 뒤/)).toBeTruthy();
});

it("ready: shows exactly the command, says that 켜기 stands while the app runs, and 켜기 sends exactly that argv back — nothing runs before the press", async () => {
  const changed = vi.fn();
  const value = api([S.ready]);
  await mount(value, { onChanged: changed });
  expect(screen.getByLabelText("실행할 명령").textContent).toBe("tailscale serve --https=443 http://127.0.0.1:41733");
  expect(STANDING).toBe("끄기를 누를 때까지, 이 앱이 켜져 있는 동안만 열립니다. 앱을 끄면 닫히고, 다시 켜면 다시 열립니다.");
  expect(screen.getByText(STANDING)).toBeTruthy();
  expect(screen.getByText(/아래 명령을 실행해 둡니다/)).toBeTruthy();
  expect(screen.getByText(ADDRESS)).toBeTruthy();
  expect(value.tailscaleOn).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(button("켜기")); });
  expect(value.tailscaleOn).toHaveBeenCalledExactlyOnceWith(ON);
  expect(changed).toHaveBeenCalledOnce();
  expect(heading()).toBe("켜짐: 내 테일스케일 안에서만 열림");
});

it("on: the address, the three phone steps and a QR for that address; never '휴대폰에서 열림' before a device came through it", async () => {
  const value = api([S.on]);
  await mount(value);
  expect(screen.getByText(ADDRESS)).toBeTruthy();
  expect(screen.getByText("아직 이 주소로 연결한 기기가 없습니다.")).toBeTruthy();
  expect(screen.queryByText(/휴대폰에서 열림/)).toBeNull();
  expect(screen.getAllByRole("listitem").map(item => item.textContent)).toEqual([
    "휴대폰에 테일스케일 앱을 설치하고 이 PC와 같은 계정으로 로그인합니다.",
    "아래 QR을 휴대폰 카메라로 찍으면 휴대폰 브라우저에 작업실이 열립니다.",
    "휴대폰과 이 PC에 같은 여섯 자리 숫자가 보이는지 보고, 이 PC에서 승인합니다.",
  ]);
  await act(async () => { fireEvent.click(button("휴대폰으로 찍을 QR 만들기")); });
  expect(screen.getByRole("img", { name: "휴대폰으로 찍을 연결 QR 코드" })).toBeTruthy();
  cleanup();
  await mount(api([S.seen]));
  expect(screen.getByRole("status").textContent).toMatch(/^휴대폰에서 열림 · /);
  expect(screen.getByText(STANDING)).toBeTruthy();
});

it("a QR for some other address is not drawn as the Tailscale QR", async () => {
  const value = api([S.on], { createOffer: vi.fn(async () => ({ offerId: "o", hostId: "h", token: "t", createdAt: 1, expiresAt: Date.now() + 60_000, url: "https://elsewhere.example/#offer=abc", qrDataUrl: "data:image/png;base64,AAAA" })) });
  await mount(value);
  await act(async () => { fireEvent.click(button("휴대폰으로 찍을 QR 만들기")); });
  expect(screen.queryByRole("img")).toBeNull();
});

it("on: shows the command the app keeps running; 끄기 ends it and leaves nothing in Tailscale; a Serve this app did not turn on offers no 끄기", async () => {
  const value = api([S.on]);
  await mount(value);
  expect(screen.getByLabelText("실행 중인 명령").textContent).toBe("tailscale serve --https=443 http://127.0.0.1:41733");
  expect(screen.getByText("끄기를 누르면 이 명령을 끝내고 연결 설정을 켜기 전으로 돌립니다. 테일스케일 설정에는 아무것도 남기지 않습니다.")).toBeTruthy();
  await act(async () => { fireEvent.click(button("끄기")); });
  expect(value.tailscaleOff).toHaveBeenCalledOnce();
  expect(heading()).toBe("이 PC의 작업실을 내 테일스케일 안에서만 열기");
  cleanup();
  await mount(api([{ ...S.on, ours: false }]));
  expect(screen.queryByRole("button", { name: "끄기" })).toBeNull();
  expect(screen.getByText(/이 앱이 켠 것이 아닙니다/)).toBeTruthy();
});

it("Funnel and a taken 443 are refused in words, with no 켜기", async () => {
  await mount(api([S.funnel]));
  expect(heading()).toBe("Funnel이 켜져 있어 연결하지 않습니다");
  expect(screen.queryByRole("button", { name: "켜기" })).toBeNull();
  cleanup();
  await mount(api([S.taken]));
  expect(screen.getByText(/http:\/\/127\.0\.0\.1:3000/)).toBeTruthy();
  expect(screen.getByText(/덮어쓰지 않습니다/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "켜기" })).toBeNull();
});

it("Tailscale stopping later: the open panel looks again by itself and says the road is gone", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const value = api([S.on, S.lost]);
  await mount(value, { pollMs: 1000 });
  expect(heading()).toBe("켜짐: 내 테일스케일 안에서만 열림");
  await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
  expect(heading()).toBe("테일스케일이 꺼져 있습니다");
  expect(screen.getByText(/테일스케일 길이 끊겼습니다/)).toBeTruthy();
});

it("a failed 켜기 is one sentence with what to do, and the panel reads the state again", async () => {
  const value = api([S.ready, S.ready], { tailscaleOn: vi.fn(async () => { throw new Error("테일스케일 Serve를 켜지 못했습니다. 테일스케일의 답: access denied"); }) });
  await mount(value);
  await act(async () => { fireEvent.click(button("켜기")); });
  expect(screen.getByRole("alert").textContent).toBe("켜지 못했습니다. 테일스케일 Serve를 켜지 못했습니다. 테일스케일의 답: access denied");
  expect(value.tailscale).toHaveBeenCalledTimes(2);
});

it("in 설정 › 휴대폰과 다른 기기 the panel sits under the ways in, and 켜기 refreshes the address field", async () => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  const before: DeviceManagementState = { config: { enabled: false, listenHost: "127.0.0.1", port: 0, publicUrl: "" }, hostId: "h", hostFingerprint: "f", status: "disabled", devices: [], pending: [], workspaces: [] };
  const after: DeviceManagementState = { ...before, config: { ...before.config, enabled: true, publicUrl: ADDRESS }, status: "listening", port: 41733, phoneUrl: ADDRESS };
  const states = [before, after];
  const value = api([S.ready], { state: vi.fn(async () => states.length > 1 ? states.shift()! : states[0]!) });
  const snapshot = { hosts: [], activeHostId: null, phase: "local", credentialStorage: "session" } as const;
  const controller: HostConnectionsController = { getSnapshot: () => snapshot as never, subscribe: () => () => {}, connectOffer: vi.fn(), selectHost: vi.fn(), disconnect: vi.fn(), remove: vi.fn() };
  await act(async () => { render(<HostConnections open api={value} controller={controller} onClose={() => {}} />); });
  expect(screen.getByText("테일스케일 안내 보기")).toBeTruthy();
  expect((screen.getByLabelText("다른 기기에서 접속할 주소") as HTMLInputElement).value).toBe("");
  await act(async () => { fireEvent.click(button("켜기")); });
  expect((screen.getByLabelText("다른 기기에서 접속할 주소") as HTMLInputElement).value).toBe(ADDRESS);
  expect((screen.getByLabelText("다른 기기의 연결 허용") as HTMLInputElement).checked).toBe(true);
});

it("여는 중: while Tailscale prepares the address the panel says so (no 'on' yet), and 끄기 is there", async () => {
  await mount(api([S.opening]));
  expect(heading()).toBe("테일스케일 길을 여는 중입니다");
  expect(screen.getByText(/인증서를 받느라 조금 걸릴 수 있습니다/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "휴대폰으로 찍을 QR 만들기" })).toBeNull();
  expect(button("끄기")).toBeTruthy();
});

it("a background entry to this app on 443: said, the command to remove it shown as text, nothing to press that runs it", async () => {
  const value = api([S.background]);
  await mount(value);
  expect(heading()).toBe("테일스케일에 이 앱으로 가는 길이 따로 열려 있습니다");
  expect(screen.getByLabelText("지우는 명령").textContent).toBe("tailscale serve --https=443 off");
  expect(screen.queryByRole("button", { name: /켜기|끄기/ })).toBeNull();
  expect(value.tailscaleOn).not.toHaveBeenCalled(); expect(value.tailscaleOff).not.toHaveBeenCalled();
});

it("the road closed while 켜기 stands: the panel says it is gone, why (as text), that it is tried again, and offers 지금 다시 열기 and 끄기", async () => {
  const value = api([S.closed]);
  await mount(value);
  expect(screen.getByText("휴대폰에서 이 PC로 오던 테일스케일 길이 끊겼습니다.")).toBeTruthy();
  expect(screen.getByText("테일스케일 Serve가 끝났습니다. (테일스케일의 답: <b>HTTPS</b> is off)")).toBeTruthy();
  expect(document.querySelector(".tailscale-why b")).toBeNull();
  expect(screen.getByText("켜 둔 상태라 잠시 뒤 저절로 다시 엽니다.")).toBeTruthy();
  await act(async () => { fireEvent.click(button("지금 다시 열기")); });
  expect(value.tailscaleOn).toHaveBeenCalledExactlyOnceWith(ON);
  cleanup();
  const stopped = api([{ ...S.lost, why: "lost connection to tailscaled" }]);
  await mount(stopped);
  expect(screen.getByText("lost connection to tailscaled")).toBeTruthy();
  await act(async () => { fireEvent.click(button("끄기")); });
  expect(stopped.tailscaleOff).toHaveBeenCalledOnce();
});
