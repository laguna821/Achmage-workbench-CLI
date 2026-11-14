import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DaemonArgs, DaemonAnswer, HostPage } from "../browse-host.ts";
import { cleanKits, pair, say, startKit } from "../channels/test-kit.ts";
import { OfficeVault } from "../office-vault.ts";
import { formsOf } from "./forms.ts";
import { LoginFiller, type HostQuestion, type LoginChatSide, type LoginStep } from "./fill.ts";
import { installScrubber } from "./install.ts";
import { CredentialService } from "./service.ts";

// `workbench-credential fill` and `step` (unit 9) against a stand-in page that answers the daemon's
// commands as the real one does (its `fill` answer repeats the value, as Playwright's does). The
// value goes from the store to the page's `fill` and nowhere else. Made-up values only.

const USER = "zz-fake-user-0909";
const PASSWORD = "zz-fake-pass-0909";
const SITE = "http://127.0.0.1:41233";

afterEach(() => cleanKits());

type El = { tag: string; type: string; frame?: string };
/** A login page as the daemon sees it: its address, its elements by ref, what was typed and pressed. */
function standInPage(url = `${SITE}/login`, elements: Record<string, El> = { e4: { tag: "input", type: "text" }, e6: { tag: "input", type: "password" }, e7: { tag: "button", type: "submit" } }) {
  const state = { url, elements, title: "도서관 로그인", typed: [] as [string, string][], pressed: [] as string[], went: [] as string[], shown: { values: [] as string[], text: "로그인", blind: 0 }, sent: [] as DaemonArgs[], stale: new Set<string>(), marked: [] as [string, string[], number][], forgot: [] as string[] };
  const page: HostPage = {
    typed: (label, values) => { state.marked.push([label, values, state.typed.length]); },
    forget: (key) => { state.forgot.push(key); },
    live: () => state.marked.length > 0,
    hide: (text) => state.marked.flatMap(([label, values]) => values.map((value) => [label, value] as const)).reduce((out, [label, value]) => out.replaceAll(value, `[비밀: ${label}]`), text),
    run: async (args: DaemonArgs): Promise<DaemonAnswer> => {
      state.sent.push(args);
      const [command, first, second] = args._;
      if (command === "eval") {
        if (second) {
          if (state.stale.has(second) || !state.elements[second]) return { error: true, text: `### Error\nError: Ref ${second} not found in the current page snapshot. Try capturing new snapshot.` };
          const element = state.elements[second]!;
          return { error: false, text: JSON.stringify(JSON.stringify({ tag: element.tag, type: element.type, frame: element.frame ?? state.url })) };
        }
        if (first!.includes("location.href")) return { error: false, text: JSON.stringify(state.url) };
        if (first!.includes("document.title")) return { error: false, text: JSON.stringify(state.title) };
        if (first!.includes("innerText")) return { error: false, text: JSON.stringify(JSON.stringify(state.shown)) };
      }
      if (command === "fill") {
        if (state.stale.has(first!)) return { error: true, text: `### Error\nRef ${first} not found in the current page snapshot.` };
        state.typed.push([first!, second!]);
        return { error: false, text: `### Ran Playwright code\nawait page.getByRole('textbox').fill('${second}');` };
      }
      if (command === "click") { state.pressed.push(first!); state.title = "내 서재"; return { error: false, text: "### Ran Playwright code\nawait page.click()" }; }
      if (command === "goto") { state.went.push(first!); return { error: false, text: "" }; }
      if (command === "screenshot") { writeFileSync(String(args.filename), Buffer.from("89504e470d0a1a0a", "hex")); return { error: false, text: "### Result" }; }
      return { error: true, text: "unknown" };
    },
  };
  return { page, state };
}

async function fillKit(options: { askEachTime?: boolean; page?: ReturnType<typeof standInPage>; hostPage?: string } = {}) {
  const kit = await startKit();
  const vault = new OfficeVault(kit.dataDir, async () => ({ id: "c".repeat(32), key: Buffer.alloc(32, 7) }));
  const service = new CredentialService({ dataDir: kit.dataDir, vault, manager: kit.manager, now: () => kit.clock.now });
  installScrubber(kit.store, kit.manager, service.scrubber);
  const entry = await service.add({ name: "도서관", kind: "login", site: SITE, values: { 아이디: USER, 비밀번호: PASSWORD } });
  if (options.askEachTime) service.store.setAsk(entry.id, true);
  const page = options.page ?? standInPage();
  const filler = new LoginFiller({ service, dataDir: kit.dataDir, page: () => options.hostPage ?? page.page });
  filler.install();
  const notices: { key: string; text: string }[] = [], used: string[] = [], asked: LoginStep[] = [], hostAsked: HostQuestion[] = [];
  const chat: LoginChatSide = {
    reaches: () => true,
    askStep: async (step) => { asked.push(step); return "asked"; },
    askHost: async (question) => { hostAsked.push(question); return "asked"; },
    notice: async (_sessionId, key, text) => { if (!notices.some((notice) => notice.key === key)) notices.push({ key, text }); },
    used: (_sessionId, name, host, result) => used.push(`${name} ${host} ${result}`),
  };
  filler.chat = chat;
  await pair(kit);
  await say(kit, "도서관에서 대출 목록 받아 줘");
  const sessionId = kit.engine.sent.at(-1)!.sessionId;
  const run = (args: string[]) => service.run(sessionId, args);
  return { ...kit, service, filler, page, run, sessionId, notices, used, asked, hostAsked };
}

const FILL = ["fill", "--name", "도서관", "--ref", "아이디=e4", "--ref", "비밀번호=e6", "--submit", "e7"];

/** Every place a test can look besides the page: the tool's answers, the data folder, the chat and the log. */
function leaks(kit: Awaited<ReturnType<typeof fillKit>>, answers: unknown[], value = PASSWORD) {
  const found: string[] = [];
  const forms = formsOf(value);
  const text = JSON.stringify([answers, kit.notices, kit.used, kit.adapter.sent, kit.lines, kit.manager.items(kit.sessionId).items]);
  for (const form of forms) if (text.includes(form)) found.push(`memory:${form}`);
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (forms.some((form) => readFileSync(path).includes(form))) found.push(path);
    }
  };
  walk(kit.dataDir);
  return found;
}

describe("fill: the AI points, the gateway types", () => {
  it("types each stored value at its ref and presses submit; the AI hears ok and the title, never a value", async () => {
    const kit = await fillKit();
    const result = await kit.run(FILL);
    expect(result).toEqual({ code: 0, stdout: "ok\n제목: 내 서재\n", stderr: "" });
    expect(kit.page.state.typed).toEqual([["e4", USER], ["e6", PASSWORD]]);
    expect(kit.page.state.pressed).toEqual(["e7"]);
    expect(kit.used).toEqual(["도서관 127.0.0.1 ok"]);
    expect(leaks(kit, [result])).toEqual([]);
  });

  it("is refused on any other site, typing nothing, and the chat is told once", async () => {
    for (const url of ["http://127.0.0.2:41233/login", "http://127.0.0.1:41234/login", "http://localhost:41233/login"]) {
      const kit = await fillKit({ page: standInPage(url) });
      expect((await kit.run(FILL)).stdout).toBe("fail:wrong_site\n");
      expect((await kit.run(FILL)).stdout).toBe("fail:wrong_site\n");
      expect(kit.page.state.typed).toEqual([]);
      expect(kit.notices).toHaveLength(1);
      expect(kit.notices[0]!.text).toContain("저장한 사이트에서만 넣습니다");
    }
  });

  it("on another real host types nothing and asks the person once; allowed, the entry keeps the host and the fill goes", async () => {
    const page = standInPage("https://sso.example.ac.kr/login");
    const kit = await fillKit({ page });
    await kit.service.add({ name: "포털", kind: "login", site: "portal.example.ac.kr", values: { 아이디: USER, 비밀번호: PASSWORD } });
    const PORTAL = ["fill", "--name", "포털", "--ref", "아이디=e4", "--ref", "비밀번호=e6", "--submit", "e7"];
    expect((await kit.run(PORTAL)).stdout).toBe("fail:handover_sent\n");
    expect((await kit.run(PORTAL)).stdout).toBe("fail:handover_sent\n");
    expect(page.state.typed).toEqual([]);
    expect(kit.hostAsked.map(({ name, own, host }) => ({ name, own, host }))).toEqual([{ name: "포털", own: "portal.example.ac.kr", host: "sso.example.ac.kr" }]);
    expect(kit.notices).toEqual([]);
    expect(kit.filler.answerHost(kit.hostAsked[0]!.id, true)?.host).toBe("sso.example.ac.kr");
    expect(kit.service.store.find("포털")!.hosts).toEqual(["sso.example.ac.kr"]);
    expect(kit.filler.answerHost(kit.hostAsked[0]!.id, true)).toBeNull();
    expect((await kit.run(PORTAL)).stdout).toMatch(/^ok\n/);
    expect(page.state.typed).toEqual([["e4", USER], ["e6", PASSWORD]]);
  });

  it("a host the person refused is not asked again in that conversation; a look-alike or an address is never asked", async () => {
    const page = standInPage("https://sso.example.ac.kr/login");
    const kit = await fillKit({ page });
    await kit.service.add({ name: "포털", kind: "login", site: "portal.example.ac.kr", values: { 아이디: USER, 비밀번호: PASSWORD } });
    const PORTAL = ["fill", "--name", "포털", "--ref", "비밀번호=e6"];
    await kit.run(PORTAL);
    kit.filler.answerHost(kit.hostAsked[0]!.id, false);
    expect((await kit.run(PORTAL)).stdout).toBe("fail:wrong_site\n");
    expect(kit.hostAsked).toHaveLength(1);
    expect(kit.service.store.find("포털")!.hosts).toBeUndefined();
    for (const url of ["https://portal.example.ac.kr.evil.example/login", "https://p0rtal.example.ac.kr/login", "https://portal-example.ac.kr/", "https://127.0.0.2/login"]) {
      page.state.url = url;
      expect((await kit.run(PORTAL)).stdout, url).toBe("fail:wrong_site\n");
    }
    expect(kit.hostAsked).toHaveLength(1);
    expect(kit.notices).toHaveLength(1);
    expect(page.state.typed).toEqual([]);
  });

  it("asks about at most 3 distinct hosts per conversation and entry; a fourth is refused (fail:wrong_site) without asking", async () => {
    const page = standInPage("https://sso1.example.org/login");
    const kit = await fillKit({ page });
    await kit.service.add({ name: "포털", kind: "login", site: "portal.example.ac.kr", values: { 아이디: USER, 비밀번호: PASSWORD } });
    const PORTAL = ["fill", "--name", "포털", "--ref", "비밀번호=e6"];
    for (const host of ["sso1.example.org", "sso2.example.org", "sso3.example.org"]) {
      page.state.url = `https://${host}/login`;
      expect((await kit.run(PORTAL)).stdout, host).toBe("fail:handover_sent\n");
    }
    for (const host of ["sso4.example.org", "sso5.example.org"]) {
      page.state.url = `https://${host}/login`;
      expect((await kit.run(PORTAL)).stdout, host).toBe("fail:wrong_site\n");
    }
    // One already asked is still the pending question, not a new one.
    page.state.url = "https://sso2.example.org/login";
    expect((await kit.run(PORTAL)).stdout).toBe("fail:handover_sent\n");
    expect(kit.hostAsked.map((question) => question.host)).toEqual(["sso1.example.org", "sso2.example.org", "sso3.example.org"]);
    expect(page.state.typed).toEqual([]);
  });

  it("is refused for a field in a frame of another site, and on plain http for an entry stored for https", async () => {
    const framed = await fillKit({ page: standInPage(`${SITE}/login`, { e4: { tag: "input", type: "text" }, e6: { tag: "input", type: "password", frame: "http://127.0.0.2:41233/frame" }, e7: { tag: "button", type: "submit" } }) });
    expect((await framed.run(FILL)).stdout).toBe("fail:wrong_site\n");
    expect(framed.page.state.typed).toEqual([]);
    // The right login framed inside another site's page (the top page decides too).
    const inside = await fillKit({ page: standInPage("http://127.0.0.2:41233/evil", { e4: { tag: "input", type: "text", frame: `${SITE}/login` }, e6: { tag: "input", type: "password", frame: `${SITE}/login` }, e7: { tag: "button", type: "submit", frame: `${SITE}/login` } }) });
    expect((await inside.run(FILL)).stdout).toBe("fail:wrong_site\n");
    expect(inside.page.state.typed).toEqual([]);
    const kit = await fillKit({ page: standInPage("http://portal.example.ac.kr/login") });
    await kit.service.add({ name: "포털", kind: "login", site: "portal.example.ac.kr", values: { 아이디: USER, 비밀번호: PASSWORD } });
    expect((await kit.run(["fill", "--name", "포털", "--ref", "비밀번호=e6"])).stdout).toBe("fail:insecure\n");
    expect(kit.page.state.typed).toEqual([]);
  });

  it("never types a secret into a text input (it would show in every snapshot and screenshot); an ID may go there", async () => {
    const kit = await fillKit({ page: standInPage(`${SITE}/login`, { e4: { tag: "input", type: "text" }, e5: { tag: "input", type: "text" }, e7: { tag: "button", type: "submit" } }) });
    expect((await kit.run(["fill", "--name", "도서관", "--ref", "아이디=e4", "--ref", "비밀번호=e5"])).stdout).toBe("fail:visible_field\n");
    expect(kit.page.state.typed).toEqual([]);
    expect((await kit.run(["fill", "--name", "도서관", "--ref", "아이디=e4"])).stdout).toMatch(/^ok\n/);
    expect(kit.page.state.typed).toEqual([["e4", USER]]);
  });

  it("answers fixed codes: a ref gone after the page moved, an unknown entry or field, no page, Lightpanda", async () => {
    const page = standInPage();
    page.state.stale.add("e6");
    const kit = await fillKit({ page });
    expect((await kit.run(FILL)).stdout).toBe("fail:stale_ref\n");
    expect(kit.page.state.typed).toEqual([]);
    expect((await kit.run(["fill", "--name", "없는것", "--ref", "비밀번호=e6"])).stdout).toBe("fail:not_stored\n");
    expect((await kit.run(["fill", "--name", "도서관", "--ref", "PIN=e6"])).stdout).toBe("fail:unknown_field\n");
    expect((await kit.run(["fill", "--name", "도서관", "--ref", "비밀번호=#pw"])).stdout).toBe("fail:bad_arguments\n");
    const none = await fillKit({ hostPage: "no_page" });
    expect((await none.run(FILL)).stdout).toBe("fail:no_page\n");
    const panda = await fillKit({ hostPage: "needs_chromium" });
    expect((await panda.run(FILL)).stdout).toBe("fail:needs_chromium\n");
    expect(panda.notices.map((notice) => notice.key)).toEqual([`login-chromium:${panda.sessionId}`]);
    // It says exactly where at the PC (the app's own control), once, and that '이어서' goes on.
    expect(panda.notices[0]!.text).toContain("PC의 Workbench에서 대화 입력창 아래 '브라우저' → '탐색 방식'을 'Chromium'으로 바꿔 주세요. 한 번만 하면 됩니다.");
    expect(panda.notices[0]!.text).toContain("'이어서'라고 보내 주세요");
    const missing = await fillKit({ hostPage: "browser_missing" });
    expect((await missing.run(FILL)).stdout).toBe("fail:browser_missing\n");
    expect(missing.notices[0]!.text).toContain("대화 입력창 아래 '브라우저' → '설치'");
  });

  it("marks the secret values it types on the window before typing them (a short password is then hidden in what the window answers); the ID is not marked", async () => {
    const kit = await fillKit();
    expect((await kit.run(FILL)).code).toBe(0);
    expect(kit.page.state.marked).toEqual([["도서관", [PASSWORD], 0]]);
    const step = await fillKit();
    await step.run(["step", "--name", "도서관", "--kind", "code", "--ref", "e6"]);
    expect(await step.filler.typeOnce(step.asked[0]!, "482913")).toBe("ok");
    expect(step.page.state.marked).toEqual([["도서관", ["482913"], 0]]);
    // A code shown in a text input is not pictured for the chat either.
    step.page.state.shown = { values: ["482913"], text: "인증", blind: 0 };
    expect(await step.filler.picture(step.sessionId, SITE)).toBeNull();
  });

  it("매번 묻기: asks first and types nothing; once allowed, types once", async () => {
    const kit = await fillKit({ askEachTime: true });
    expect((await kit.run(FILL)).stdout).toBe("fail:handover_sent\n");
    expect(kit.page.state.typed).toEqual([]);
    const leave = kit.service.state().waiting.find((handoff) => handoff.mode === "use")!;
    await kit.service.allow(leave.id, true);
    expect((await kit.run(FILL)).stdout).toMatch(/^ok\n/);
    expect(kit.page.state.typed).toHaveLength(2);
    expect((await kit.run(FILL)).stdout).toBe("fail:handover_sent\n");
    expect(kit.page.state.typed).toHaveLength(2);
  });

  it("R5: with the keyring locked nothing is typed", async () => {
    const kit = await fillKit();
    const locked = new CredentialService({ dataDir: kit.dataDir, vault: new OfficeVault(kit.dataDir, async () => { throw new Error("locked"); }), manager: kit.manager, now: () => kit.clock.now });
    const filler = new LoginFiller({ service: locked, dataDir: kit.dataDir, page: () => kit.page.page });
    filler.install();
    filler.chat = { reaches: () => true, askStep: async () => "asked", askHost: async () => "asked", notice: async (_s, key, text) => void kit.notices.push({ key, text }), used: () => undefined };
    expect((await locked.run(kit.sessionId, FILL)).stdout).toBe("fail:keyring_locked\n");
    expect(kit.page.state.typed).toEqual([]);
  });
});

describe("step: what only the person has", () => {
  it("tells the engine never to ask for a one-time code with need (it would be stored)", () => {
    const text = new LoginFiller({ service: { commands: new Map() } as unknown as CredentialService, dataDir: "/x", page: () => "no_page" }).install();
    expect(text).toContain("Never use need for a one-time code, an approval in another app or a mail link");
  });

  it("a one-time code: asked in the chat, typed by the gateway on the entry's site, never stored", async () => {
    const kit = await fillKit();
    const before = readFileSync(join(kit.dataDir, "credentials", "store.json"), "utf8");
    expect((await kit.run(["step", "--name", "도서관", "--kind", "code", "--ref", "e6", "--submit", "e7", "--label", "문자 인증번호"])).stdout).toBe("fail:handover_sent\n");
    expect(kit.asked).toMatchObject([{ kind: "code", ref: "e6", submit: "e7", label: "문자 인증번호", name: "도서관" }]);
    expect(await kit.filler.typeOnce(kit.asked[0]!, "482913")).toBe("ok");
    expect(kit.page.state.typed).toEqual([["e6", "482913"]]);
    // Under 8 characters it is not looked for (the scrubber's rule; it is spent once used).
    expect(readFileSync(join(kit.dataDir, "credentials", "store.json"), "utf8")).toBe(before);
    // Its mark on the window ends with its step, not 30 minutes later.
    expect(kit.page.state.marked.at(-1)![1]).toEqual(["482913"]);
    kit.filler.endStep(kit.asked[0]!.id);
    expect(kit.page.state.forgot).toEqual([kit.asked[0]!.id]);
  });

  it("a code is not asked for a field on another site; a mail link of another site is not opened", async () => {
    const kit = await fillKit({ page: standInPage("http://127.0.0.2:41233/otp") });
    expect((await kit.run(["step", "--name", "도서관", "--kind", "code", "--ref", "e6"])).stdout).toBe("fail:wrong_site\n");
    expect(kit.asked).toEqual([]);
    const other = await fillKit();
    expect((await other.run(["step", "--name", "도서관", "--kind", "link"])).stdout).toBe("fail:handover_sent\n");
    expect(await other.filler.openLink(other.asked[0]!, "http://127.0.0.2:41233/magic?t=zz-fake-token")).toBe("wrong_site");
    expect(await other.filler.openLink(other.asked[0]!, `${SITE}/magic?t=zz-fake-token`)).toBe("ok");
    expect(other.page.state.went).toEqual([`${SITE}/magic?t=zz-fake-token`]);
    // The link is a login of its own: hidden in whatever the AI reads next (the page's address).
    expect(other.service.scrubber.text(`Page URL: ${SITE}/magic?t=zz-fake-token`)).toBe("Page URL: [비밀: 도서관]");
  });

  it("an approval in another app and a PC-only step are asked; without a chat the AI is told to say it at the PC", async () => {
    const kit = await fillKit();
    expect((await kit.run(["step", "--name", "도서관", "--kind", "approve", "--app", "카카오톡"])).stdout).toBe("fail:handover_sent\n");
    expect((await kit.run(["step", "--name", "도서관", "--kind", "pc", "--why", "captcha"])).stdout).toBe("fail:handover_sent\n");
    expect(kit.asked.map((step) => [step.kind, step.app ?? step.why])).toEqual([["approve", "카카오톡"], ["pc", "captcha"]]);
    expect((await kit.run(["step", "--name", "도서관", "--kind", "pc", "--why", "fingerprint"])).stdout).toBe("fail:bad_arguments\n");
    kit.filler.chat = { ...kit.filler.chat!, reaches: () => false };
    expect((await kit.run(["step", "--name", "도서관", "--kind", "approve", "--app", "카카오톡"])).stdout).toBe("fail:no_chat\n");
  });
});

describe("a picture of the page for the chat", () => {
  it("is taken only on the site asked about and never while a stored value shows as text", async () => {
    const kit = await fillKit();
    const path = await kit.filler.picture(kit.sessionId, SITE);
    expect(path && existsSync(path)).toBeTruthy();
    expect(await kit.filler.picture(kit.sessionId, "http://127.0.0.2:41233")).toBeNull();
    kit.page.state.shown = { values: [PASSWORD], text: "로그인", blind: 0 };
    expect(await kit.filler.picture(kit.sessionId, SITE)).toBeNull();
    kit.page.state.shown = { values: [], text: `비밀번호: ${PASSWORD}`, blind: 0 };
    expect(await kit.filler.picture(kit.sessionId, SITE)).toBeNull();
  });

  it("a page with a frame or shadow root that could not be read: no picture while a typed value is live (said, not silent); a picture otherwise", async () => {
    const kit = await fillKit();
    kit.page.state.shown = { values: [], text: "로그인", blind: 1 };
    const before = await kit.filler.picture(kit.sessionId, SITE);
    expect(before && before !== "withheld" && existsSync(before)).toBeTruthy();
    expect((await kit.run(FILL)).stdout).toMatch(/^ok\n/);
    expect(await kit.filler.picture(kit.sessionId, SITE)).toBe("withheld");
  });
});
