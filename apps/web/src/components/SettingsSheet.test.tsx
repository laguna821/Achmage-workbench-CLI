// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProviderStatus } from "@workbench/contracts";
import { DEFAULT_APPEARANCE, readAppearance, AppearanceContext, type AppearanceApi } from "../appearance.ts";
import { AppearancePanel } from "./AppearanceSheet.tsx";
import { AboutSection, AdvancedSection, DevicesSection, DocumentsSection, EnginesSection, GeneralSection } from "./Connections.tsx";
import { EngineCard, engineState } from "./EngineSetup.tsx";
import { SettingsSheet, SETTINGS_SECTIONS, readSettingsSection } from "./SettingsSheet.tsx";

// 설정 (release unit B): one place with a left list of sections; every control the old ⋯ pile held
// keeps a row and its behaviour; stored looks are never lost; developer words stay out of the rows.

beforeEach(() => { HTMLDialogElement.prototype.showModal = function () { this.open = true; }; HTMLDialogElement.prototype.close = function () { this.open = false; }; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const engineActions = { install: vi.fn(), login: vi.fn(), loginCode: vi.fn(async () => undefined), cancelLogin: vi.fn(), openUrl: vi.fn(), copy: vi.fn() };
const status = (changes: Partial<ProviderStatus> = {}): ProviderStatus => ({
  provider: "claude", installed: true, binary: "/home/someone/.local/bin/claude", binarySource: "installed", origin: "path", canInstall: true, install: null, login: null,
  version: "2.1.999", loggedIn: true, loginMethod: "subscription", billingVars: [], account: "fake@example.com", plan: "max", usage: [{ label: "5시간", usedPercent: 35, resetsAt: null }],
  usageObservedAt: null, models: [], configuredAccess: null, error: null, ...changes,
});

it("opens on the section it is given, moves with the list and the arrows, and closes on Escape with the focus back on its opener", async () => {
  const opener = document.createElement("button"); opener.textContent = "설정"; document.body.append(opener); opener.focus();
  const onSection = vi.fn(), onClose = vi.fn();
  const view = render(<SettingsSheet section="engines" onSection={onSection} onClose={onClose}><p>rows</p></SettingsSheet>);
  const nav = screen.getByRole("navigation", { name: "설정" });
  expect(within(nav).getAllByRole("button").map((key) => key.textContent)).toEqual(SETTINGS_SECTIONS.map((entry) => entry.label));
  expect(within(nav).getByRole("button", { name: "AI 엔진" }).getAttribute("aria-current")).toBe("page");
  expect(document.activeElement?.textContent).toBe("AI 엔진");
  expect(screen.getByRole("heading", { level: 2, name: "AI 엔진" })).toBeTruthy();
  fireEvent.click(within(nav).getByRole("button", { name: "메신저" }));
  expect(onSection).toHaveBeenLastCalledWith("messenger");
  fireEvent.keyDown(within(nav).getByRole("button", { name: "AI 엔진" }), { key: "ArrowDown" });
  expect(onSection).toHaveBeenLastCalledWith("devices");
  fireEvent(document.querySelector("dialog.settings-dialog")!, new Event("cancel", { cancelable: true }));
  expect(onClose).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(document.activeElement).toBe(opener);
  opener.remove();
});

it("on a phone: 설정 opens on its section list full-screen, a section has a back key to the list", () => {
  const before = window.matchMedia;
  window.matchMedia = ((query: string) => ({ matches: query === "(width < 40rem)", media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  const onSection = vi.fn();
  const view = render(<SettingsSheet section="engines" onSection={onSection} onClose={() => {}} listFirst><p>rows</p></SettingsSheet>);
  const nav = () => document.querySelector<HTMLElement>(".settings-nav")!, pane = () => document.querySelector<HTMLElement>(".settings-pane")!;
  expect(nav().hidden).toBe(false);
  expect(pane().hidden).toBe(true);
  expect(within(nav()).getByRole("button", { name: "설정 닫기" })).toBeTruthy();
  fireEvent.click(within(nav()).getByRole("button", { name: "휴대폰과 다른 기기" }));
  expect(onSection).toHaveBeenLastCalledWith("devices");
  expect(nav().hidden).toBe(true);
  expect(pane().hidden).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "설정 목록으로" }));
  expect(nav().hidden).toBe(false);
  view.unmount();
  // Opened on a named section (기기 연결 from the first run): that section first, the list one key away.
  render(<SettingsSheet section="devices" onSection={onSection} onClose={() => {}}><p>rows</p></SettingsSheet>);
  expect(pane().hidden).toBe(false);
  expect(screen.getByRole("button", { name: "설정 목록으로" })).toBeTruthy();
  window.matchMedia = before;
});

it("reopens on the section seen last, and falls back to 일반 for anything it does not know", () => {
  expect(readSettingsSection("vault")).toBe("vault");
  expect(readSettingsSection("connections")).toBe("general");
  expect(readSettingsSection(undefined)).toBe("general");
});

it("keeps a row, and the behaviour, for every control the old ⋯ menu held", () => {
  const calls: string[] = [];
  const call = (name: string) => () => { calls.push(name); };
  render(<>
    <GeneralSection startScreen="home" onStartScreen={(next) => calls.push(`start:${next}`)} notifications onNotifications={(next) => calls.push(`notify:${next}`)} brandMotion onBrandMotion={(next) => calls.push(`motion:${next}`)}
      onPropertyTemplate={call("template")} shortcutSettings={<p>단축키 목록</p>} onOnboarding={call("onboarding")} />
    <EnginesSection providers={{ claude: status(), codex: status({ provider: "codex", installed: false, binary: null, loggedIn: null, loginMethod: null, account: null, plan: null, usage: [] }) }} connected engineActions={engineActions}
      onRefresh={call("refresh")} browser={null} browserActions={{} as never} onIntegrations={call("integrations")} voice={<p>음성</p>} />
    <DevicesSection local onConnections={call("devices")} onPush={call("push")} onMessenger={call("messenger")} />
    <DocumentsSection tools={null} onInstallIeum={call("ieum")} onRefreshTools={call("tools")} onOfficeSettings={call("office")} onDropbox={call("dropbox")} onOfficeImport={call("import")} onKnowledge={call("knowledge")} />
    <AdvancedSection onDesktop={call("desktop")} onExtensions={call("extensions")} onEventHub={call("hub")} />
    <AboutSection hostLabel="노트북" />
  </>);
  for (const [label, name] of [["템플릿 고치기…", "template"], ["다시 보기", "onboarding"], ["상태 다시 확인", "refresh"], ["열기…", "integrations"], ["기기 연결…", "devices"], ["알림 설정…", "push"], ["메신저 설정", "messenger"],
    ["문서 도구 다시 확인", "tools"], ["문서 AI 설정…", "office"], ["Dropbox 폴더 연결…", "dropbox"], ["이음오피스 설정 가져오기…", "import"], ["지식베이스…", "knowledge"], ["외부 앱…", "desktop"], ["실행 확장…", "extensions"], ["이벤트 받기…", "hub"]] as const) {
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(calls.at(-1)).toBe(name);
  }
  fireEvent.click(screen.getByRole("radio", { name: "마지막 작업" }));
  expect(calls.at(-1)).toBe("start:last");
  fireEvent.click(screen.getByRole("switch", { name: "끝나면 알림 보내기" }));
  expect(calls.at(-1)).toBe("notify:false");
  fireEvent.click(screen.getByRole("switch", { name: "지금 화면의 로고 움직임" }));
  expect(calls.at(-1)).toBe("motion:false");
  expect(screen.getByText("단축키 목록")).toBeTruthy();
  expect(screen.getByText("음성")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Codex 설치" })).toBeTruthy();
});

it("says engines and tools in a teacher's words: no developer words, no middle dots, and the path only behind 찾은 위치 보기", () => {
  render(<EnginesSection providers={{ claude: status({ origin: "override", billingVars: ["ANTHROPIC_API_KEY"] }) }} connected engineActions={engineActions} onRefresh={() => {}} browser={null} browserActions={{} as never} onIntegrations={() => {}} />);
  const text = document.body.textContent!;
  expect(text).toContain("구독으로 연결됨 (Max)");
  expect(text).not.toMatch(/ · |환경 변수|CLI|호스트|PATH|세션|런타임/);
  // The path shares its folded box with where it was found and the version (the row itself says only "찾았습니다").
  const path = screen.getByText((_content, node) => node?.tagName === "CODE" && node.textContent!.endsWith("/home/someone/.local/bin/claude"));
  expect(path.textContent).toContain("판 2.1.999");
  expect(document.querySelector(".setup-engine .settings-row-hint")!.textContent).toBe("이 컴퓨터에서 찾았습니다. Max 구독으로 바로 쓸 수 있습니다.");
  expect(path.closest("details")).not.toBeNull();
  expect(path.closest("details")!.open).toBe(false);
  expect(within(path.closest("details")!).getByText("찾은 위치 보기")).toBeTruthy();
  expect(engineState(status({ installed: false })).text).toBe("이 컴퓨터에 없음");
});

it("shows the engine's next step as the one key at its row's end", () => {
  const login = vi.fn();
  render(<EngineCard provider="codex" status={status({ provider: "codex", loggedIn: false, loginMethod: null })} actions={{ ...engineActions, login }} />);
  fireEvent.click(screen.getByRole("button", { name: "Codex 로그인" }));
  expect(login).toHaveBeenCalledWith("codex");
});

it("never loses a stored look: custom values saved under v6, v7 and v8 read back unchanged", () => {
  for (const v of [6, 7, 8]) {
    const stored = JSON.parse(JSON.stringify({ ...DEFAULT_APPEARANCE, v }));
    stored.claude.light.palette.accent = "#123456";
    stored.claude.light.fontSize = 19;
    stored.codex.dark.font = "custom:나눔명조";
    stored.codex.mode = "dark";
    const read = readAppearance(stored);
    expect(read.claude.light.palette.accent, `v${v}`).toBe("#123456");
    expect(read.claude.light.fontSize, `v${v}`).toBe(19);
    expect(read.codex.dark.font, `v${v}`).toBe("custom:나눔명조");
    expect(read.codex.mode, `v${v}`).toBe("dark");
  }
});

it("화면: the app's look first, then the reading face and size for the engine chosen; colours wait behind 색 직접 고르기", () => {
  const updateLook = vi.fn(), setMode = vi.fn(), onThemePref = vi.fn(), onTarget = vi.fn();
  const api = { appearance: readAppearance({ ...DEFAULT_APPEARANCE, v: 8 }), appTheme: "light", updateLook, setMode, resetLook: vi.fn(), lookOf: () => DEFAULT_APPEARANCE.claude.light } as unknown as AppearanceApi;
  render(<AppearanceContext.Provider value={api}><AppearancePanel target={{ provider: "claude", theme: "light" }} onTarget={onTarget} themePref="system" onThemePref={onThemePref} /></AppearanceContext.Provider>);
  const choice = screen.getByRole("radiogroup", { name: "화면" });
  expect(within(choice).getAllByRole("radio").map((key) => key.textContent)).toEqual(["시스템 따라", "밝게", "어둡게"]);
  fireEvent.click(within(choice).getByRole("radio", { name: "어둡게" }));
  expect(onThemePref).toHaveBeenCalledWith("dark");
  expect(updateLook).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("slider", { name: "글자 크기" }), { target: { value: "18" } });
  expect(updateLook).toHaveBeenCalledWith("claude", "light", { fontSize: 18 });
  const more = screen.getByText("색 직접 고르기").closest("details")!;
  expect(more.open).toBe(false);
  expect(within(more).getByLabelText("화면 배경 색 값")).toBeTruthy();
  expect(screen.getByRole("img", { name: "Claude 밝을 때 미리 보기" })).toBeTruthy();
  fireEvent.click(within(screen.getByRole("radiogroup", { name: "엔진" })).getByRole("radio", { name: "Codex" }));
  expect(onTarget).toHaveBeenCalledWith({ provider: "codex", theme: "light" });
});

// Tech review 2 (mutants that survived): Home/End reach the first and the LAST section; the list is one tab stop.
it("Home opens the first section and End the last; the section list is ONE tab stop (the current section)", () => {
  const onSection = vi.fn();
  render(<SettingsSheet section="engines" onSection={onSection} onClose={() => {}}><p>rows</p></SettingsSheet>);
  const nav = screen.getByRole("navigation", { name: "설정" });
  const keys = within(nav).getAllByRole("button").filter((key) => key.hasAttribute("data-section"));
  fireEvent.keyDown(within(nav).getByRole("button", { name: "AI 엔진" }), { key: "End" });
  expect(onSection).toHaveBeenLastCalledWith(SETTINGS_SECTIONS.at(-1)!.id);
  fireEvent.keyDown(within(nav).getByRole("button", { name: "AI 엔진" }), { key: "Home" });
  expect(onSection).toHaveBeenLastCalledWith(SETTINGS_SECTIONS[0]!.id);
  expect(keys.filter((key) => key.tabIndex === 0).map((key) => key.textContent)).toEqual(["AI 엔진"]);
  expect(keys.filter((key) => key.tabIndex === -1)).toHaveLength(keys.length - 1);
});
