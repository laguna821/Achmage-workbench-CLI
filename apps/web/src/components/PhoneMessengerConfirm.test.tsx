// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelBinding, ChannelBot, ChannelsState } from "@workbench/contracts";
import type { Api } from "../api.ts";
import { PhoneMessenger } from "./PhoneMessenger.tsx";

// 설정 › 메신저 › a connected chat: "확인 받기" (unit 13), the same value as the chat's 메뉴 › 알림 row.
// Every answer is a stand-in; nothing leaves.

const chat = (extra: Partial<ChannelBinding> = {}): ChannelBinding => ({ id: "b1", kind: "telegram", botId: "7000000001", chatId: "555", userId: "555", displayName: "홍길동", handle: null, createdAt: 1, revokedAt: null, pausedAt: null, lockedAt: null, pointerWorkId: null, pointerSessionId: null, ...extra });
const telegram = (bindings: ChannelBinding[]): ChannelBot => ({ kind: "telegram", id: "7000000001", username: "wb_7k3q9x_bot", name: "내 Workbench", createdAt: 1, token: "sealed", status: { state: "connected", detail: null }, pairing: { expiresAt: null, request: null, lockedUntil: null }, bindings });

function fixture(initial: ChannelsState) {
  let state = initial;
  const patches: { path: string; body: unknown }[] = [];
  const request = vi.fn(async (method: string, path: string, body?: unknown) => {
    if (method === "PATCH" && path.startsWith("/api/channels/bindings/")) {
      patches.push({ path, body });
      const confirm = (body as { confirm: boolean }).confirm;
      state = { bots: state.bots.map((bot) => ({ ...bot, bindings: bot.bindings.map((binding) => ({ ...binding, confirm })) })) };
      return state;
    }
    if (path === "/api/host/autostart") return { label: "", enabled: true, supported: true };
    return state;
  });
  const api = { request, isRemote: false } as unknown as Api;
  const mount = async () => { await act(async () => { render(<PhoneMessenger embedded api={api} openExternal={vi.fn(async () => {})} copy={vi.fn(async () => {})} readClipboard={vi.fn(async () => "")} onClose={vi.fn()} />); }); };
  return { patches, mount };
}
const open = async () => { await act(async () => { fireEvent.click(screen.getByRole("button", { name: "텔레그램 열기" })); }); };

afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });

describe("설정 › 메신저: 확인 받기 of a connected chat", () => {
  it("is shown off by default (and for an older gateway that does not say), and one click turns it on through the chat's own PATCH", async () => {
    const f = fixture({ bots: [telegram([chat()])] });
    await f.mount();
    await open();
    const toggle = screen.getByRole("switch", { name: "확인 받기" }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    await act(async () => { fireEvent.click(toggle); });
    expect(f.patches).toEqual([{ path: "/api/channels/bindings/b1", body: { confirm: true } }]);
    expect((screen.getByRole("switch", { name: "확인 받기" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("확인 받기를 켰습니다. 이 채팅이 새로 만드는 대화는 '자동' 모드로, 묻는 일은 휴대폰에 [허용] [거절]로 갑니다.");
    await act(async () => { fireEvent.click(screen.getByRole("switch", { name: "확인 받기" })); });
    expect(f.patches.at(-1)).toEqual({ path: "/api/channels/bindings/b1", body: { confirm: false } });
    expect(screen.getByRole("status").textContent).toBe("확인 받기를 껐습니다. 새 대화는 전처럼 묻지 않고 끝까지 합니다.");
  });

  it("shows what the chat set", async () => {
    const f = fixture({ bots: [telegram([chat({ confirm: true })])] });
    await f.mount();
    await open();
    expect((screen.getByRole("switch", { name: "확인 받기" }) as HTMLInputElement).checked).toBe(true);
  });

  it("is not offered before a phone is connected", async () => {
    const f = fixture({ bots: [telegram([])] });
    await f.mount();
    await open();
    expect(screen.queryByRole("switch", { name: "확인 받기" })).toBeNull();
  });
});
