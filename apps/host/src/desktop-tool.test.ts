import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Session } from "@workbench/contracts";
import type { BrowserEngineHooks } from "./browse.ts";
import { EventBus } from "./bus.ts";
import { DesktopTool } from "./desktop-tool.ts";
import type { DesktopService } from "./desktop-adapter.ts";
import { findSessionName } from "./find-tool.ts";

const dirs: string[] = [];
const tools: DesktopTool[] = [];
afterEach(() => {
  for (const tool of tools.splice(0)) tool.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const session = (id: string, over: Partial<Session> = {}) => ({ id, provider: "claude", nativeSessionId: null, archivedAt: null, ...over }) as unknown as Session;
const base: BrowserEngineHooks = {
  pathDirs: () => [], sessionEnv: () => ({}), instructions: () => null, offNote: () => "", allowsCommand: () => false,
  writableRoots: () => [], told: () => null, setTold: () => undefined, extraInstructions: () => "",
};
const until = async (what: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end && !what()) await new Promise((done) => setTimeout(done, 20)); return what(); };

function setup(pollMs?: number) {
  const dir = mkdtempSync(join(tmpdir(), "wb-desktoptool-"));
  dirs.push(dir);
  // Many sessions known (archived ones included), as in a long-used install.
  const sessions = new Map<string, Session>();
  for (let index = 0; index < 50; index++) sessions.set(`old-${index}`, session(`old-${index}`, { archivedAt: 1 }));
  sessions.set("live", session("live"));
  const bus = new EventBus();
  const asked: string[] = [];
  const service = { observe: async (id: string) => { asked.push(id); return { id: "obs" }; }, release: () => undefined } as unknown as DesktopService;
  const tool = new DesktopTool(dir, service, sessions, bus, pollMs === undefined ? {} : { pollMs });
  tools.push(tool);
  return { dir, tool, bus, asked, sessions, hooks: tool.hooks(base) };
}
const request = (dir: string, sessionId: string, id = "abcd-1234") => {
  const spool = join(dir, "desktop", "tool", "spool", findSessionName(sessionId));
  mkdirSync(spool, { recursive: true });
  writeFileSync(join(spool, `${id}.req.json`), JSON.stringify({ id, args: ["snapshot"] }));
  return join(spool, `${id}.res.json`);
};

describe("workbench-desktop's spool (A9): only live conversations, by a watcher", () => {
  it("looks at no folder until a conversation's engine is handed the tool, and never at archived ones", () => {
    const { tool, hooks, sessions } = setup();
    expect(tool.watched).toEqual([]);
    hooks.sessionEnv(sessions.get("live")!);
    expect(tool.watched).toEqual([findSessionName("live")]);
  });

  it("answers a request at once through the watcher, without waiting for the slow look", async () => {
    const { dir, hooks, sessions, asked } = setup(60_000);
    hooks.sessionEnv(sessions.get("live")!);
    const answer = request(dir, "live");
    expect(await until(() => existsSync(answer))).toBe(true);
    expect(JSON.parse(readFileSync(answer, "utf8"))).toMatchObject({ code: 0 });
    expect(asked).toEqual(["live"]);
  });

  it("the slow look still finds a request the watcher missed", async () => {
    const { dir, tool, hooks, sessions } = setup(50);
    hooks.sessionEnv(sessions.get("live")!);
    tool.dropWatchersForTest();
    const answer = request(dir, "live", "miss-0001");
    expect(await until(() => existsSync(answer))).toBe(true);
  });

  it("a conversation archived stops being looked at; a request in its folder is not answered", async () => {
    const { dir, tool, hooks, sessions, bus, asked } = setup(50);
    hooks.sessionEnv(sessions.get("live")!);
    bus.publish({ type: "session.upserted", session: session("live", { archivedAt: 2 }) });
    expect(tool.watched).toEqual([]);
    const answer = request(dir, "live", "late-0001");
    await new Promise((done) => setTimeout(done, 300));
    expect(existsSync(answer)).toBe(false);
    expect(asked).toEqual([]);
  });
});
