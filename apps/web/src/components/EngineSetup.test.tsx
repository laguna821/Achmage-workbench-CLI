// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Provider, ProviderStatus } from "@workbench/contracts";
import { EngineCard, type EngineActions } from "./EngineSetup.tsx";

// 0.5.6 round 2, the owner: "클로드의 경우 자동감지 이외에도 로그인 기능이 따로 구현되어 있는데 GPT의 경우 수동으로
// OAuth 로그인 기능이 설정에 없었어." 설정 › AI 엔진 is the same for both engines: signed out "<name> 로그인";
// signed in "다른 계정으로 다시 로그인" and "로그아웃" (asked first: running conversations keep going);
// unknown (the engine idle) "로그인 상태 확인".
afterEach(cleanup);

const status = (provider: Provider, over: Partial<ProviderStatus> = {}): ProviderStatus => ({
  provider, installed: true, binary: `/usr/bin/${provider}`, binarySource: "installed", version: "1.0.0", loggedIn: true, loginMethod: "subscription",
  billingVars: [], account: "kim@example.com", plan: "pro", usage: [], usageObservedAt: null, models: [], configuredAccess: null, error: null, ...over,
});
const actions = () => {
  const keys = {
    install: vi.fn(), login: vi.fn((_provider: Provider) => undefined), loginCode: vi.fn(async () => undefined), cancelLogin: vi.fn(), openUrl: vi.fn(), copy: vi.fn(),
    logout: vi.fn(async (_provider: Provider) => undefined), checkLogin: vi.fn((_provider: Provider) => undefined),
  };
  return keys satisfies EngineActions;
};

describe.each(["claude", "codex"] as const)("설정 › AI 엔진, %s", (provider) => {
  const name = provider === "claude" ? "Claude" : "Codex";

  it("signed out: \"<name> 로그인\"", () => {
    const keys = actions();
    render(<EngineCard provider={provider} status={status(provider, { loggedIn: false, loginMethod: null, account: null, plan: null })} actions={keys} manage />);
    fireEvent.click(screen.getByRole("button", { name: `${name} 로그인` }));
    expect(keys.login).toHaveBeenCalledWith(provider);
    expect(screen.queryByRole("button", { name: "로그아웃" })).toBeNull();
  });

  it("signed in: 다른 계정으로 다시 로그인 and 로그아웃, which asks first and says running conversations keep going", async () => {
    const keys = actions();
    render(<EngineCard provider={provider} status={status(provider)} actions={keys} manage />);
    fireEvent.click(screen.getByRole("button", { name: "다른 계정으로 다시 로그인" }));
    expect(keys.login).toHaveBeenCalledWith(provider);
    fireEvent.click(screen.getByRole("button", { name: "로그아웃" }));
    const confirm = screen.getByRole("group", { name: `${name} 로그아웃 확인` });
    expect(confirm.textContent).toContain(`진행 중인 ${name} 대화는 중간에 멈출 수 있으니 답이 끝난 뒤에 하세요.`);
    expect(keys.logout).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "취소" }));
    expect(screen.queryByRole("group", { name: `${name} 로그아웃 확인` })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "로그아웃" }));
    await act(async () => { fireEvent.click(within(screen.getByRole("group", { name: `${name} 로그아웃 확인` })).getByRole("button", { name: "로그아웃" })); });
    expect(keys.logout).toHaveBeenCalledWith(provider);
    expect(screen.queryByRole("group", { name: `${name} 로그아웃 확인` })).toBeNull();
  });

  it("unknown (the engine idle): \"로그인 상태 확인\" instead of nothing", () => {
    const keys = actions();
    render(<EngineCard provider={provider} status={status(provider, { loggedIn: null, loginMethod: null, account: null, plan: null })} actions={keys} manage />);
    fireEvent.click(screen.getByRole("button", { name: "로그인 상태 확인" }));
    expect(keys.checkLogin).toHaveBeenCalledWith(provider);
  });

  it("the first run (no manage) keeps only the login: no 로그아웃 there", () => {
    render(<EngineCard provider={provider} status={status(provider)} actions={actions()} />);
    expect(screen.queryByRole("button", { name: "로그아웃" })).toBeNull();
    expect(screen.queryByRole("button", { name: "다른 계정으로 다시 로그인" })).toBeNull();
  });
});
