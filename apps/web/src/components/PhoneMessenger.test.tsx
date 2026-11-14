// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelAuditRow, ChannelBinding, ChannelBot, ChannelsState } from "@workbench/contracts";
import { ApiRequestError, type Api } from "../api.ts";
import { approvalKeyApplies } from "../conversation/approval-keys.ts";
import { PhoneMessenger } from "./PhoneMessenger.tsx";

// The "휴대폰 메신저" dialog: the Telegram registration wizard step by step (design §4.1), the
// pairing approval with its four digits, and the registered state's gates (pause, unlock at the PC
// only, disconnect, replace token, the record). Every answer here is a stand-in; nothing leaves.

const TOKEN = "7000" + "000001:AAFkkkkkkkk-Fake_token-for-loopback-01";
const START = "AbCdEfGhIjKlMnOpQrStUv";
const LINK = `https://t.me/wb_7k3q9x_bot?start=${START}`;
const QR = "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=";

const binding = (extra: Partial<ChannelBinding> = {}): ChannelBinding => ({ id: "b1", kind: "telegram", botId: "7000000001", chatId: "555", userId: "555", displayName: "길동 홍", handle: "hong", createdAt: Date.UTC(2026, 10, 12, 1), revokedAt: null, pausedAt: null, lockedAt: null, pointerWorkId: "w", pointerSessionId: "s", pointerLabel: "「휴대폰」 › 「휴대폰 · 11/12」 (Claude · 전체 허용)", ...extra });
const bot = (extra: Partial<ChannelBot> = {}): ChannelBot => ({ kind: "telegram", id: "7000000001", username: "wb_7k3q9x_bot", name: "내 Workbench", createdAt: 1, token: "sealed", status: { state: "connected", detail: null }, pairing: { expiresAt: null, request: null, lockedUntil: null }, bindings: [], ...extra });

type Call = { method: string; path: string; body: unknown };

function fixture(initial: ChannelsState, options: { autostart?: { enabled: boolean; supported: boolean }; audit?: ChannelAuditRow[] } = {}) {
  let state = initial;
  const calls: Call[] = [];
  const answers = new Map<string, (body: unknown) => unknown>();
  const request = vi.fn(async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    const answer = answers.get(`${method} ${path.split("?")[0]}`);
    if (answer) return answer(body);
    if (method === "GET" && path === "/api/channels") return state;
    if (method === "GET" && path.startsWith("/api/channels/audit")) return { rows: options.audit ?? [] };
    if (path === "/api/host/autostart") return method === "GET" ? { label: "", ...(options.autostart ?? { enabled: false, supported: true }) } : { label: "", enabled: (body as { enabled: boolean }).enabled, supported: true };
    if (method === "PATCH" || method === "POST" || method === "DELETE") return state;
    throw new Error(`unexpected ${method} ${path}`);
  });
  const api = { request, isRemote: false } as unknown as Api;
  const openExternal = vi.fn(async (_url: string) => {});
  const copy = vi.fn(async (_text: string) => {});
  const readClipboard = vi.fn(async () => TOKEN);
  const onClose = vi.fn();
  const mount = async () => { await act(async () => { render(<PhoneMessenger api={api} openExternal={openExternal} copy={copy} readClipboard={readClipboard} onClose={onClose} />); }); };
  return {
    calls, answers, request, openExternal, copy, readClipboard, onClose, mount,
    set: (next: ChannelsState) => { state = next; },
    sent: (method: string, path: string) => calls.filter((call) => call.method === method && call.path === path),
  };
}

const click = async (name: string | RegExp) => { await act(async () => { fireEvent.click(screen.getByRole("button", { name })); }); };
const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("registration (design §4.1)", () => {
  it("opens with what it does, the two honest sentences, the two starts and the autostart tick on", async () => {
    const f = fixture({ bots: [] });
    await f.mount();
    expect(screen.getByRole("dialog", { name: "휴대폰 메신저" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "휴대폰으로 일 시키기" })).toBeTruthy();
    expect(screen.getByText("휴대폰 메신저로 이 PC의 AI에게 일을 시키고 결과를 받습니다.")).toBeTruthy();
    expect(screen.getByText("연결을 켜면, 연결한 텔레그램 계정을 쓸 수 있는 사람은 누구든 이 PC에 확인 없이 무엇이든 시킬 수 있습니다(저장해 둔 로그인과 카드 사용 포함).")).toBeTruthy();
    expect(screen.getByText("주고받는 글·사진·파일과 AI의 답은 텔레그램 회사의 서버를 거쳐 그곳에 저장되며, 봇 토큰이 새면 남이 그 대화를 엿보거나 가로챌 수 있습니다.")).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "PC를 켜면 자동으로 시작" }) as HTMLInputElement).checked).toBe(true);
    // Slack has its own branch (PhoneMessengerSlack.test.tsx); 이전 comes back here.
    await click("Slack으로 시작");
    expect(screen.getByRole("heading", { name: "Slack 앱을 만듭니다." })).toBeTruthy();
    await click("이전");
    expect(screen.getByRole("heading", { name: "휴대폰으로 일 시키기" })).toBeTruthy();
  });

  it("walks in four steps: BotFather's chat in Telegram Web (no app on the PC needed), three lines to send, the token", async () => {
    const f = fixture({ bots: [] });
    await f.mount();
    expect(screen.getByText("1 / 6단계")).toBeTruthy();
    await click("텔레그램으로 시작");

    // Step 2: the chat itself, inside Telegram Web. The t.me page only works with the app installed.
    expect(screen.getByText("2 / 6단계")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "PC 브라우저에서 BotFather 대화를 엽니다." })).toBeTruthy();
    await click("텔레그램 웹에서 BotFather 열기");
    expect(f.openExternal).toHaveBeenLastCalledWith("https://web.telegram.org/k/#@BotFather");
    expect(screen.getByText(/휴대폰 텔레그램 → 설정 → 기기 → 데스크톱 기기 연결/)).toBeTruthy();
    // When the chat does not open by itself: its name to paste into the search field.
    await click("@BotFather 복사");
    expect(f.copy).toHaveBeenLastCalledWith("@BotFather");
    expect(screen.getByText(/\[START\]/)).toBeTruthy();
    // The app's own link stays, named for what it needs.
    await click("PC에 텔레그램 앱이 있으면: 앱으로 열기");
    expect(f.openExternal).toHaveBeenLastCalledWith("https://t.me/BotFather");
    await click("다음");

    // Step 3: all three lines on one screen.
    expect(screen.getByText("3 / 6단계")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "BotFather에게 아래 세 줄을 차례로 보내세요." })).toBeTruthy();
    // BotFather asks in English: each line is named by the question it answers, and the user name's rule is said.
    expect(screen.getByText(/It must end in `bot`/)).toBeTruthy();
    expect(screen.getByText(/끝은 반드시 bot/)).toBeTruthy();
    await click("/newbot 복사");
    expect(f.copy).toHaveBeenLastCalledWith("/newbot");
    await click("봇 이름 복사");
    expect(f.copy).toHaveBeenLastCalledWith("내 Workbench");
    const shown = () => screen.getByTestId("bot-username").textContent!;
    const first = shown();
    expect(first).toMatch(/^wb_[a-z0-9]{6}_bot$/);
    expect(first.length).toBeGreaterThanOrEqual(5);
    expect(first.length).toBeLessThanOrEqual(32);
    await click("사용자명 복사");
    expect(f.copy).toHaveBeenLastCalledWith(first);
    await click("다른 이름 만들기");
    expect(shown()).not.toBe(first);
    expect(shown()).toMatch(/^wb_[a-z0-9]{6}_bot$/);
    await click("다음");

    expect(screen.getByText("4 / 6단계")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "BotFather가 보낸 긴 토큰(숫자:문자)을 복사해 여기에 붙여 넣으세요." })).toBeTruthy();
    // Back goes back one step.
    await click("이전");
    expect(screen.getByRole("heading", { name: "BotFather에게 아래 세 줄을 차례로 보내세요." })).toBeTruthy();
  });

  it("checks the token, never shows or keeps it, turns autostart on, and goes on to the QR with the deep link", async () => {
    const f = fixture({ bots: [] }, { autostart: { enabled: false, supported: true } });
    f.answers.set("POST /api/channels/telegram/bots", () => { const next = { bots: [bot()] }; f.set(next); return next; });
    f.answers.set("POST /api/channels/telegram/bots/7000000001/pairing", () => { f.set({ bots: [bot({ pairing: { expiresAt: Date.now() + 600_000, request: null, lockedUntil: null } })] }); return { link: LINK, qr: QR, expiresAt: Date.now() + 600_000 }; });
    await f.mount();
    await click("텔레그램으로 시작");
    await click("토큰을 직접 입력");
    const field = screen.getByLabelText("봇 토큰") as HTMLInputElement;
    expect(field.type).toBe("password");
    await click("붙여넣기");
    expect(f.readClipboard).toHaveBeenCalled();
    expect(document.body.innerHTML).not.toContain(TOKEN);
    await click("확인");
    expect(f.sent("POST", "/api/channels/telegram/bots")).toEqual([{ method: "POST", path: "/api/channels/telegram/bots", body: { token: TOKEN } }]);
    expect(screen.getByText("봇 @wb_7k3q9x_bot을 확인했습니다.")).toBeTruthy();
    expect(f.sent("PUT", "/api/host/autostart")).toMatchObject([{ body: { enabled: true } }]);
    // The token field is gone and the token is nowhere on the screen.
    expect(screen.queryByLabelText("봇 토큰")).toBeNull();
    expect(document.body.innerHTML).not.toContain(TOKEN);
    // Step 5 of Telegram's own six: the QR of the deep link, the link itself not written out.
    const qr = screen.getByRole("img", { name: "텔레그램 봇 연결 QR" }) as HTMLImageElement;
    expect(qr.getAttribute("src")).toBe(QR);
    expect(screen.getByText("휴대폰 카메라로 찍으세요.")).toBeTruthy();
    expect(screen.getByText("5 / 6단계")).toBeTruthy();
    expect(document.body.textContent).not.toContain(START);
  });

  it("leaves autostart alone when the tick was taken off", async () => {
    const f = fixture({ bots: [] }, { autostart: { enabled: false, supported: true } });
    f.answers.set("POST /api/channels/telegram/bots", () => { const next = { bots: [bot()] }; f.set(next); return next; });
    f.answers.set("POST /api/channels/telegram/bots/7000000001/pairing", () => ({ link: LINK, qr: QR, expiresAt: Date.now() + 600_000 }));
    await f.mount();
    await act(async () => { fireEvent.click(screen.getByRole("checkbox", { name: "PC를 켜면 자동으로 시작" })); });
    await click("텔레그램으로 시작");
    await click("토큰을 직접 입력");
    await act(async () => { fireEvent.change(screen.getByLabelText("봇 토큰"), { target: { value: TOKEN } }); });
    await click("확인");
    expect(f.sent("PUT", "/api/host/autostart")).toEqual([]);
  });

  it("says why a token was refused, in the server's words", async () => {
    const f = fixture({ bots: [] });
    f.answers.set("POST /api/channels/telegram/bots", () => { throw new ApiRequestError(400, { code: "channel_token_invalid", message: "봇 토큰이 맞지 않습니다. BotFather가 보낸 토큰(숫자:문자)을 그대로 붙여 넣어 주세요." }); });
    await f.mount();
    await click("텔레그램으로 시작");
    await click("토큰을 직접 입력");
    await act(async () => { fireEvent.change(screen.getByLabelText("봇 토큰"), { target: { value: "123:wrong" } }); });
    await click("확인");
    expect(screen.getByRole("alert").textContent).toBe("봇 토큰이 맞지 않습니다. BotFather가 보낸 토큰(숫자:문자)을 그대로 붙여 넣어 주세요.");
    expect(screen.getByLabelText("봇 토큰")).toBeTruthy();
  });

  it("without an OS keyring: says so in one line, stores nothing in plain text, and offers to remember it for this run only", async () => {
    const f = fixture({ bots: [] });
    f.answers.set("POST /api/channels/telegram/bots", (body) => {
      if (!(body as { memoryOnly?: boolean }).memoryOnly) throw new ApiRequestError(503, { code: "office_vault_unavailable", message: "운영체제의 보안 저장소를 사용할 수 없습니다." });
      const next = { bots: [bot({ token: "memory" })] }; f.set(next); return next;
    });
    f.answers.set("POST /api/channels/telegram/bots/7000000001/pairing", () => ({ link: LINK, qr: QR, expiresAt: Date.now() + 600_000 }));
    await f.mount();
    await click("텔레그램으로 시작");
    await click("토큰을 직접 입력");
    await act(async () => { fireEvent.change(screen.getByLabelText("봇 토큰"), { target: { value: TOKEN } }); });
    await click("확인");
    expect(screen.getByRole("alert").textContent).toBe("이 PC에는 토큰을 봉인해 둘 보안 저장소(키링)가 없습니다. 토큰을 평문으로 저장하지 않습니다.");
    expect(f.sent("POST", "/api/channels/telegram/bots")).toHaveLength(1);
    await click("이번 실행 동안만 기억");
    expect(f.sent("POST", "/api/channels/telegram/bots").at(-1)!.body).toEqual({ token: TOKEN, memoryOnly: true });
    expect(screen.getByText("봇 @wb_7k3q9x_bot을 확인했습니다.")).toBeTruthy();
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });
});

describe("pairing (design §4.1 steps 7–8)", () => {
  const waiting = (request = { id: "r1", userId: "555", displayName: "길동 홍", handle: "hong", digits: "4821", at: 1, expiresAt: Date.now() + 600_000 }) =>
    ({ bots: [bot({ pairing: { expiresAt: Date.now() + 600_000, request, lockedUntil: null } })] });

  it("shows the phone's request with the four digits and connects only on 연결", async () => {
    const f = fixture({ bots: [bot()] });
    f.answers.set("POST /api/channels/telegram/bots/7000000001/pairing", () => ({ link: LINK, qr: QR, expiresAt: Date.now() + 600_000 }));
    await f.mount();
    expect(screen.getByRole("img", { name: "텔레그램 봇 연결 QR" })).toBeTruthy();
    f.set(waiting());
    await tick(2_100);
    const card = screen.getByRole("group", { name: "연결 요청" });
    expect(within(card).getByText(/텔레그램 사용자/).textContent).toBe("텔레그램 사용자 길동 홍이 연결을 요청합니다.");
    expect(within(card).getByTestId("pairing-handle").textContent).toBe("@hong");
    expect(within(card).getByTestId("pairing-number").textContent).toBe("555");
    expect(within(card).getByTestId("pairing-digits").textContent).toBe("4 8 2 1");
    expect(screen.getByText("6 / 6단계")).toBeTruthy();
    f.answers.set("POST /api/channels/telegram/bots/7000000001/pairing/r1", () => { const next = { bots: [bot({ bindings: [binding()] })] }; f.set(next); return next; });
    await click("연결");
    expect(f.sent("POST", "/api/channels/telegram/bots/7000000001/pairing/r1")).toMatchObject([{ body: { approve: true } }]);
    expect(screen.getByText("연결되었습니다. 휴대폰에서 하고 싶은 일을 적어 보내 보세요.")).toBeTruthy();
  });

  it("declines on 아니요", async () => {
    const f = fixture(waiting());
    f.answers.set("POST /api/channels/telegram/bots/7000000001/pairing", () => ({ link: LINK, qr: QR, expiresAt: Date.now() + 600_000 }));
    await f.mount();
    f.answers.set("POST /api/channels/telegram/bots/7000000001/pairing/r1", () => { const next = { bots: [bot()] }; f.set(next); return next; });
    await click("아니요");
    expect(f.sent("POST", "/api/channels/telegram/bots/7000000001/pairing/r1")).toMatchObject([{ body: { approve: false } }]);
    // A new QR at once, and no "ran out" line: the request was answered.
    await tick(2_100);
    expect(screen.getByRole("img", { name: "텔레그램 봇 연결 QR" })).toBeTruthy();
    expect(screen.queryByText("연결 요청의 시간이 지났습니다. 새 QR로 다시 하세요.")).toBeNull();
  });

  it("offers a new QR when the old one ran out", async () => {
    const f = fixture({ bots: [bot()] });
    let made = 0;
    f.answers.set("POST /api/channels/telegram/bots/7000000001/pairing", () => { made += 1; return { link: LINK, qr: QR, expiresAt: Date.now() + 1_000 }; });
    await f.mount();
    await tick(2_100);
    expect(screen.getByText("QR의 유효 시간(10분)이 지났습니다.")).toBeTruthy();
    expect(screen.queryByRole("img", { name: "텔레그램 봇 연결 QR" })).toBeNull();
    await click("새 QR 만들기");
    expect(made).toBe(2);
  });
});

describe("after registration (design §11)", () => {
  it("shows the status line and pauses and resumes with one button", async () => {
    const f = fixture({ bots: [bot({ bindings: [binding()] })] });
    await f.mount();
    expect(screen.getByTestId("channel-status").textContent).toBe("텔레그램 @wb_7k3q9x_bot · 연결됨 · 길동 홍");
    expect(screen.queryByRole("button", { name: "잠금 풀기" })).toBeNull();
    f.answers.set("PATCH /api/channels/bindings/b1", (body) => { const next = { bots: [bot({ bindings: [binding({ pausedAt: (body as { paused: boolean }).paused ? 5 : null })] })] }; f.set(next); return next; });
    await click("멈춤");
    expect(f.sent("PATCH", "/api/channels/bindings/b1")).toMatchObject([{ body: { paused: true } }]);
    expect(screen.getByTestId("channel-status").textContent).toBe("텔레그램 @wb_7k3q9x_bot · 멈춤 · 길동 홍");
    expect(screen.getByText("휴대폰에서 온 글은 실행하지 않고, 멈춰 두었다고만 답합니다.")).toBeTruthy();
    await click("다시 시작");
    expect(f.sent("PATCH", "/api/channels/bindings/b1").at(-1)!.body).toEqual({ paused: false });
  });

  it("unlocks only here, and only when the chat locked itself", async () => {
    const f = fixture({ bots: [bot({ bindings: [binding({ lockedAt: 7 })] })] });
    await f.mount();
    expect(screen.getByTestId("channel-status").textContent).toBe("텔레그램 @wb_7k3q9x_bot · 잠김 · 길동 홍");
    expect(screen.getByText("잠갔습니다. 이 PC에서만 풀 수 있습니다. 그동안 끝난 답은 풀 때 보냅니다.")).toBeTruthy();
    await click("잠금 풀기");
    expect(f.sent("PATCH", "/api/channels/bindings/b1")).toMatchObject([{ body: { locked: false } }]);
  });

  it("disconnects at once, without asking", async () => {
    const f = fixture({ bots: [bot({ bindings: [binding()] })] });
    await f.mount();
    f.answers.set("PATCH /api/channels/bindings/b1", () => { const next = { bots: [bot()] }; f.set(next); return next; });
    f.answers.set("POST /api/channels/telegram/bots/7000000001/pairing", () => ({ link: LINK, qr: QR, expiresAt: Date.now() + 600_000 }));
    await click("연결 끊기");
    expect(f.sent("PATCH", "/api/channels/bindings/b1")).toMatchObject([{ body: { revoked: true } }]);
    expect(screen.queryByRole("dialog", { name: /확인/ })).toBeNull();
    expect(screen.getByText("연결을 끊었습니다. 그 휴대폰에서 온 글은 이제 실행하지 않습니다.")).toBeTruthy();
  });

  it("names the conflict and its one thing to do, and takes a new token there", async () => {
    const conflict = "다른 PC나 프로그램이 이 봇을 쓰고 있습니다. 같은 봇을 두 곳에서 쓸 수 없습니다. 봇 토큰이 새었을 수도 있으니 [토큰 바꾸기]를 눌러 새 토큰을 넣어 주세요.";
    const f = fixture({ bots: [bot({ status: { state: "conflict", detail: conflict }, bindings: [binding()] })] });
    await f.mount();
    expect(screen.getByTestId("channel-status").textContent).toBe("텔레그램 @wb_7k3q9x_bot · 충돌 · 길동 홍");
    expect(screen.getByText(conflict)).toBeTruthy();
    f.answers.set("POST /api/channels/telegram/bots", () => { const next = { bots: [bot({ bindings: [binding()] })] }; f.set(next); return next; });
    await click("토큰 바꾸기");
    const field = screen.getByLabelText("새 봇 토큰") as HTMLInputElement;
    expect(field.value).toBe("");
    await act(async () => { fireEvent.change(field, { target: { value: TOKEN } }); });
    await click("확인");
    expect(f.sent("POST", "/api/channels/telegram/bots")).toMatchObject([{ body: { token: TOKEN } }]);
    expect(screen.queryByLabelText("새 봇 토큰")).toBeNull();
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  it("says when it is reconnecting, and when the token has to be entered again", async () => {
    const f = fixture({ bots: [bot({ status: { state: "retrying", detail: "다시 연결 중 (3번째)" }, bindings: [binding()] })] });
    await f.mount();
    expect(screen.getByTestId("channel-status").textContent).toBe("텔레그램 @wb_7k3q9x_bot · 다시 연결 중 (3번째) · 길동 홍");
    expect(screen.getByText("인터넷이 이어지면 저절로 다시 연결됩니다.")).toBeTruthy();
    f.set({ bots: [bot({ token: "none", status: { state: "stopped", detail: "토큰을 다시 넣어 주세요." }, bindings: [binding()] })] });
    await tick(2_100);
    expect(screen.getByTestId("channel-status").textContent).toBe("텔레그램 @wb_7k3q9x_bot · 꺼짐 · 길동 홍");
    expect(screen.getByText("토큰을 다시 넣어 주세요.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "토큰 바꾸기" })).toBeTruthy();
  });

  it("reads the record: names and actions, newest first", async () => {
    const audit: ChannelAuditRow[] = [
      { id: 3, at: Date.UTC(2026, 10, 12, 3, 4), bindingId: "b1", kind: "telegram", action: "lock", sessionId: null, requestId: null, target: null, result: "stopped" },
      { id: 2, at: Date.UTC(2026, 10, 12, 3, 2), bindingId: "b1", kind: "telegram", action: "request", sessionId: "s", requestId: "ch:telegram:1:1", target: null, result: "started" },
      { id: 1, at: Date.UTC(2026, 10, 12, 3, 1), bindingId: null, kind: "telegram", action: "refused", sessionId: null, requestId: null, target: "user:999", result: "stranger" },
    ];
    const f = fixture({ bots: [bot({ bindings: [binding()] })] }, { audit });
    await f.mount();
    await act(async () => { fireEvent.click(screen.getByRole("tab", { name: "기록" })); });
    const rows = screen.getAllByRole("listitem").map((row) => row.textContent);
    expect(rows[0]).toContain("길동 홍");
    expect(rows[0]).toContain("휴대폰에서 잠금 · 하던 일 멈춤");
    expect(rows[1]).toContain("요청 보냄");
    expect(rows[2]).toContain("모르는 사람");
    expect(rows[2]).toContain("거절");
    expect(screen.getByText(/2단계 인증/)).toBeTruthy();
  });

  it("keeps the autostart tick in reach after registration", async () => {
    const f = fixture({ bots: [bot({ bindings: [binding()] })] }, { autostart: { enabled: true, supported: true } });
    await f.mount();
    const tick = screen.getByRole("checkbox", { name: "PC를 켜면 자동으로 시작" }) as HTMLInputElement;
    expect(tick.checked).toBe(true);
    await act(async () => { fireEvent.click(tick); });
    expect(f.sent("PUT", "/api/host/autostart")).toMatchObject([{ body: { enabled: false } }]);
  });
});

describe("keyboard", () => {
  it("is a modal dialog whose keys never answer a conversation's approval", async () => {
    const f = fixture({ bots: [bot({ bindings: [binding()] })] });
    await f.mount();
    const conversation = document.createElement("section");
    document.body.appendChild(conversation);
    const inside = screen.getByRole("button", { name: "멈춤" });
    expect(approvalKeyApplies({ key: "Enter", target: inside, defaultPrevented: false, isComposing: false } as never, conversation)).toBe(false);
    // Not even with nothing focused: the open dialog keeps Enter and Esc from the conversation behind it.
    expect(approvalKeyApplies({ key: "Enter", target: document.body, defaultPrevented: false, isComposing: false } as never, conversation)).toBe(false);
    // The tabs move with the arrow keys.
    const tabs = screen.getByRole("tablist", { name: "휴대폰 메신저 보기" });
    await act(async () => { fireEvent.keyDown(within(tabs).getByRole("tab", { name: "연결" }), { key: "ArrowRight" }); });
    expect(screen.getByRole("tab", { name: "기록" }).getAttribute("aria-selected")).toBe("true");
    conversation.remove();
  });
});

describe("lines about what was just done", () => {
  it("go after ten seconds, so they never stand under a later state", async () => {
    const f = fixture({ bots: [bot({ bindings: [binding({ lockedAt: 7 })] })] });
    await f.mount();
    f.answers.set("PATCH /api/channels/bindings/b1", () => { const next = { bots: [bot({ bindings: [binding()] })] }; f.set(next); return next; });
    await click("잠금 풀기");
    expect(screen.getByText("잠금을 풀었습니다.")).toBeTruthy();
    await tick(10_100);
    expect(screen.queryByText("잠금을 풀었습니다.")).toBeNull();
  });

  it("shows record times on a 24-hour clock, so they fit one line", async () => {
    const at = new Date(2026, 10, 12, 22, 58).getTime();
    const f = fixture({ bots: [bot({ bindings: [binding()] })] }, { audit: [{ id: 1, at, bindingId: null, kind: "telegram", action: "token.replaced", sessionId: null, requestId: null, target: null, result: null }] });
    await f.mount();
    await act(async () => { fireEvent.click(screen.getByRole("tab", { name: "기록" })); });
    expect(screen.getByRole("listitem").querySelector("time")!.textContent).toBe("22:58");
  });
});

describe("fix round 1", () => {
  const request = (extra: Partial<{ id: string; userId: string; displayName: string; handle: string | null; digits: string }> = {}) =>
    ({ id: "r1", userId: "555", displayName: "길동 홍", handle: "hong" as string | null, digits: "4821", at: 1, expiresAt: Date.now() + 600_000, ...extra });
  const pairingState = (extra: Partial<ChannelBot["pairing"]> = {}) => ({ bots: [bot({ pairing: { expiresAt: null, request: null, lockedUntil: null, ...extra } })] });

  it("names the account by number and handle, isolates the name's direction, announces the request and puts the focus on its text", async () => {
    const f = fixture({ bots: [bot()] });
    f.answers.set("POST /api/channels/telegram/bots/7000000001/pairing", () => ({ link: LINK, qr: QR, expiresAt: Date.now() + 600_000 }));
    await f.mount();
    f.set(pairingState({ request: request({ displayName: "\u202e악성 이름", handle: null, userId: "123456789" }) }));
    await tick(2_100);
    const card = screen.getByRole("group", { name: "연결 요청" });
    expect(card.closest("[aria-live]")).toBeTruthy();
    expect(card.querySelector("bdi")!.textContent).toBe("\u202e악성 이름");
    expect(within(card).getByTestId("pairing-number").textContent).toBe("123456789");
    expect(within(card).getByTestId("pairing-handle").textContent).toBe("사용자명 없음");
    expect(within(card).getByText(/숫자/, { selector: ".pm-hint" }).textContent).toContain("이름이 아니라 네 숫자");
    expect(document.activeElement).toBe(within(card).getByText(/텔레그램 사용자/));
    expect(within(card).getByTestId("pairing-digits").getAttribute("aria-label")).toBeNull();
  });

  it("makes no new QR while a phone's request waits", async () => {
    const f = fixture(pairingState({ request: request() }));
    await f.mount();
    await tick(4_100);
    expect(f.sent("POST", "/api/channels/telegram/bots/7000000001/pairing")).toEqual([]);
  });

  it("approves the request on screen now, not the first one it saw", async () => {
    const f = fixture(pairingState({ request: request({ id: "first" }) }));
    await f.mount();
    f.set(pairingState({ request: request({ id: "second", userId: "777", displayName: "다른 사람", digits: "1234" }) }));
    await tick(2_100);
    await click("연결");
    expect(f.calls.filter((call) => call.method === "POST" && call.path.includes("/pairing/")).map((call) => call.path)).toEqual(["/api/channels/telegram/bots/7000000001/pairing/second"]);
  });

  it("says a request ran out when it goes without an answer", async () => {
    const f = fixture(pairingState({ request: request() }));
    f.answers.set("POST /api/channels/telegram/bots/7000000001/pairing", () => ({ link: LINK, qr: QR, expiresAt: Date.now() + 600_000 }));
    await f.mount();
    f.set(pairingState());
    await tick(2_100);
    expect(screen.getByText("연결 요청의 시간이 지났습니다. 새 QR로 다시 하세요.")).toBeTruthy();
  });

  it("shows a contested scan's notice and starts again on request", async () => {
    const notice = "두 계정이 같은 연결 값을 냈습니다. 다른 사람이 화면의 QR을 보았을 수 있습니다. 화면을 가리고(화면 공유·프로젝터를 끄고) 다시 시작해 주세요.";
    const f = fixture(pairingState({ notice }));
    let made = 0;
    f.answers.set("POST /api/channels/telegram/bots/7000000001/pairing", () => { made += 1; f.set(pairingState()); return { link: LINK, qr: QR, expiresAt: Date.now() + 600_000 }; });
    await f.mount();
    expect(screen.getByRole("alert").textContent).toBe(notice);
    expect(screen.queryByRole("img", { name: "텔레그램 봇 연결 QR" })).toBeNull();
    expect(made).toBe(0);
    await click("다시 시작");
    expect(made).toBe(1);
    expect(screen.getByRole("img", { name: "텔레그램 봇 연결 QR" })).toBeTruthy();
  });

  it("lists the accounts refused for wrong values, with until when", async () => {
    const until = Date.now() + 45 * 60_000;
    const shown = new Date(until).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    const f = fixture(pairingState({ refusedSenders: [{ userId: "999", displayName: "남", handle: "stranger", until }] }));
    f.answers.set("POST /api/channels/telegram/bots/7000000001/pairing", () => ({ link: LINK, qr: QR, expiresAt: Date.now() + 600_000 }));
    await f.mount();
    expect(screen.getByTestId("refused-senders").textContent).toContain(`남 · @stranger · 번호 999 · ${shown}까지`);
  });

  it("offers this PC's Telegram app and the browser as two choices when the camera cannot read the QR, never writing the link on the screen", async () => {
    const f = fixture({ bots: [bot()] });
    f.answers.set("POST /api/channels/telegram/bots/7000000001/pairing", () => ({ link: LINK, qr: QR, expiresAt: Date.now() + 600_000 }));
    await f.mount();
    await click("텔레그램 앱으로 열기");
    expect(f.openExternal).toHaveBeenLastCalledWith(`tg://resolve?domain=wb_7k3q9x_bot&start=${START}`);
    await click("브라우저로 열기");
    expect(f.openExternal).toHaveBeenLastCalledWith(LINK);
    expect(document.body.innerHTML).not.toContain(START);
  });

  it("says so when the Telegram app could not be opened, and points to the browser", async () => {
    const f = fixture({ bots: [bot()] });
    f.answers.set("POST /api/channels/telegram/bots/7000000001/pairing", () => ({ link: LINK, qr: QR, expiresAt: Date.now() + 600_000 }));
    await f.mount();
    f.openExternal.mockRejectedValueOnce(new Error("no handler"));
    await click("텔레그램 앱으로 열기");
    expect(screen.getByText("이 PC에서 텔레그램 앱을 열지 못했습니다. [브라우저로 열기]를 써 보세요.")).toBeTruthy();
  });

  it("keeps the countdown out of every live region, and states the expiry once in words", async () => {
    const f = fixture({ bots: [bot()] });
    const expiresAt = Date.now() + 600_000;
    f.answers.set("POST /api/channels/telegram/bots/7000000001/pairing", () => ({ link: LINK, qr: QR, expiresAt }));
    await f.mount();
    const countdown = screen.getByTestId("pairing-countdown");
    expect(countdown.closest("[aria-live]")).toBeNull();
    expect(countdown.getAttribute("aria-hidden")).toBe("true");
    const until = new Date(expiresAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    expect(screen.getByText(`${until}까지 쓸 수 있는 한 번만 쓰는 QR입니다.`).closest("[aria-live]")).toBeNull();
    for (const live of document.querySelectorAll("[aria-live]")) expect(live.textContent).not.toMatch(/\d+:\d{2} 남음/);
  });

  it("puts the contested notice and the ran-out line in a live region", async () => {
    const notice = "두 계정이 같은 연결 값을 냈습니다. 다시 시작해 주세요.";
    const f = fixture(pairingState({ notice }));
    await f.mount();
    expect(screen.getByRole("alert").closest("[aria-live]")).toBeTruthy();
    f.set(pairingState({ request: request() }));
    await tick(2_100);
    f.set(pairingState());
    await tick(2_100);
    expect(screen.getByText("연결 요청의 시간이 지났습니다. 새 QR로 다시 하세요.").closest("[aria-live]")).toBeTruthy();
  });

  it("cancels the unscanned one-time value at the gateway when the dialog closes", async () => {
    const f = fixture({ bots: [bot()] });
    f.answers.set("POST /api/channels/telegram/bots/7000000001/pairing", () => ({ link: LINK, qr: QR, expiresAt: Date.now() + 600_000 }));
    await f.mount();
    expect(screen.getByRole("img", { name: "텔레그램 봇 연결 QR" })).toBeTruthy();
    await act(async () => { cleanup(); });
    expect(f.sent("DELETE", "/api/channels/telegram/bots/7000000001/pairing")).toHaveLength(1);
  });

  it("does not cancel anything when the dialog closes while a phone's request waits", async () => {
    const f = fixture(pairingState({ request: request() }));
    await f.mount();
    await act(async () => { cleanup(); });
    expect(f.sent("DELETE", "/api/channels/telegram/bots/7000000001/pairing")).toEqual([]);
  });

  it("[잠금 풀기] is offered only while locked, also when paused at the same time", async () => {
    const f = fixture({ bots: [bot({ bindings: [binding({ pausedAt: 5 })] })] });
    await f.mount();
    expect(screen.queryByRole("button", { name: "잠금 풀기" })).toBeNull();
    f.set({ bots: [bot({ bindings: [binding({ pausedAt: 5, lockedAt: 6 })] })] });
    await tick(2_100);
    expect(screen.getByRole("button", { name: "잠금 풀기" })).toBeTruthy();
  });

  it("locks from the PC with [잠금], beside [멈춤]; locked, it offers only the unlock", async () => {
    const f = fixture({ bots: [bot({ bindings: [binding()] })] });
    f.answers.set("PATCH /api/channels/bindings/b1", () => { const next = { bots: [bot({ bindings: [binding({ lockedAt: 9 })] })] }; f.set(next); return next; });
    await f.mount();
    await click("잠금");
    expect(f.sent("PATCH", "/api/channels/bindings/b1")).toMatchObject([{ body: { locked: true } }]);
    expect(screen.queryByRole("button", { name: "잠금" })).toBeNull();
    expect(screen.getByRole("button", { name: "잠금 풀기" })).toBeTruthy();
  });

  it("says on the status line when answers could not be delivered, or may not have been, with when and why", async () => {
    const at = new Date(2026, 10, 12, 21, 5).getTime();
    const f = fixture({ bots: [bot({ bindings: [binding({ undelivered: { count: 2, at, reason: "텔레그램이 답을 받지 않았습니다(봇을 차단했을 수 있습니다)." }, uncertain: { count: 1, at } })] })] });
    await f.mount();
    expect(screen.getByTestId("channel-undelivered").textContent).toBe("전하지 못한 답 2개 · 21:05 · 텔레그램이 답을 받지 않았습니다(봇을 차단했을 수 있습니다).");
    expect(screen.getByTestId("channel-uncertain").textContent).toBe("전달됐는지 확인하지 못한 답 1개 · 21:05 · 다시 보내지는 않습니다. 대화는 PC에 있습니다.");
  });

  it("reads the new record lines, puts PC actions on PC, and keeps the name of a disconnected chat", async () => {
    const row = (id: number, action: string, extra: Partial<ChannelAuditRow> = {}): ChannelAuditRow => ({ id, at: Date.UTC(2026, 10, 12, 3, id), bindingId: "gone", kind: "telegram", action, sessionId: null, requestId: null, target: null, result: null, ...extra });
    const audit = [
      row(6, "send.refused", { target: "final", result: "403" }),
      row(5, "answer.discarded"),
      row(4, "lock", { target: "pc", result: "stopped" }),
      row(3, "pause"),
      row(2, "pairing.contested", { bindingId: null, target: "user:555", result: "user:666" }),
      row(1, "pairing.sender_locked", { bindingId: null, target: "user:999" }),
    ];
    const f = fixture({ bots: [bot()] }, { audit });
    f.answers.set("GET /api/channels/audit", () => ({ rows: audit, names: { gone: "예전 휴대폰" } }));
    f.answers.set("POST /api/channels/telegram/bots/7000000001/pairing", () => ({ link: LINK, qr: QR, expiresAt: Date.now() + 600_000 }));
    await f.mount();
    await act(async () => { fireEvent.click(screen.getByRole("tab", { name: "기록" })); });
    const rows = screen.getAllByRole("listitem").map((item) => item.textContent ?? "");
    expect(rows[0]).toContain("예전 휴대폰");
    expect(rows[0]).toContain("답을 전하지 못함");
    expect(rows[1]).toContain("PC가 끊어 보내지 않은 답");
    expect(rows[2]).toMatch(/PC.*PC에서 잠금 · 하던 일 멈춤/);
    expect(rows[3]).toMatch(/PC.*PC에서 멈춤/);
    expect(rows[4]).toContain("연결 취소 · 두 계정이 같은 값을 냄");
    expect(rows[5]).toContain("잘못된 값이 많아 한 시간 거절");
  });

  it("reads what the chat did through its menu, in words", async () => {
    const row = (id: number, action: string, extra: Partial<ChannelAuditRow> = {}): ChannelAuditRow => ({ id, at: Date.UTC(2026, 10, 12, 3, id), bindingId: "b1", kind: "telegram", action, sessionId: null, requestId: null, target: null, result: null, ...extra });
    const audit = [
      row(16, "schedule.disabled", { result: "2" }),
      row(15, "schedule.enabled", { result: "1" }),
      row(14, "refused", { result: "queue.archived" }),
      row(13, "access", { result: "ask" }),
      row(12, "access", { result: "full" }),
      row(11, "pointer", { target: "document" }),
      row(10, "pointer"),
      row(9, "engine", { result: "codex" }),
      row(8, "model", { result: "sonnet" }),
      row(7, "queue.send", { result: "steered" }),
      row(6, "queue.drop"),
      row(5, "note.entry", { result: "question" }),
      row(4, "note.conflict"),
      row(3, "schedule", { result: "daily" }),
      row(2, "notify", { result: "on" }),
      row(1, "work.created"),
    ];
    const f = fixture({ bots: [bot({ bindings: [binding()] })] }, { audit });
    f.answers.set("GET /api/channels/audit", () => ({ rows: audit, names: {} }));
    await f.mount();
    await act(async () => { fireEvent.click(screen.getByRole("tab", { name: "기록" })); });
    const rows = screen.getAllByRole("listitem").map((item) => item.textContent ?? "");
    expect(rows.shift()).toContain("이 채팅의 예약 2개 끔");
    expect(rows.shift()).toContain("예약 1개 다시 켬");
    expect(rows.shift()).toContain("거절 · 대기 요청을 보내지 못함");
    expect(rows[0]).toContain("접근 모드 · 묻기");
    expect(rows[1]).toContain("접근 모드 · 전체 접근");
    expect(rows[2]).toContain("문서 AI로 옮김");
    expect(rows[3]).toContain("대화 바꿈");
    expect(rows[4]).toContain("엔진 바꿈 · Codex 새 대화");
    expect(rows[5]).toContain("모델 바꿈");
    expect(rows[6]).toContain("대기 요청 지금 보냄");
    expect(rows[7]).toContain("대기 요청 뺌");
    expect(rows[8]).toContain("노트에 열린 질문 적음");
    expect(rows[9]).toContain("노트가 바뀌어 적지 않음");
    expect(rows[10]).toContain("예약 만듦");
    expect(rows[11]).toContain("알림 켬");
    expect(rows[12]).toContain("새 프로젝트 만듦");
  });

  it("reads the files that came and went, and those kept back", async () => {
    const row = (id: number, action: string, extra: Partial<ChannelAuditRow> = {}): ChannelAuditRow => ({ id, at: Date.UTC(2026, 10, 12, 3, id), bindingId: "b1", kind: "telegram", action, sessionId: null, requestId: null, target: null, result: null, ...extra });
    const audit = [row(4, "file.unsent", { result: "1" }), row(3, "file.blocked", { result: "2" }), row(2, "file.sent", { result: "3" }), row(1, "file.received", { result: "1" })];
    const f = fixture({ bots: [bot({ bindings: [binding()] })] }, { audit });
    f.answers.set("GET /api/channels/audit", () => ({ rows: audit, names: {} }));
    await f.mount();
    await act(async () => { fireEvent.click(screen.getByRole("tab", { name: "기록" })); });
    const rows = screen.getAllByRole("listitem").map((item) => item.textContent ?? "");
    expect(rows.shift()).toContain("답과 함께 가지 못한 파일 1개");
    expect(rows[0]).toContain("비밀이 있을 수 있는 파일 2개를 보내지 않음");
    expect(rows[1]).toContain("파일 3개 보냄");
    expect(rows[2]).toContain("파일 1개 받음");
  });

  it("removes the bot in two steps, saying what stays at Telegram", async () => {
    const f = fixture({ bots: [bot({ bindings: [binding()] })] });
    await f.mount();
    await click("봇 등록 지우기");
    expect(f.sent("DELETE", "/api/channels/telegram/bots/7000000001")).toEqual([]);
    expect(screen.getByText("이 PC에서 봇 등록을 지웁니다. 휴대폰 연결도 끊어지고, 다시 쓰려면 토큰을 넣고 다시 연결해야 합니다. 봇과 토큰은 텔레그램에 그대로 남습니다(끝내려면 BotFather에서 토큰을 폐기하세요).")).toBeTruthy();
    await click("취소");
    expect(screen.getByRole("button", { name: "봇 등록 지우기" })).toBeTruthy();
    await click("봇 등록 지우기");
    f.answers.set("DELETE /api/channels/telegram/bots/7000000001", () => { const next = { bots: [] }; f.set(next); return next; });
    await click("지우기");
    expect(f.sent("DELETE", "/api/channels/telegram/bots/7000000001")).toHaveLength(1);
  });

  it("offers the removal also where the 409 sends the person: in conflict and without a token", async () => {
    const f = fixture({ bots: [bot({ token: "none", status: { state: "stopped", detail: "토큰을 다시 넣어 주세요." }, bindings: [binding()] })] });
    await f.mount();
    expect(screen.getByRole("button", { name: "봇 등록 지우기" })).toBeTruthy();
  });

  it("puts a token error next to the field it is about", async () => {
    const f = fixture({ bots: [bot({ bindings: [binding()] })] });
    f.answers.set("POST /api/channels/telegram/bots", () => { throw new ApiRequestError(409, { code: "channel_bot_exists", message: "이미 등록한 봇이 있습니다. 다른 봇을 쓰려면 먼저 지금 봇을 지워 주세요." }); });
    await f.mount();
    await click("토큰 바꾸기");
    await act(async () => { fireEvent.change(screen.getByLabelText("새 봇 토큰"), { target: { value: TOKEN } }); });
    await click("확인");
    expect(screen.getByRole("alert").closest("form")).toBe(screen.getByLabelText("새 봇 토큰").closest("form"));
  });
});
