// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelBinding, ChannelBot, ChannelsState } from "@workbench/contracts";
import { ApiRequestError, type Api } from "../api.ts";
import { PhoneMessenger } from "./PhoneMessenger.tsx";
import { slackManifest } from "./PhoneMessengerSlack.tsx";

// The Slack branch of the "휴대폰 메신저" dialog (design §4.2): the manifest to copy, the steps in
// Korean, the two tokens in masked fields, pairing by a line sent in the app's DM, and the
// registered state in Slack's words. Every answer is a stand-in; nothing leaves.

// A stand-in, put together here so that no token-shaped literal sits in the repository.
const BOT = "xoxb-7000000001-7000000002-" + "Fk".repeat(6) + "LoopbackOnly01";
const APP = "xapp" + "-1-A0FAKEAPP01-7000000003-f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0";
const SAY = "연결 AbCdEfGhIjKlMnOpQrStUv";

const slackBot = (extra: Partial<ChannelBot> = {}): ChannelBot => ({ kind: "slack", id: "B0FAKEBOT01", username: "workbench", name: "연구실", createdAt: 1, token: "sealed", status: { state: "connected", detail: null }, pairing: { expiresAt: null, request: null, lockedUntil: null }, bindings: [], ...extra });
const binding = (extra: Partial<ChannelBinding> = {}): ChannelBinding => ({ id: "b1", kind: "slack", botId: "B0FAKEBOT01", chatId: "D0HONG", userId: "U0HONG", displayName: "길동", handle: "hong", createdAt: Date.UTC(2026, 10, 12, 1), revokedAt: null, pausedAt: null, lockedAt: null, pointerWorkId: null, pointerSessionId: null, ...extra });

type Call = { method: string; path: string; body: unknown };
function fixture(initial: ChannelsState) {
  let state = initial;
  const calls: Call[] = [];
  const answers = new Map<string, (body: unknown) => unknown>();
  const request = vi.fn(async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    const answer = answers.get(`${method} ${path.split("?")[0]}`);
    if (answer) return answer(body);
    if (method === "GET" && path === "/api/channels") return state;
    if (method === "GET" && path === "/api/snapshot") return { hostLabel: "노트북" };
    if (method === "GET" && path.startsWith("/api/channels/audit")) return { rows: [] };
    if (path === "/api/host/autostart") return { label: "", enabled: false, supported: true };
    return state;
  });
  const api = { request, isRemote: false } as unknown as Api;
  const openExternal = vi.fn(async (_url: string) => {});
  const copy = vi.fn(async (_text: string) => {});
  const readClipboard = vi.fn(async () => BOT);
  const mount = async () => { await act(async () => { render(<PhoneMessenger api={api} openExternal={openExternal} copy={copy} readClipboard={readClipboard} onClose={() => {}} />); }); };
  return { calls, answers, openExternal, copy, readClipboard, mount, set: (next: ChannelsState) => { state = next; }, sent: (method: string, path: string) => calls.filter((call) => call.method === method && call.path === path) };
}
const click = async (name: string | RegExp) => { await act(async () => { fireEvent.click(screen.getByRole("button", { name })); }); };
const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); localStorage.clear(); });

describe("registering Slack (design §4.2)", () => {
  it("the manifest asks only for what a DM and files need, by Socket Mode, with the messages tab open — in YAML and the same in JSON", () => {
    const yaml = slackManifest("Workbench · 노트북", "yaml");
    expect(yaml).toContain("socket_mode_enabled: true");
    expect(yaml).toContain("messages_tab_enabled: true");
    expect(yaml).toContain("messages_tab_read_only_enabled: false");
    expect(yaml).toContain("- message.im");
    expect(yaml).toContain('name: "Workbench · 노트북"');
    const scopes = [...yaml.split("bot:\n")[1]!.split("settings:")[0]!.matchAll(/- ([a-z:]+)/g)].map((match) => match[1]);
    expect(scopes).toEqual(["chat:write", "im:history", "files:read", "files:write", "users:read"]);
    expect(yaml).not.toMatch(/groups:|channels:|message\.groups|message\.channels/);
    const json = JSON.parse(slackManifest("Workbench · 노트북", "json")) as { display_information: { name: string }; oauth_config: { scopes: { bot: string[] } }; settings: { socket_mode_enabled: boolean; event_subscriptions: { bot_events: string[] } }; features: { app_home: { messages_tab_read_only_enabled: boolean } } };
    expect(json.display_information.name).toBe("Workbench · 노트북");
    expect(json.oauth_config.scopes.bot).toEqual(scopes);
    expect(json.settings).toMatchObject({ socket_mode_enabled: true, event_subscriptions: { bot_events: ["message.im"] } });
    expect(json.features.app_home.messages_tab_read_only_enabled).toBe(false);
    // Slack's limit for an app name is 35 characters.
    expect((JSON.parse(slackManifest("가".repeat(50), "json")) as { display_information: { name: string } }).display_information.name).toHaveLength(35);
  });

  it("walks from the manifest through installing to the two tokens, in Slack's own words, and says one messenger at a time", async () => {
    const f = fixture({ bots: [] });
    await f.mount();
    expect(screen.getByText("메신저는 한 번에 하나만 연결합니다.")).toBeTruthy();
    await click("Slack으로 시작");
    expect(screen.getByRole("heading", { name: "Slack 앱을 만듭니다." })).toBeTruthy();
    expect(screen.getByText("2 / 6단계")).toBeTruthy();
    expect(screen.getByText(/브라우저에서 Slack 로그인을 먼저 하라고 나오면/)).toBeTruthy();
    // The app's name: the PC's name by default (two colleagues' apps must not look the same), and editable.
    const name = screen.getByLabelText("앱 이름") as HTMLInputElement;
    expect(name.value).toBe("Workbench · 노트북");
    await act(async () => { fireEvent.change(name, { target: { value: "홍길동 연구실 PC" } }); });
    await click("YAML로 복사");
    expect(f.copy).toHaveBeenLastCalledWith(slackManifest("홍길동 연구실 PC", "yaml"));
    await click("JSON으로 복사");
    expect(f.copy).toHaveBeenLastCalledWith(slackManifest("홍길동 연구실 PC", "json"));
    expect(screen.getByText(/YAML과 JSON 탭/)).toBeTruthy();
    expect(screen.getByText("연결을 켜면, 연결한 Slack 계정을 쓸 수 있는 사람은 누구든 이 PC에 확인 없이 무엇이든 시킬 수 있습니다(저장해 둔 로그인과 카드 사용 포함).")).toBeTruthy();
    expect(screen.getByText(/Slack 회사와, 워크스페이스에 따라 그 관리자의 서버를 거쳐/)).toBeTruthy();
    await click("Slack 앱 만들기 열기");
    expect(f.openExternal).toHaveBeenCalledWith("https://api.slack.com/apps?new_app=1");
    await click("다음");
    expect(screen.getByRole("heading", { name: "워크스페이스에 설치합니다." })).toBeTruthy();
    expect(screen.getByText(/관리자 승인/).textContent).toContain("Install을 한 번 더");
    expect(screen.getByText(/이 창을 닫았다가 다시 열어도 이 단계로 돌아옵니다/)).toBeTruthy();
    // After a day's wait for the admin the Slack tab may be gone: a way back to the app's settings.
    await click("Slack 앱 설정 열기");
    expect(f.openExternal).toHaveBeenLastCalledWith("https://api.slack.com/apps");
    await click("다음");
    expect(screen.getByRole("heading", { name: "토큰 두 개를 붙여 넣습니다." })).toBeTruthy();
    expect(screen.getByText(/아래로 내리면/)).toBeTruthy();
    f.openExternal.mockClear();
    await click("Slack 앱 설정 열기");
    expect(f.openExternal).toHaveBeenLastCalledWith("https://api.slack.com/apps");
    const bot = screen.getByLabelText("봇 토큰 (xoxb-)") as HTMLInputElement, app = screen.getByLabelText("앱 토큰 (xapp-)") as HTMLInputElement;
    expect([bot.type, app.type]).toEqual(["password", "password"]);
    await click("이전");
    expect(screen.getByRole("heading", { name: "워크스페이스에 설치합니다." })).toBeTruthy();
  });

  it("sends both tokens once, keeps neither on the page, and says what Slack refused", async () => {
    const f = fixture({ bots: [] });
    let answer: unknown = new ApiRequestError(400, { code: "channel_token_swapped", message: "두 칸이 바뀌었습니다." });
    f.answers.set("POST /api/channels/slack/bots", () => { if (answer instanceof Error) throw answer; return answer; });
    await f.mount();
    await click("Slack으로 시작");
    await click("다음");
    await click("다음");
    const bot = screen.getByLabelText("봇 토큰 (xoxb-)") as HTMLInputElement, app = screen.getByLabelText("앱 토큰 (xapp-)") as HTMLInputElement;
    await act(async () => { fireEvent.change(bot, { target: { value: ` ${APP} ` } }); fireEvent.change(app, { target: { value: BOT } }); });
    await click("확인");
    expect(screen.getByRole("alert").textContent).toBe("두 칸이 바뀌었습니다.");
    // The name typed for the app goes with the tokens: the pairing step tells the person to search for it.
    expect(f.sent("POST", "/api/channels/slack/bots")[0]!.body).toEqual({ botToken: APP, appToken: BOT, appName: "Workbench · 노트북" });
    answer = { bots: [slackBot()] };
    f.set({ bots: [slackBot()] });
    f.answers.set("POST /api/channels/slack/bots/B0FAKEBOT01/pairing", () => ({ link: "", qr: "", say: SAY, open: "https://slack.com/app_redirect?app=A0FAKEAPP01&team=T0FAKETEAM1", expiresAt: Date.now() + 600_000 }));
    await act(async () => { fireEvent.change(bot, { target: { value: BOT } }); fireEvent.change(app, { target: { value: APP } }); });
    await click("확인");
    expect(f.sent("POST", "/api/channels/slack/bots")[1]!.body).toEqual({ botToken: BOT, appToken: APP, appName: "Workbench · 노트북" });
    expect(document.body.innerHTML).not.toContain(BOT);
    expect(document.body.innerHTML).not.toContain(APP);
    expect(screen.getByText("Slack 앱 @workbench(연구실)을 확인했습니다.")).toBeTruthy();
  });

  it("without an OS keyring, offers to keep both for this run only", async () => {
    const f = fixture({ bots: [] });
    f.answers.set("POST /api/channels/slack/bots", (body) => { if ((body as { memoryOnly?: boolean }).memoryOnly) return { bots: [slackBot({ token: "memory" })] }; throw new ApiRequestError(503, { code: "office_vault_unavailable", message: "no keyring" }); });
    await f.mount();
    await click("Slack으로 시작");
    await click("다음");
    await click("다음");
    await act(async () => { fireEvent.change(screen.getByLabelText("봇 토큰 (xoxb-)"), { target: { value: BOT } }); fireEvent.change(screen.getByLabelText("앱 토큰 (xapp-)"), { target: { value: APP } }); });
    await click("확인");
    expect(screen.getByRole("alert").textContent).toContain("키링");
    await click("이번 실행 동안만 기억");
    expect(f.sent("POST", "/api/channels/slack/bots").at(-1)!.body).toEqual({ botToken: BOT, appToken: APP, appName: "Workbench · 노트북", memoryOnly: true });
  });

  it("closed while waiting for the admin, the dialog opens at the shared start, which offers to go on with Slack at the step the person was on, with the name kept", async () => {
    const f = fixture({ bots: [] });
    await f.mount();
    expect(screen.getByText("1 / 6단계")).toBeTruthy();
    await click("Slack으로 시작");
    expect(screen.getByText("2 / 6단계")).toBeTruthy();
    await act(async () => { fireEvent.change(screen.getByLabelText("앱 이름"), { target: { value: "연구실 PC" } }); });
    await click("다음");
    cleanup();
    await f.mount();
    // Slack's place never takes over the dialog: Telegram stays one press away.
    expect(screen.getByRole("heading", { name: "휴대폰으로 일 시키기" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "텔레그램으로 시작" })).toBeTruthy();
    expect(screen.getByTestId("slack-kept")).toBeTruthy();
    await click("Slack 이어서 하기");
    expect(screen.getByRole("heading", { name: "워크스페이스에 설치합니다." })).toBeTruthy();
    await click("이전");
    expect((screen.getByLabelText("앱 이름") as HTMLInputElement).value).toBe("연구실 PC");
    // Back to the intro: the place is forgotten.
    await click("이전");
    expect(screen.queryByTestId("slack-kept")).toBeNull();
    expect(screen.getByRole("button", { name: "Slack으로 시작" })).toBeTruthy();
    cleanup();
    await f.mount();
    expect(screen.getByRole("heading", { name: "휴대폰으로 일 시키기" })).toBeTruthy();
    expect(screen.queryByTestId("slack-kept")).toBeNull();
  });
});

describe("pairing and the registered state on Slack", () => {
  it("shows the line to send in the app's DM with a copy button and a link to open the app; no QR", async () => {
    const f = fixture({ bots: [slackBot()] });
    f.answers.set("POST /api/channels/slack/bots/B0FAKEBOT01/pairing", () => ({ link: "", qr: "", say: SAY, open: "https://app.slack.com/client/T0FAKETEAM1", expiresAt: Date.now() + 600_000 }));
    await f.mount();
    await tick(0);
    expect(screen.getByRole("heading", { name: "Slack에서 이 앱에 “연결”이라고 보내세요." })).toBeTruthy();
    expect(screen.getByText("5 / 6단계")).toBeTruthy();
    // The PC path is a browser; the phone path says what to do there, with no link claimed to open the app.
    await click("브라우저에서 Slack 열기");
    expect(f.openExternal).toHaveBeenCalledWith("https://app.slack.com/client/T0FAKETEAM1");
    // Without the typed name (registered before it was kept), the bot's handle.
    expect(screen.getByText(/왼쪽 위 검색에 @workbench/)).toBeTruthy();
    expect(screen.getByText("휴대폰 Slack에서 앱 이름(@workbench)을 검색해 열고 “연결”이라고 보내세요.")).toBeTruthy();
    expect(screen.getByText(/Messages Tab/)).toBeTruthy();
    // The long line stays, second.
    expect(screen.getByTestId("pairing-say").textContent).toBe(SAY);
    expect(screen.queryByRole("img")).toBeNull();
    await click("연결 줄 복사");
    expect(f.copy).toHaveBeenCalledWith(SAY);
    expect(screen.getByTestId("channel-status").textContent).toContain("Slack @workbench");
  });

  it("tells the person to search for the app by the name they typed, not a handle Slack made from it", async () => {
    const f = fixture({ bots: [slackBot({ appName: "Workbench · 연구실 PC" })] });
    f.answers.set("POST /api/channels/slack/bots/B0FAKEBOT01/pairing", () => ({ link: "", qr: "", say: SAY, open: "https://app.slack.com/client/T0FAKETEAM1", expiresAt: Date.now() + 600_000 }));
    await f.mount();
    await tick(0);
    expect(screen.getByText("이 PC에서: 브라우저 Slack의 왼쪽 위 검색에 “Workbench · 연구실 PC”를 넣어 앱을 열고, 메시지 칸에 “연결”이라고 보내세요.")).toBeTruthy();
    expect(screen.getByText("휴대폰 Slack에서 앱 이름 “Workbench · 연구실 PC”를 검색해 열고 “연결”이라고 보내세요.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("@workbench을");
  });

  it("the request says Slack and shows the Slack user id beside the name; the four digits decide", async () => {
    const request = { id: "rq1", userId: "U0HONG", displayName: "길동", handle: "hong", digits: "4821", at: Date.now(), expiresAt: Date.now() + 600_000 };
    const f = fixture({ bots: [slackBot({ pairing: { expiresAt: null, request, lockedUntil: null } })] });
    await f.mount();
    expect(document.querySelector(".pm-request-text")!.textContent).toBe("Slack 사용자 길동이 연결을 요청합니다.");
    expect(screen.getByText("Slack 사용자 ID")).toBeTruthy();
    expect(screen.getByTestId("pairing-number").textContent).toBe("U0HONG");
    expect(screen.getByTestId("pairing-digits").textContent).toBe("4 8 2 1");
    expect(screen.getByText("Slack에 보이는 숫자")).toBeTruthy();
    // The workspace is the app's own (the same for everyone who asks, it tells nobody apart), and said so.
    expect(screen.getByTestId("pairing-workspace").textContent).toBe("연구실 (이 앱이 설치된 곳)");
    expect(screen.getByText("6 / 6단계")).toBeTruthy();
    expect(screen.queryByTestId("pairing-others")).toBeNull();
  });

  it("another person asked while one waits: the card names them and says to refuse the first if it is not you; a declined person is listed apart", async () => {
    const request = {
      id: "rq1", userId: "U0KIM", displayName: "김", handle: "kim", digits: "4821", at: Date.now(), expiresAt: Date.now() + 600_000,
      others: [{ userId: "U0HONG", displayName: "길동 (홍길동)", handle: "hong" }],
    };
    const f = fixture({ bots: [slackBot({ pairing: { expiresAt: null, request, lockedUntil: null } })] });
    await f.mount();
    const others = screen.getByTestId("pairing-others");
    expect(others.textContent).toContain("다른 사람도 연결을 요청했습니다");
    expect(others.textContent).toContain("길동 (홍길동) · @hong · U0HONG");
    expect(others.textContent).toContain("[거절]");
    await click("거절");
    expect(f.calls.filter((call) => call.method === "POST" && call.path.endsWith("/pairing/rq1")).map((call) => call.body)).toEqual([{ approve: false }]);
    cleanup();
    const until = Date.now() + 3_600_000;
    const g = fixture({ bots: [slackBot({ pairing: { expiresAt: Date.now() + 600_000, request: null, lockedUntil: null, refusedSenders: [{ userId: "U0KIM", displayName: "김", handle: "kim", until, declined: true }] } })] });
    await g.mount();
    expect(screen.getByTestId("refused-senders").textContent).toContain("PC에서 거절한 계정은 한 시간 동안 받지 않습니다");
    expect(screen.getByTestId("refused-senders").textContent).not.toContain("잘못된 연결 값");
  });

  it("replaces the two tokens together, and the removal warning says what stays at Slack", async () => {
    const f = fixture({ bots: [slackBot({ bindings: [binding()] })] });
    await f.mount();
    expect(screen.getByText("토큰 두 개")).toBeTruthy();
    expect(screen.getByText(/· ID U0HONG/)).toBeTruthy();
    await click("토큰 바꾸기");
    expect(screen.getByLabelText("새 봇 토큰 (xoxb-)")).toBeTruthy();
    await act(async () => { fireEvent.change(screen.getByLabelText("새 봇 토큰 (xoxb-)"), { target: { value: BOT } }); fireEvent.change(screen.getByLabelText("새 앱 토큰 (xapp-)"), { target: { value: APP } }); });
    await click("확인");
    expect(f.sent("POST", "/api/channels/slack/bots")[0]!.body).toEqual({ botToken: BOT, appToken: APP });
    await click("봇 등록 지우기");
    expect(screen.getByText(/Slack 앱과 토큰은 Slack에 그대로 남습니다/)).toBeTruthy();
  });
});
