import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { EventBus } from "./bus.ts";
import { FindTool, findSessionName, isPlainFindCommand, withFindTool } from "./find-tool.ts";
import { FIND_HEAD } from "./search.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";

// workbench-find as engines run it: the command on PATH writes a request into its session's
// spool folder and the gateway answers with a file (no socket: Codex's sandbox allows none).

const run = promisify(execFile);
const dirs: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wb-find-"));
  dirs.push(dir);
  const store = new Store(join(dir, "state.sqlite"));
  const bus = new EventBus();
  const manager = new SessionManager(store, bus, { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works"), dataDir: dir });
  return { dir, bus, manager };
}

function say(manager: SessionManager, sessionId: string, text: string) {
  manager.sink.upsertItem(sessionId, { kind: "assistant", id: `a:${Date.now()}`, text, streaming: false, at: Date.now() });
}

function work(manager: SessionManager, title: string, provider: "claude" | "codex", purpose: string) {
  const created = manager.createWork({ title, titleSource: "user" });
  const session = manager.createSession(created.id, { provider, purpose });
  manager.updateSession(session.id, { purpose });
  return { work: created, session };
}

describe("workbench-find through the spool", () => {
  it("runs from an engine's PATH through the spool, for Claude (session variable) and Codex (thread id)", async () => {
    const { dir, bus, manager } = setup();
    const { session: codex } = work(manager, "안녕", "codex", "과제 채점 기준표");
    const claude = manager.createSession(codex.workId, { provider: "claude", purpose: "슬라이드" });
    say(manager, codex.id, "채점 기준은 세 단계입니다.");
    manager.sink.updateSession(codex.id, { nativeSessionId: "thr_test_1" });
    const tool = new FindTool({ dataDir: dir, finder: manager.finder, sessions: () => manager.view.sessions, bus, pollMs: 50 });
    closers.push(() => tool.close());
    const hooks = withFindTool(null, tool.engineHooks());
    expect(hooks.pathDirs()).toEqual([tool.bin]);
    const env = hooks.sessionEnv(claude);
    expect(env).toEqual({ WORKBENCH_FIND_SESSION: findSessionName(claude.id) });
    expect(hooks.writableRoots(codex)).toEqual([join(tool.spool, findSessionName(codex.id))]);
    expect(hooks.allowsCommand(codex.id, 'workbench-find "채점 기준"')).toBe(true);
    expect(hooks.allowsCommand(codex.id, "bash -lc 'workbench-find --all 기준'")).toBe(true);
    expect(isPlainFindCommand('workbench-find "기준" | head')).toBe(false);
    expect(isPlainFindCommand("workbench-find $(cat x)")).toBe(false);
    const command = join(tool.bin, "workbench-find");
    const fromClaude = await run(command, ["채점 기준"], { env: { ...process.env, ...env } });
    expect(fromClaude.stdout.split("\n")[0]).toContain(FIND_HEAD);
    expect(fromClaude.stdout).toContain("[안녕 · Codex · 과제 채점 기준표");
    const fromCodex = await run(command, ["채점 기준"], { env: { ...process.env, WORKBENCH_FIND_SESSION: "", CODEX_THREAD_ID: "thr_test_1" } });
    expect(fromCodex.stdout).toContain("[안녕 · Codex · 과제 채점 기준표");
    expect(JSON.parse(readFileSync(join(tool.root, "threads.json"), "utf8"))).toEqual({ thr_test_1: findSessionName(codex.id) });
    // Outside a Workbench session it says so.
    await expect(run(command, ["기준"], { env: { ...process.env, WORKBENCH_FIND_SESSION: "", CODEX_THREAD_ID: "" } })).rejects.toMatchObject({ stderr: expect.stringContaining("Workbench 세션 안에서만") });
    // Nothing is left behind in the spool.
    expect(readdirSync(join(tool.spool, findSessionName(claude.id))).filter((file) => !file.endsWith(".tmp"))).toEqual([]);
  });
});
