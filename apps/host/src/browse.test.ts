import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { browserSessionName, type AccessMode, type AgentBrowserStatus, type Session, type TranscriptItem, type Work } from "@workbench/contracts";
import { AgentBrowser, readSignedIn, signedInSites } from "./browse.ts";
import { claudeSdkEnv, engineEnv } from "./engine-env.ts";

// The agent browser in the gateway, with the stand-in CLI (no browser): the wrapper on an
// engine's PATH, the spool, the access rules with approval cards, pause, blocked commands, the
// Codex thread map and what the engines get.

const FAKE_CLI = resolve("scripts/fixtures/fake-playwright-cli.mjs");
const dirs: string[] = [];
const browsers: AgentBrowser[] = [];
afterEach(async () => {
  for (const browser of browsers.splice(0)) await browser.shutdown();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(access: AccessMode = "full", provider: Session["provider"] = "claude", waitGraceMs?: number) {
  const dataDir = mkdtempSync(join(tmpdir(), "wb-browse-"));
  const cwd = mkdtempSync(join(tmpdir(), "wb-browse-work-"));
  dirs.push(dataDir, cwd);
  process.env.FAKE_PWCLI_DIR = join(dataDir, "fake");
  const session = { id: "5a1e0c3d-aaaa-bbbb-cccc-ddddeeeeffff", workId: "w1", provider, status: "running", browser: true, nativeSessionId: provider === "codex" ? "thread-1" : null, archivedAt: null, purpose: "메일" } as unknown as Session;
  const work = { id: "w1", cwd } as Work;
  const items: TranscriptItem[] = [];
  const statuses: AgentBrowserStatus[] = [];
  const state = { session, access };
  const browser = new AgentBrowser({ dataDir, cli: FAKE_CLI, idleCloseMs: 60_000, waitGraceMs });
  browsers.push(browser);
  browser.bind({
    lookup: (id) => (id === state.session.id ? { session: state.session, work, access: state.access } : null),
    sessions: () => [state.session],
    upsertItem: (_id, item) => {
      const index = items.findIndex((entry) => entry.id === item.id);
      if (index >= 0) items[index] = item;
      else items.push(item);
    },
    updateSession: (_id, patch) => {
      state.session = { ...state.session, ...patch };
    },
    publish: (status) => statuses.push(status),
  });
  const name = browserSessionName(session.id);
  /** The wrapper as an engine's shell runs it: by name on PATH, in the work folder. */
  const cli = (args: string[], env: Record<string, string> = {}) =>
    new Promise<{ code: number | null; out: string }>((done) => {
      const child = spawn("playwright-cli", args, { cwd, env: { ...process.env, ...env, PATH: `${browser.paths.bin}${delimiter}${process.env.PATH}` } });
      let out = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (out += chunk));
      child.on("exit", (code) => done({ code, out }));
    });
  const approvals = () => items.filter((item): item is Extract<TranscriptItem, { kind: "approval" }> => item.kind === "approval");
  const until = async (what: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (!what() && Date.now() < end) await new Promise((done) => setTimeout(done, 20));
    return what();
  };
  const ran = () => {
    try {
      return readFileSync(join(dataDir, "fake", "commands.log"), "utf8");
    } catch {
      return "";
    }
  };
  return { browser, state, name, cli, items, statuses, approvals, until, work, dataDir, ran };
}

describe("agent browser through the wrapper", () => {
  it("runs a session's commands in its own window and reports the page", async () => {
    const { browser, name, cli, statuses } = setup("full");
    const opened = await cli([`-s=${name}`, "open", "https://example.com"]);
    expect(opened.code).toBe(0);
    expect(opened.out).toContain("Page URL: https://example.com/");
    expect(opened.out).toContain("Page Title: Example Domain");
    const snapshot = await cli([`-s=${name}`, "snapshot"]);
    expect(snapshot.out).toContain('button "보내기" [ref=e5]');
    expect(browser.status().window).toMatchObject({ kind: "agent", url: "https://example.com/", title: "Example Domain" });
    expect(statuses.some((status) => status.window.kind === "agent" && status.window.busy)).toBe(true);
    // Links to files the CLI wrote come back absolute (the conversation's image scan finds them).
    const shot = await cli([`-s=${name}`, "screenshot"]);
    expect(shot.out).toMatch(/\[Screenshot of viewport\]\(\/.*\.playwright-cli\/page-1\.png\)/);
  });

  it("refuses credential and window-management commands outright", async () => {
    const { name, cli } = setup("full");
    for (const command of ["cookie-list", "localstorage-get", "state-save", "run-code", "kill-all"]) {
      const result = await cli([`-s=${name}`, command]);
      expect(result.code, command).toBe(1);
      expect(result.out).toContain("쓸 수 없습니다");
    }
  });

  it("자동 reads and stays on known sites, and asks to act (naming the element) or to open a new site", async () => {
    const { browser, name, cli, approvals, until, state } = setup("auto");
    // A new site asks; once allowed, the session may come back to it.
    const open = cli([`-s=${name}`, "open", "https://example.com"]);
    expect(await until(() => approvals().some((item) => item.decision === null))).toBe(true);
    const visit = approvals().find((item) => item.decision === null)!;
    expect(visit.title).toBe("브라우저로 새 사이트를 열까요?");
    expect(browser.answer(state.session.id, visit.id, "accept")).toBe(true);
    expect((await open).code).toBe(0);
    expect((await cli([`-s=${name}`, "goto", "https://example.com/again"])).code).toBe(0);
    expect((await cli([`-s=${name}`, "snapshot"])).code).toBe(0);
    expect(approvals()).toHaveLength(1);
    const click = cli([`-s=${name}`, "click", "e5"]);
    expect(await until(() => approvals().some((item) => item.decision === null))).toBe(true);
    const card = approvals().find((item) => item.decision === null)!;
    expect(card.title).toBe("브라우저에서 누를까요?");
    expect(card.detail).toContain('button "보내기"');
    expect(state.session.status).toBe("awaitingApproval");
    expect(browser.answer(state.session.id, card.id, "decline")).toBe(true);
    const declined = await click;
    expect(declined.code).toBe(1);
    expect(declined.out).toContain("허용하지 않았습니다");
  });

  it("묻기 asks even to read; allowing runs the command", async () => {
    const { name, cli, approvals, until, browser, state } = setup("ask");
    const open = cli([`-s=${name}`, "open", "https://example.com"]);
    expect(await until(() => approvals().some((item) => item.decision === null))).toBe(true);
    const card = approvals().find((item) => item.decision === null)!;
    expect(card.title).toBe("브라우저로 새 사이트를 열까요?");
    expect(browser.answer(state.session.id, card.id, "accept")).toBe(true);
    expect((await open).code).toBe(0);
    expect(approvals().find((item) => item.id === card.id)?.decision).toBe("accept");
    expect(state.session.status).toBe("running");
  });

  it("switching to 전체 접근 answers a waiting card; a stop expires it", async () => {
    const { name, cli, approvals, until, browser, state } = setup("ask");
    const first = cli([`-s=${name}`, "open", "https://example.com"]);
    expect(await until(() => approvals().some((item) => item.decision === null))).toBe(true);
    state.access = "full";
    browser.accessChanged(state.session.id, "full");
    expect((await first).code).toBe(0);
    state.access = "ask";
    const second = cli([`-s=${name}`, "snapshot"]);
    expect(await until(() => approvals().filter((item) => item.decision === null).length === 1)).toBe(true);
    browser.expire(state.session.id);
    expect((await second).code).toBe(1);
    expect(approvals().at(-1)?.decision).toBe("expired");
  });

  it("an approval given after the engine stopped waiting runs nothing", async () => {
    const { browser, name, cli, approvals, until, state, work, ran } = setup("ask", "claude", 300);
    const open = cli([`-s=${name}`, "open", "https://example.com"]);
    expect(await until(() => approvals().some((item) => item.decision === null))).toBe(true);
    browser.answer(state.session.id, approvals().find((item) => item.decision === null)!.id, "accept");
    expect((await open).code).toBe(0);
    // An engine gives up on a command (Claude's Bash timeout, a stop): the wrapper is gone.
    const child = spawn("playwright-cli", [`-s=${name}`, "click", "e5"], { cwd: work.cwd, env: { ...process.env, PATH: `${browser.paths.bin}${delimiter}${process.env.PATH}` } });
    expect(await until(() => approvals().some((item) => item.decision === null))).toBe(true);
    child.kill("SIGKILL");
    await new Promise((done) => setTimeout(done, 1500));
    browser.answer(state.session.id, approvals().find((item) => item.decision === null)!.id, "accept");
    await new Promise((done) => setTimeout(done, 400));
    expect(ran()).toContain("goto https://example.com/");
    expect(ran()).not.toContain("click");
  });

  it("멈춤 refuses the session's commands until resumed", async () => {
    const { name, cli, browser, state } = setup("full");
    browser.setPaused(state.session.id, true);
    const paused = await cli([`-s=${name}`, "snapshot"]);
    expect(paused.code).toBe(1);
    expect(paused.out).toContain("멈췄습니다");
    browser.setPaused(state.session.id, false);
    expect((await cli([`-s=${name}`, "open", "example.com"])).code).toBe(0);
  });

  it("switched off: the wrapper says so at once and the window closes", async () => {
    const { name, cli, browser, state } = setup("full");
    expect((await cli([`-s=${name}`, "open", "example.com"])).code).toBe(0);
    state.session = { ...state.session, browser: false };
    browser.sessionChanged(state.session);
    expect(await new Promise((done) => setTimeout(() => done(browser.status().window.kind), 300))).toBe("closed");
    const off = await cli([`-s=${name}`, "snapshot"]);
    expect(off.code).toBe(1);
    expect(off.out).toContain("꺼져 있습니다");
  });

  it("Codex: a command finds its session by the thread it runs in, without -s", async () => {
    const { cli, browser } = setup("full", "codex");
    const threads = JSON.parse(readFileSync(browser.paths.threads, "utf8")) as Record<string, string>;
    expect(threads["thread-1"]).toBe(browserSessionName("5a1e0c3d-aaaa-bbbb-cccc-ddddeeeeffff"));
    const result = await cli(["open", "https://example.com"], { CODEX_THREAD_ID: "thread-1" });
    expect(result.code).toBe(0);
    expect(result.out).toContain("Example Domain");
  });

  it("anything that is not a Workbench session goes to another playwright-cli, or explains", async () => {
    const { cli } = setup("full");
    const result = await cli(["-s=my-own", "snapshot"], { PATH: "/usr/bin:/bin" });
    expect(result.code).toBe(127);
    expect(result.out).toContain("꺼져 있습니다");
  });
});

describe("what engines get", () => {
  it("puts the wrapper first on PATH and names the session's browser for Claude while on", () => {
    const { browser, state, name } = setup("full");
    const hooks = browser.engineHooks();
    const env = claudeSdkEnv("/usr/bin/claude", { paths: hooks.pathDirs(), extra: hooks.sessionEnv(state.session) });
    expect(env.PATH?.split(delimiter).slice(0, 2)).toEqual([browser.paths.bin, "/usr/bin"]);
    expect(env.PLAYWRIGHT_CLI_SESSION).toBe(name);
    expect(hooks.sessionEnv({ ...state.session, browser: false })).toEqual({});
    expect(engineEnv({ base: { PATH: "/bin" }, paths: hooks.pathDirs(), platform: "linux" }).PATH).toBe(`${browser.paths.bin}${delimiter}/bin`);
    expect(hooks.instructions(state.session)).toContain(`-s=${name}`);
    expect(hooks.instructions({ ...state.session, browser: false })).toBeNull();
    expect(hooks.writableRoots(state.session)).toEqual([join(browser.paths.spool, name)]);
    expect(existsSync(hooks.writableRoots(state.session)[0]!)).toBe(true);
    expect(hooks.allowsCommand(state.session.id, `playwright-cli -s=${name} snapshot`)).toBe(true);
    expect(hooks.allowsCommand(state.session.id, `playwright-cli -s=${name} snapshot; ls`)).toBe(false);
  });

  it("remembers what each Codex thread was told across gateway restarts", async () => {
    const { browser, dataDir } = setup("full", "codex");
    const hooks = browser.engineHooks();
    expect(hooks.told("s1")).toBeNull();
    hooks.setTold("s1", true);
    await browser.shutdown();
    const again = new AgentBrowser({ dataDir, cli: FAKE_CLI });
    browsers.push(again);
    expect(again.engineHooks().told("s1")).toBe(true);
  });
});

describe("signed-in sites", () => {
  it("are read from cookie domains and names only, never values", () => {
    expect(signedInSites([{ host_key: ".google.com", name: "SID" }, { host_key: ".naver.com", name: "NNB" }, { host_key: "github.com", name: "user_session" }])).toEqual(["Google", "GitHub"]);
    const profile = mkdtempSync(join(tmpdir(), "wb-browse-profile-"));
    dirs.push(profile);
    mkdirSync(join(profile, "Default"));
    const db = new DatabaseSync(join(profile, "Default", "Cookies"));
    db.exec("CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB)");
    db.prepare("INSERT INTO cookies VALUES (?, ?, ?, ?)").run(".naver.com", "NID_AUT", "secret-value", Buffer.from("x"));
    db.prepare("INSERT INTO cookies VALUES (?, ?, ?, ?)").run(".example.com", "session", "secret-value", Buffer.from("x"));
    db.close();
    expect(readSignedIn(profile)).toEqual(["네이버"]);
    expect(readSignedIn(join(profile, "none"))).toEqual([]);
  });
});
