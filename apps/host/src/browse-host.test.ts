import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { browserSessionName, type AccessMode, type Session, type TranscriptItem, type Work } from "@workbench/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentBrowser, noPasswordManager } from "./browse.ts";
import { daemonRun, daemonSocket, hideTyped, hostPageOf } from "./browse-host.ts";
import { TranscriptScrubber } from "./credentials/scrubber.ts";

// Unit 9: the gateway's own commands on the agent browser go to the CLI daemon's socket, never
// through a process (a value in a command line can be read by any program of the same user), and
// every answer an engine reads from the browser has stored values replaced. A stand-in daemon
// speaks the CLI's socket line; made-up values only.

const VALUE = "zz-fake-pass-0909";
/** A short password: under the scrubber's 8 characters, so only the window's own rule hides it. */
const SHORT = "zz7f09";
const FAKE_CLI = resolve("scripts/fixtures/fake-playwright-cli.mjs");
const dirs: string[] = [];
const servers: Server[] = [];
const browsers: AgentBrowser[] = [];
const saved = process.env.PWTEST_DAEMON_SESSION_DIR;
afterEach(async () => {
  for (const browser of browsers.splice(0)) await browser.shutdown();
  for (const server of servers.splice(0)) server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (saved === undefined) delete process.env.PWTEST_DAEMON_SESSION_DIR; else process.env.PWTEST_DAEMON_SESSION_DIR = saved;
});

/** A stand-in daemon: a session file naming its socket, and what it was sent. */
async function standInDaemon(name: string, profile: string, answer: (args: Record<string, unknown>, raw: boolean) => { isError?: boolean; text: string } | Promise<{ isError?: boolean; text: string }>, socketDir?: string) {
  const root = mkdtempSync(join(tmpdir(), "wb-daemon-"));
  dirs.push(root);
  process.env.PWTEST_DAEMON_SESSION_DIR = join(root, "daemon");
  mkdirSync(join(root, "daemon", "0123456789abcdef"), { recursive: true });
  if (socketDir) mkdirSync(socketDir, { recursive: true });
  const socketPath = join(socketDir ?? root, `${name}.sock`);
  const received: { args: Record<string, unknown>; raw: boolean; cwd: unknown }[] = [];
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const message = JSON.parse(buffer.slice(0, end)) as { id: number; params: { args: Record<string, unknown>; raw?: boolean; cwd: unknown } };
      received.push({ args: message.params.args, raw: Boolean(message.params.raw), cwd: message.params.cwd });
      void Promise.resolve(answer(message.params.args, Boolean(message.params.raw))).then((result) => { if (!socket.destroyed) socket.write(`${JSON.stringify({ id: message.id, result })}\n`); });
    });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(socketPath, done));
  writeFileSync(join(root, "daemon", "0123456789abcdef", `${name}.session`), JSON.stringify({ name, version: "0.1.22", socketPath, browser: { userDataDir: profile } }));
  return { socketPath, received };
}

describe("the gateway's hand on the daemon", () => {
  it("finds the daemon of this session on this profile only, and sends the command as the CLI would, without a process", async () => {
    const daemon = await standInDaemon("wb-abc", "/data/agent-browser/profile", () => ({ text: "### Ran Playwright code\nawait page.fill('…')" }));
    expect(daemonSocket("wb-abc", "/data/agent-browser/profile")).toBe(daemon.socketPath);
    expect(daemonSocket("wb-abc", "/other/profile")).toBeNull();
    expect(daemonSocket("wb-other", "/data/agent-browser/profile")).toBeNull();
    const order: string[] = [];
    const page = hostPageOf("wb-abc", "/data/agent-browser/profile", "/work", async (work) => { order.push("serial"); return work(); });
    const answer = await page.run({ _: ["fill", "e4", VALUE] });
    expect(answer).toEqual({ error: false, text: "### Ran Playwright code\nawait page.fill('…')" });
    expect(order).toEqual(["serial"]);
    expect(daemon.received).toEqual([{ args: { _: ["fill", "e4", VALUE] }, raw: false, cwd: "/work" }]);
  });

  it("with the gateway's socket folder given, takes only a socket of this user inside it (a session file naming another socket is not the gateway's daemon)", async () => {
    const outside = await standInDaemon("wb-abc", "/data/agent-browser/profile", () => ({ text: "ok" }));
    const sockets = join(dirname(process.env.PWTEST_DAEMON_SESSION_DIR!), "s");
    mkdirSync(sockets, { recursive: true });
    expect(daemonSocket("wb-abc", "/data/agent-browser/profile")).toBe(outside.socketPath);
    expect(daemonSocket("wb-abc", "/data/agent-browser/profile", sockets)).toBeNull();
    const inside = await standInDaemon("wb-abc", "/data/agent-browser/profile", () => ({ text: "ok" }), join(sockets, "cli"));
    expect(daemonSocket("wb-abc", "/data/agent-browser/profile", sockets)).toBe(inside.socketPath);
    // Not a socket (a file planted under the name): refused.
    writeFileSync(join(sockets, "cli", "planted.sock"), "");
    writeFileSync(join(process.env.PWTEST_DAEMON_SESSION_DIR!, "0123456789abcdef", "wb-planted.session"), JSON.stringify({ socketPath: join(sockets, "cli", "planted.sock"), browser: { userDataDir: "/data/agent-browser/profile" } }));
    expect(daemonSocket("wb-planted", "/data/agent-browser/profile", sockets)).toBeNull();
  });

  it("answers an error code when there is no daemon, or it says no", async () => {
    const daemon = await standInDaemon("wb-abc", "/p", () => ({ isError: true, text: "### Error\nRef e4 not found in the current page snapshot." }));
    expect(await daemonRun(daemon.socketPath, { _: ["fill", "e4", "x"] }, { cwd: "/" })).toMatchObject({ error: true });
    expect(await daemonRun(join(tmpdir(), "wb-no-such.sock"), { _: ["snapshot"] }, { cwd: "/" })).toEqual({ error: true, text: "no_daemon" });
  });
});

function setup(access: AccessMode = "full", extra: { hostTimeoutMs?: number } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "wb-browse-"));
  const cwd = mkdtempSync(join(tmpdir(), "wb-browse-work-"));
  dirs.push(dataDir, cwd);
  process.env.FAKE_PWCLI_DIR = join(dataDir, "fake");
  const session = { id: "5a1e0c3d-aaaa-bbbb-cccc-ddddeeeeffff", workId: "w1", provider: "claude", status: "running", browser: true, nativeSessionId: null, archivedAt: null, purpose: "로그인" } as unknown as Session;
  const state = { session, access };
  const browser = new AgentBrowser({ dataDir, cli: FAKE_CLI, idleCloseMs: 60_000, ...extra });
  browsers.push(browser);
  const items: TranscriptItem[] = [];
  browser.bind({
    lookup: (id) => (id === state.session.id ? { session: state.session, work: { id: "w1", cwd } as Work, access: state.access } : null),
    sessions: () => [state.session],
    upsertItem: (_id, item) => items.push(item),
    updateSession: (_id, patch) => { state.session = { ...state.session, ...patch }; },
    publish: () => undefined,
  });
  const name = browserSessionName(session.id);
  const cli = (args: string[]) => new Promise<{ code: number | null; out: string }>((done) => {
    const child = spawn("playwright-cli", args, { cwd, env: { ...process.env, PATH: `${browser.paths.bin}${delimiter}${process.env.PATH}` } });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("exit", (code) => done({ code, out }));
  });
  return { browser, state, name, cli, cwd, dataDir, items };
}

describe("what an engine reads from the agent browser", () => {
  it("has stored values replaced, in the answer and in the snapshot file it links", async () => {
    const { browser, name, cli, cwd } = setup();
    browser.scrubOutput = (text) => text.replaceAll(VALUE, "[비밀: 포털]");
    expect((await cli([`-s=${name}`, "open", "https://example.com"])).code).toBe(0);
    // A page shows a typed password in its snapshot (Playwright's AI snapshot prints an input's value).
    const echoed = await cli([`-s=${name}`, "hover", VALUE]);
    expect(echoed.out).toContain("[비밀: 포털]");
    expect(echoed.out).not.toContain(VALUE);
    mkdirSync(join(cwd, ".playwright-cli"), { recursive: true });
    writeFileSync(join(cwd, ".playwright-cli", "page-1.yml"), `- textbox "비밀번호" [ref=e6]: ${VALUE}\n`);
    const moved = await cli([`-s=${name}`, "goto", "https://example.com/next"]);
    expect(moved.out).toMatch(/\[Snapshot\]\([^)]*page-1\.yml\)/);
    expect(readFileSync(join(cwd, ".playwright-cli", "page-1.yml"), "utf8")).toBe(`- textbox "비밀번호" [ref=e6]: [비밀: 포털]\n`);
  }, 30_000);

  it("a value the gateway typed is hidden in all the window answers afterwards, whatever its length: answers, snapshot files (its own commands' too) and approval cards", async () => {
    const { browser, state, name, cli, cwd, items } = setup();
    // Nothing stored is this short: the scrubber leaves it.
    browser.scrubOutput = (text) => text;
    expect((await cli([`-s=${name}`, "open", "https://example.com"])).code).toBe(0);
    const file = join(cwd, ".playwright-cli", "page-1.yml");
    mkdirSync(dirname(file), { recursive: true });
    await standInDaemon(name, browser.paths.profile, (args) => ({ text: (args._ as string[])[0] === "click" ? `### Page\n### Snapshot\n- [Snapshot](${file})` : "### Ran Playwright code" }), join(browser.socketsDir, "cli"));
    const page = browser.hostPage(state.session.id);
    if (typeof page === "string") throw new Error(page);
    page.typed("포털", [SHORT]);
    // The real daemon writes a snapshot file after the gateway's own click; the field still holds the value.
    writeFileSync(file, `- textbox "비밀번호" [ref=e6]: ${SHORT}\n- textbox "아이디" [ref=e4]: zz-user\n`);
    await page.run({ _: ["click", "e7"] });
    expect(readFileSync(file, "utf8")).toBe(`- textbox "비밀번호" [ref=e6]: [비밀: 포털]\n- textbox "아이디" [ref=e4]: zz-user\n`);
    expect(page.hide(`값 ${SHORT}`)).toBe("값 [비밀: 포털]");
    const echoed = await cli([`-s=${name}`, "hover", SHORT]);
    expect(echoed.out).not.toContain(SHORT);
    writeFileSync(file, `- textbox "비밀번호" [ref=e6]: ${SHORT}\n`);
    expect((await cli([`-s=${name}`, "goto", "https://example.com/next"])).code).toBe(0);
    expect(readFileSync(file, "utf8")).not.toContain(SHORT);
    // An approval card describes the field from the last snapshot: never with its value.
    state.access = "auto";
    const clicking = cli([`-s=${name}`, "click", "e6"]);
    for (let round = 0; round < 100 && !items.some((item) => item.kind === "approval"); round += 1) await new Promise((done) => setTimeout(done, 50));
    const card = items.find((item) => item.kind === "approval")!;
    expect(JSON.stringify(card)).toContain("비밀번호");
    expect(JSON.stringify(card)).not.toContain(SHORT);
    browser.answer(state.session.id, card.id, "decline");
    await clicking;
  }, 30_000);

  it("a short or all-digit typed value (a PIN, a one-time code) is hidden as a field's value and, since round 4 (ruling P4), as any whole token of running text, never inside refs; a longer one everywhere but refs", () => {
    const page = [
      "- text: 2026년 3월 · 문의 010-2026-1234 · 482913번 주문",
      '- link "다음" [ref=e2026]',
      '- link "f7e123 다음" [ref=f7e1234]',
      '- textbox "PIN" [ref=e5]: 2026',
      '- textbox "인증번호" [ref=e6]: 482913',
      '- textbox "전화" [ref=e7]: 010-2026-1234',
      '- textbox "비밀번호" [ref=e8]: "f7e123"',
      "### Result",
      '"482913"',
      "2026",
    ].join("\n");
    const out = hideTyped(page, [{ label: "핀", value: "2026" }, { label: "인증번호", value: "482913" }, { label: "포털", value: "f7e123" }]);
    expect(out.split("\n")).toEqual([
      "- text: [비밀: 핀]년 3월 · 문의 010-[비밀: 핀]-1234 · [비밀: 인증번호]번 주문",
      '- link "다음" [ref=e2026]',
      '- link "[비밀: 포털] 다음" [ref=f7e1234]',
      '- textbox "PIN" [ref=e5]: [비밀: 핀]',
      '- textbox "인증번호" [ref=e6]: [비밀: 인증번호]',
      '- textbox "전화" [ref=e7]: 010-[비밀: 핀]-1234',
      '- textbox "비밀번호" [ref=e8]: [비밀: 포털]',
      "### Result",
      "[비밀: 인증번호]",
      "[비밀: 핀]",
    ]);
  });

  it("a one-time code's mark ends two minutes after its step ends (round 4, ruling P4); a stored login's stays", async () => {
    const { browser, state, name, cli } = setup();
    expect((await cli([`-s=${name}`, "open", "https://example.com"])).code).toBe(0);
    const page = browser.hostPage(state.session.id);
    if (typeof page === "string") throw new Error(page);
    page.typed("포털", [SHORT]);
    page.typed("인증번호", ["482913"], "s_step1");
    const field = '- textbox "인증번호" [ref=e6]: 482913\n- textbox "비밀번호" [ref=e8]: ' + SHORT;
    expect(page.hide(field)).toBe('- textbox "인증번호" [ref=e6]: [비밀: 인증번호]\n- textbox "비밀번호" [ref=e8]: [비밀: 포털]');
    page.forget("s_step1");
    expect(page.hide(field)).toBe('- textbox "인증번호" [ref=e6]: [비밀: 인증번호]\n- textbox "비밀번호" [ref=e8]: [비밀: 포털]');
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2 * 60_000 + 1);
    expect(page.hide(field)).toBe('- textbox "인증번호" [ref=e6]: 482913\n- textbox "비밀번호" [ref=e8]: [비밀: 포털]');
    vi.restoreAllMocks();
  }, 30_000);

  it("an engine's screenshot or PDF is refused while a typed value shows as text on the page (a 'show password' toggle); otherwise it runs", async () => {
    const { browser, state, name, cli, dataDir } = setup();
    expect((await cli([`-s=${name}`, "open", "https://example.com"])).code).toBe(0);
    let shown: { values: string[]; text: string; blind?: number } = { values: [] as string[], text: "로그인" };
    await standInDaemon(name, browser.paths.profile, (args) => ({ text: (args._ as string[])[0] === "eval" ? JSON.stringify(JSON.stringify(shown)) : "ok" }), join(browser.socketsDir, "cli"));
    const page = browser.hostPage(state.session.id);
    if (typeof page === "string") throw new Error(page);
    page.typed("포털", [SHORT]);
    shown = { values: [SHORT], text: "로그인" };
    for (const command of ["screenshot", "pdf"]) {
      const refused = await cli([`-s=${name}`, command]);
      expect(refused.code).not.toBe(0);
      expect(refused.out).toContain("찍지 않았습니다");
    }
    expect(readFileSync(join(dataDir, "fake", "commands.log"), "utf8")).not.toMatch(/ (screenshot|pdf)/);
    shown = { values: ["", "zz-user"], text: "로그인" };
    expect((await cli([`-s=${name}`, "screenshot"])).code).toBe(0);
    expect(readFileSync(join(dataDir, "fake", "commands.log"), "utf8")).toMatch(/ screenshot/);
    // A frame or a shadow root the page check could not read: refused while the typed value is live (I9).
    shown = { values: ["", "zz-user"], text: "로그인", blind: 1 };
    const blind = await cli([`-s=${name}`, "pdf"]);
    expect(blind.code).not.toBe(0);
    expect(readFileSync(join(dataDir, "fake", "commands.log"), "utf8")).not.toMatch(/ pdf/);
  }, 30_000);

  it("the window's launch: the password manager, its save prompt and autofill off in the profile (other preferences kept); no command log; the daemon's sockets in the data folder; no global CLI config", async () => {
    const { browser, name, cli, dataDir } = setup();
    mkdirSync(join(browser.paths.profile, "Default"), { recursive: true });
    writeFileSync(join(browser.paths.profile, "Default", "Preferences"), JSON.stringify({ intl: { accept_languages: "ko" }, profile: { name: "Workbench" } }));
    expect((await cli([`-s=${name}`, "open", "https://example.com"])).code).toBe(0);
    const prefs = JSON.parse(readFileSync(join(browser.paths.profile, "Default", "Preferences"), "utf8"));
    expect(prefs).toMatchObject({
      credentials_enable_service: false, credentials_enable_autosignin: false,
      profile: { name: "Workbench", password_manager_enabled: false, password_manager_leak_detection: false },
      autofill: { enabled: false, profile_enabled: false, credit_card_enabled: false },
      intl: { accept_languages: "ko" },
    });
    expect(JSON.parse(readFileSync(browser.paths.config, "utf8"))).toMatchObject({ saveSession: false, codegen: "none" });
    const env = JSON.parse(readFileSync(join(dataDir, "fake", `fake-pwcli-${name}.env.json`), "utf8"));
    expect(env).toEqual({ PWTEST_SOCKETS_DIR: browser.socketsDir, PWTEST_CLI_GLOBAL_CONFIG: browser.paths.root });
    expect(statSync(browser.socketsDir).mode & 0o777).toBe(0o700);
  }, 30_000);

  it("a Preferences file Chromium cannot parse is set aside and the password manager is switched off anyway", () => {
    const profile = mkdtempSync(join(tmpdir(), "wb-prefs-"));
    dirs.push(profile);
    mkdirSync(join(profile, "Default"), { recursive: true });
    writeFileSync(join(profile, "Default", "Preferences"), "{not json");
    noPasswordManager(profile);
    expect(JSON.parse(readFileSync(join(profile, "Default", "Preferences"), "utf8"))).toMatchObject({ credentials_enable_service: false, profile: { password_manager_enabled: false } });
    expect(readFileSync(join(profile, "Default", "Preferences.corrupt"), "utf8")).toBe("{not json");
  });

  it("a gateway command that timed out: a snapshot file the daemon wrote meanwhile is rewritten hidden", async () => {
    const { browser, state, name, cli } = setup("full", { hostTimeoutMs: 300 });
    expect((await cli([`-s=${name}`, "open", "https://example.com"])).code).toBe(0);
    const file = join(browser.paths.output, "page-late.yml");
    mkdirSync(browser.paths.output, { recursive: true });
    await standInDaemon(name, browser.paths.profile, async () => {
      writeFileSync(file, `- textbox "비밀번호" [ref=e6]: ${SHORT}\n`);
      await new Promise((done) => setTimeout(done, 1000));
      return { text: `- [Snapshot](${file})` };
    }, join(browser.socketsDir, "cli"));
    const page = browser.hostPage(state.session.id);
    if (typeof page === "string") throw new Error(page);
    page.typed("포털", [SHORT]);
    expect(await page.run({ _: ["click", "e7"] })).toEqual({ error: true, text: "timeout" });
    expect(readFileSync(file, "utf8")).toBe('- textbox "비밀번호" [ref=e6]: [비밀: 포털]\n');
  }, 30_000);

  it("one exit for every file a browser command wrote, by place and whatever the link's title: hidden, or removed and said; a file flag pointing elsewhere is refused before the CLI runs", async () => {
    const { browser, state, name, cli, cwd, dataDir } = setup();
    browser.scrubOutput = (text) => text.replaceAll(VALUE, "[비밀: 포털]");
    expect((await cli([`-s=${name}`, "open", "https://example.com"])).code).toBe(0);
    const own = join(browser.paths.output, "own-1.txt");
    await standInDaemon(name, browser.paths.profile, () => {
      // The gateway's own command: the daemon writes a file and links nothing.
      writeFileSync(own, `값: ${VALUE}\n- textbox "비밀번호" [ref=e6]: ${SHORT}\n`);
      return { text: "### Ran Playwright code" };
    }, join(browser.socketsDir, "cli"));
    const page = browser.hostPage(state.session.id);
    if (typeof page === "string") throw new Error(page);
    page.typed("포털", [SHORT]);
    // The page holds a stored value and the typed one in its fields (an AI snapshot prints them).
    writeFileSync(join(dataDir, "fake", "page.txt"), `- textbox "아이디" [ref=e4]: ${VALUE}\n- textbox "비밀번호" [ref=e6]: ${SHORT}\n`);
    const linked = (out: string, title: string) => {
      const file = new RegExp(`\\[${title}\\]\\(([^)]+)\\)`).exec(out)?.[1];
      if (!file) throw new Error(out);
      return file;
    };
    const holds = (text: string) => text.includes(VALUE) || text.includes(`: ${SHORT}`);
    for (const [args, title, where] of [[["find", "비밀번호", "--filename=results.md"], "Find results", cwd], [["eval", "() => 1", "--filename", "x.json"], "Evaluation result", cwd], [["console"], "Console messages", browser.paths.output]] as const) {
      const result = await cli([`-s=${name}`, ...args]);
      expect(result.code, args.join(" ")).toBe(0);
      const file = linked(result.out, title);
      // Written by the CLI inside the gateway's output folder and hidden there; a name asked for in
      // the work folder is then moved there (round 3, ruling C), and the answer names that place.
      expect(file.startsWith(`${where}/`), file).toBe(true);
      expect(holds(readFileSync(file, "utf8")), file).toBe(false);
      expect(readFileSync(file, "utf8")).toContain("[비밀: 포털]");
    }
    expect(holds(readFileSync(join(cwd, "results.md"), "utf8"))).toBe(false);
    // A file that cannot be rewritten hidden (binary bytes, or unreadable) is removed, and the answer says so.
    const binary = await cli([`-s=${name}`, "eval", "() => 1", "--filename=r.bin"]);
    expect(existsSync(linked(binary.out, "Evaluation result"))).toBe(false);
    expect(binary.out).toContain("지웠습니다");
    process.env.FAKE_PWCLI_LOCK = "console";
    try {
      const locked = await cli([`-s=${name}`, "console"]);
      expect(existsSync(linked(locked.out, "Console messages"))).toBe(false);
      expect(locked.out).toContain("지웠습니다");
    } finally {
      delete process.env.FAKE_PWCLI_LOCK;
    }
    // A file flag pointing outside the work folder and the output folder, or through a link: refused, and the CLI never runs.
    const outside = mkdtempSync(join(tmpdir(), "wb-outside-"));
    dirs.push(outside);
    symlinkSync(join(outside, "t.md"), join(browser.paths.output, "link.md"));
    symlinkSync(outside, join(browser.paths.output, "sub"));
    symlinkSync(join(outside, "t.md"), join(cwd, "link.md"));
    symlinkSync(outside, join(cwd, "sub"));
    const before = readFileSync(join(dataDir, "fake", "commands.log"), "utf8");
    for (const flag of [`--filename=${join(outside, "a.md")}`, "--filename=../a.md", "--filename=link.md", "--filename=sub/a.md", `--filename=${browser.paths.output}/link.md`, `--filename=${browser.paths.output}/sub/a.md`, `--filename=${cwd}`]) {
      const refused = await cli([`-s=${name}`, "find", "비밀번호", flag]);
      expect(refused.code, flag).toBe(1);
      expect(refused.out, flag).toContain("작업 폴더");
    }
    const separate = await cli([`-s=${name}`, "find", "x", "--filename", join(outside, "b.md")]);
    expect(separate.code).toBe(1);
    expect(readFileSync(join(dataDir, "fake", "commands.log"), "utf8")).toBe(before);
    expect(readdirSync(outside)).toEqual([]);
    // The gateway's own command: a file it wrote without a link is swept too.
    await page.run({ _: ["click", "e7"] });
    expect(holds(readFileSync(own, "utf8"))).toBe(false);
    // Nothing in the output folder or the work folder holds a value.
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isSymbolicLink() ? [] : entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
    for (const file of [...walk(browser.paths.output), ...walk(cwd)]) expect(holds(readFileSync(file, "utf8")), file).toBe(false);
  }, 60_000);

  it("round 3, ruling E: structured output is judged decoded: snapshot --json and find --json with a 5-digit typed code and a short stored value; the JSON a file holds; text that only looks like JSON", async () => {
    const { browser, state, name, cli, dataDir } = setup();
    browser.scrubOutput = (text) => text;
    // A stored value under the scrubber's 8 characters: only its exact form is known.
    browser.storedExact = (text) => (text === "zz4f" ? "[비밀: 메모]" : null);
    expect((await cli([`-s=${name}`, "open", "https://example.com"])).code).toBe(0);
    await standInDaemon(name, browser.paths.profile, () => ({ text: "ok" }), join(browser.socketsDir, "cli"));
    const page = browser.hostPage(state.session.id);
    if (typeof page === "string") throw new Error(page);
    page.typed("인증번호", ["48291"], "s_step");
    writeFileSync(join(dataDir, "fake", "page.txt"), '- textbox "PIN" [active] [ref=e3]: 48291\n- textbox "메모" [ref=e4]: zz4f\n- text: 주문 48291번 · 메모 zz4f 참고\n');
    const snapshot = await cli([`-s=${name}`, "snapshot", "--json"]);
    expect(snapshot.code).toBe(0);
    const json = JSON.parse(snapshot.out) as { snapshot: { text?: string }[] };
    expect(json.snapshot.map((element) => element.text)).toEqual(["[비밀: 인증번호]", "[비밀: 메모]", "주문 [비밀: 인증번호]번 · 메모 zz4f 참고"]);
    const found = await cli([`-s=${name}`, "find", "PIN", "--json"]);
    expect(found.code).toBe(0);
    expect(found.out).not.toContain("48291");
    expect((JSON.parse(found.out) as { result: string }).result).toBe('- textbox "PIN" [active] [ref=e3]: [비밀: 인증번호]');
    // The JSON a file holds: the same, decoded.
    writeFileSync(join(dataDir, "fake", "page.txt"), JSON.stringify({ pin: "48291", memo: "zz4f", line: '- textbox "PIN" [ref=e3]: "48291"', note: "주문 48291번" }));
    const evaluated = await cli([`-s=${name}`, "eval", "() => 1", "--filename=r.json"]);
    const file = /\[Evaluation result\]\(([^)]+)\)/.exec(evaluated.out)![1]!;
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ pin: "[비밀: 인증번호]", memo: "[비밀: 메모]", line: '- textbox "PIN" [ref=e3]: [비밀: 인증번호]', note: "주문 [비밀: 인증번호]번" });
    // Text that only looks like JSON (cut off): a field whose value part is a short live value is hidden.
    expect(page.hide('{\n  "pin": "48291",\n  "result": "- textbox \\"PIN\\" [ref=e3]: \\"48291\\"",\n  "more": ')).not.toContain("48291");
  }, 30_000);

  it("round 4, ruling P4: JSON judged decoded all the way down: eval \"JSON.stringify({pin: …})\" plain and --json, a JSON number, a key, and a whole token in plain text while a short typed value is live", async () => {
    const { browser, state, name, cli } = setup();
    browser.scrubOutput = (text) => text;
    browser.storedExact = (text) => (text === "zz4f" ? "[비밀: 메모]" : null);
    expect((await cli([`-s=${name}`, "open", "https://example.com"])).code).toBe(0);
    await standInDaemon(name, browser.paths.profile, () => ({ text: "ok" }), join(browser.socketsDir, "cli"));
    const page = browser.hostPage(state.session.id);
    if (typeof page === "string") throw new Error(page);
    page.typed("인증번호", ["48291"], "s_step");
    // The real CLI's text mode prints an eval result as JSON.stringify(result, null, 2): a JSON-encoded string.
    const plain = page.hide(`### Result\n${JSON.stringify(JSON.stringify({ pin: "48291", name: "id" }))}`);
    expect(plain).not.toContain("48291");
    expect(JSON.parse(JSON.parse(plain.split("\n")[1]!) as string)).toEqual({ pin: "[비밀: 인증번호]", name: "id" });
    // --json: the same string inside the CLI's own JSON (pretty), and three levels down.
    expect(page.hide(JSON.stringify({ result: JSON.stringify({ pin: "48291" }) }, null, 2))).not.toContain("48291");
    expect(page.hide(JSON.stringify({ result: JSON.stringify([JSON.stringify({ inner: JSON.stringify({ pin: "48291" }) })]) }))).not.toContain("48291");
    // A JSON number whose text is a live value, and a key equal to it.
    expect(page.hide(JSON.stringify({ result: 48291 }, null, 2))).not.toContain("48291");
    expect(page.hide(JSON.stringify({ result: [1, 48291, 3] }))).not.toContain("48291");
    expect(page.hide(JSON.stringify({ 48291: "pin" }))).not.toContain("48291");
    // Plain text: a whole token equal to the live short value is hidden; a longer number holding it is not.
    const text = page.hide("주문 48291번 · 코드=48291; 전화 0248291 · e48291");
    expect(text).toBe("주문 [비밀: 인증번호]번 · 코드=[비밀: 인증번호]; 전화 0248291 · e48291");
    // Ended (the step's mark forgotten): still hidden for 2 minutes after.
    page.forget("s_step");
    expect(page.hide("코드 48291")).toBe("코드 [비밀: 인증번호]");
  }, 30_000);

  it("round 3, ruling B: the sweep is the byte scanner, off the event loop: a 30 MiB PNG and a 30 MiB PDF with 3 stored values hold the loop under the bound; one holding a value is removed and said, a clean one is left as it is", async () => {
    const { browser, name, cli, dataDir } = setup();
    const scrubber = new TranscriptScrubber();
    scrubber.set("a", "포털", [VALUE]);
    scrubber.set("b", "도서관", ["zz-fake-libr-0303"]);
    scrubber.set("c", "메일", ["zz-fake-mail-0404"]);
    browser.scrubOutput = (text) => scrubber.text(text);
    browser.storedNeedles = () => scrubber.needles();
    browser.storedExact = (text) => scrubber.exact(text);
    expect((await cli([`-s=${name}`, "open", "https://example.com"])).code).toBe(0);
    const big = (head: string, value?: string) => {
      const bytes = randomBytes(30 * 1024 * 1024);
      bytes.write(head, 0, "latin1");
      if (value) bytes.write(value, 15 * 1024 * 1024, "utf8");
      return bytes;
    };
    let longest = 0;
    const timed = async (command: string, file: string, bytes: Buffer) => {
      writeFileSync(join(dataDir, "fake", `${command}.bin`), bytes);
      let last = performance.now();
      const timer = setInterval(() => { const now = performance.now(); longest = Math.max(longest, now - last); last = now; }, 1);
      const started = performance.now();
      const result = await cli([`-s=${name}`, command, `--filename=${file}`]);
      const took = performance.now() - started;
      clearInterval(timer);
      console.info(`ruling B: ${command} ${Math.round(bytes.length / 1024 / 1024)} MiB, 3 stored values: ${Math.round(took)} ms, longest event-loop gap so far ${Math.round(longest)} ms`);
      return result;
    };
    const cleanPng = big("\x89PNG\r\n\x1a\n"), cleanPdf = big("%PDF-1.7\n");
    const out = (file: string) => join(browser.paths.output, file);
    const shots = [
      await timed("screenshot", out("clean.png"), cleanPng),
      await timed("screenshot", out("held.png"), big("\x89PNG\r\n\x1a\n", "zz-fake-mail-0404")),
      await timed("pdf", out("clean.pdf"), cleanPdf),
      await timed("pdf", out("held.pdf"), big("%PDF-1.7\n", VALUE)),
    ];
    // Text up to 8 MiB is rewritten hidden in pieces (a large snapshot file).
    const lines = Array.from({ length: 120_000 }, (_, index) => `- listitem "항목 ${index}" [ref=e${index}]: 내용 ${index % 97 === 0 ? VALUE : "보통"}`).join("\n");
    await timed("screenshot", out("page.yml"), Buffer.from(lines));
    const rewritten = readFileSync(out("page.yml"), "utf8");
    expect(rewritten.includes(VALUE)).toBe(false);
    expect(rewritten).toContain("[비밀: 포털]");
    expect(longest).toBeLessThan(250);
    expect(existsSync(out("held.png"))).toBe(false);
    expect(existsSync(out("held.pdf"))).toBe(false);
    expect(shots[1]!.out).toContain("지웠습니다");
    expect(shots[3]!.out).toContain("지웠습니다");
    expect(readFileSync(out("clean.png")).equals(cleanPng)).toBe(true);
    expect(readFileSync(out("clean.pdf")).equals(cleanPdf)).toBe(true);
  }, 120_000);

  it("round 3, ruling C: a file asked for inside the work folder arrives there hidden; the answer names it; the gateway's own earlier file is written over, the person's never", async () => {
    const { browser, name, cli, cwd, dataDir } = setup();
    browser.scrubOutput = (text) => text.replaceAll(VALUE, "[비밀: 포털]");
    browser.storedNeedles = () => [VALUE];
    expect((await cli([`-s=${name}`, "open", "https://example.com"])).code).toBe(0);
    const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001", "hex");
    writeFileSync(join(dataDir, "fake", "screenshot.bin"), png);
    const shot = await cli([`-s=${name}`, "screenshot", "--filename", "shot.png"]);
    expect(shot.code).toBe(0);
    expect(readFileSync(join(cwd, "shot.png")).equals(png)).toBe(true);
    expect(shot.out).toContain(`[Screenshot of viewport](${join(cwd, "shot.png")})`);
    expect(shot.out).toContain(`파일을 ${join(cwd, "shot.png")}에 두었습니다`);
    // Again under the same name: the gateway's own earlier file is written over.
    const again = Buffer.concat([png, Buffer.from([1])]);
    writeFileSync(join(dataDir, "fake", "screenshot.bin"), again);
    await cli([`-s=${name}`, "screenshot", "--filename=shot.png"]);
    expect(readFileSync(join(cwd, "shot.png")).equals(again)).toBe(true);
    // A file the person made under that name stays; the picture goes under the next free name.
    writeFileSync(join(cwd, "mine.png"), "the person's own");
    const beside = await cli([`-s=${name}`, "screenshot", "--filename=mine.png"]);
    expect(readFileSync(join(cwd, "mine.png"), "utf8")).toBe("the person's own");
    expect(readFileSync(join(cwd, "mine-2.png")).equals(again)).toBe(true);
    expect(beside.out).toContain(`파일을 ${join(cwd, "mine-2.png")}에 두었습니다`);
    // Folders are made; a PDF too.
    writeFileSync(join(dataDir, "fake", "pdf.bin"), Buffer.from("%PDF-1.7\nzz clean\n"));
    await cli([`-s=${name}`, "pdf", `--filename=${join(cwd, "캡처", "page.pdf")}`]);
    expect(readFileSync(join(cwd, "캡처", "page.pdf"), "utf8")).toContain("zz clean");
    // A picture holding a stored value never arrives: removed and said.
    writeFileSync(join(dataDir, "fake", "screenshot.bin"), Buffer.concat([png, Buffer.from(VALUE)]));
    const held = await cli([`-s=${name}`, "screenshot", "--filename=held.png"]);
    expect(existsSync(join(cwd, "held.png"))).toBe(false);
    expect(held.out).toContain("지웠습니다");
    // Without a file flag nothing changes: the picture stays in the output folder, linked.
    const plain = await cli([`-s=${name}`, "screenshot"]);
    expect(plain.out).toContain(`](${browser.paths.output}/`);
  }, 60_000);

  it("round 3 minors: a hard link planted in the output folder is removed (never rewritten through), and the CLI never writes through one; the output folder is emptied when the browser session ends", async () => {
    const { browser, name, cli, cwd, dataDir } = setup();
    browser.scrubOutput = (text) => text.replaceAll(VALUE, "[비밀: 포털]");
    browser.storedNeedles = () => [VALUE];
    expect((await cli([`-s=${name}`, "open", "https://example.com"])).code).toBe(0);
    // The person's file, with a second name planted in the output folder.
    const mine = join(cwd, "mine.txt");
    writeFileSync(mine, `내 메모 ${VALUE}\n`);
    linkSync(mine, join(browser.paths.output, "planted.txt"));
    const swept = await cli([`-s=${name}`, "snapshot"]);
    expect(existsSync(join(browser.paths.output, "planted.txt"))).toBe(false);
    expect(swept.out).toContain("지웠습니다");
    expect(readFileSync(mine, "utf8")).toBe(`내 메모 ${VALUE}\n`);
    // A file flag naming a hard link in the output folder: the link goes first, the CLI writes a new file.
    linkSync(mine, join(browser.paths.output, "into.png"));
    writeFileSync(join(dataDir, "fake", "screenshot.bin"), Buffer.from("89504e470d0a1a0a", "hex"));
    await cli([`-s=${name}`, "screenshot", `--filename=${join(browser.paths.output, "into.png")}`]);
    expect(readFileSync(mine, "utf8")).toBe(`내 메모 ${VALUE}\n`);
    // A file written between two commands is swept by the next one.
    writeFileSync(join(browser.paths.output, "between.md"), `값 ${VALUE}\n`);
    await cli([`-s=${name}`, "snapshot"]);
    expect(readFileSync(join(browser.paths.output, "between.md"), "utf8")).toBe("값 [비밀: 포털]\n");
    // The session's browser ends: its output goes.
    expect((await cli([`-s=${name}`, "close"])).code).toBe(0);
    expect(readdirSync(browser.paths.output)).toEqual([]);
  }, 60_000);

  it("the gateway's own hand: only on this session's own open Chromium window, never paused", async () => {
    const { browser, state, name, cli } = setup();
    expect(browser.hostPage(state.session.id)).toBe("no_page");
    expect((await cli([`-s=${name}`, "open", "https://example.com"])).code).toBe(0);
    expect(typeof browser.hostPage(state.session.id)).toBe("object");
    expect(browser.hostPage("another-session")).toBe("browser_off");
    browser.setPaused(state.session.id, true);
    expect(browser.hostPage(state.session.id)).toBe("paused");
    browser.setPaused(state.session.id, false);
    state.session = { ...state.session, browser: false };
    expect(browser.hostPage(state.session.id)).toBe("browser_off");
  }, 30_000);

  it("Chromium chosen but not installed: the gateway's hand says so (nothing is downloaded)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "wb-browse-"));
    dirs.push(dataDir);
    const browser = new AgentBrowser({ dataDir, engine: "chromium" });
    browsers.push(browser);
    const session = { id: "s1", browser: true } as unknown as Session;
    browser.bind({ lookup: () => ({ session, work: { id: "w", cwd: dataDir } as Work, access: "full" }), sessions: () => [session], upsertItem: () => undefined, updateSession: () => undefined, publish: () => undefined });
    expect(browser.hostPage("s1")).toBe("browser_missing");
    expect(browser.status().install.state).not.toBe("installing");
  });

  it("with no screen to show a window on (a service without a graphical session), the window opens headless", () => {
    const saved = { DISPLAY: process.env.DISPLAY, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY };
    try {
      delete process.env.DISPLAY; delete process.env.WAYLAND_DISPLAY;
      const { browser } = setup();
      const config = JSON.parse(readFileSync(browser.paths.config, "utf8")) as { browser: { launchOptions: { headless: boolean } } };
      expect(config.browser.launchOptions.headless).toBe(process.platform === "linux");
      process.env.WAYLAND_DISPLAY = "wayland-0";
      const shown = setup().browser;
      expect((JSON.parse(readFileSync(shown.paths.config, "utf8")) as { browser: { launchOptions: { headless: boolean } } }).browser.launchOptions.headless).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  it("Lightpanda keeps no login: the gateway's hand is not offered there", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "wb-browse-"));
    dirs.push(dataDir);
    const browser = new AgentBrowser({ dataDir, engine: "lightpanda", lightpanda: "/nonexistent/lightpanda" });
    browsers.push(browser);
    const session = { id: "s1", browser: true } as unknown as Session;
    browser.bind({ lookup: () => ({ session, work: { id: "w", cwd: dataDir } as Work, access: "full" }), sessions: () => [session], upsertItem: () => undefined, updateSession: () => undefined, publish: () => undefined });
    expect(browser.hostPage("s1")).toBe("needs_chromium");
  });
});
