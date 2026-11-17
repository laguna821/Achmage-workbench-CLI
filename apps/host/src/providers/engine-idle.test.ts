import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session, TranscriptItem, Work } from "@workbench/contracts";
import type { AdapterSink } from "./types.ts";
import { ClaudeAdapter } from "./claude.ts";
import { CodexAdapter } from "./codex.ts";

// 0.5.3 A11: an idle engine of a conversation that is not on screen is closed sooner than one on screen;
// the next message resumes the same conversation as after today's idle stop. Stand-in engines only.

const dirs: string[] = [];
const adapters: { shutdown(): Promise<void> }[] = [];
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.shutdown();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function recorder() {
  const items: { sessionId: string; item: TranscriptItem }[] = [];
  const text = new Map<string, string>();
  const patches: { sessionId: string; patch: Partial<Session> }[] = [];
  const sink: AdapterSink = {
    upsertItem: (sessionId, item) => items.push({ sessionId, item }),
    delta: (sessionId, _itemId, delta) => text.set(sessionId, (text.get(sessionId) ?? "") + delta),
    updateSession: (sessionId, patch) => patches.push({ sessionId, patch }),
    providerStatus: () => undefined,
    steerDropped: () => undefined,
    toolImages: () => undefined,
  };
  return { items, text, patches, sink };
}
const session = (id: string, provider: "claude" | "codex", over: Partial<Session> = {}): Session & { access: "full" } => ({
  id, workId: "w", provider, hostId: "h", nativeSessionId: null, purpose: "", purposeSource: "user", model: "fake-pick", effort: "high",
  engineModel: null, engineEffort: null, preview: null, previewAt: null, status: "idle", activity: null, lastError: null, pinned: false,
  sort: 0, archivedAt: null, seenAt: null, unread: false, queued: [], context: null, createdAt: 0, updatedAt: 0, ...over, access: "full",
});
const work = (cwd: string): Work => ({ id: "w", title: "w", titleSource: "user", folderId: null, cwd, cwdManaged: false, activeSessionId: null, pinned: false, sort: 0, archivedAt: null, createdAt: 0, updatedAt: 0 });
const until = async (what: () => boolean, timeout = 15_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end && !what()) await new Promise((done) => setTimeout(done, 50));
  return what();
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function setup() {
  // The stand-in keeps its conversation record only under a temporary CLAUDE_CONFIG_DIR (never ~/.claude).
  const cwd = mkdtempSync(join(tmpdir(), "wb-engine-idle-"));
  dirs.push(cwd);
  const log = join(cwd, "args.log");
  vi.stubEnv("WORKBENCH_CLAUDE_BIN", resolve("scripts/fixtures/fake-claude.mjs"));
  vi.stubEnv("WORKBENCH_CODEX_BIN", resolve("scripts/fixtures/fake-codex.mjs"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(cwd, "claude"));
  vi.stubEnv("FAKE_ENGINE_ARGS_LOG", log);
  const starts = () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { engine: string; pid: number; args?: string[]; method?: string; config?: Record<string, unknown> | null; session?: string | null }) : [];
  return { cwd, starts };
}
const turnEnds = (items: { sessionId: string; item: TranscriptItem }[], sessionId: string) => items.filter((entry) => entry.sessionId === sessionId && entry.item.kind === "turnEnd").length;

describe("Claude: an idle engine off screen is closed sooner (A11)", () => {
  it("off screen it closes after the short time; the next message resumes the same conversation with its settings", async () => {
    const { cwd, starts } = setup();
    const { items, text, patches, sink } = recorder();
    const adapter = new ClaudeAdapter(sink, { idleMs: 60_000, offScreenIdleMs: 400 });
    adapters.push(adapter);
    const s = session("s-off", "claude");
    await adapter.send(s, work(cwd), "안녕", "req-1");
    expect(await until(() => turnEnds(items, s.id) === 1)).toBe(true);
    const first = starts().filter((entry) => entry.engine === "claude" && entry.session);
    expect(first).toHaveLength(1);
    const native = patches.find((entry) => entry.patch.nativeSessionId)?.patch.nativeSessionId;
    expect(native).toBeTruthy();
    // Not on screen: closed after ~0.4 s, not after the on-screen minute.
    expect(await until(() => !alive(first[0]!.pid), 5_000)).toBe(true);
    // The next message: a new process that resumes the same conversation, with the same model, effort and access.
    text.clear();
    await adapter.send({ ...s, nativeSessionId: native! }, work(cwd), "다시", "req-2");
    expect(await until(() => turnEnds(items, s.id) === 2)).toBe(true);
    const second = starts().filter((entry) => entry.engine === "claude" && entry.session);
    expect(second).toHaveLength(2);
    const args = second[1]!.args!;
    expect(args).toContain(`--resume=${native}`);
    expect(args).toEqual(expect.arrayContaining(["--model=fake-pick", "--effort=high", "--permission-mode=bypassPermissions", "--setting-sources=user,project,local"]));
    // Its context came back: the stand-in read the record of the first request.
    expect(text.get(s.id)).toContain("이어 받은 기록: 요청 1개");
  }, 30_000);

  it("on screen it stays for the long time; taken off screen it closes after the short one", async () => {
    const { cwd, starts } = setup();
    const { items, sink } = recorder();
    const adapter = new ClaudeAdapter(sink, { idleMs: 60_000, offScreenIdleMs: 400 });
    adapters.push(adapter);
    const s = session("s-on", "claude");
    adapter.shownChanged(new Set([s.id]));
    await adapter.send(s, work(cwd), "안녕", "req-1");
    expect(await until(() => turnEnds(items, s.id) === 1)).toBe(true);
    const pid = starts().find((entry) => entry.engine === "claude" && entry.session)!.pid;
    await new Promise((done) => setTimeout(done, 1_200));
    expect(alive(pid)).toBe(true);
    adapter.shownChanged(new Set());
    expect(await until(() => !alive(pid), 5_000)).toBe(true);
  }, 30_000);
});

describe("Codex: the shared app-server stops sooner when none of its conversations is on screen (A11)", () => {
  it("stops after the short time off screen, stays while one is on screen; the next message resumes the thread", async () => {
    const { cwd, starts } = setup();
    const { items, patches, sink } = recorder();
    const adapter = new CodexAdapter(sink, { idleMs: 60_000, offScreenIdleMs: 400 });
    adapters.push(adapter);
    const s = session("s-codex", "codex");
    adapter.shownChanged(new Set([s.id]));
    await adapter.send(s, work(cwd), "안녕", "req-1");
    expect(await until(() => turnEnds(items, s.id) === 1)).toBe(true);
    const pid = starts().find((entry) => entry.engine === "codex")!.pid;
    await new Promise((done) => setTimeout(done, 1_200));
    expect(alive(pid)).toBe(true);
    adapter.shownChanged(new Set());
    expect(await until(() => !alive(pid), 5_000)).toBe(true);
    const thread = patches.find((entry) => entry.patch.nativeSessionId)?.patch.nativeSessionId;
    await adapter.send({ ...s, nativeSessionId: thread! }, work(cwd), "다시", "req-2");
    expect(await until(() => turnEnds(items, s.id) === 2)).toBe(true);
    expect(starts().filter((entry) => entry.engine === "codex").map((entry) => entry.method)).toEqual(["thread/start", "thread/resume"]);
  }, 30_000);
});

describe("the engines listed for the memory readout, and '쉬는 엔진 지금 끄기' (B1)", () => {
  it("lists each Claude conversation's process with whether it is idle; closing idle ones never touches a running turn", async () => {
    const { cwd, starts } = setup();
    const { items, sink } = recorder();
    const adapter = new ClaudeAdapter(sink, { idleMs: 60_000, offScreenIdleMs: 60_000 });
    adapters.push(adapter);
    const quiet = session("s-quiet", "claude"), busy = session("s-busy", "claude");
    await adapter.send(quiet, work(cwd), "안녕", "q-1");
    expect(await until(() => turnEnds(items, quiet.id) === 1)).toBe(true);
    await adapter.send(busy, work(cwd), "길게 써 줘", "b-1");
    expect(adapter.engineProcesses()).toEqual([
      { provider: "claude", sessionIds: [quiet.id], pid: null, marker: quiet.id, idle: true },
      { provider: "claude", sessionIds: [busy.id], pid: null, marker: busy.id, idle: false },
    ]);
    expect(await until(() => starts().filter((entry) => entry.session).length === 2)).toBe(true);
    const pids = Object.fromEntries(starts().filter((entry) => entry.session).map((entry) => [entry.session!, entry.pid]));
    expect(adapter.closeIdleEngines()).toBe(1);
    expect(await until(() => !alive(pids[quiet.id]!), 5_000)).toBe(true);
    expect(alive(pids[busy.id]!)).toBe(true);
    expect(adapter.engineProcesses().map((entry) => entry.sessionIds[0])).toEqual([busy.id]);
    // The running turn ends normally.
    expect(await until(() => turnEnds(items, busy.id) === 1, 20_000)).toBe(true);
    expect(items.filter((entry) => entry.sessionId === busy.id && entry.item.kind === "turnEnd").map((entry) => (entry.item as { status: string }).status)).toEqual(["completed"]);
  }, 40_000);

  it("Codex: one shared app-server with its conversations; closed only when nothing runs", async () => {
    const { cwd, starts } = setup();
    const { items, sink } = recorder();
    const adapter = new CodexAdapter(sink, { idleMs: 60_000, offScreenIdleMs: 60_000 });
    adapters.push(adapter);
    const s = session("s-cx", "codex");
    await adapter.send(s, work(cwd), "길게 써 줘", "c-1");
    const pid = starts().find((entry) => entry.engine === "codex")!.pid;
    expect(adapter.engineProcesses()).toEqual([{ provider: "codex", sessionIds: [s.id], pid, marker: null, idle: false }]);
    expect(adapter.closeIdleEngines()).toBe(0);
    expect(await until(() => turnEnds(items, s.id) === 1, 20_000)).toBe(true);
    expect(adapter.engineProcesses()[0]!.idle).toBe(true);
    expect(adapter.closeIdleEngines()).toBe(1);
    expect(await until(() => !alive(pid), 5_000)).toBe(true);
    expect(adapter.engineProcesses()).toEqual([]);
  }, 40_000);
});

describe("the public default loads no personal MCP servers or hooks (owner 2026-11-16)", () => {
  it("Claude: by default --strict-mcp-config and hooks off, the user settings (permissions, model, CLAUDE.md) still loaded; the switch on: as before", async () => {
    const { cwd, starts } = setup();
    const { items, sink } = recorder();
    let personal = false;
    const adapter = new ClaudeAdapter(sink, { idleMs: 60_000, personalTools: () => personal });
    adapters.push(adapter);
    const s = session("s-mcp", "claude");
    await adapter.send(s, work(cwd), "안녕", "m-1");
    expect(await until(() => turnEnds(items, s.id) === 1)).toBe(true);
    const off = starts().filter((entry) => entry.session)[0]!.args!;
    expect(off).toContain("--strict-mcp-config");
    expect(off).toContain("--setting-sources=user,project,local");
    const settings = off.find((arg) => arg.startsWith("--settings="))?.slice(11) ?? off[off.indexOf("--settings") + 1]!;
    expect(JSON.parse(settings)).toEqual({ disableAllHooks: true });
    expect(adapter.status().personalTools).toBe(false);
    // Switched on: the idle engine closes so the next message starts with the person's own servers and hooks.
    personal = true;
    adapter.personalToolsChanged();
    expect(adapter.status().personalTools).toBe(true);
    await adapter.send(s, work(cwd), "다시", "m-2");
    expect(await until(() => turnEnds(items, s.id) === 2)).toBe(true);
    const on = starts().filter((entry) => entry.session)[1]!.args!;
    expect(on).not.toContain("--strict-mcp-config");
    expect(on.some((arg) => arg.startsWith("--settings"))).toBe(false);
    expect(on).toContain("--setting-sources=user,project,local");
  }, 30_000);

  it("Codex: by default each configured MCP server is turned off for the thread and hooks are off; the switch on passes nothing", async () => {
    const { cwd, starts } = setup();
    vi.stubEnv("FAKE_CODEX_MCP_SERVERS", "achmage,lightpanda");
    const { items, patches, sink } = recorder();
    let personal = false;
    const adapter = new CodexAdapter(sink, { idleMs: 60_000, personalTools: () => personal });
    adapters.push(adapter);
    const s = session("s-cx-mcp", "codex");
    await adapter.send(s, work(cwd), "안녕", "x-1");
    expect(await until(() => turnEnds(items, s.id) === 1)).toBe(true);
    expect(starts().filter((entry) => entry.engine === "codex")[0]!.config).toEqual({ "mcp_servers.achmage.enabled": false, "mcp_servers.lightpanda.enabled": false, "features.codex_hooks": false });
    expect(adapter.status().personalTools).toBe(false);
    personal = true;
    adapter.personalToolsChanged();
    await new Promise((done) => setTimeout(done, 300));
    const thread = patches.find((entry) => entry.patch.nativeSessionId)?.patch.nativeSessionId;
    await adapter.send({ ...s, nativeSessionId: thread! }, work(cwd), "다시", "x-2");
    expect(await until(() => turnEnds(items, s.id) === 2)).toBe(true);
    const resumed = starts().filter((entry) => entry.engine === "codex").at(-1)!;
    expect(resumed.method).toBe("thread/resume");
    expect(resumed.config).toBeNull();
  }, 30_000);
});
