import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { Session, Work } from "@workbench/contracts";
import type { BrowserEngineHooks } from "../browse.ts";
import { EventBus } from "../bus.ts";
import { TranscriptScrubber } from "../credentials/scrubber.ts";
import { findSessionName } from "../find-tool.ts";
import { ChannelLog } from "./log.ts";
import { RemoteTool } from "./remote-tool.ts";
import { VaultRedactor } from "./vault-chat.ts";

// The transport of workbench-remote and its key: only a conversation of a messenger's place gets
// the command's spool and a key; a request without that key is refused; the key is hidden wherever
// text is kept, shown or sent (the transcript scrubber, the channel's redactor and log).

const run = promisify(execFile);
const dirs: string[] = [];
const tools: RemoteTool[] = [];
afterEach(() => {
  for (const tool of tools.splice(0)) tool.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const base: BrowserEngineHooks = {
  pathDirs: () => ["/base/bin"], sessionEnv: () => ({ BASE: "1" }), instructions: () => null, offNote: () => "", allowsCommand: () => false,
  writableRoots: () => ["/base/spool"], told: () => null, setTold: () => undefined, extraInstructions: () => "base tools",
};
const session = (id: string, over: Partial<Session> = {}) => ({ id, workId: "home", provider: "claude", nativeSessionId: null, archivedAt: null, ...over }) as unknown as Session;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wb-remotetool-"));
  dirs.push(dir);
  const works = new Map<string, Work>([["home", { id: "home", archivedAt: null, messengerHome: { kind: "telegram", registered: true } } as unknown as Work], ["mine", { id: "mine", archivedAt: null } as unknown as Work]]);
  const sessions = new Map<string, Session>([
    ["s-remote", session("s-remote")], ["s-codex", session("s-codex", { provider: "codex", nativeSessionId: "thread-9" })], ["s-project", session("s-project", { workId: "mine" })],
  ]);
  const asked: { sessionId: string; args: string[]; input: string }[] = [];
  const scrubber = new TranscriptScrubber();
  const bus = new EventBus();
  const tool = new RemoteTool({
    dataDir: dir, sessions: () => sessions, works: () => works, bus, pollMs: 20,
    run: async (sessionId, args, input) => { asked.push({ sessionId, args, input }); return { code: 0, stdout: `${JSON.stringify({ ok: true, args })}\n`, stderr: "" }; },
    hide: (id, name, value) => (value ? scrubber.set(id, name, [value]) : scrubber.remove(id)),
  });
  tools.push(tool);
  return { dir, tool, hooks: tool.hooks(base), sessions, works, asked, scrubber, bus };
}

const command = (bin: string, args: string[], env: Record<string, string | undefined>, input?: string) => {
  const child = run(join(bin, "workbench-remote"), args, { env: { PATH: process.env.PATH, ...env }, timeout: 20_000 });
  if (input !== undefined) { child.child.stdin?.end(input); }
  return child.then((out) => ({ code: 0, ...out }), (error: { code: number; stdout: string; stderr: string }) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }));
};

describe("workbench-remote's transport", () => {
  it("only a messenger place's conversation gets its spool, its key and its lines; the others get nothing new", () => {
    const { hooks, sessions } = setup();
    const remote = hooks.sessionEnv(sessions.get("s-remote")!);
    expect(remote.WORKBENCH_REMOTE_SESSION).toBe(findSessionName("s-remote"));
    expect(remote.WORKBENCH_REMOTE_KEY).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hooks.sessionEnv(sessions.get("s-project")!)).toEqual({ BASE: "1" });
    expect(hooks.writableRoots(sessions.get("s-project")!)).toEqual(["/base/spool"]);
    expect(hooks.writableRoots(sessions.get("s-remote")!)).toHaveLength(2);
    expect(hooks.extraInstructions!(sessions.get("s-remote")!)).toContain("workbench-remote");
    expect(hooks.extraInstructions!(sessions.get("s-project")!)).toBe("base tools");
  });

  it("runs from the command line for Claude (its variables) and Codex (its thread, the key file), with the instruction on stdin", async () => {
    const { hooks, sessions, asked, tool, dir } = setup();
    const bin = hooks.pathDirs().find((entry) => entry !== "/base/bin")!;
    expect(statSync(join(bin, "workbench-remote")).mode & 0o111).not.toBe(0);
    const env = hooks.sessionEnv(sessions.get("s-remote")!);
    const out = await command(bin, ["tell", "--conversation", "x"], env, "서론 다시 써 줘\n");
    expect(out.code).toBe(0);
    expect(asked[0]).toEqual({ sessionId: "s-remote", args: ["tell", "--conversation", "x"], input: "서론 다시 써 줘\n" });
    hooks.writableRoots(sessions.get("s-codex")!);
    const codex = await command(bin, ["projects"], { CODEX_THREAD_ID: "thread-9" });
    expect(codex.code).toBe(0);
    expect(asked[1]).toMatchObject({ sessionId: "s-codex", args: ["projects"] });
    // The key file is the person's own (0600, in a 0700 folder).
    expect(statSync(join(tool.root, "keys", findSessionName("s-codex"))).mode & 0o077).toBe(0);
    expect(statSync(join(dir, "remote-tool")).mode & 0o077).toBe(0);
  });

  it("refuses a request without the right key, and from a conversation outside a messenger's place", async () => {
    const { hooks, sessions, asked, tool } = setup();
    const bin = hooks.pathDirs().find((entry) => entry !== "/base/bin")!;
    const env = hooks.sessionEnv(sessions.get("s-remote")!);
    const wrong = await command(bin, ["projects"], { WORKBENCH_REMOTE_SESSION: env.WORKBENCH_REMOTE_SESSION, WORKBENCH_REMOTE_KEY: "x".repeat(43) });
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toMatch(/리모콘/);
    const none = await command(bin, ["projects"], { WORKBENCH_REMOTE_SESSION: findSessionName("s-project") });
    expect(none.code).toBe(1);
    expect(none.stderr).toMatch(/메신저의 대화/);
    // A request file planted by hand in the remote's spool, without the key, is refused too.
    const spool = join(tool.root, "spool", findSessionName("s-remote"));
    writeFileSync(join(spool, "abcd-1234.req.json"), JSON.stringify({ id: "abcd-1234", args: ["projects"], input: "" }));
    for (let i = 0; i < 200 && !existsSync(join(spool, "abcd-1234.res.json")); i += 1) await new Promise((done) => setTimeout(done, 10));
    expect(JSON.parse(readFileSync(join(spool, "abcd-1234.res.json"), "utf8")).code).toBe(1);
    expect(asked).toEqual([]);
  });

  it("the key ends when the conversation is archived (or leaves the place), and is never shown, kept or logged", async () => {
    const { hooks, sessions, asked, scrubber, bus, tool } = setup();
    const bin = hooks.pathDirs().find((entry) => entry !== "/base/bin")!;
    const env = hooks.sessionEnv(sessions.get("s-remote")!);
    const key = env.WORKBENCH_REMOTE_KEY!;
    // The transcript scrubber, the channel's redactor and its log all hide it.
    expect(scrubber.text(`env: WORKBENCH_REMOTE_KEY=${key}`)).toBe("env: WORKBENCH_REMOTE_KEY=[비밀: Workbench 리모콘 키]");
    const lines: string[] = [];
    const log = new ChannelLog(new VaultRedactor(scrubber), (line) => lines.push(line));
    expect(log.scrub(`답: ${key}`)).not.toContain(key);
    log.note("send_refused", new Error(`failed with ${key}`));
    expect(lines.join("\n")).not.toContain(key);
    // Nothing of it is in the tool's own folder for a Claude conversation.
    const files = readdirSync(tool.root, { recursive: true }).map(String);
    for (const file of files) { try { if (statSync(join(tool.root, file)).isFile()) expect(readFileSync(join(tool.root, file), "utf8")).not.toContain(key); } catch { /* A folder. */ } }
    // Archived: the key is worth nothing.
    const archived = { ...sessions.get("s-remote")!, archivedAt: 1 } as Session;
    sessions.set("s-remote", archived);
    bus.publish({ type: "session.upserted", session: archived });
    const after = await command(bin, ["projects"], env);
    expect(after.code).toBe(1);
    expect(asked).toEqual([]);
  });
});
