import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DaemonArgs, DaemonAnswer, HostPage } from "../browse-host.ts";
import { EventBus } from "../bus.ts";
import { LoginFiller } from "../credentials/fill.ts";
import { formsOf } from "../credentials/forms.ts";
import { installScrubber } from "../credentials/install.ts";
import { CredentialService } from "../credentials/service.ts";
import { OfficeVault } from "../office-vault.ts";
import { SessionManager } from "../sessions.ts";
import { Store } from "../store.ts";
import { FAKE_TOKEN, FakeTelegram } from "./fake-telegram.ts";
import { ChannelService } from "./service.ts";
import { StandInEngine, until } from "./test-kit.ts";

// Unit 9 in the chat (design §6.4, transcript A), through the real Telegram adapter against the
// stand-in Bot API on 127.0.0.1 and a stand-in agent page that answers the daemon's commands as the
// real one does. Made-up values only; every search is shown able to find a planted one.

const ID = "zz-login-user-0909";
const PASSWORD = "zz-login-pass-0909";
const CODE = "482913";
const LINK_TOKEN = "zz-fake-magic-0909";
const SITE = "http://127.0.0.1:41233";
const NEED = ["need", "--name", "도서관", "--kind", "login", "--site", SITE, "--fields", "아이디,비밀번호"];
const FILL = ["fill", "--name", "도서관", "--ref", "아이디=e4", "--ref", "비밀번호=e6", "--submit", "e7"];

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

/** A login page as the daemon sees it (see fill.test.ts): its address, its elements, what was typed, pressed and opened. */
function standInPage(url = `${SITE}/login`) {
  const state = { url, blind: 0, title: "도서관 로그인", typed: [] as [string, string][], pressed: [] as string[], went: [] as string[], shots: 0, elements: { e4: { tag: "input", type: "text" }, e6: { tag: "input", type: "password" }, e7: { tag: "button", type: "submit" } } as Record<string, { tag: string; type: string }> };
  const marked: string[] = [];
  const page: HostPage = {
    typed: (_label, values) => { marked.push(...values); },
    forget: () => undefined,
    live: () => marked.length > 0,
    hide: (text) => marked.reduce((out, value) => out.replaceAll(value, "[비밀]"), text),
    run: async (args: DaemonArgs): Promise<DaemonAnswer> => {
      const [command, first, second] = args._;
      if (command === "eval") {
        if (second) { const element = state.elements[second]; return element ? { error: false, text: JSON.stringify(JSON.stringify({ ...element, frame: state.url })) } : { error: true, text: `Ref ${second} not found in the current page snapshot` }; }
        if (first!.includes("location.href")) return { error: false, text: JSON.stringify(state.url) };
        if (first!.includes("document.title")) return { error: false, text: JSON.stringify(state.title) };
        if (first!.includes("innerText")) return { error: false, text: JSON.stringify(JSON.stringify({ values: [], text: "로그인", blind: state.blind })) };
      }
      if (command === "fill") { state.typed.push([first!, second!]); return { error: false, text: `await page.fill('${second}')` }; }
      if (command === "click") { state.pressed.push(first!); state.title = "내 서재"; return { error: false, text: "" }; }
      if (command === "goto") { state.went.push(first!); return { error: false, text: "" }; }
      if (command === "screenshot") { state.shots += 1; writeFileSync(String(args.filename), Buffer.from("89504e470d0a1a0a0000000d49484452", "hex")); return { error: false, text: "" }; }
      return { error: true, text: "unknown" };
    },
  };
  return { page, state };
}

async function paired(page = standInPage()) {
  const dir = mkdtempSync(join(tmpdir(), "wb-login-chat-"));
  const dataDir = join(dir, "data");
  mkdirSync(dataDir, { recursive: true });
  const fake = new FakeTelegram();
  await fake.start();
  const store = new Store(join(dataDir, "state.sqlite"));
  const bus = new EventBus();
  const manager = new SessionManager(store, bus, { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dataDir, "works"), dataDir });
  const engine = new StandInEngine(() => manager.sink);
  manager.registerAdapter(engine);
  const vault = new OfficeVault(dataDir, async () => ({ id: "d".repeat(32), key: Buffer.alloc(32, 5) }));
  const credentials = new CredentialService({ dataDir, vault, manager });
  installScrubber(store, manager, credentials.scrubber);
  const logins = new LoginFiller({ service: credentials, dataDir, page: () => page.page });
  logins.install();
  const lines: string[] = [];
  const channels = new ChannelService({ dataDir, store, manager, bus, vault, credentials, logins, telegramUrl: fake.url, telegram: { pollSeconds: 1, minSendGapMs: 0 }, log: (line) => lines.push(line) });
  await channels.start();
  await credentials.start();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await channels.close();
    credentials.close();
    await manager.shutdown();
    store.close();
  };
  cleanups.push(async () => { await close(); await fake.stop(); rmSync(dir, { recursive: true, force: true }); });
  await channels.registerTelegram(FAKE_TOKEN, {});
  const { code } = channels.core.beginPairing("telegram", fake.botId);
  fake.message(`/start ${code}`);
  await until(() => Boolean(channels.core.pairing("telegram", fake.botId).request));
  await channels.core.approvePairing("telegram", fake.botId, channels.core.pairing("telegram", fake.botId).request!.id);
  fake.message("도서관 대출 목록 정리해 줘");
  await until(() => engine.sent.length === 1);
  const sessionId = channels.core.bindings()[0]!.pointerSessionId!;
  const run = (args: string[]) => credentials.run(sessionId, args);
  /** The AI ends its turn after a hand-over (as the tool tells it to). */
  const endTurn = () => { engine.say(sessionId, "기다립니다."); engine.finish(sessionId); };
  return { dir, dataDir, fake, store, manager, engine, credentials, channels, logins, lines, page, sessionId, run, endTurn, close };
}
type Rig = Awaited<ReturnType<typeof paired>>;

const continued = (r: Rig, part: string) => r.engine.sent.filter((entry) => entry.text.includes("[자동 이어 하기] '") && entry.text.includes(part));
const toAi = (r: Rig, value: string) => [...r.engine.sent, ...r.engine.steered].some((entry) => entry.text.includes(value));
const pressOn = (r: Rig, label: string) => { const button = r.fake.button(label); return r.fake.press(button.data, { messageId: button.messageId }); };
type Update = Record<string, unknown>;
const deleted = (r: Rig, update: Update) => r.fake.of("deleteMessage").filter((call) => call.params.message_id === (update.message as { message_id: number }).message_id).length;
/** Every byte under the data folder and the channel's log lines. */
function everywhere(r: Rig, value: string): string[] {
  let all = r.lines.join("\n");
  for (const entry of readdirSync(r.dataDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const bytes = readFileSync(join(entry.parentPath, entry.name));
    all += bytes.toString("latin1") + bytes.toString("utf8");
  }
  return formsOf(value).filter((form) => all.includes(form));
}

describe("a first login (transcript A)", () => {
  it("sends the login page's picture as its own message before the hand-over; the hand-over's buttons stay on its text; then the gateway types the stored values with nothing said", async () => {
    const r = await paired();
    expect(await r.run(NEED)).toMatchObject({ stdout: "fail:handover_sent\n" });
    r.endTurn();
    await until(() => r.fake.texts().some((text) => text.includes("필요합니다")));
    const photos = r.fake.of("sendPhoto");
    expect(photos).toHaveLength(1);
    expect(photos[0]!.file?.name).toBe("login.png");
    expect(String(photos[0]!.params.caption)).toBe("'도서관' 로그인 화면");
    const ask = r.fake.of("sendMessage").find((call) => String(call.params.text).includes("필요합니다"))!;
    expect(r.fake.calls.indexOf(photos[0]!)).toBeLessThan(r.fake.calls.indexOf(ask));
    // The picture is not kept once sent.
    expect(readdirSync(join(r.dataDir, "credential-tool", "pictures"))).toEqual([]);
    // [나중에] sits on the text message and works there.
    pressOn(r, "나중에");
    // Fix round 4 (P1): the input's one ending line, with [다시 넣기].
    await until(() => r.fake.texts().some((text) => text.includes("입력을 닫았습니다") && text.includes("나중에 넣으려면")));
    pressOn(r, "다시 넣기");
    await until(() => r.fake.texts().filter((text) => text.includes("아이디로 받습니다")).length === 2);
    r.fake.message(ID);
    await until(() => r.fake.texts().some((text) => text.startsWith("'도서관'의 아이디를 받았습니다")));
    r.fake.message(PASSWORD);
    await until(() => continued(r, "'도서관'가 준비되었습니다").length === 1);
    // The continuation: the AI points, the gateway types; the chat hears nothing of it.
    const said = r.fake.texts().length;
    expect(await r.run(FILL)).toEqual({ code: 0, stdout: "ok\n제목: 내 서재\n", stderr: "" });
    expect(r.page.state.typed).toEqual([["e4", ID], ["e6", PASSWORD]]);
    expect(r.fake.texts()).toHaveLength(said);
    const used = r.channels.core.auditList({}).find((row) => row.action === "credential.used");
    expect(used).toMatchObject({ target: "도서관 · 127.0.0.1", result: "ok" });
    expect(toAi(r, ID) || toAi(r, PASSWORD)).toBe(false);
    await r.close();
    expect(everywhere(r, PASSWORD)).toEqual([]);
    writeFileSync(join(r.dataDir, "planted"), PASSWORD);
    expect(everywhere(r, PASSWORD).length).toBeGreaterThan(0);
  });

  it("a stored login is used at once: need answers ok, fill types it, and the chat gets nothing", async () => {
    const r = await paired();
    await r.credentials.add({ name: "도서관", kind: "login", site: SITE, values: { 아이디: ID, 비밀번호: PASSWORD } });
    const said = r.fake.of("sendMessage").length;
    expect(await r.run(NEED)).toMatchObject({ stdout: "ok\n" });
    expect((await r.run(FILL)).stdout).toMatch(/^ok\n/);
    expect(r.fake.of("sendMessage")).toHaveLength(said);
    expect(r.fake.of("sendPhoto")).toHaveLength(0);
  });

  it("a fill on another site is refused and the chat is told once", async () => {
    const r = await paired(standInPage("http://127.0.0.2:41233/login"));
    await r.credentials.add({ name: "도서관", kind: "login", site: SITE, values: { 아이디: ID, 비밀번호: PASSWORD } });
    expect((await r.run(FILL)).stdout).toBe("fail:wrong_site\n");
    expect((await r.run(FILL)).stdout).toBe("fail:wrong_site\n");
    await until(() => r.fake.texts().some((text) => text.includes("저장한 사이트에서만 넣습니다")));
    expect(r.fake.texts().filter((text) => text.includes("저장한 사이트에서만 넣습니다"))).toHaveLength(1);
    expect(r.page.state.typed).toEqual([]);
  });
});

describe("a stored login on another host", () => {
  const PORTAL = ["fill", "--name", "포털", "--ref", "아이디=e4", "--ref", "비밀번호=e6", "--submit", "e7"];
  async function onSso() {
    const r = await paired(standInPage("https://sso.example.ac.kr/login"));
    await r.credentials.add({ name: "포털", kind: "login", site: "portal.example.ac.kr", values: { 아이디: ID, 비밀번호: PASSWORD } });
    return r;
  }
  const QUESTION = "'포털' 로그인은 portal․example․ac․kr에 저장되어 있습니다. sso․example․ac․kr에서도 쓰게 할까요?";

  it("asks once, naming both hosts; [이 주소도 허용] keeps the host on the entry and the conversation goes on once, then the fill types", async () => {
    const r = await onSso();
    expect((await r.run(PORTAL)).stdout).toBe("fail:handover_sent\n");
    expect((await r.run(PORTAL)).stdout).toBe("fail:handover_sent\n");
    r.endTurn();
    await until(() => r.fake.texts().includes(QUESTION));
    expect(r.fake.texts().filter((text) => text === QUESTION)).toHaveLength(1);
    expect(r.page.state.typed).toEqual([]);
    pressOn(r, "이 주소도 허용");
    await until(() => continued(r, "sso.example.ac.kr에서도 쓰도록 허용되었습니다").length === 1);
    expect(r.credentials.store.find("포털")!.hosts).toEqual(["sso.example.ac.kr"]);
    pressOn(r, "안 함");
    await until(() => r.fake.of("answerCallbackQuery").length >= 2);
    expect(continued(r, "포털")).toHaveLength(1);
    expect((await r.run(PORTAL)).stdout).toMatch(/^ok\n/);
    expect(r.page.state.typed).toEqual([["e4", ID], ["e6", PASSWORD]]);
  });

  it("[안 함] continues once with fail:wrong_site, and that host is not asked again", async () => {
    const r = await onSso();
    await r.run(PORTAL);
    r.endTurn();
    await until(() => r.fake.texts().includes(QUESTION));
    pressOn(r, "안 함");
    await until(() => continued(r, "fail:wrong_site").length === 1);
    expect((await r.run(PORTAL)).stdout).toBe("fail:wrong_site\n");
    expect(r.fake.texts().filter((text) => text === QUESTION)).toHaveLength(1);
    expect(r.credentials.store.find("포털")!.hosts).toBeUndefined();
    expect(r.page.state.typed).toEqual([]);
  });
});

describe("second factors", () => {
  async function stored() {
    const r = await paired();
    await r.credentials.add({ name: "도서관", kind: "login", site: SITE, values: { 아이디: ID, 비밀번호: PASSWORD } });
    return r;
  }

  it("a code: the page's picture and [인증번호 넣기]; the code is taken out of the chat, typed by the gateway, never stored nor sent to the AI; the conversation goes on once", async () => {
    const r = await stored();
    const before = readFileSync(join(r.dataDir, "credentials", "store.json"), "utf8");
    expect((await r.run(["step", "--name", "도서관", "--kind", "code", "--ref", "e6", "--submit", "e7", "--label", "문자 인증번호"])).stdout).toBe("fail:handover_sent\n");
    r.endTurn();
    await until(() => r.fake.texts().some((text) => text.includes("문자 인증번호를 묻습니다")));
    expect(r.fake.of("sendPhoto")).toHaveLength(1);
    expect(r.fake.buttonData("인증번호 넣기")).toBeTruthy();
    const sent = r.fake.message(CODE);
    await until(() => continued(r, "문자 인증번호를 넣었습니다").length === 1);
    expect(deleted(r, sent)).toBe(1);
    expect(r.page.state.typed).toEqual([["e6", CODE]]);
    expect(r.page.state.pressed).toEqual(["e7"]);
    expect(r.fake.texts().some((text) => text.startsWith("문자 인증번호를 넣었습니다(메시지는 지웠고 저장하지 않았습니다)"))).toBe(true);
    expect(toAi(r, CODE)).toBe(false);
    expect(readFileSync(join(r.dataDir, "credentials", "store.json"), "utf8")).toBe(before);
    // The input is over: the next line goes to the AI.
    r.fake.message("고마워");
    await until(() => toAi(r, "고마워"));
  });

  it("while the code input is open nothing the person writes reaches the AI: app words act, a code (also inside the SMS as pasted) is typed, anything else is held with one reply and deleted", async () => {
    const r = await stored();
    await r.run(["step", "--name", "도서관", "--kind", "code", "--ref", "e6", "--submit", "e7"]);
    r.endTurn();
    await until(() => r.fake.texts().some((text) => text.includes("인증번호를 묻습니다")));
    const first = r.fake.message("문자가 아직 안 왔어");
    await until(() => r.fake.texts().some((text) => text.startsWith("지금은 인증번호를 기다리고 있습니다. 번호만 보내 주세요. 그만두려면 '취소'라고 보내 주세요.")));
    await until(() => deleted(r, first) === 1);
    const second = r.fake.message("기다리는 중이야 482913 아니면 135790");
    const third = r.fake.message("010-1234-5678로 문자 왔어?");
    await until(() => deleted(r, second) === 1 && deleted(r, third) === 1);
    // Fix round 4 (P2): every held line is answered once, with [그대로 보내기].
    await until(() => r.fake.texts().filter((text) => text.startsWith("지금은 인증번호를 기다리고")).length === 3);
    expect(r.fake.buttonData("그대로 보내기")).toBeTruthy();
    expect(toAi(r, "문자가 아직") || toAi(r, "기다리는 중") || toAi(r, "010-1234") || toAi(r, "135790")).toBe(false);
    expect(r.page.state.typed).toEqual([]);
    // An everyday word acts as itself (unit 14's words): answered by the app, never typed, never to the AI.
    const helps = r.fake.texts().length;
    r.fake.message("도움말");
    await until(() => r.fake.texts().length > helps);
    expect(toAi(r, "도움말")).toBe(false);
    expect(r.page.state.typed).toEqual([]);
    // The SMS as a Korean phone shows it: its one code is taken and typed; the message deleted.
    const sms = r.fake.message(`[Web발신]\n[도서관] 인증번호 [${CODE}]를 입력해 주세요. 2026.11.13 10:30`);
    await until(() => continued(r, "인증번호를 넣었습니다").length === 1);
    expect(deleted(r, sms)).toBe(1);
    expect(r.page.state.typed).toEqual([["e6", CODE]]);
    expect(r.fake.texts().some((text) => text.startsWith("인증번호를 넣었습니다(메시지는 지웠고"))).toBe(true);
    expect(toAi(r, CODE)).toBe(false);
  });

  it("a code written with spaces or hyphens is typed without them", async () => {
    const r = await stored();
    await r.run(["step", "--name", "도서관", "--kind", "code", "--ref", "e6", "--submit", "e7"]);
    r.endTurn();
    await until(() => r.fake.texts().some((text) => text.includes("인증번호를 묻습니다")));
    r.fake.message("482 913");
    await until(() => continued(r, "인증번호를 넣었습니다").length === 1);
    expect(r.page.state.typed).toEqual([["e6", CODE]]);
  });

  it("after a code step ended, only the same code again (also inside a sentence) or a bare all-digit code is caught; thanks, ok and other words go on", async () => {
    const r = await stored();
    await r.run(["step", "--name", "도서관", "--kind", "code", "--ref", "e6", "--submit", "e7"]);
    r.endTurn();
    await until(() => r.fake.texts().some((text) => text.includes("인증번호를 묻습니다")));
    r.fake.message(CODE);
    await until(() => continued(r, "인증번호를 넣었습니다").length === 1);
    r.endTurn();
    for (const word of ["thanks", "okay", "done"]) {
      r.fake.message(word);
      await until(() => toAi(r, word));
    }
    const again = r.fake.message(`[Web발신] 인증번호 [${CODE}]를 입력해 주세요`);
    await until(() => deleted(r, again) === 1);
    const other = r.fake.message("135790");
    await until(() => deleted(r, other) === 1);
    expect(toAi(r, CODE) || toAi(r, "135790")).toBe(false);
    expect(r.page.state.typed).toEqual([["e6", CODE]]);
  });

  it("while an approval in another app waits, a line is held (never to the AI) with the approval's own words; [했어요] still continues", async () => {
    const r = await stored();
    await r.run(["step", "--name", "도서관", "--kind", "approve", "--app", "카카오톡"]);
    r.endTurn();
    await until(() => r.fake.texts().some((text) => text.includes("휴대폰 카카오톡 앱에서 승인해 주세요")));
    const line = r.fake.message("알림이 안 와");
    await until(() => deleted(r, line) === 1 && r.fake.texts().some((text) => text.startsWith("지금은 휴대폰 앱의 승인을 기다리고 있습니다.")));
    expect(toAi(r, "알림이 안 와")).toBe(false);
    pressOn(r, "했어요");
    await until(() => continued(r, "카카오톡 앱에서 승인했다고 합니다").length === 1);
    r.endTurn();
    r.fake.message("고마워");
    await until(() => toAi(r, "고마워"));
  });

  it("a mail link input takes the one link of a pasted line; a line without one is held with the link's own words", async () => {
    const r = await stored();
    await r.run(["step", "--name", "도서관", "--kind", "link"]);
    r.endTurn();
    await until(() => r.fake.texts().some((text) => text.includes("링크 주소를 복사해 보내 주세요")));
    const line = r.fake.message("메일 찾는 중");
    await until(() => deleted(r, line) === 1 && r.fake.texts().some((text) => text.startsWith("지금은 메일로 온 로그인 링크를 기다리고 있습니다.")));
    expect(toAi(r, "메일 찾는 중")).toBe(false);
    r.fake.message(`이거야 ${SITE}/magic?t=${LINK_TOKEN} 열어 줘`);
    await until(() => continued(r, "로그인 링크를 열었습니다").length === 1);
    expect(r.page.state.went).toEqual([`${SITE}/magic?t=${LINK_TOKEN}`]);
    expect(toAi(r, LINK_TOKEN) || toAi(r, "메일 찾는")).toBe(false);
  });

  it("the same code arriving again just after its step ended (SMS often comes twice) is deleted, never passed on, and answered once", async () => {
    const r = await stored();
    await r.run(["step", "--name", "도서관", "--kind", "code", "--ref", "e6", "--submit", "e7"]);
    r.endTurn();
    await until(() => r.fake.texts().some((text) => text.includes("인증번호를 묻습니다")));
    r.fake.message(CODE);
    await until(() => continued(r, "인증번호를 넣었습니다").length === 1);
    r.endTurn();
    const again = r.fake.message(CODE);
    await until(() => r.fake.texts().some((text) => text.startsWith("방금 보낸 글은 인증번호처럼 보여 AI에게 보내지 않고 지웠습니다.")));
    expect(deleted(r, again)).toBe(1);
    expect(toAi(r, CODE)).toBe(false);
    expect(r.page.state.typed).toEqual([["e6", CODE]]);
  });

  it("a code sent after the gateway lost the step (a restart) is still taken out of the chat, never to the AI (R4)", async () => {
    const r = await stored();
    await r.run(["step", "--name", "도서관", "--kind", "code", "--ref", "e6"]);
    r.endTurn();
    await until(() => r.fake.texts().some((text) => text.includes("인증번호를 묻습니다")));
    // The steps live in memory: a restart forgets them, the chat's input (in the database) stays open.
    const stepId = [...(r.logins as unknown as { steps: Map<string, unknown> }).steps.keys()][0]!;
    r.logins.endStep(stepId);
    const sent = r.fake.message(CODE);
    await until(() => deleted(r, sent) === 1 && r.fake.texts().some((text) => text.startsWith("이 요청은 이미 끝나")));
    expect(toAi(r, CODE)).toBe(false);
    expect(r.page.state.typed).toEqual([]);
    // The conversation is told once, so it does not wait in silence (M12).
    await until(() => continued(r, "fail:step_lost").length === 1);
    expect(toAi(r, CODE)).toBe(false);
  });

  it("login pictures whose send never happened are swept by the chat's own tick, not only by the next picture (M11)", async () => {
    const r = await stored();
    const dir = join(r.dataDir, "credential-tool", "pictures");
    mkdirSync(dir, { recursive: true });
    const old = join(dir, "0123456789abcdef.png");
    writeFileSync(old, "x");
    utimesSync(old, new Date(Date.now() - 2 * 3600_000), new Date(Date.now() - 2 * 3600_000));
    await (r.channels as unknown as { vault: { expire(): Promise<void> } }).vault.expire();
    expect(existsSync(old)).toBe(false);
  });

  it("after a fill, a page part that could not be checked: the step goes without its picture and says so in one line", async () => {
    const r = await stored();
    expect((await r.run(FILL)).stdout).toMatch(/^ok\n/);
    r.page.state.blind = 1;
    expect((await r.run(["step", "--name", "도서관", "--kind", "approve", "--app", "카카오톡"])).stdout).toBe("fail:handover_sent\n");
    await until(() => r.fake.texts().some((text) => text.includes("휴대폰 카카오톡 앱에서 승인해 주세요")));
    expect(r.page.state.shots).toBe(0);
    expect(r.fake.texts().find((text) => text.includes("카카오톡"))).toContain("PC 화면에 넣은 값이 보일 수 있어 화면 사진은 보내지 않았습니다.");
  });

  it("an approval in another app: one message and [했어요], which continues once", async () => {
    const r = await stored();
    expect((await r.run(["step", "--name", "도서관", "--kind", "approve", "--app", "카카오톡"])).stdout).toBe("fail:handover_sent\n");
    r.endTurn();
    await until(() => r.fake.texts().some((text) => text.includes("휴대폰 카카오톡 앱에서 승인해 주세요")));
    pressOn(r, "했어요");
    await until(() => continued(r, "카카오톡 앱에서 승인했다고 합니다").length === 1);
    pressOn(r, "했어요");
    await until(() => r.fake.of("answerCallbackQuery").length >= 2);
    expect(continued(r, "승인했다고")).toHaveLength(1);
  });

  it("a mail link: one of another site is not opened and asked again; the site's own is opened in the same browser and hidden afterwards", async () => {
    const r = await stored();
    expect((await r.run(["step", "--name", "도서관", "--kind", "link"])).stdout).toBe("fail:handover_sent\n");
    r.endTurn();
    await until(() => r.fake.texts().some((text) => text.includes("링크 주소를 복사해 보내 주세요")));
    r.fake.message(`http://127.0.0.2:41233/magic?t=${LINK_TOKEN}`);
    await until(() => r.fake.texts().some((text) => text.includes("사이트의 주소가 아니라 열지 않았습니다")));
    expect(r.page.state.went).toEqual([]);
    r.fake.message(`${SITE}/magic?t=${LINK_TOKEN}`);
    await until(() => continued(r, "로그인 링크를 열었습니다").length === 1);
    expect(r.page.state.went).toEqual([`${SITE}/magic?t=${LINK_TOKEN}`]);
    expect(toAi(r, LINK_TOKEN)).toBe(false);
    expect(r.credentials.scrubber.text(`Page URL: ${SITE}/magic?t=${LINK_TOKEN}`)).not.toContain(LINK_TOKEN);
  });

  it("a mail link of another site twice: the step gives up and the conversation hears fail:wrong_site once", async () => {
    const r = await stored();
    await r.run(["step", "--name", "도서관", "--kind", "link"]);
    r.endTurn();
    await until(() => r.fake.texts().some((text) => text.includes("링크 주소를 복사해 보내 주세요")));
    r.fake.message(`http://127.0.0.2:41233/magic?t=${LINK_TOKEN}`);
    await until(() => r.fake.texts().some((text) => text.includes("사이트의 주소가 아니라 열지 않았습니다")));
    r.fake.message(`http://127.0.0.3:41233/magic?t=${LINK_TOKEN}`);
    await until(() => continued(r, "fail:wrong_site").length === 1);
    expect(r.page.state.went).toEqual([]);
    expect(toAi(r, LINK_TOKEN)).toBe(false);
    r.fake.message("고마워");
    await until(() => toAi(r, "고마워"));
  });

  it("what only the PC can do is said in the design's words, and the chat's next line ('이어서') goes to the AI", async () => {
    const r = await stored();
    expect((await r.run(["step", "--name", "도서관", "--kind", "pc", "--why", "security"])).stdout).toBe("fail:handover_sent\n");
    r.endTurn();
    await until(() => r.fake.texts().some((text) => text.includes("PC에서 끝내고 '이어서'라고 보내 주세요")));
    expect(r.fake.texts().find((text) => text.includes("이어서"))).toContain("보안 프로그램이나 가상 키패드");
    r.fake.message("이어서");
    await until(() => toAi(r, "이어서"));
  });

  it("in a paused chat nothing is said and no input opens; the AI hears fail:chat_paused", async () => {
    const r = await stored();
    const binding = r.channels.core.bindings()[0]!;
    r.channels.core.pause(binding.id, true);
    const said = r.fake.of("sendMessage").length;
    expect((await r.run(["step", "--name", "도서관", "--kind", "code", "--ref", "e6"])).stdout).toBe("fail:chat_paused\n");
    expect(r.fake.of("sendMessage").length).toBe(said);
    expect(r.fake.of("sendPhoto")).toHaveLength(0);
  });
});

describe("fix round 3, ruling A: a human-only input closes only for its own reasons", () => {
  async function codeStep() {
    const r = await paired();
    await r.credentials.add({ name: "도서관", kind: "login", site: SITE, values: { 아이디: ID, 비밀번호: PASSWORD } });
    await r.run(["step", "--name", "도서관", "--kind", "code", "--ref", "e6", "--submit", "e7"]);
    r.endTurn();
    await until(() => r.fake.texts().some((text) => text.includes("인증번호를 묻습니다")));
    return r;
  }
  const SMS = `[Web발신]\n[도서관] 인증번호 [${CODE}]를 입력해 주세요.`;

  it("상태 is answered by the app, ends with what is still awaited, and the SMS sent next is typed and deleted", async () => {
    const r = await codeStep();
    r.fake.message("상태");
    await until(() => r.fake.texts().some((text) => text === "인증번호를 기다리고 있습니다."));
    const sms = r.fake.message(SMS);
    await until(() => continued(r, "인증번호를 넣었습니다").length === 1);
    expect(deleted(r, sms)).toBe(1);
    expect(r.page.state.typed).toEqual([["e6", CODE]]);
    expect(toAi(r, CODE)).toBe(false);
    expect(r.engine.sent.some((entry) => entry.text.trim() === "상태")).toBe(false);
  });

  it("메뉴, then a menu button, then a bare code: the code is taken", async () => {
    const r = await codeStep();
    r.fake.message("메뉴");
    await until(() => r.fake.texts().some((text) => text.startsWith("메뉴 · 지금")));
    await until(() => r.fake.texts().some((text) => text === "인증번호를 기다리고 있습니다."));
    pressOn(r, "사용량");
    await until(() => r.fake.of("editMessageText").length > 0 || r.fake.texts().length > 0);
    const code = r.fake.message(CODE);
    await until(() => continued(r, "인증번호를 넣었습니다").length === 1);
    expect(deleted(r, code)).toBe(1);
    expect(r.page.state.typed).toEqual([["e6", CODE]]);
    expect(toAi(r, CODE)).toBe(false);
  });

  for (const word of ["멈춰", "새 대화", "다시 시도", "잠금"]) {
    it(`${word} ends the code step and says so; a pasted SMS or a bare code after it never reaches the AI`, async () => {
      const r = await codeStep();
      r.fake.message(word);
      // Fix round 4 (P1): the one ending line.
      // Fix round 5, Q1: 잠금 closes the chat, so its line says the gate's sentence.
      await until(() => r.fake.texts().some((text) => text.includes(word === "잠금" ? "'도서관' 인증번호 입력을 닫았습니다. 지금은 채널이 잠겨 있어 보내는 글이 전달되지 않습니다." : "'도서관' 인증번호 입력을 닫았습니다. 지금부터 보내는 글은 AI에게 갑니다.")));
      const sms = r.fake.message(SMS);
      await until(() => deleted(r, sms) === 1);
      if (word === "잠금") r.channels.core.unlock(r.channels.core.bindings()[0]!.id);
      const bare = r.fake.message(CODE);
      await until(() => deleted(r, bare) === 1);
      r.fake.message("다른 일 해 줘");
      await until(() => toAi(r, "다른 일 해 줘"));
      expect(toAi(r, CODE)).toBe(false);
      expect(r.page.state.typed).toEqual([]);
    });
  }
});

describe("fix round 4 minors", () => {
  it("NEW-M-f: 멈춰 does not wait for a send before stopping: with the line about the ended input stuck on its way, the stop still happens", async () => {
    const r = await paired();
    await r.credentials.add({ name: "도서관", kind: "login", site: SITE, values: { 아이디: ID, 비밀번호: PASSWORD } });
    await r.run(["step", "--name", "도서관", "--kind", "code", "--ref", "e6", "--submit", "e7"]);
    // The turn is still running (the AI did not end it): 멈춰 has something to stop.
    await until(() => r.fake.texts().some((text) => text.includes("인증번호를 묻습니다")));
    const reach = (r.channels as unknown as { vault: { reach: { reply: (...args: unknown[]) => Promise<unknown>; say: (...args: unknown[]) => Promise<unknown> } } }).vault.reach;
    const stuck = (send: (...args: unknown[]) => Promise<unknown>) => (...args: unknown[]) => (/^(?:ended|login-ended):/.test(String(args[1])) ? new Promise(() => undefined) : send(...args));
    reach.reply = stuck(reach.reply.bind(reach));
    reach.say = stuck(reach.say.bind(reach));
    r.fake.message("멈춰");
    await until(() => r.engine.interrupted.includes(r.sessionId));
  });
});
