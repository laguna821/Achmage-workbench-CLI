import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

// Security review of 0.5.6, finding 2 (also in the released workbench-find): a request read with readFileSync after
// a size check — a FIFO blocks the gateway's main thread, a symlink to /dev/zero exhausts it. Every tool that
// answers an engine through a spool folder reads its request with readSpoolRequest (spool-folders.ts): a regular
// file only, O_NOFOLLOW | O_NONBLOCK, fstat, at most the cap. A blocked main thread cannot be timed out from inside,
// so each tool runs in a child Node: a FIFO request is planted, then a normal one, which must be answered.

const run = promisify(execFile);
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; };

const TOOLS = ["find", "peers", "desktop", "remote", "credential", "browser"] as const;

async function fifoChild(tool: (typeof TOOLS)[number]) {
  const dir = temp(`wb-spool-fifo-${tool}-`);
  const script = join(dir, "child.ts");
  const src = resolve("apps/host/src");
  const at = (file: string) => JSON.stringify(join(src, file));
  writeFileSync(script, `
import { execFileSync, execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { browserSessionName } from ${JSON.stringify(resolve("packages/contracts/src/index.ts"))};
import { EventBus } from ${at("bus.ts")};
import { FindTool, findSessionName } from ${at("find-tool.ts")};
import { PeerDesk, PeerTool } from ${at("peer-read.ts")};
import { DesktopTool } from ${at("desktop-tool.ts")};
import { RemoteTool } from ${at("channels/remote-tool.ts")};
import { CredentialTool } from ${at("credentials/tool.ts")};
import { AgentBrowser } from ${at("browse.ts")};
const dir = ${JSON.stringify(dir)};
const tool = ${JSON.stringify(tool)};
const one = { id: "5a1e0c3d-aaaa-bbbb-cccc-ddddeeeeffff", workId: "w", provider: "claude", nativeSessionId: null, archivedAt: null, purpose: "대화", status: "running", browser: true, updatedAt: 1 };
const sessions = new Map([[one.id, one]]);
const base = { pathDirs: () => [], sessionEnv: () => ({}), writableRoots: () => [], allowsCommand: () => false, instructions: () => null, offNote: () => "", told: () => null, setTold: () => {}, extraInstructions: () => null };
let spool, request = { id: "good-0001", args: ["list"] };
if (tool === "find") {
  const t = new FindTool({ dataDir: dir, finder: { find: async () => ({ code: 0, stdout: "찾음\\n", stderr: "" }) }, sessions: () => sessions, bus: new EventBus(), pollMs: 20 });
  t.engineHooks().sessionEnv(one); spool = join(t.spool, findSessionName(one.id)); request = { id: "good-0001", args: ["x"], cwd: null };
} else if (tool === "peers") {
  const desk = new PeerDesk({ sessions: () => sessions, works: () => new Map([["w", { id: "w", title: "프로젝트" }]]), items: () => [], document: () => null, workspace: () => null, scrub: (text) => text });
  const t = new PeerTool({ dataDir: dir, desk, sessions: () => sessions, bus: new EventBus(), pollMs: 20 });
  t.hooks(base).sessionEnv(one); spool = join(t.root, "spool", findSessionName(one.id));
} else if (tool === "desktop") {
  const t = new DesktopTool(dir, { observe: async () => ({ ok: true }), release: () => {} }, sessions, new EventBus(), { pollMs: 20 });
  t.hooks(base).sessionEnv(one); spool = join(dir, "desktop", "tool", "spool", findSessionName(one.id)); request = { id: "good-0001", args: ["snapshot"] };
} else if (tool === "remote") {
  const works = new Map([["w", { id: "w", archivedAt: null, messengerHome: { kind: "telegram", registered: true } }]]);
  const t = new RemoteTool({ dataDir: dir, sessions: () => sessions, works: () => works, bus: new EventBus(), pollMs: 20, run: async () => ({ code: 0, stdout: "{}\\n", stderr: "" }), hide: () => {} });
  t.hooks(base).sessionEnv(one); spool = join(t.root, "spool", findSessionName(one.id)); request = { id: "good-0001", args: ["projects"], input: "", key: "x" };
} else if (tool === "credential") {
  const t = new CredentialTool({ dataDir: dir, sessions, bus: new EventBus(), run: async () => ({ code: 0, stdout: "(비어 있음)\\n", stderr: "" }), pollMs: 20 });
  t.hooks(base).sessionEnv(one); spool = join(dir, "credential-tool", "spool", findSessionName(one.id));
} else {
  const cwd = join(dir, "work"); mkdirSync(cwd);
  process.env.FAKE_PWCLI_DIR = join(dir, "fake");
  const browser = new AgentBrowser({ dataDir: dir, cli: ${JSON.stringify(resolve("scripts/fixtures/fake-playwright-cli.mjs"))}, idleCloseMs: 60_000 });
  browser.bind({ lookup: (id) => (id === one.id ? { session: one, work: { id: "w", cwd }, access: "full" } : null), sessions: () => [one], upsertItem: () => {}, updateSession: () => {}, publish: () => {} });
  const name = browserSessionName(one.id);
  await new Promise((done) => execFile("playwright-cli", ["-s=" + name, "snapshot"], { cwd, env: { ...process.env, PATH: browser.paths.bin + delimiter + process.env.PATH } }, () => done(null)));
  spool = join(browser.paths.spool, name); request = { id: "good-0001", args: ["-s=" + name, "snapshot"], cwd };
}
execFileSync("mkfifo", [join(spool, "fifo-0001.req.json")]);
writeFileSync(join(spool, "good-0001.req.json"), JSON.stringify(request));
setInterval(() => { if (existsSync(join(spool, "good-0001.res.json"))) { console.log("answered"); process.exit(0); } }, 25);
`);
  return run(process.execPath, [script], { timeout: 45_000, cwd: resolve(".") }).then((out) => out.stdout.trim(), (error: { stderr?: string }) => `blocked ${String(error.stderr ?? "").slice(0, 300)}`);
}

describe("finding 2: a request that is not a regular file never blocks the gateway", () => {
  for (const tool of TOOLS) {
    it(`${tool}: a FIFO request is dropped and the next request is still answered`, async () => {
      expect(await fifoChild(tool)).toBe("answered");
    }, 120_000);
  }
});

describe("the shared spool helper", () => {
  it("reads a regular request within its cap and takes it away; refuses a symlink, a FIFO and an oversize file", async () => {
    const { readSpoolRequest } = await import("./spool-folders.ts");
    const dir = temp("wb-spool-helper-");
    writeFileSync(join(dir, "a.req.json"), JSON.stringify({ id: "a" }));
    expect(readSpoolRequest(join(dir, "a.req.json"), 1_000)).toEqual({ id: "a" });
    expect(existsSync(join(dir, "a.req.json"))).toBe(false);
    symlinkSync("/dev/zero", join(dir, "z.req.json"));
    expect(readSpoolRequest(join(dir, "z.req.json"), 1_000)).toBeNull();
    execFileSync("mkfifo", [join(dir, "f.req.json")]);
    expect(readSpoolRequest(join(dir, "f.req.json"), 1_000)).toBeNull();
    writeFileSync(join(dir, "big.req.json"), JSON.stringify({ id: "x".repeat(5_000) }));
    expect(readSpoolRequest(join(dir, "big.req.json"), 1_000)).toBeNull();
    for (const file of ["z.req.json", "f.req.json", "big.req.json"]) expect(existsSync(join(dir, file))).toBe(false);
  });

});
