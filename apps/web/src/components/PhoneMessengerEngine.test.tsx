// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelBot, ChannelsState, Provider } from "@workbench/contracts";
import { ApiRequestError, type Api } from "../api.ts";
import { PhoneMessenger } from "./PhoneMessenger.tsx";

// 설정 › 메신저: "기본 엔진" of each messenger (Claude | Codex | 정하지 않음). The two rows say it; a
// messenger's own screen changes it with the segmented control 설정 uses elsewhere; what the chat set
// shows here on the next look at the gateway. Every answer is a stand-in; nothing leaves.

const telegram = (extra: Partial<ChannelBot> = {}): ChannelBot => ({ kind: "telegram", id: "7000000001", username: "wb_7k3q9x_bot", name: "내 Workbench", createdAt: 1, token: "sealed", status: { state: "connected", detail: null }, pairing: { expiresAt: null, request: null, lockedUntil: null }, bindings: [], ...extra });
const slack = (extra: Partial<ChannelBot> = {}): ChannelBot => ({ kind: "slack", id: "B0FAKEBOT01", username: "workbench", name: "연구실", createdAt: 2, token: "sealed", status: { state: "connected", detail: null }, pairing: { expiresAt: null, request: null, lockedUntil: null }, bindings: [], ...extra });

function fixture(initial: ChannelsState, options: { refuse?: Provider } = {}) {
  let state = initial;
  const patches: { path: string; body: unknown }[] = [];
  const request = vi.fn(async (method: string, path: string, body?: unknown) => {
    if (method === "PATCH" && /^\/api\/channels\/(telegram|slack)\/bots\/[^/]+$/.test(path)) {
      patches.push({ path, body });
      const engine = (body as { defaultEngine: Provider | null }).defaultEngine;
      if (engine && engine === options.refuse) throw new ApiRequestError(409, { code: "channel_engine_missing", message: "Codex가 이 PC에 설치되어 있지 않습니다." });
      state = { bots: state.bots.map((bot) => (path.startsWith(`/api/channels/${bot.kind}/`) ? { ...bot, defaultEngine: engine } : bot)) };
      return state;
    }
    if (path === "/api/host/autostart") return { label: "", enabled: true, supported: true };
    if (method === "POST" && path.endsWith("/pairing")) return { link: "https://t.me/wb_7k3q9x_bot?start=AbCd", qr: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", say: "연결 AbCd", open: null, expiresAt: Date.now() + 600_000 };
    return state;
  });
  const api = { request, isRemote: false } as unknown as Api;
  const mount = async () => { await act(async () => { render(<PhoneMessenger embedded api={api} openExternal={vi.fn(async () => {})} copy={vi.fn(async () => {})} readClipboard={vi.fn(async () => "")} onClose={vi.fn()} />); }); };
  return { patches, mount, set: (next: ChannelsState) => { state = next; } };
}
const click = async (name: string | RegExp) => { await act(async () => { fireEvent.click(screen.getByRole("button", { name })); }); };
const choose = async (name: string) => { await act(async () => { fireEvent.click(screen.getByRole("radio", { name })); }); };
const rowText = (label: string) => [...document.querySelectorAll(".settings-row")].find((element) => element.querySelector(".settings-row-label")?.textContent?.startsWith(label))?.textContent ?? "";
const chosen = () => [...screen.getByRole("radiogroup", { name: "기본 엔진" }).querySelectorAll('[role="radio"]')].filter((cell) => cell.getAttribute("aria-checked") === "true").map((cell) => cell.textContent);

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: false }); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); localStorage.clear(); });

describe("설정 › 메신저: each messenger's 기본 엔진", () => {
  it("the two rows say each messenger's own default, and nothing when none is set", async () => {
    const f = fixture({ bots: [telegram({ defaultEngine: "codex" }), slack({ defaultEngine: "claude" })] });
    await f.mount();
    expect(rowText("텔레그램")).toContain("기본 엔진 Codex");
    expect(rowText("Slack")).toContain("기본 엔진 Claude");
    cleanup();
    const none = fixture({ bots: [telegram(), slack({ defaultEngine: null })] });
    await none.mount();
    expect(rowText("텔레그램")).not.toContain("기본 엔진");
    expect(rowText("Slack")).not.toContain("기본 엔진");
  });

  it("a messenger's screen has 기본 엔진 with the three choices; choosing one sets it for that messenger only and says so", async () => {
    const f = fixture({ bots: [telegram(), slack({ defaultEngine: "claude" })] });
    await f.mount();
    await click("텔레그램 열기");
    expect([...screen.getByRole("radiogroup", { name: "기본 엔진" }).querySelectorAll('[role="radio"]')].map((cell) => cell.textContent)).toEqual(["정하지 않음", "Claude", "Codex"]);
    expect(chosen()).toEqual(["정하지 않음"]);
    await choose("Codex");
    expect(f.patches).toEqual([{ path: "/api/channels/telegram/bots/7000000001", body: { defaultEngine: "codex" } }]);
    expect(chosen()).toEqual(["Codex"]);
    expect(screen.getByRole("status").textContent).toBe("앞으로 텔레그램의 새 대화는 Codex로 만듭니다. 지금 있는 대화는 그대로입니다.");
    // Slack's is as it was.
    await click("← 메신저 목록");
    expect(rowText("텔레그램")).toContain("기본 엔진 Codex");
    expect(rowText("Slack")).toContain("기본 엔진 Claude");
    await click("Slack 열기");
    expect(chosen()).toEqual(["Claude"]);
    await choose("정하지 않음");
    expect(f.patches.at(-1)).toEqual({ path: "/api/channels/slack/bots/B0FAKEBOT01", body: { defaultEngine: null } });
    expect(chosen()).toEqual(["정하지 않음"]);
    expect(screen.getByRole("status").textContent).toBe("기본 엔진을 정하지 않았습니다. Slack의 새 대화는 전처럼 지금 대화나 프로젝트의 엔진으로 만듭니다.");
  });

  it("what the chat set shows here at the next look, without doing anything", async () => {
    const f = fixture({ bots: [telegram()] });
    await f.mount();
    await click("텔레그램 열기");
    expect(chosen()).toEqual(["정하지 않음"]);
    f.set({ bots: [telegram({ defaultEngine: "codex" })] });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_100); });
    expect(chosen()).toEqual(["Codex"]);
    expect(f.patches).toEqual([]);
  });

  it("an engine this PC does not have: the gateway's sentence is shown and the choice stays as it was", async () => {
    const f = fixture({ bots: [telegram({ defaultEngine: "claude" })] }, { refuse: "codex" });
    await f.mount();
    await click("텔레그램 열기");
    await choose("Codex");
    expect(screen.getByRole("alert").textContent).toBe("Codex가 이 PC에 설치되어 있지 않습니다.");
    expect(chosen()).toEqual(["Claude"]);
  });
});
