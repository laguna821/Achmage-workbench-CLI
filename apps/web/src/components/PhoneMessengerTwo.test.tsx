// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelAuditRow, ChannelBinding, ChannelBot, ChannelKind, ChannelsState } from "@workbench/contracts";
import type { Api } from "../api.ts";
import { PhoneMessenger } from "./PhoneMessenger.tsx";

// 설정 › 메신저 with one Telegram bot AND one Slack app: two rows, each connected and set up on its
// own (연결하기 → its own wizard, 열기 → its own status), and `kind` to open one of them alone (the
// first-run screen). Every answer is a stand-in; nothing leaves.

const telegram = (extra: Partial<ChannelBot> = {}): ChannelBot => ({ kind: "telegram", id: "7000000001", username: "wb_7k3q9x_bot", name: "내 Workbench", createdAt: 1, token: "sealed", status: { state: "connected", detail: null }, pairing: { expiresAt: null, request: null, lockedUntil: null }, bindings: [], ...extra });
const slack = (extra: Partial<ChannelBot> = {}): ChannelBot => ({ kind: "slack", id: "B0FAKEBOT01", username: "workbench", name: "연구실", createdAt: 2, token: "sealed", status: { state: "connected", detail: null }, pairing: { expiresAt: null, request: null, lockedUntil: null }, bindings: [], ...extra });
const binding = (kind: ChannelKind, extra: Partial<ChannelBinding> = {}): ChannelBinding => ({ id: `b-${kind}`, kind, botId: kind === "slack" ? "B0FAKEBOT01" : "7000000001", chatId: kind === "slack" ? "D0HONG" : "555", userId: kind === "slack" ? "U0HONG" : "555", displayName: kind === "slack" ? "길동 (Slack)" : "길동 홍", handle: "hong", createdAt: Date.UTC(2026, 10, 12, 1), revokedAt: null, pausedAt: null, lockedAt: null, pointerWorkId: null, pointerSessionId: null, ...extra });
const row = (id: number, kind: ChannelKind, action: string, bindingId: string | null, result: string | null = null): ChannelAuditRow => ({ id, at: Date.UTC(2026, 10, 15, 2, id), bindingId, kind, action, sessionId: null, requestId: null, target: null, result });

function fixture(initial: ChannelsState, audit: ChannelAuditRow[] = []) {
  let state = initial;
  const calls: { method: string; path: string }[] = [];
  const request = vi.fn(async (method: string, path: string) => {
    calls.push({ method, path });
    if (method === "GET" && path === "/api/channels") return state;
    if (method === "GET" && path === "/api/snapshot") return { hostLabel: "노트북" };
    if (method === "GET" && path.startsWith("/api/channels/audit")) return { rows: audit, names: {} };
    if (path === "/api/host/autostart") return { label: "", enabled: true, supported: true };
    if (method === "POST" && path.endsWith("/pairing")) return { link: "https://t.me/wb_7k3q9x_bot?start=AbCd", qr: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", say: "연결 AbCd", open: null, expiresAt: Date.now() + 600_000 };
    if (method === "DELETE" && path.includes("/bots/")) { state = { bots: state.bots.filter((bot) => !path.startsWith(`/api/channels/${bot.kind}/`)) }; return state; }
    return state;
  });
  const api = { request, isRemote: false } as unknown as Api;
  const onClose = vi.fn();
  const mount = async (kind?: ChannelKind) => { await act(async () => { render(<PhoneMessenger embedded {...(kind ? { kind } : {})} api={api} openExternal={vi.fn(async () => {})} copy={vi.fn(async () => {})} readClipboard={vi.fn(async () => "")} onClose={onClose} />); }); };
  return { calls, mount, onClose, set: (next: ChannelsState) => { state = next; } };
}
const click = async (name: string | RegExp) => { await act(async () => { fireEvent.click(screen.getByRole("button", { name })); }); };
const rowText = (label: string) => [...document.querySelectorAll(".settings-row")].find((element) => element.querySelector(".settings-row-label")?.textContent?.startsWith(label))?.textContent ?? "";

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: false }); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); localStorage.clear(); });

describe("설정 › 메신저: two rows, each on its own", () => {
  it("none connected: 텔레그램 and Slack each say 연결 안 됨 with their own 연결하기; nothing says one at a time", async () => {
    const f = fixture({ bots: [] });
    await f.mount();
    expect(rowText("텔레그램")).toContain("연결 안 됨");
    expect(rowText("Slack")).toContain("연결 안 됨");
    expect(screen.getByRole("button", { name: "텔레그램 연결하기" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Slack 연결하기" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "비밀 보관함 열기" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("한 번에 하나만");
    // 텔레그램 연결하기: Telegram's own wizard; back to the rows; Slack 연결하기: Slack's own.
    await click("텔레그램 연결하기");
    expect(screen.getByRole("heading", { name: "텔레그램으로 일 시키기" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Slack/ })).toBeNull();
    await click("← 메신저 목록");
    await click("Slack 연결하기");
    expect(screen.getByRole("heading", { name: "Slack 앱을 만듭니다." })).toBeTruthy();
    expect(screen.getByText("1 / 5단계")).toBeTruthy();
    // Slack's 이전 on its first step comes back to the rows.
    await click("이전");
    expect(screen.getByRole("button", { name: "텔레그램 연결하기" })).toBeTruthy();
  });

  it("Telegram only: its row says 연결됨 with the bot and the person, and opens its status; Slack still offers its own 연결하기", async () => {
    const f = fixture({ bots: [telegram({ bindings: [binding("telegram")] })] });
    await f.mount();
    expect(rowText("텔레그램")).toContain("연결됨");
    expect(rowText("텔레그램")).toContain("@wb_7k3q9x_bot");
    expect(rowText("텔레그램")).toContain("길동 홍");
    expect(rowText("Slack")).toContain("연결 안 됨");
    await click("Slack 연결하기");
    expect(screen.getByRole("heading", { name: "Slack 앱을 만듭니다." })).toBeTruthy();
    expect(document.body.textContent).not.toContain("wb_7k3q9x_bot");
    await click("← 메신저 목록");
    await click("텔레그램 열기");
    expect(screen.getByTestId("channel-status").textContent).toContain("텔레그램 @wb_7k3q9x_bot: 연결됨");
  });

  it("both connected: each 열기 opens its own status, and removing Slack touches only Slack", async () => {
    const f = fixture({ bots: [telegram({ bindings: [binding("telegram")] }), slack({ bindings: [binding("slack")] })] });
    await f.mount();
    expect(rowText("텔레그램")).toContain("연결됨");
    expect(rowText("Slack")).toContain("연결됨");
    expect(rowText("Slack")).toContain("@workbench");
    await click("텔레그램 열기");
    expect(screen.getByTestId("channel-status").textContent).toContain("텔레그램 @wb_7k3q9x_bot");
    await click("← 메신저 목록");
    await click("Slack 열기");
    expect(screen.getByTestId("channel-status").textContent).toContain("Slack @workbench");
    await click("봇 등록 지우기");
    await click("지우기");
    expect(f.calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual(["/api/channels/slack/bots/B0FAKEBOT01"]);
    // Slack gone: its own wizard; Telegram's row is as it was.
    expect(screen.getByRole("heading", { name: "Slack 앱을 만듭니다." })).toBeTruthy();
    await click("← 메신저 목록");
    expect(rowText("텔레그램")).toContain("연결됨");
    expect(rowText("Slack")).toContain("연결 안 됨");
  });

  it("기록 says which messenger each row belongs to", async () => {
    const audit = [row(4, "slack", "request", "b-slack", "started"), row(3, "telegram", "request", "b-telegram", "started"), row(2, "slack", "bot.registered", null, "sealed"), row(1, "telegram", "bot.registered", null, "sealed")];
    const f = fixture({ bots: [telegram({ bindings: [binding("telegram")] }), slack({ bindings: [binding("slack")] })] }, audit);
    await f.mount();
    await click("텔레그램 열기");
    await act(async () => { fireEvent.click(screen.getByRole("tab", { name: "기록" })); });
    const lines = [...document.querySelectorAll(".pm-record li")].map((element) => element.textContent);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("Slack · 요청 보냄");
    expect(lines[1]).toContain("텔레그램 · 요청 보냄");
    expect(lines[2]).toContain("Slack · 봇 등록");
    expect(lines[3]).toContain("텔레그램 · 봇 등록");
  });

  it("a Slack way left part done is named on its row and goes on where it stopped", async () => {
    localStorage.setItem("workbench.phone-messenger.slack", JSON.stringify({ step: "install", name: "연구실 PC" }));
    const f = fixture({ bots: [telegram()] });
    await f.mount();
    expect(rowText("Slack")).toContain("등록을 하던 중");
    await click("Slack 이어서 하기");
    expect(screen.getByRole("heading", { name: "워크스페이스에 설치합니다." })).toBeTruthy();
  });

  it("kind opens one messenger alone, as the first-run screen shows it: no rows, nothing of the other", async () => {
    const f = fixture({ bots: [telegram({ bindings: [binding("telegram")] }), slack()] });
    await f.mount("slack");
    expect(screen.queryByRole("button", { name: "텔레그램 열기" })).toBeNull();
    expect(screen.queryByRole("button", { name: /메신저 목록/ })).toBeNull();
    expect(screen.getByTestId("channel-status").textContent).toContain("Slack @workbench");
    cleanup();
    f.set({ bots: [slack()] });
    await f.mount("telegram");
    expect(screen.getByRole("heading", { name: "텔레그램으로 일 시키기" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("@workbench");
  });
});
