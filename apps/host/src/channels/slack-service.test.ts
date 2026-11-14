import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChannelPairingLink, ChannelsState } from "@workbench/contracts";
import { EventBus } from "../bus.ts";
import { HttpError } from "../errors.ts";
import { sendJson } from "../http.ts";
import { OfficeVault, nativeOfficeVault } from "../office-vault.ts";
import { SessionManager } from "../sessions.ts";
import { Store } from "../store.ts";
import { FAKE_TOKEN, FakeTelegram } from "./fake-telegram.ts";
import { FAKE_APP_TOKEN, FAKE_BOT_TOKEN, FakeSlack } from "./fake-slack.ts";
import { CredentialService } from "../credentials/service.ts";
import { LoginFiller } from "../credentials/fill.ts";
import type { DaemonArgs, DaemonAnswer, HostPage } from "../browse-host.ts";
import { installScrubber } from "../credentials/install.ts";
import { formsOf } from "../credentials/forms.ts";
import { gatewayChannels } from "./gateway.ts";
import { ChannelService } from "./service.ts";
import { StandInEngine, until } from "./test-kit.ts";

// The Slack branch of the channel as the PC screen uses it: over HTTP, with a stand-in Slack (Web
// API + Socket Mode) and a stand-in Bot API on loopback, a stand-in keyring and a stand-in engine.
// The conversation goes through the same core as Telegram's. No test here reaches Slack.

type Rig = Awaited<ReturnType<typeof rig>>;
const rigs: { stop(): Promise<void> }[] = [];
afterEach(async () => { for (const entry of rigs.splice(0)) await entry.stop(); });

/** Unit 9: a login page as the daemon sees it (as in login-chat.test.ts): what was typed, pressed, opened. */
function loginPage(url: string) {
  const state = { url, typed: [] as [string, string][], pressed: [] as string[], went: [] as string[], elements: { e4: { tag: "input", type: "text" }, e6: { tag: "input", type: "password" }, e7: { tag: "button", type: "submit" } } as Record<string, { tag: string; type: string }> };
  const page: HostPage = {
    typed: () => undefined, forget: () => undefined, live: () => false, hide: (text) => text,
    run: async (args: DaemonArgs): Promise<DaemonAnswer> => {
      const [command, first, second] = args._;
      if (command === "eval") {
        if (second) { const element = state.elements[second]; return element ? { error: false, text: JSON.stringify(JSON.stringify({ ...element, frame: state.url })) } : { error: true, text: "Ref not found" }; }
        if (first!.includes("location.href")) return { error: false, text: JSON.stringify(state.url) };
        if (first!.includes("document.title")) return { error: false, text: JSON.stringify("로그인") };
        if (first!.includes("innerText")) return { error: false, text: JSON.stringify(JSON.stringify({ values: [], text: "로그인", blind: 0 })) };
      }
      if (command === "fill") { state.typed.push([first!, second!]); return { error: false, text: "" }; }
      if (command === "click") { state.pressed.push(first!); return { error: false, text: "" }; }
      if (command === "goto") { state.went.push(first!); return { error: false, text: "" }; }
      if (command === "screenshot") { writeFileSync(String(args.filename), Buffer.from("89504e470d0a1a0a", "hex")); return { error: false, text: "" }; }
      return { error: true, text: "unknown" };
    },
  };
  return { page, state };
}
const LOGIN_PAGE = loginPage("https://lib.example.ac.kr/login");

async function open(dir: string, slack: FakeSlack, telegram: FakeTelegram, keyring: boolean, withCredentials = false) {
  const dataDir = join(dir, "data");
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(join(dataDir, "state.sqlite"));
  const bus = new EventBus();
  const manager = new SessionManager(store, bus, { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dataDir, "works"), dataDir });
  const engine = new StandInEngine(() => manager.sink);
  manager.registerAdapter(engine);
  const vault = keyring
    ? new OfficeVault(dataDir, async () => ({ id: "d".repeat(32), key: Buffer.alloc(32, 5) }))
    : new OfficeVault(dataDir, nativeOfficeVault(dataDir, "/missing-workbench-secret-binary"));
  // The credential store of units 7–8, as the gateway wires it (its in-chat input on: `store` is passed).
  const credentials = withCredentials ? new CredentialService({ dataDir, vault, manager }) : undefined;
  if (credentials) installScrubber(store, manager, credentials.scrubber);
  const logins = credentials ? new LoginFiller({ service: credentials, dataDir, page: () => LOGIN_PAGE.page }) : undefined;
  logins?.install();
  const service = new ChannelService({ dataDir, store, manager, bus, vault, ...(credentials ? { credentials } : {}), ...(logins ? { logins } : {}), telegramUrl: telegram.url, telegram: { pollSeconds: 1, minSendGapMs: 0 }, slackUrl: slack.api, slack: { minSendGapMs: 0, pingMs: 5_000 } });
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    service.handleManagement(req, res, url).then((handled) => { if (!handled) sendJson(res, 404, { code: "not_found", message: "" }); })
      .catch((error: unknown) => sendJson(res, error instanceof HttpError ? error.status : 500, { code: error instanceof HttpError ? error.code : "error", message: error instanceof Error ? error.message : "" }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${origin}${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, text, json: (text ? JSON.parse(text) : null) as Record<string, unknown> };
  };
  await service.start();
  const close = async () => {
    await service.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await manager.shutdown();
    store.close();
  };
  return { dataDir, store, bus, manager, engine, service, credentials, api, close };
}

async function rig(options: { keyring?: boolean; credentials?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wb-slack-service-"));
  const fake = new FakeSlack();
  const telegram = new FakeTelegram();
  await fake.start();
  await telegram.start();
  let gateway = await open(dir, fake, telegram, options.keyring !== false, options.credentials === true);
  let running = true;
  const down = async () => { if (running) { running = false; await gateway.close(); } };
  const entry = {
    dir, fake, telegram,
    get g() { return gateway; },
    async restart() { await down(); gateway = await open(dir, fake, telegram, options.keyring !== false, options.credentials === true); running = true; },
    async stop() { await down(); await fake.stop(); await telegram.stop(); rmSync(dir, { recursive: true, force: true }); },
    state: async () => (await gateway.api("GET", "/api/channels")).json as unknown as ChannelsState,
  };
  rigs.push(entry);
  return entry;
}
function everything(dir: string): string {
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => readFileSync(join(entry.parentPath, entry.name), "latin1")).join("\n");
}
const base = (r: Rig) => `/api/channels/slack/bots/${r.fake.botId}`;
async function register(r: Rig) {
  const response = await r.g.api("POST", "/api/channels/slack/bots", { botToken: FAKE_BOT_TOKEN, appToken: FAKE_APP_TOKEN });
  expect(response.status).toBe(200);
  await until(async () => (await r.state()).bots[0]?.status.state === "connected");
  return response;
}
/** Pair the stand-in person (U0HONG) through the routes the PC screen uses: the PC gives the line, the person sends it in the DM, the PC approves. */
async function pair(r: Rig) {
  const started = (await r.g.api("POST", `${base(r)}/pairing`, {})).json as unknown as ChannelPairingLink;
  r.fake.message(started.say!);
  await until(async () => Boolean((await r.state()).bots[0]?.pairing.request));
  const request = (await r.state()).bots[0]!.pairing.request!;
  expect((await r.g.api("POST", `${base(r)}/pairing/${request.id}`, { approve: true })).status).toBe(200);
  await until(() => r.fake.texts().some((text) => text.startsWith("연결되었습니다")));
  return { started, request };
}
const answered = (r: Rig, match: (text: string) => boolean, channel = "D0HONG") => until(() => r.fake.texts(channel).some(match));

describe("registering a Slack app", () => {
  it("keeps the app's name as typed in the wizard (cleaned, at most 35 characters); new tokens keep it", async () => {
    const r = await rig();
    const first = await r.g.api("POST", "/api/channels/slack/bots", { botToken: FAKE_BOT_TOKEN, appToken: FAKE_APP_TOKEN, appName: "  Workbench · 연구실\u0007 PC  " });
    expect(first.status).toBe(200);
    expect((await r.state()).bots[0]!.appName).toBe("Workbench · 연구실 PC");
    await r.g.api("POST", "/api/channels/slack/bots", { botToken: FAKE_BOT_TOKEN, appToken: FAKE_APP_TOKEN });
    expect((await r.state()).bots[0]!.appName).toBe("Workbench · 연구실 PC");
  });

  it("does nothing at all before a Slack app is registered: no call, no socket", async () => {
    const r = await rig();
    await new Promise((done) => setTimeout(done, 100));
    expect(r.fake.calls).toHaveLength(0);
    expect(r.fake.maxOpen).toBe(0);
    expect(r.g.store.getMeta("channel.slack")).toBeNull();
  });

  it("checks both tokens, seals them apart, connects one socket, and never gives either back", async () => {
    const r = await rig();
    const response = await register(r);
    const state = response.json as unknown as ChannelsState;
    expect(state.bots).toMatchObject([{ kind: "slack", id: "B0FAKEBOT01", username: "workbench", name: "연구실", token: "sealed", bindings: [] }]);
    for (const text of [response.text, (await r.g.api("GET", "/api/channels")).text]) {
      expect(text).not.toContain(FAKE_BOT_TOKEN);
      expect(text).not.toContain(FAKE_APP_TOKEN);
    }
    const sealed = JSON.parse(readFileSync(join(r.g.dataDir, "channels", "bots.json"), "utf8")) as { tokens: Record<string, string> };
    expect(Object.keys(sealed.tokens).sort()).toEqual(["slack:B0FAKEBOT01:app", "slack:B0FAKEBOT01:bot"]);
    expect(Object.values(sealed.tokens).every((value) => value.startsWith("sealed:v1:"))).toBe(true);
    const disk = everything(r.g.dataDir);
    expect(disk).not.toContain(FAKE_BOT_TOKEN);
    expect(disk).not.toContain(FAKE_APP_TOKEN);
    expect(r.fake.open()).toBe(1);
    // An older gateway reads `channel.bots` as Telegram bots: the Slack app is not there.
    expect(JSON.parse(r.g.store.getMeta("channel.bots") ?? "[]")).toEqual([]);
    expect(JSON.parse(r.g.store.getMeta("channel.slack")!)).toMatchObject([{ kind: "slack", id: "B0FAKEBOT01", teamId: "T0FAKETEAM1", userId: "U0FAKEBOT01" }]);
  });

  it("refuses wrong tokens with a reason and keeps nothing", async () => {
    const r = await rig();
    expect(await r.g.api("POST", "/api/channels/slack/bots", { botToken: FAKE_APP_TOKEN, appToken: FAKE_BOT_TOKEN })).toMatchObject({ status: 400, json: { code: "channel_token_swapped" } });
    const wrong = await r.g.api("POST", "/api/channels/slack/bots", { botToken: FAKE_BOT_TOKEN, appToken: `${FAKE_APP_TOKEN}9` });
    expect(wrong).toMatchObject({ status: 400, json: { code: "channel_app_token_invalid" } });
    expect(wrong.text).not.toContain(FAKE_APP_TOKEN);
    expect(await r.g.api("POST", "/api/channels/slack/bots", { botToken: FAKE_BOT_TOKEN })).toMatchObject({ status: 400 });
    expect(await r.state()).toEqual({ bots: [] });
    expect(existsSync(join(r.g.dataDir, "channels", "bots.json"))).toBe(false);
  });

  it("without an OS keyring stores neither token; both can be kept for this run only", async () => {
    const r = await rig({ keyring: false });
    expect(await r.g.api("POST", "/api/channels/slack/bots", { botToken: FAKE_BOT_TOKEN, appToken: FAKE_APP_TOKEN })).toMatchObject({ status: 503, json: { code: "office_vault_unavailable" } });
    expect(await r.state()).toEqual({ bots: [] });
    const kept = await r.g.api("POST", "/api/channels/slack/bots", { botToken: FAKE_BOT_TOKEN, appToken: FAKE_APP_TOKEN, memoryOnly: true });
    expect((kept.json as unknown as ChannelsState).bots[0]).toMatchObject({ kind: "slack", token: "memory" });
    await until(async () => (await r.state()).bots[0]!.status.state === "connected");
    expect(everything(r.g.dataDir)).not.toContain(FAKE_BOT_TOKEN);
    expect(everything(r.g.dataDir)).not.toContain(FAKE_APP_TOKEN);
  });

  it("one messenger at a time: Slack is refused while a Telegram bot is registered, and Telegram while a Slack app is", async () => {
    const r = await rig();
    expect((await r.g.api("POST", "/api/channels/telegram/bots", { token: FAKE_TOKEN })).status).toBe(200);
    expect(await r.g.api("POST", "/api/channels/slack/bots", { botToken: FAKE_BOT_TOKEN, appToken: FAKE_APP_TOKEN })).toMatchObject({ status: 409, json: { code: "channel_bot_exists" } });
    expect((await r.g.api("DELETE", `/api/channels/telegram/bots/${r.telegram.botId}`)).status).toBe(200);
    await register(r);
    expect(await r.g.api("POST", "/api/channels/telegram/bots", { token: FAKE_TOKEN })).toMatchObject({ status: 409, json: { code: "channel_bot_exists" } });
  });

  it("removing the app disconnects its chat, forgets both tokens and closes the socket", async () => {
    const r = await rig();
    await register(r);
    await pair(r);
    expect((await r.g.api("DELETE", base(r))).status).toBe(200);
    await until(() => r.fake.open() === 0);
    expect(await r.state()).toEqual({ bots: [] });
    expect(JSON.parse(readFileSync(join(r.g.dataDir, "channels", "bots.json"), "utf8")).tokens).toEqual({});
    const calls = r.fake.calls.length;
    r.fake.message("아직 거기 있나요");
    await new Promise((done) => setTimeout(done, 100));
    expect(r.fake.calls.length).toBe(calls);
  });

  it("a stand-in Slack is accepted from the environment only on this machine", () => {
    const deps = { dataDir: "/nonexistent", store: {} as Store, manager: { channelGate: null } as unknown as SessionManager, bus: new EventBus() };
    expect(gatewayChannels({ WORKBENCH_SLACK_API: "http://127.0.0.1:9/x" }, deps)!.slackApi).toBe("http://127.0.0.1:9/api");
    expect(gatewayChannels({ WORKBENCH_SLACK_API: "https://slack.example.org" }, deps)!.slackApi).toBe("https://slack.com/api");
    expect(gatewayChannels({}, deps)!.slackApi).toBe("https://slack.com/api");
  });
});

describe("pairing on Slack", () => {
  it("gives the line to send once (no picture), takes it from the DM, shows four digits on both, and the PC approves", async () => {
    const r = await rig();
    await register(r);
    const started = (await r.g.api("POST", `${base(r)}/pairing`, {})).json as unknown as ChannelPairingLink;
    expect(started).toMatchObject({ link: "", qr: "", open: "https://app.slack.com/client/T0FAKETEAM1" });
    expect(started.say).toMatch(/^연결 [A-Za-z0-9_-]{22}$/);
    const code = started.say!.split(" ")[1]!;
    expect((await r.g.api("GET", "/api/channels")).text).not.toContain(code);
    r.fake.message(started.say!);
    await until(async () => Boolean((await r.state()).bots[0]?.pairing.request));
    const request = (await r.state()).bots[0]!.pairing.request!;
    expect(request).toMatchObject({ userId: "U0HONG", displayName: "길동 (홍길동)", handle: "hong" });
    expect(r.fake.texts().at(-1)).toBe(`PC 화면에 같은 숫자가 보이면 PC에서 [연결]을 눌러 주세요: ${request.digits.split("").join(" ")}`);
    await r.g.api("POST", `${base(r)}/pairing/${request.id}`, { approve: true });
    await answered(r, (text) => text.startsWith("연결되었습니다"));
    expect((await r.state()).bots[0]!.bindings).toMatchObject([{ kind: "slack", chatId: "D0HONG", userId: "U0HONG", displayName: "길동 (홍길동)" }]);
    // The one-time value is in no file of the data folder (the inbox kept the bare command).
    expect(everything(r.g.dataDir)).not.toContain(code);
  });

  it("default deny: a stranger's DM runs nothing and is told once a day; a channel is refused", async () => {
    const r = await rig();
    await register(r);
    await pair(r);
    r.fake.message("내 일 해 줘", { user: "U0KIM" });
    r.fake.message("또", { user: "U0KIM" });
    await answered(r, (text) => text === "이 앱은 개인용입니다.", "D0KIM");
    await new Promise((done) => setTimeout(done, 100));
    expect(r.fake.texts("D0KIM")).toEqual(["이 앱은 개인용입니다."]);
    r.fake.message("채널에서 시킴", { channel: "C0ROOM", channelType: "channel" });
    await until(async () => (await r.g.api("GET", "/api/channels/audit")).text.includes("group"));
    expect(r.g.engine.asked).toBe(0);
    expect(r.fake.texts("C0ROOM")).toEqual([]);
  });
});

describe("pairing by the bare word (ruling of fix round 1)", () => {
  const request = async (r: Rig) => (await r.state()).bots[0]!.pairing.request;

  it("while the PC's window is open, a DM of just 연결 starts the request: four digits in the DM and on the PC, the PC approves", async () => {
    const r = await rig();
    await register(r);
    // Outside a window, the word is the private line, and never a wrong try.
    r.fake.message("연결");
    await answered(r, (text) => text === "이 앱은 개인용입니다.");
    expect((await r.state()).bots[0]!.pairing.refusedSenders ?? []).toEqual([]);
    await r.g.api("POST", `${base(r)}/pairing`, {});
    r.fake.message("연결.");
    await until(async () => Boolean(await request(r)));
    const waiting = (await request(r))!;
    expect(waiting).toMatchObject({ userId: "U0HONG", displayName: "길동 (홍길동)" });
    await answered(r, (text) => text.endsWith(waiting.digits.split("").join(" ")));
    await r.g.api("POST", `${base(r)}/pairing/${waiting.id}`, { approve: true });
    await answered(r, (text) => text.startsWith("연결되었습니다"));
    expect((await r.state()).bots[0]!.bindings).toMatchObject([{ userId: "U0HONG" }]);
  });

  const FIRST = "다른 사람이 먼저 요청했습니다. PC에서 그 요청을 거절한 뒤 다시 보내 주세요.";

  it("while one request waits, another account's bare 연결 or long line cancels nothing: it is told someone asked first, and the PC's card names it", async () => {
    const r = await rig();
    await register(r);
    const started = (await r.g.api("POST", `${base(r)}/pairing`, {})).json as unknown as ChannelPairingLink;
    r.fake.message("연결", { user: "U0KIM" });
    await until(async () => (await request(r))?.userId === "U0KIM");
    const first = (await request(r))!;
    r.fake.message("연결");
    await answered(r, (text) => text === FIRST);
    r.fake.message(started.say!);
    await until(() => r.fake.texts("D0HONG").filter((text) => text === FIRST).length === 2);
    expect(await request(r)).toMatchObject({ id: first.id, userId: "U0KIM", others: [{ userId: "U0HONG", displayName: "길동 (홍길동)", handle: "hong" }] });
    expect((await r.state()).bots[0]!.pairing.notice ?? null).toBeNull();
    expect((await r.state()).bots[0]!.pairing.refusedSenders ?? []).toEqual([]);
    expect(r.fake.texts("D0KIM").some((text) => text.includes("취소"))).toBe(false);
    expect((await r.g.api("GET", "/api/channels/audit")).text).not.toContain("pairing.contested");
  });

  it("a person the PC declined is refused for the lock time, also in the next window; the owner's 연결 is then taken", async () => {
    const r = await rig();
    await register(r);
    await r.g.api("POST", `${base(r)}/pairing`, {});
    r.fake.message("연결", { user: "U0KIM" });
    await until(async () => (await request(r))?.userId === "U0KIM");
    const first = (await request(r))!;
    await r.g.api("POST", `${base(r)}/pairing/${first.id}`, { approve: false });
    await r.g.api("POST", `${base(r)}/pairing`, {});
    r.fake.message("연결", { user: "U0KIM" });
    await answered(r, (text) => text === "이 앱은 개인용입니다.", "D0KIM");
    expect(await request(r)).toBeNull();
    const refused = (await r.state()).bots[0]!.pairing.refusedSenders ?? [];
    expect(refused).toMatchObject([{ userId: "U0KIM" }]);
    expect(refused[0]!.until - Date.now()).toBeGreaterThan(59 * 60_000);
    r.fake.message("연결");
    await until(async () => (await request(r))?.userId === "U0HONG");
  });

  it("two bare 연결 from two people while the core is busy: the first is the request, the second is told someone asked first (nothing cancelled)", async () => {
    const r = await rig();
    await register(r);
    await r.g.api("POST", `${base(r)}/pairing`, {});
    // The first reply waits out a 429, so the second word arrives before the first is answered.
    r.fake.retryAfter = 1;
    r.fake.failAt("chat.postMessage", 1, { kind: "limit" });
    r.fake.message("연결", { user: "U0KIM" });
    r.fake.message("연결");
    await answered(r, (text) => text === FIRST);
    expect(await request(r)).toMatchObject({ userId: "U0KIM" });
    expect((await r.state()).bots[0]!.pairing.notice ?? null).toBeNull();
    await answered(r, (text) => text.startsWith("PC 화면에 같은 숫자가"), "D0KIM");
  });
});

describe("the same conversation as on Telegram", () => {
  it("a line runs once in the chat's conversation — also when Slack delivers it again — and the answer comes back", async () => {
    const r = await rig();
    await register(r);
    await pair(r);
    const sent = r.fake.message("명단에서 3학년만 뽑아 줘");
    await until(() => r.g.engine.sent.length === 1);
    r.fake.redeliver(sent.envelopeId!);
    await new Promise((done) => setTimeout(done, 150));
    // Neither a second request nor a line added to the running one.
    expect(r.g.engine.asked).toBe(1);
    expect(r.g.engine.steered).toEqual([]);
    expect(r.g.manager.items(r.g.engine.sent[0]!.sessionId).items.filter((item) => item.kind === "user")).toHaveLength(1);
    expect(r.g.engine.sent[0]!.text).toContain("명단에서 3학년만 뽑아 줘");
    await answered(r, (text) => text === "작업 중 · 0:00");
    r.g.engine.say(r.g.engine.sent[0]!.sessionId, "3학년 27명을 저장했습니다. <!channel> & 끝");
    r.g.engine.finish(r.g.engine.sent[0]!.sessionId);
    await answered(r, (text) => text.startsWith("3학년 27명"));
    // The answer escaped for Slack, then the core's footer (unit 14) under it, as on Telegram.
    expect(r.fake.texts().find((text) => text.startsWith("3학년 27명"))).toMatch(/^3학년 27명을 저장했습니다\. &lt;!channel&gt; &amp; 끝\n\nClaude · \d+:\d{2}$/);
    expect(r.fake.messages.some((message) => message.edited && /^끝남 · \d+:\d{2}$/.test(message.text))).toBe(true);
  });

  it("the menu is one message edited in place; a button works once, for the person it was sent to, on that message", async () => {
    const r = await rig();
    await register(r);
    await pair(r);
    r.g.manager.createWork({ title: "연구계획서" });
    r.fake.message("메뉴");
    await answered(r, (text) => text.startsWith("메뉴 · 지금:"));
    const menu = r.fake.button("새 대화");
    const posts = r.fake.of("chat.postMessage").length;
    // Someone else pressing it, and the same token on another message: nothing.
    r.fake.press(menu.value, { user: "U0KIM", channel: "D0HONG", messageTs: menu.ts });
    r.fake.press(menu.value, { messageTs: "1.000001" });
    await until(() => r.fake.ephemeral.length === 2);
    expect(r.fake.ephemeral.map((line) => line.text)).toEqual(["쓸 수 없는 버튼입니다", "쓸 수 없는 버튼입니다"]);
    r.fake.press(menu.value, { messageTs: menu.ts });
    await until(() => (r.fake.shown(menu.ts) ?? "").startsWith("새 대화를 만들었습니다"));
    expect(r.fake.of("chat.postMessage").length).toBe(posts);
    r.fake.press(menu.value, { messageTs: menu.ts });
    await until(() => r.fake.ephemeral.length === 3);
    expect(r.fake.ephemeral[2]!.text).toBe("이미 처리됨");
  });

  it("멈춰 stops at once; 잠금 locks from the chat and only the PC unlocks; a paused chat gets only the short reply", async () => {
    const r = await rig();
    await register(r);
    await pair(r);
    r.fake.message("긴 일 해 줘");
    await until(() => r.g.engine.sent.length === 1);
    r.fake.message("멈춰");
    await answered(r, (text) => text.startsWith("멈췄습니다"));
    expect(r.g.engine.interrupted).toHaveLength(1);
    const bindingId = (await r.state()).bots[0]!.bindings[0]!.id;
    await r.g.api("PATCH", `/api/channels/bindings/${bindingId}`, { paused: true });
    r.fake.message("멈춘 동안의 요청");
    await answered(r, (text) => text === "지금은 PC에서 채널을 멈춰 두었습니다.");
    await r.g.api("PATCH", `/api/channels/bindings/${bindingId}`, { paused: false });
    r.fake.message("잠금");
    await answered(r, (text) => text.includes("푸는 것은 PC에서만 할 수 있습니다."));
    r.fake.message("잠근 뒤 요청");
    await answered(r, (text) => text === "채널이 잠겨 있습니다. PC에서만 풀 수 있습니다.");
    expect(r.g.engine.asked).toBe(1);
    // Disconnected at the PC: nothing more reaches the chat, not even the short reply.
    await r.g.api("PATCH", `/api/channels/bindings/${bindingId}`, { revoked: true });
    const before = r.fake.texts().length;
    r.fake.message("끊긴 뒤");
    await new Promise((done) => setTimeout(done, 150));
    expect(r.fake.texts().slice(before)).toEqual(["이 앱은 개인용입니다."]);
  });

  it("a file from the DM reaches the engine as an attachment; the record names it, never the text", async () => {
    const r = await rig();
    await register(r);
    await pair(r);
    const png = Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001080600000031b0ec3a", "hex");
    const file = r.fake.file("칠판.png", png, { mimetype: "image/png" });
    r.fake.message("이거 표로 정리해 줘", { files: [file], subtype: "file_share" });
    await until(() => r.g.engine.sent.length === 1);
    const items = r.g.manager.items(r.g.engine.sent[0]!.sessionId).items;
    expect(items.find((item) => item.kind === "user")).toMatchObject({ attachments: [{ name: "칠판.png" }] });
    const audit = (await r.g.api("GET", "/api/channels/audit")).text;
    expect(audit).toContain("file.received");
    expect(audit).not.toContain("표로 정리");
  });

  it("a file over what this PC takes is named, in Slack's words (not Telegram's)", async () => {
    const r = await rig();
    await register(r);
    await pair(r);
    const big = r.fake.file("녹화.mp4", Buffer.from("x"), { mimetype: "video/mp4", reported: 30 * 1024 * 1024 });
    r.fake.message("", { files: [big], subtype: "file_share" });
    await answered(r, (text) => text.startsWith("「녹화.mp4」"));
    expect(r.fake.texts().find((text) => text.startsWith("「녹화.mp4」"))).toBe("「녹화.mp4」은(는) 25MB가 넘어 받지 못했습니다. 이 PC가 Slack에서 받을 수 있는 파일은 25MB까지입니다.");
  });

  it("what waited more than a day is not run; the chat is told once how many and since when, and the record says so", async () => {
    const r = await rig();
    await register(r);
    await pair(r);
    await r.restart();
    r.fake.redeliverUnacked = false;
    const old = Math.floor(Date.now() / 1000) - 2 * 86_400;
    // Pairing was before these in Slack's time: move the read mark back as if it had been days ago.
    const offsets = JSON.parse(r.g.store.channels.offset("slack", r.fake.botId)!) as Record<string, string>;
    r.g.store.channels.record("slack", r.fake.botId, [], JSON.stringify({ ...offsets, D0HONG: `${old - 60}.000001` }));
    r.fake.message("이틀 전 요청", { deliver: false, ts: `${old}.000001` });
    r.fake.refresh();
    await answered(r, (text) => text.includes("실행하지 않았습니다"));
    expect(r.fake.texts().filter((text) => text.includes("실행하지 않았습니다"))).toHaveLength(1);
    expect(r.fake.texts().find((text) => text.includes("실행하지 않았습니다"))).toMatch(/^PC가 꺼져 있던 동안 온 요청 중 1개는 실행하지 않았습니다 \(\d+\/\d+ \d{2}:\d{2}부터/);
    expect(r.g.engine.asked).toBe(0);
    expect((await r.g.api("GET", "/api/channels/audit")).text).toContain("history.skipped");
  });

  it("a paused chat is not told the count (only the short reply), but the record still says what was not run", async () => {
    const r = await rig();
    await register(r);
    await pair(r);
    const bindingId = (await r.state()).bots[0]!.bindings[0]!.id;
    await r.g.api("PATCH", `/api/channels/bindings/${bindingId}`, { paused: true });
    await r.restart();
    r.fake.redeliverUnacked = false;
    const old = Math.floor(Date.now() / 1000) - 2 * 86_400;
    const offsets = JSON.parse(r.g.store.channels.offset("slack", r.fake.botId)!) as Record<string, string>;
    r.g.store.channels.record("slack", r.fake.botId, [], JSON.stringify({ ...offsets, D0HONG: `${old - 60}.000001` }));
    r.fake.message("이틀 전 요청", { deliver: false, ts: `${old}.000001` });
    r.fake.refresh();
    await answered(r, (text) => text === "지금은 PC에서 채널을 멈춰 두었습니다.");
    expect(r.fake.texts().some((text) => text.includes("실행하지 않았습니다"))).toBe(false);
    await until(async () => (await r.g.api("GET", "/api/channels/audit")).text.includes("history.skipped"));
    expect(r.g.engine.asked).toBe(0);
  });

  it("what was written while the gateway was off runs once after it starts again, read from the history", async () => {
    const r = await rig();
    await register(r);
    await pair(r);
    await r.restart();
    // Not delivered on the socket (none was open): only in the DM's history.
    r.fake.redeliverUnacked = false;
    r.fake.message("꺼져 있던 동안의 요청", { deliver: false });
    await until(() => r.g.engine.sent.length === 1);
    expect(r.g.engine.sent[0]!.text).toContain("꺼져 있던 동안의 요청");
    r.fake.refresh();
    await until(() => r.fake.of("conversations.history").length >= 2);
    await new Promise((done) => setTimeout(done, 100));
    expect(r.g.engine.asked).toBe(1);
  });
});

describe("answers on Slack after unit 14 (the formatting step, the everyday words)", () => {
  it("an engine's markdown answer arrives whole and readable, with its link written out and no markup or Telegram entities; the footer under it", async () => {
    const r = await rig();
    await register(r);
    await pair(r);
    r.fake.message("자료 찾아 줘");
    await until(() => r.g.engine.sent.length === 1);
    const sessionId = r.g.engine.sent[0]!.sessionId;
    r.g.engine.say(sessionId, "## 찾음\n\n**세 건**을 찾았습니다: [목록](https://lib.example.ac.kr/list) 그리고 `npm test`.\n\n- 하나\n- 둘");
    r.g.engine.finish(sessionId);
    await answered(r, (text) => text.includes("세 건"));
    const call = r.fake.of("chat.postMessage").find((entry) => String(entry.params.text).includes("세 건"))!;
    const text = String(call.params.text);
    expect(text).toContain("목록 (https://lib.example.ac.kr/list)");
    expect(text).toContain("npm test");
    expect(text).toContain("둘");
    expect(text).not.toMatch(/\*\*|\]\(|`|^## /m);
    expect(text).toMatch(/\n\nClaude · \d+:\d{2}$/);
    expect(Object.keys(call.params).filter((key) => /entit|parse/.test(key))).toEqual([]);
  });

  it("the everyday words work on Slack through the same core: 상태, 도움말", async () => {
    const r = await rig();
    await register(r);
    await pair(r);
    const before = r.fake.texts().length;
    r.fake.message("도움말");
    await until(() => r.fake.texts().length > before);
    // Slack never delivers a line that begins with `/` to the app: the help names no slash word there.
    expect(r.fake.texts()[before]).toContain("한 줄로 보내면 바로 되는 말");
    expect(r.fake.texts()[before]).not.toMatch(/\/(menu|help|new)\b/);
    r.fake.message("상태");
    await until(() => r.fake.texts().length > before + 1);
    expect(r.g.engine.sent).toEqual([]);
  });
});

describe("secret input on Slack (merge with units 7–8): a value is never taken from a Slack chat", () => {
  const VALUE = "zz-secret-pass-0012";
  const NEED = ["need", "--name", "학술정보원", "--kind", "login", "--site", "lib.example.ac.kr", "--fields", "아이디,비밀번호"];
  const PC_LINE = "이 값은 PC의 휴대폰 메신저 → 비밀 보관함에서 넣어 주세요. 넣으면 이어서 합니다.";
  /** A paired Slack chat with a conversation, and the AI asking for a login through the tool. */
  async function handOver() {
    const r = await rig({ credentials: true });
    await register(r);
    await pair(r);
    r.fake.message("도서관 대출 목록 정리해 줘");
    await until(() => r.g.engine.sent.length === 1);
    const sessionId = r.g.engine.sent[0]!.sessionId;
    expect(await r.g.credentials!.run(sessionId, NEED)).toMatchObject({ stdout: "fail:handover_sent\n" });
    r.g.engine.finish(sessionId);
    await answered(r, (text) => text.includes("'학술정보원'"));
    return { r, sessionId, handoff: r.g.credentials!.state().waiting[0]! };
  }
  const leaked = (r: Rig) => formsOf(VALUE).filter((form) => everything(r.g.dataDir).includes(form) || JSON.stringify(r.fake.calls).includes(form));

  it("a hand-over says in one line that the value is entered on the PC: no input opens, no button offers one, nothing asks for it in the chat", async () => {
    const { r } = await handOver();
    // Unit 9: the login page's picture goes first as its own message (its caption names the login); then the hand-over.
    const asked = r.fake.messages.filter((message) => message.text.includes("'학술정보원'") && !message.text.endsWith("로그인 화면"));
    expect(asked).toHaveLength(1);
    expect(asked[0]!.text).toContain("로그인 정보가 필요합니다");
    expect(asked[0]!.text).toContain(PC_LINE);
    expect(asked[0]!.text).not.toContain("다음에 보내는 메시지");
    expect(r.fake.labels(asked[0]!.ts)).toEqual([]);
    expect(r.g.store.channels.auditList().some((row) => row.action === "secret.asked" && row.result === "pc")).toBe(true);
  });

  it("a line typed right after it is an ordinary line to the AI, never stored as a value; adding it at the PC continues the conversation", async () => {
    const { r, sessionId, handoff } = await handOver();
    r.fake.message(`비밀번호는 ${VALUE}`);
    // The line goes the ordinary way (the inbox, the conversation) and is not taken out as a secret.
    await until(() => r.g.engine.sent.length === 2);
    expect(r.g.engine.sent[1]!.text).toContain(VALUE);
    expect(r.g.credentials!.store.filled(handoff.id)).toEqual([]);
    expect(r.g.credentials!.store.summaries()).toEqual([]);
    expect(r.g.credentials!.handoff(handoff.id)?.state).toBe("waiting");
    expect(r.fake.of("chat.delete")).toEqual([]);
    r.g.engine.finish(sessionId);
    await r.g.credentials!.add({ name: "학술정보원", kind: "login", site: "lib.example.ac.kr", values: { 아이디: "zz-user-0012", 비밀번호: "zz-pass-pc-0012" } });
    await answered(r, (text) => text.startsWith("PC에서 '학술정보원'"));
    await until(() => r.g.engine.sent.some((entry) => entry.text.includes("가 준비되었습니다")));
  });

  it("a press of an old [넣기] or [다시 넣기] on Slack opens nothing and points to the PC", async () => {
    const { r, handoff } = await handOver();
    // As if sent before this rule (or by a future path): bound to the chat and the person, on no message.
    const binding = r.g.store.channels.bindings().find((row) => !row.revokedAt)!;
    for (const [kind, data] of [["cred-give", { h: handoff.id }], ["cred-redo", { h: handoff.id, f: 0 }]] as const) {
      const token = `zz${kind.replace("-", "")}0012`;
      r.g.store.channels.addButton({ token, bindingId: binding.id, chatId: binding.chatId, userId: binding.userId, sessionId: null, itemId: null, kind, data: JSON.stringify(data), expiresAt: Date.now() + 60_000 });
      r.fake.press(token);
    }
    await until(() => r.fake.texts().filter((text) => text.includes("PC의 '휴대폰 메신저 → 비밀 보관함'")).length === 2);
    r.fake.message(VALUE);
    await until(() => r.g.engine.sent.length === 2);
    expect(r.g.credentials!.store.filled(handoff.id)).toEqual([]);
  });

  it("the history fill reads a line sent while the socket was down as an ordinary line: nothing is stored as a value", async () => {
    const { r, handoff } = await handOver();
    r.fake.cut();
    r.fake.message(VALUE);
    await until(() => r.g.engine.sent.length === 2, 8_000);
    expect(r.g.credentials!.store.filled(handoff.id)).toEqual([]);
    expect(r.g.credentials!.handoff(handoff.id)?.state).toBe("waiting");
  });

  it("a stored value the AI writes back (inside markdown bold) is hidden in every Slack call and every data file", async () => {
    const r = await rig({ credentials: true });
    await register(r);
    await pair(r);
    await r.g.credentials!.add({ name: "도서관", kind: "login", site: "", values: { 아이디: "zz-user-0014", 비밀번호: VALUE } });
    r.fake.message("로그인 확인해 줘");
    await until(() => r.g.engine.sent.length === 1);
    const sessionId = r.g.engine.sent[0]!.sessionId;
    r.g.engine.say(sessionId, `비밀번호 **${VALUE}** 로 들어갔습니다.`);
    r.g.engine.finish(sessionId);
    await answered(r, (text) => text.includes("로 들어갔습니다"));
    expect(leaked(r)).toEqual([]);
  });

  it("[비밀 보관함] in the Slack chat lists and offers rename and delete, and no entry of values", async () => {
    const r = await rig({ credentials: true });
    await register(r);
    await pair(r);
    r.fake.message("비밀 보관함");
    await answered(r, (text) => text.startsWith("비밀 보관함이 비어 있습니다"));
    expect(r.fake.texts().find((text) => text.startsWith("비밀 보관함이 비어 있습니다"))).toContain("PC");
    await r.g.credentials!.add({ name: "도서관", kind: "login", site: "", values: { 아이디: "zz-user-0013", 비밀번호: "zz-pass-0013" } });
    r.fake.message("비밀 보관함");
    await answered(r, (text) => text.startsWith("비밀 보관함 · 1개"));
    const name = r.fake.button("도서관");
    r.fake.press(name.value, { messageTs: name.ts, actionId: name.actionId });
    await answered(r, (text) => text.startsWith("「도서관」"));
    expect(r.fake.labels(r.fake.button("지우기").ts)).toEqual(["이름 바꾸기", "지우기", "매번 묻기 켜기"]);
    // The menu's row opens the same list.
    r.fake.message("메뉴");
    await answered(r, (text) => text.startsWith("메뉴 · 지금:"));
    const row = r.fake.button("비밀 보관함");
    const lists = r.fake.texts().filter((text) => text.startsWith("비밀 보관함 · 1개")).length;
    r.fake.press(row.value, { messageTs: row.ts, actionId: row.actionId });
    await until(() => r.fake.texts().filter((text) => text.startsWith("비밀 보관함 · 1개")).length === lists + 1);
    expect(leaked(r)).toEqual([]);
  });
});

describe("a login step on Slack (unit 9 after the merge): never a value from a Slack chat, never a dead end", () => {
  const CODE = "482913";
  async function signedIn() {
    const r = await rig({ credentials: true });
    await register(r);
    await pair(r);
    await r.g.credentials!.add({ name: "도서관", kind: "login", site: "lib.example.ac.kr", values: { 아이디: "zz-user-0909", 비밀번호: "zz-pass-0909-slack" } });
    r.fake.message("도서관 대출 목록 정리해 줘");
    await until(() => r.g.engine.sent.length === 1);
    const sessionId = r.g.engine.sent[0]!.sessionId;
    LOGIN_PAGE.state.url = "https://lib.example.ac.kr/login";
    LOGIN_PAGE.state.typed.length = 0;
    LOGIN_PAGE.state.went.length = 0;
    return { r, sessionId };
  }

  for (const [kind, extra, words] of [["code", ["--ref", "e6"], "인증번호"], ["link", [], "로그인 링크"]] as const) {
    it(`a ${kind} step: the chat is told plainly to do it in the PC's browser window and send '이어서'; no input, no button, and a value sent anyway is never typed`, async () => {
      const { r, sessionId } = await signedIn();
      expect((await r.g.credentials!.run(sessionId, ["step", "--name", "도서관", "--kind", kind, ...extra])).stdout).toBe("fail:handover_sent\n");
      r.g.engine.finish(sessionId);
      const step = (text: string) => text.includes("'도서관' 로그인") && !text.endsWith("로그인 화면");
      await answered(r, step);
      const said = r.fake.messages.find((message) => step(message.text))!;
      expect(said.text).toContain("PC");
      expect(said.text).toContain(words);
      expect(said.text).toContain("'이어서'");
      expect(said.text).not.toContain("다음에 보내는 메시지");
      expect(r.fake.labels(said.ts)).toEqual([]);
      // A value sent here anyway (round 3; fix round 4, P2): held, never typed, never to the AI; Slack cannot delete it,
      // so each held line is answered once: why, to delete it by hand, and [그대로 보내기].
      const value = kind === "code" ? `[Web발신] 인증번호 [${CODE}]를 입력해 주세요` : "https://lib.example.ac.kr/magic?t=zz-fake-magic-0909";
      r.fake.message(value);
      const held = kind === "code" ? "방금 보낸 글은 인증번호처럼 보여 AI에게 보내지 않았습니다. 이 메시지는 직접 지워 주세요. 인증번호가 아니었다면 [그대로 보내기]를 눌러 주세요."
        : "방금 보낸 글은 로그인 링크처럼 보여 AI에게 보내지 않았습니다. 이 메시지는 직접 지워 주세요. 로그인 링크가 아니었다면 [그대로 보내기]를 눌러 주세요.";
      await answered(r, (text) => text === held);
      expect(r.fake.labels(r.fake.messages.findLast((message) => message.text === held)!.ts)).toEqual(["그대로 보내기"]);
      r.fake.message(kind === "code" ? CODE : value);
      await until(() => r.fake.texts().filter((text) => text === held).length === 2);
      // An ordinary line with a number goes to the AI while the step waits at the PC (NEW-I-i).
      r.fake.message("회의는 1430호에서 해요");
      await until(() => r.g.engine.sent.length === 2);
      expect(r.g.engine.sent[1]!.text).toContain("1430호");
      r.g.engine.finish(sessionId);
      r.fake.message("이어서");
      await until(() => r.g.engine.sent.length === 3);
      expect(r.g.engine.sent[2]!.text).toContain("이어서");
      expect(r.g.engine.sent.some((entry) => entry.text.includes(CODE) || entry.text.includes("zz-fake-magic-0909"))).toBe(false);
      expect(LOGIN_PAGE.state.typed).toEqual([]);
      expect(LOGIN_PAGE.state.went).toEqual([]);
      expect(r.fake.of("chat.delete")).toEqual([]);
    });
  }

  it("a press of an old [인증번호 넣기] on Slack opens nothing and points to the PC", async () => {
    const { r, sessionId } = await signedIn();
    await r.g.credentials!.run(sessionId, ["step", "--name", "도서관", "--kind", "approve", "--app", "카카오톡"]);
    r.g.engine.finish(sessionId);
    await answered(r, (text) => text.includes("카카오톡 앱에서 승인해 주세요"));
    const binding = r.g.store.channels.bindings().find((row) => !row.revokedAt)!;
    const done = r.fake.button("했어요");
    const row = r.g.store.channels.button(done.value)!;
    r.g.store.channels.addButton({ token: "zzcredlogingive0909", bindingId: binding.id, chatId: binding.chatId, userId: binding.userId, sessionId: null, itemId: null, kind: "cred-login-give", data: row.data, expiresAt: Date.now() + 60_000 });
    r.fake.press("zzcredlogingive0909");
    await answered(r, (text) => text.includes("이 메신저로는 받지 않습니다"));
    expect(r.fake.texts().some((text) => text.includes("다음에 보내는 메시지"))).toBe(false);
  });

  it("an approval in another app keeps its [했어요] button, which works on Slack and continues once", async () => {
    const { r, sessionId } = await signedIn();
    await r.g.credentials!.run(sessionId, ["step", "--name", "도서관", "--kind", "approve", "--app", "카카오톡"]);
    r.g.engine.finish(sessionId);
    await answered(r, (text) => text.includes("카카오톡 앱에서 승인해 주세요"));
    const done = r.fake.button("했어요");
    r.fake.press(done.value, { messageTs: done.ts, actionId: done.actionId });
    await until(() => r.g.engine.sent.some((entry) => entry.text.includes("승인했다고 합니다")));
  });

  it("the host question's buttons work on Slack: [이 주소도 허용] keeps the host and the conversation goes on", async () => {
    const { r, sessionId } = await signedIn();
    LOGIN_PAGE.state.url = "https://sso.example.ac.kr/login";
    expect((await r.g.credentials!.run(sessionId, ["fill", "--name", "도서관", "--ref", "비밀번호=e6"])).stdout).toBe("fail:handover_sent\n");
    r.g.engine.finish(sessionId);
    await answered(r, (text) => text.includes("에서도 쓰게 할까요?"));
    const allow = r.fake.button("이 주소도 허용");
    r.fake.press(allow.value, { messageTs: allow.ts, actionId: allow.actionId });
    await until(() => r.g.engine.sent.some((entry) => entry.text.includes("허용되었습니다")));
    expect(r.g.credentials!.store.find("도서관")!.hosts).toEqual(["sso.example.ac.kr"]);
  });
});
