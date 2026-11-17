// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Onboarding } from "./Onboarding.tsx";

// The first run (atlas-look): one centred panel, four steps — 화면, AI 엔진, 휴대폰 메신저, 즐겨찾기 (0.5.1) —
// in a teacher's words; every step can be left for later; the gate (onDone → prefs.onboarding) and the actions stay.
// (The earlier 첫 프로젝트 step left the first run: the empty list's 새 프로젝트 makes the first project.)

vi.mock("./pkm/PkmContext.tsx", () => ({ usePkm: () => ({ dialog: null }) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const engineActions = { install: vi.fn(), login: vi.fn(), loginCode: vi.fn(async () => undefined), cancelLogin: vi.fn(), openUrl: vi.fn(), copy: vi.fn() };
const mount = async (extra: Partial<Parameters<typeof Onboarding>[0]> = {}) => {
  const props = { providers: {}, tools: null, engineActions, onRefresh: vi.fn(), onInstallIeum: vi.fn(), onDone: vi.fn(), onTheme: vi.fn(), onPalette: vi.fn(), onOpenMessenger: vi.fn(), ...extra };
  await act(async () => { render(<Onboarding {...props} />); });
  return props;
};
const steps = () => within(screen.getByRole("list", { name: "처음 설정 단계" })).getAllByRole("button").map((key) => key.textContent);
const next = () => act(async () => { fireEvent.click(screen.getAllByRole("button").find((key) => ["다음", "AI 없이 계속", "건너뛰기", "시작하기"].includes(key.textContent ?? ""))!); });

it("walks four steps, one idea each: 화면, AI 엔진, 휴대폰 메신저, 즐겨찾기", async () => {
  const props = await mount();
  expect(steps()).toEqual(["1화면", "2AI 엔진", "3휴대폰 메신저", "4즐겨찾기"]);
  const seen: string[] = [];
  for (let at = 0; at < 4; at++) {
    seen.push(screen.getByRole("heading", { level: 2 }).textContent!);
    if (at < 3) expect(props.onDone).not.toHaveBeenCalled();
    await next();
  }
  expect(seen).toEqual(["화면을 고르세요", "AI 엔진에 로그인하세요", "휴대폰 메신저로도 쓰기", "쓰던 즐겨찾기 가져오기"]);
  expect(props.onDone).toHaveBeenCalledTimes(1);
});

it("is one panel: the steps on its left, the step and its keys on its right, the launch's attribution line its last row", async () => {
  await mount({ foot: <div className="launch-credit">디자인 편집기에 쓴 오픈소스</div> });
  const panel = document.querySelector(".onboarding-first > .onboarding")!;
  expect([...panel.children].map((child) => child.className)).toEqual(["onboarding-side", "onboarding-pane", "onboarding-foot"]);
  expect(panel.querySelector(".onboarding-side .onboarding-steps")).toBeTruthy();
  expect(panel.querySelector(".onboarding-pane > .onboarding-actions")).toBeTruthy();
  expect(panel.querySelector(".onboarding-foot > .launch-credit")).toBeTruthy();
});

it("speaks a teacher's words on every step: no CLI, OS 등록, 이음 앱, 호스트, orchestration, raw commands or middle dots", async () => {
  await mount();
  for (let at = 0; at < 4; at++) {
    const text = document.body.textContent!;
    expect(text).not.toMatch(/CLI|OS 등록|이음 앱|호스트|orchestration|대화|워크스페이스| · |npm |brew /);
    if (at < 3) await next();
  }
});

it("화면 sets the look at once: 밝기 and 색 조합 (the default pair or Workbench; every set is in 설정 › 화면; the one quiet line)", async () => {
  const props = await mount();
  fireEvent.click(screen.getByRole("radio", { name: /어둡게/ }));
  expect(props.onTheme).toHaveBeenCalledWith("dark");
  const palette = screen.getByRole("radiogroup", { name: "색 조합" });
  expect(within(palette).getAllByRole("radio").map((choice) => [choice.textContent, choice.getAttribute("aria-checked")])).toEqual([["Atlas (기본)", "true"], ["Workbench", "false"]]);
  fireEvent.click(within(palette).getByRole("radio", { name: "Workbench" }));
  expect(props.onPalette).toHaveBeenCalledWith({ light: "workbench", dark: "workbench" });
  fireEvent.click(within(palette).getByRole("radio", { name: "Atlas (기본)" }));
  expect(props.onPalette).toHaveBeenLastCalledWith({ light: "atlas", dark: "graphite" });
  expect(document.body.textContent).toContain("색 조합은 Atlas File Manager의 것을 따랐습니다. Dracula, Nord, Rosé Pine은 각 프로젝트의 색입니다.");
  expect(screen.getByRole("img", { name: "고른 화면 미리 보기" })).toBeTruthy();
});

it("AI 엔진: with no engine found, one clear way on per engine, 다시 확인, and a quiet way to continue without", async () => {
  const props = await mount({ providers: { claude: { provider: "claude", installed: false, canInstall: true, billingVars: [], usage: [] } as never } });
  await next();
  expect(screen.getByRole("button", { name: "Claude 설치" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "다시 확인" }));
  expect(props.onRefresh).toHaveBeenCalled();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "AI 없이 계속" })); });
  expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("휴대폰 메신저로도 쓰기");
});

it("AI 엔진: a found engine reads ready in a teacher's words; where and which version only behind 찾은 위치 보기", async () => {
  await mount({ providers: { claude: { provider: "claude", installed: true, origin: "override", version: "2.1.999", binary: "/opt/claude/bin/claude", loggedIn: true, loginMethod: "subscription", plan: "max", billingVars: [], usage: [] } as never } });
  await next();
  const row = document.querySelector(".setup-engine[data-provider=claude]")!;
  const hint = row.querySelector(".settings-row-hint")!.textContent!;
  expect(hint).toBe("이 컴퓨터에서 찾았습니다. Max 구독으로 바로 쓸 수 있습니다.");
  expect(hint).not.toMatch(/2\.1\.999|직접 지정/);
  const found = row.querySelector("details.settings-path")!;
  expect(found.querySelector("summary")!.textContent).toBe("찾은 위치 보기");
  expect(found.querySelector("code")!.textContent).toBe("직접 지정한 위치에서 찾았습니다 (판 2.1.999).\n/opt/claude/bin/claude");
});

it("every step can be left for later; 텔레그램 and Slack each hand over to 설정 › 메신저 for themselves; 건너뛰기 is always on the last step", async () => {
  const first = await mount();
  fireEvent.click(screen.getByRole("button", { name: "나중에 설정" }));
  await act(async () => undefined);
  expect(first.onDone).toHaveBeenCalledTimes(1);
  cleanup();
  const props = await mount();
  await next(); await next();
  fireEvent.click(screen.getByRole("button", { name: "텔레그램 연결하기" }));
  fireEvent.click(screen.getByRole("button", { name: "Slack 연결하기" }));
  expect(vi.mocked(props.onOpenMessenger!).mock.calls).toEqual([["telegram"], ["slack"]]);
  expect(screen.queryByRole("button", { name: "건너뛰기" })).toBeNull();
  await next();
  expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("쓰던 즐겨찾기 가져오기");
  fireEvent.click(screen.getByRole("button", { name: "건너뛰기" }));
  await act(async () => undefined);
  expect(props.onDone).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("keeps its place while 설정 › 메신저 is in front, and comes back on the same step", async () => {
  const props = { providers: {}, tools: null, engineActions, onRefresh: vi.fn(), onInstallIeum: vi.fn(), onDone: vi.fn(), onOpenMessenger: vi.fn() };
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<Onboarding {...props} />); });
  await next(); await next();
  fireEvent.click(screen.getByRole("button", { name: "텔레그램 연결하기" }));
  await act(async () => { view.rerender(<Onboarding {...props} suspended />); });
  expect(screen.queryByRole("dialog")).toBeNull();
  await act(async () => { view.rerender(<Onboarding {...props} />); });
  expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("휴대폰 메신저로도 쓰기");
  expect(props.onDone).not.toHaveBeenCalled();
});

it("holds the focus (I1): the app beside and under it is inert while it is up, and given back after", async () => {
  const shell = document.createElement("div"); shell.className = "rail"; shell.innerHTML = `<textarea class="composer-input"></textarea>`;
  const outside = document.createElement("div"); outside.className = "already-inert"; outside.setAttribute("inert", "");
  document.body.append(shell, outside);
  try {
    const props = { providers: {}, tools: null, engineActions, onRefresh: vi.fn(), onInstallIeum: vi.fn(), onDone: vi.fn() };
    let view!: ReturnType<typeof render>;
    await act(async () => { view = render(<Onboarding {...props} />); });
    expect(shell.hasAttribute("inert")).toBe(true);
    expect(document.activeElement?.id).toBe("onboarding-title");
    expect(document.querySelector(".onboarding")!.closest("[inert]")).toBeNull();
    await act(async () => { view.unmount(); });
    expect(shell.hasAttribute("inert")).toBe(false);
    // An element that was inert before stays inert: only what the first run set is taken back.
    expect(outside.hasAttribute("inert")).toBe(true);
  } finally { shell.remove(); outside.remove(); }
});

it("Esc is 나중에 설정 (I1)", async () => {
  const props = await mount();
  await act(async () => { fireEvent.keyDown(screen.getByRole("heading", { level: 2 }), { key: "Escape" }); });
  expect(props.onDone).toHaveBeenCalledTimes(1);
});

it("one filled key per step (I2): with no engine ready, 'AI 없이 계속' is quiet; once one is ready, 다음 is the filled key", async () => {
  await mount({ providers: { claude: { provider: "claude", installed: false, canInstall: true, billingVars: [], usage: [] } as never } });
  await next();
  expect(screen.getByRole("button", { name: "AI 없이 계속" }).classList.contains("primary")).toBe(false);
  cleanup();
  await mount({ providers: { claude: { provider: "claude", installed: true, loggedIn: true, loginMethod: "subscription", billingVars: [], usage: [] } as never } });
  await next();
  expect(screen.getByRole("button", { name: "다음" }).classList.contains("primary")).toBe(true);
});

it("says only true things about the phone (I3, I10): the messenger needs the app; nothing about a QR here", async () => {
  await mount();
  await next(); await next();
  const text = document.body.textContent!;
  expect(text).not.toContain("따로 설치할 것이 없습니다");
  expect(text).not.toMatch(/같은 와이파이에 있거나|QR/);
  expect(text).toContain("휴대폰에 텔레그램이나 Slack 앱만 있으면 됩니다.");
});

it("휴대폰 메신저: two independent rows, each with its own state and key — both can be connected at once", async () => {
  const bots = [{ kind: "telegram", id: "t1", username: "my_wb_bot", name: "내 Workbench", createdAt: 1, token: {} }, { kind: "slack", id: "s1", username: "", name: "wb", appName: "내 Workbench", createdAt: 2, token: {} }];
  const api = { request: vi.fn(async () => ({ bots })) };
  await mount({ api: api as never });
  await next(); await next();
  await act(async () => undefined);
  const rows = [...document.querySelectorAll(".onboarding-ways li")].map((row) => [row.getAttribute("data-messenger"), row.querySelector(".onboarding-way-state")!.textContent, row.querySelector("button")!.textContent]);
  expect(rows).toEqual([["telegram", "연결됨, @my_wb_bot", "열기"], ["slack", "연결됨, 내 Workbench", "열기"]]);
  expect(document.body.textContent).not.toContain("한 번에 하나만");
  expect(screen.getByRole("button", { name: "나중에 설정" })).toBeTruthy();
});

// ── 즐겨찾기 (0.5.1): the fourth step — the browsers found on this PC, one key each ──────────────────
const bookmarkApi = (sources: unknown[]) => {
  const request = vi.fn(async (_method: string, path: string, _body?: unknown) => {
    if (path === "/api/bookmarks/sources") return sources;
    if (path === "/api/bookmarks/import") return { bookmarks: { showBar: true, items: [] }, items: 132, folders: 9, message: "즐겨찾기 132개, 폴더 9개를 가져왔습니다." };
    if (path === "/api/bookmarks") return { showBar: true, items: [] };
    return { bots: [] };
  });
  return { request, isRemote: false };
};
const toBookmarks = async () => { await next(); await next(); await next(); await act(async () => undefined); };

it("즐겨찾기, browsers found: one key naming each browser (each profile when there are several); pressing it brings them in and one line says what came in", async () => {
  const api = bookmarkApi([
    { id: "chrome", label: "Chrome", profiles: [{ id: "Default", name: "기본 프로필" }, { id: "Profile 2", name: "프로필 2" }] },
    { id: "firefox", label: "Firefox", profiles: [{ id: "0:Profile0", name: "default-release" }] },
  ]);
  const props = await mount({ api: api as never });
  await toBookmarks();
  expect(document.querySelector(".onboarding-count")!.textContent).toBe("4 / 4, 즐겨찾기");
  const rows = [...document.querySelectorAll(".onboarding-ways li")].map((row) => [row.getAttribute("data-browser"), row.querySelector("div")!.textContent, row.querySelector("button")!.textContent, row.querySelector("button")!.getAttribute("aria-label")]);
  expect(rows).toEqual([
    ["chrome", "Chrome기본 프로필", "Chrome에서 가져오기", "Chrome 기본 프로필에서 가져오기"],
    ["chrome", "Chrome프로필 2", "Chrome에서 가져오기", "Chrome 프로필 2에서 가져오기"],
    ["firefox", "Firefox", "Firefox에서 가져오기", "Firefox에서 가져오기"],
  ]);
  // Nothing is read before a key is pressed: only the list of browsers was asked for.
  expect(api.request.mock.calls.filter((call) => String(call[1]).startsWith("/api/bookmarks")).map((call) => call[1])).toEqual(["/api/bookmarks/sources"]);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Chrome 프로필 2에서 가져오기" })); });
  expect(api.request).toHaveBeenCalledWith("POST", "/api/bookmarks/import", { source: "chrome", profile: "Profile 2" });
  expect(screen.getByRole("status").textContent).toBe("즐겨찾기 132개, 폴더 9개를 가져왔습니다.");
  expect(document.body.textContent).toContain("즐겨찾기만 읽습니다. 암호, 방문 기록, 로그인 정보는 읽지 않습니다.");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "시작하기" })); });
  expect(props.onDone).toHaveBeenCalledTimes(1);
});

it("즐겨찾기, no browser found: the step says so in one line and can be passed", async () => {
  const props = await mount({ api: bookmarkApi([]) as never });
  await toBookmarks();
  expect(document.querySelector(".onboarding-ways")).toBeNull();
  expect(document.querySelector(".onboarding-page")!.textContent).toContain("이 PC에서 즐겨찾기를 가져올 브라우저를 찾지 못했습니다. 건너뛰어도 됩니다.");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "시작하기" })); });
  expect(props.onDone).toHaveBeenCalledTimes(1);
});

it("즐겨찾기, skipped: 건너뛰기 finishes the first run and nothing is brought in; 이전 goes back to 휴대폰 메신저", async () => {
  const api = bookmarkApi([{ id: "edge", label: "Edge", profiles: [{ id: "Default", name: "기본 프로필" }] }]);
  const props = await mount({ api: api as never });
  await toBookmarks();
  fireEvent.click(screen.getByRole("button", { name: "이전" }));
  expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("휴대폰 메신저로도 쓰기");
  await act(async () => { fireEvent.click(within(screen.getByRole("list", { name: "처음 설정 단계" })).getByRole("button", { name: /즐겨찾기/ })); });
  expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("쓰던 즐겨찾기 가져오기");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "건너뛰기" })); });
  expect(props.onDone).toHaveBeenCalledTimes(1);
  expect(api.request.mock.calls.some((call) => call[1] === "/api/bookmarks/import")).toBe(false);
});

it("즐겨찾기 is not a step on a phone joined to another PC (no web tabs there): three steps as before", async () => {
  await mount({ api: { ...bookmarkApi([]), isRemote: true } as never });
  expect(steps()).toEqual(["1화면", "2AI 엔진", "3휴대폰 메신저"]);
});
