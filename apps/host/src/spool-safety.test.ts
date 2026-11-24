import { execFile, execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { browserSessionName, type Session, type Work } from "@workbench/contracts";
import { AgentBrowser, type BrowserEngineHooks } from "./browse.ts";
import { EventBus } from "./bus.ts";
import { CredentialTool } from "./credentials/tool.ts";
import { DesktopTool } from "./desktop-tool.ts";
import type { DesktopService } from "./desktop-adapter.ts";
import { FindTool, findSessionName } from "./find-tool.ts";
import { PeerDesk, PeerTool } from "./peer-read.ts";
import { RemoteTool } from "./channels/remote-tool.ts";
import type { Finder } from "./search.ts";

// Security review of 0.5.6 (2416cede..bd2b7a41), finding 1, for EVERY tool that answers an engine through
// a spool folder (workbench-find, -peers, -desktop, -remote, -credential and the agent browser's playwright-cli):
// the folder is writable by the (sandboxed) engine, the gateway is not sandboxed.
// 1. The answer is never written through a path the engine planted (a symlink at `<id>.res.json.tmp`), and never
//    outside the folder (an id with `..`).

const run = promisify(execFile);
const dirs: string[] = [];
const closers: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; };
const until = async (what: () => boolean, ms = 30_000) => { const end = Date.now() + ms; while (!what() && Date.now() < end) await new Promise((done) => setTimeout(done, 25)); return what(); };

const base: BrowserEngineHooks = {
  pathDirs: () => [], sessionEnv: () => ({}), instructions: () => null, offNote: () => "", allowsCommand: () => false,
  writableRoots: () => [], told: () => null, setTold: () => undefined, extraInstructions: () => null,
};
const session = (id: string, over: Partial<Session> = {}) => ({ id, workId: "w", provider: "claude", nativeSessionId: null, archivedAt: null, purpose: "대화", status: "idle", updatedAt: 1, createdAt: 1, queued: [], preview: null, lastError: null, ...over }) as unknown as Session;

type Rig = { spool: string; request: (id: string) => Record<string, unknown> };

/** Each tool, made in `dir`, with one conversation whose spool is open: its folder and a request it answers. */
const TOOLS: Record<string, (dir: string) => Promise<Rig>> = {
  find: async (dir) => {
    const one = session("s-find");
    const finder = { find: async () => ({ code: 0, stdout: "찾음\n", stderr: "" }) } as unknown as Finder;
    const tool = new FindTool({ dataDir: dir, finder, sessions: () => new Map([[one.id, one]]), bus: new EventBus(), pollMs: 20 });
    closers.push(() => tool.close());
    tool.engineHooks().sessionEnv(one);
    return { spool: join(tool.spool, findSessionName(one.id)), request: (id) => ({ id, args: ["찾기"], cwd: null }) };
  },
  peers: async (dir) => {
    const me = session("s-me"), other = session("s-other", { purpose: "다른 대화" });
    const sessions = new Map([[me.id, me], [other.id, other]]);
    const desk = new PeerDesk({ sessions: () => sessions, works: () => new Map([["w", { id: "w", title: "프로젝트" } as Work]]), items: () => [], document: () => null, workspace: () => null, scrub: (text) => text });
    const tool = new PeerTool({ dataDir: dir, desk, sessions: () => sessions, bus: new EventBus(), pollMs: 20 });
    closers.push(() => tool.close());
    tool.hooks(base).sessionEnv(me);
    return { spool: join(tool.root, "spool", findSessionName(me.id)), request: (id) => ({ id, args: ["list"] }) };
  },
  desktop: async (dir) => {
    const one = session("s-desk");
    const service = { observe: async () => ({ ok: true }), release: () => undefined } as unknown as DesktopService;
    const tool = new DesktopTool(dir, service, new Map([[one.id, one]]), new EventBus(), { pollMs: 20 });
    closers.push(() => tool.close());
    tool.hooks(base).sessionEnv(one);
    return { spool: join(dir, "desktop", "tool", "spool", findSessionName(one.id)), request: (id) => ({ id, args: ["snapshot"] }) };
  },
  remote: async (dir) => {
    const one = session("s-remote", { workId: "home" });
    const works = new Map([["home", { id: "home", archivedAt: null, messengerHome: { kind: "telegram", registered: true } } as unknown as Work]]);
    const tool = new RemoteTool({ dataDir: dir, sessions: () => new Map([[one.id, one]]), works: () => works, bus: new EventBus(), pollMs: 20, run: async () => ({ code: 0, stdout: "{}\n", stderr: "" }), hide: () => undefined });
    closers.push(() => tool.close());
    tool.hooks(base).sessionEnv(one);
    return { spool: join(tool.root, "spool", findSessionName(one.id)), request: (id) => ({ id, args: ["projects"], input: "", key: "wrong" }) };
  },
  credential: async (dir) => {
    const one = session("s-cred");
    const tool = new CredentialTool({ dataDir: dir, sessions: new Map([[one.id, one]]), bus: new EventBus(), run: async () => ({ code: 0, stdout: "(비어 있음)\n", stderr: "" }), pollMs: 20 });
    closers.push(() => tool.close());
    tool.hooks(base).sessionEnv(one);
    return { spool: join(dir, "credential-tool", "spool", findSessionName(one.id)), request: (id) => ({ id, args: ["list"] }) };
  },
  browser: async (dir) => {
    const cwd = temp("wb-spool-browse-work-");
    process.env.FAKE_PWCLI_DIR = join(dir, "fake");
    const one = session("5a1e0c3d-aaaa-bbbb-cccc-ddddeeeeffff", { workId: "w1", status: "running", browser: true });
    const browser = new AgentBrowser({ dataDir: dir, cli: resolve("scripts/fixtures/fake-playwright-cli.mjs"), idleCloseMs: 60_000 });
    closers.push(() => browser.shutdown());
    browser.bind({ lookup: (id) => (id === one.id ? { session: one, work: { id: "w1", cwd } as Work, access: "full" } : null), sessions: () => [one], upsertItem: () => undefined, updateSession: () => undefined, publish: () => undefined });
    const name = browserSessionName(one.id);
    // The wrapper once, as an engine's shell runs it, so the conversation's spool is open and looked at.
    await run("playwright-cli", [`-s=${name}`, "snapshot"], { cwd, env: { ...process.env, PATH: `${browser.paths.bin}${delimiter}${process.env.PATH}` }, timeout: 30_000 }).catch(() => undefined);
    const spool = join(browser.paths.spool, name);
    mkdirSync(spool, { recursive: true });
    return { spool, request: (id) => ({ id, args: [`-s=${name}`, "snapshot"], cwd }) };
  },
};

describe("finding 1: the answer is written only where the gateway chose", () => {
  for (const [name, make] of Object.entries(TOOLS)) {
    it(`${name}: a symlink planted at <id>.res.json.tmp does not make the gateway write into the file it points at`, async () => {
      const dir = temp(`wb-spool-${name}-`);
      const rig = await make(dir);
      const victim = join(dir, "victim.txt");
      writeFileSync(victim, "원래 내용\n");
      const id = "abcd-1234";
      symlinkSync(victim, join(rig.spool, `${id}.res.json.tmp`));
      writeFileSync(join(rig.spool, `${id}.req.json`), JSON.stringify(rig.request(id)));
      expect(await until(() => existsSync(join(rig.spool, `${id}.res.json`)))).toBe(true);
      expect(readFileSync(victim, "utf8")).toBe("원래 내용\n");
      expect(lstatSync(join(rig.spool, `${id}.res.json`)).isFile()).toBe(true);
    });
  }

  it("browser: an id with a path in it is not answered outside the spool folder", async () => {
    const dir = temp("wb-spool-browser-id-");
    const rig = await TOOLS.browser!(dir);
    writeFileSync(join(rig.spool, "wxyz-0001.req.json"), JSON.stringify(rig.request("../../escaped")));
    const escaped = join(rig.spool, "..", "..", "escaped.res.json");
    // A normal request after it is answered: the bad one had its turn.
    writeFileSync(join(rig.spool, "wxyz-0002.req.json"), JSON.stringify(rig.request("wxyz-0002")));
    expect(await until(() => existsSync(join(rig.spool, "wxyz-0002.res.json")))).toBe(true);
    expect(existsSync(escaped)).toBe(false);
  });
});

// The helper itself: O_EXCL temp names, no answer through a planted answer path, no id with a path.
describe("the shared spool helper", () => {
  it("does not replace an answer path that is a symlink or a folder, refuses an id with a path, and leaves no temp file", async () => {
    const { writeSpoolAnswer } = await import("./spool-folders.ts");
    const dir = temp("wb-spool-helper-");
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "원래\n");
    symlinkSync(victim, join(dir, "link-0001.res.json"));
    expect(writeSpoolAnswer(dir, "link-0001", { code: 0 })).toBe(false);
    mkdirSync(join(dir, "fold-0001.res.json"));
    expect(writeSpoolAnswer(dir, "fold-0001", { code: 0 })).toBe(false);
    expect(writeSpoolAnswer(dir, "../up-0001", { code: 0 })).toBe(false);
    expect(writeSpoolAnswer(dir, "good-0001", { code: 0 })).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "good-0001.res.json"), "utf8"))).toEqual({ code: 0 });
    expect(readFileSync(victim, "utf8")).toBe("원래\n");
    expect(execFileSync("ls", ["-A", dir]).toString().split("\n").filter((file) => file.includes(".part") || file.endsWith(".tmp"))).toEqual([]);
  });
});
