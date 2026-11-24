// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { GeminiSetup, ProviderStatus } from "@workbench/contracts";
import { EnginesSection } from "./Connections.tsx";
import { GeminiCard, GEMINI_GOOGLE_WARNING, GEMINI_NO_FULL, GEMINI_RECOMMEND, GEMINI_SUSPENDED_LINE, GEMINI_WHAT_IT_IS, geminiState } from "./GeminiSetup.tsx";
import { AccessPicker } from "./SessionControls.tsx";

// 설정 › AI 엔진 › Gemini (0.5.6): missing → 설치 opens a terminal; old → one line; the warning and the opt-in
// first; signed out → Google 계정으로 로그인 opens a terminal; signed in. Subscription login only (the owner,
// 2026-11-21): no API-key or Enterprise choice — agy's own sign-in takes a personal or a company Google account.

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const setup = (changes: Partial<GeminiSetup> = {}): GeminiSetup => ({
  googleOptIn: true, versionOk: true, versionRecommended: true, minVersion: "1.5.2", authMethods: [], canReopen: true,
  installCommand: "curl -fsSL https://antigravity.google/cli/install.sh | bash", links: { faq: "https://antigravity.google/docs/faq", terms: "https://antigravity.google/terms", install: "https://antigravity.google/docs/install?tab=cli" },
  strippedVars: [], ...changes,
});
const status = (changes: Partial<ProviderStatus> = {}, gemini: Partial<GeminiSetup> = {}): ProviderStatus => ({
  provider: "gemini", installed: true, binary: "/home/someone/.local/bin/agy", binarySource: "installed", origin: "native", version: "1.5.13", loggedIn: true, loginMethod: "subscription",
  billingVars: [], account: "Google 계정 (구독 종류 확인 불가)", plan: null, usage: [], usageObservedAt: null, models: [], configuredAccess: null, error: null, gemini: setup(gemini), ...changes,
});
const actions = () => ({ settings: vi.fn(), terminal: vi.fn(), refresh: vi.fn(), openUrl: vi.fn() });

it("missing: 설치 runs Google's installer in a terminal tab, and the command can be read first", () => {
  const act = actions();
  render(<GeminiCard status={status({ installed: false, binary: null, version: null, loggedIn: null })} actions={act} />);
  expect(screen.getByText("이 컴퓨터에 없음")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Antigravity CLI 설치" }));
  expect(act.terminal).toHaveBeenCalledWith("install");
  // After the installer ran in its terminal, 다시 확인 is right there.
  fireEvent.click(screen.getByRole("button", { name: "다시 확인" }));
  expect(act.refresh).toHaveBeenCalled();
  expect(screen.getByText(GEMINI_WHAT_IT_IS)).toBeTruthy();
});

it("an old agy: one line on what to do, no login key", () => {
  render(<GeminiCard status={status({ loggedIn: null, version: "1.5.1", error: "Antigravity CLI 1.5.1은 너무 오래되었습니다. 1.5.2 이상이 필요합니다. 터미널에서 agy를 한 번 실행하면 스스로 업데이트합니다." }, { versionOk: false })} actions={actions()} />);
  expect(screen.getByText("업데이트 필요")).toBeTruthy();
  expect(screen.getByText(/1.5.2 이상이 필요합니다/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Gemini 로그인" })).toBeNull();
});

it("between 1.5.2 and 1.5.11: works, with one line recommending 1.5.12 or later", () => {
  const view = render(<GeminiCard status={status({ version: "1.5.5" }, { versionRecommended: false })} actions={actions()} />);
  expect(screen.getByText(GEMINI_RECOMMEND)).toBeTruthy();
  expect(screen.getByText("로그인됨")).toBeTruthy();
  view.rerender(<GeminiCard status={status()} actions={actions()} />);
  expect(screen.queryByText(GEMINI_RECOMMEND)).toBeNull();
});

it("an account Google blocked: one clear line, Google's appeal address, no login key", () => {
  const act = actions();
  render(<GeminiCard status={status({ loggedIn: false }, { suspended: { appeal: "https://antigravity.google/appeal-standin" } })} actions={act} />);
  expect(screen.getByText("사용 막힘")).toBeTruthy();
  expect(screen.getByText(GEMINI_SUSPENDED_LINE)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Google에 이의 제기" }));
  expect(act.openUrl).toHaveBeenCalledWith("https://antigravity.google/appeal-standin");
  expect(screen.queryByRole("button", { name: "Google 계정으로 로그인" })).toBeNull();
});

it("every sign-in: the plain warning, Google's FAQ and terms, and the opt-in before anything else", () => {
  const act = actions();
  render(<GeminiCard status={status({ loggedIn: null }, { googleOptIn: false })} actions={act} />);
  expect(screen.getByText("동의 필요")).toBeTruthy();
  expect(screen.getByText(GEMINI_GOOGLE_WARNING)).toBeTruthy();
  // The risk stays; the DeepMind staff's statement is said as a fact, with no person or post named.
  expect(GEMINI_GOOGLE_WARNING).toContain("계정이 정지될 수 있다고");
  expect(GEMINI_GOOGLE_WARNING).toContain("Google DeepMind 직원들이 2026-11-21~22에 Antigravity ACP 서버를 그대로 쓰는 앱은 괜찮다며 약관을 고쳐 보겠다고 밝혔지만, 공식 약관과 FAQ는 아직 바뀌지 않았습니다.");
  expect(GEMINI_GOOGLE_WARNING).not.toMatch(/@|https?:|x\.com|twitter/i);
  expect(screen.queryByRole("button", { name: "Gemini 로그인" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Google FAQ 보기" }));
  expect(act.openUrl).toHaveBeenCalledWith("https://antigravity.google/docs/faq");
  fireEvent.click(screen.getByRole("switch", { name: "위 내용을 읽었고 내 Google 계정으로 씁니다" }));
  expect(act.settings).toHaveBeenCalledWith({ googleOptIn: true });
});

it("signed out: 로그인 opens a terminal tab with agy's own sign-in", () => {
  const act = actions();
  render(<GeminiCard status={status({ loggedIn: false, loginMethod: null, account: null })} actions={act} />);
  expect(screen.getByText("로그인 필요")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Google 계정으로 로그인" }));
  expect(act.terminal).toHaveBeenCalledWith("login");
  fireEvent.click(screen.getByRole("button", { name: "로그인 상태 확인" }));
  expect(act.refresh).toHaveBeenCalled();
});

it("the engine rows' pattern: unknown → 로그인 상태 확인; signed in → 다른 계정으로 다시 로그인 (the terminal sign-in again); no 로그아웃", () => {
  const act = actions();
  const view = render(<GeminiCard status={status({ loggedIn: null })} actions={act} />);
  fireEvent.click(screen.getByRole("button", { name: "로그인 상태 확인" }));
  expect(act.refresh).toHaveBeenCalledTimes(1);
  view.rerender(<GeminiCard status={status()} actions={act} />);
  fireEvent.click(screen.getByRole("button", { name: "다른 계정으로 다시 로그인" }));
  expect(act.terminal).toHaveBeenCalledWith("login");
  expect(screen.queryByRole("button", { name: "로그아웃" })).toBeNull();
});

it("subscription login only: no API-key or Enterprise choice, no credential-store pick; agy decides personal or company", () => {
  render(<GeminiCard status={status()} actions={actions()} />);
  expect(screen.getByText("로그인됨")).toBeTruthy();
  expect(screen.getByText(/사용 한도\(5시간, 주간\)는 agy가 Workbench에 알려 주지 않습니다/)).toBeTruthy();
  expect(screen.queryByRole("radio", { name: "Gemini API 키" })).toBeNull();
  expect(screen.queryByText(/Gemini Enterprise/)).toBeNull();
  expect(screen.queryByLabelText("비밀 보관함의 API 키")).toBeNull();
  expect(screen.getByText(/개인 계정이든 회사 계정이든/)).toBeTruthy();
  expect(geminiState(status()).text).toBe("로그인됨");
});

it("설정 › AI 엔진 shows the Gemini card after Claude and Codex", () => {
  const engine = { install: vi.fn(), login: vi.fn(), loginCode: vi.fn(async () => undefined), cancelLogin: vi.fn(), openUrl: vi.fn(), copy: vi.fn() };
  const { container } = render(<EnginesSection providers={{ gemini: status() }} connected engineActions={engine} onRefresh={() => {}} browser={null} browserActions={{} as never} onIntegrations={() => {}} gemini={actions()} />);
  expect(container.querySelector('.setup-engine[data-provider="gemini"]')).toBeTruthy();
});

it("the access picker leaves 전체 접근 out for Gemini, with the line", () => {
  render(<AccessPicker provider="gemini" value="auto" onChange={() => {}} noFull={GEMINI_NO_FULL} />);
  fireEvent.click(screen.getByRole("button", { name: /자동/ }));
  expect(screen.queryByText("전체 접근")).toBeNull();
  expect(screen.getByText(/전체 접근을 쓰지 않습니다/)).toBeTruthy();
});
