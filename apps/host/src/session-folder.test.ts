import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ApprovalDecision, ProviderStatus, Session, Work } from "@workbench/contracts";
import { EventBus } from "./bus.ts";
import { scopedRoute } from "./devices/scope.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";
import { emptyStatus, type EngineProcess, type ProviderAdapter } from "./providers/types.ts";

// composer-056: a conversation's working folder (the folder its engine runs in) is chosen from the
// input's 첨부. Rule: a conversation that has not started moves to the folder chosen; one that has (a
// request sent, an engine already running for it) stays where it is and a NEW conversation starts in the
// folder chosen — a running engine is never moved. The project's other conversations, its own folder and
// its documents stay as they are. Files dropped as paths (a file manager's file:// list) are attached by
// path, under the rules every attachment follows. Both are the PC's own: a paired phone is refused.

class Engine implements ProviderAdapter {
  readonly provider = "codex" as const;
  cwds: string[] = [];
  alive = new Set<string>();
  async init() {}
  status(): ProviderStatus { return emptyStatus("codex"); }
  async refreshStatus() { return this.status(); }
  async login() { return { url: null, message: "" }; }
  async send(session: Session, work: Work) { this.cwds.push(work.cwd); this.alive.add(session.id); }
  async interrupt() {}
  async answerApproval(_session: Session, _itemId: string, _decision: ApprovalDecision) { return false; }
  engineProcesses(): EngineProcess[] { return [...this.alive].map((id) => ({ provider: "codex", sessionIds: [id], pid: null, marker: null, idle: true })); }
  async shutdown() {}
}

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wb-session-folder-"));
  dirs.push(dir);
  const manager = new SessionManager(new Store(join(dir, "state.sqlite")), new EventBus(), { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works"), dataDir: dir });
  const engine = new Engine();
  manager.registerAdapter(engine);
  const work = manager.createWork({ title: "강의" });
  const other = manager.createSession(work.id, { provider: "codex" });
  const session = manager.createSession(work.id, { provider: "codex", model: "m1" });
  const chosen = join(dir, "수업 자료");
  mkdirSync(chosen);
  return { dir, manager, engine, work, other, session, chosen };
}
const cwdOf = (manager: SessionManager, session: Session) => manager.workspaces.get(session.workspaceId!).cwd;

describe("a conversation's working folder", () => {
  it("a conversation not started moves to the folder chosen: its engine starts there; the project and its other conversations stay", async () => {
    const { manager, engine, work, other, session, chosen } = setup();
    const before = { work: manager.view.works.get(work.id)!, other: manager.view.sessions.get(other.id)! };
    const result = manager.sessionFolder(session.id, chosen);
    expect(result.moved).toBe(true);
    expect(result.session.id).toBe(session.id);
    expect(cwdOf(manager, result.session)).toBe(realpathSync(chosen));
    expect(manager.view.works.get(work.id)!.cwd).toBe(before.work.cwd);
    expect(manager.view.sessions.get(other.id)!.workspaceId).toBe(before.other.workspaceId);
    await manager.send(session.id, "r1", "자료 정리해 줘");
    expect(engine.cwds).toEqual([realpathSync(chosen)]);
  });

  it("a conversation that has started stays where it is; a new conversation of the same engine and model starts in the folder chosen", async () => {
    const { manager, engine, session, chosen } = setup();
    await manager.send(session.id, "r1", "먼저 한 요청");
    const kept = manager.view.sessions.get(session.id)!;
    const result = manager.sessionFolder(session.id, chosen);
    expect(result.moved).toBe(false);
    expect(result.session.id).not.toBe(session.id);
    expect(result.session).toMatchObject({ provider: "codex", model: "m1", workId: session.workId });
    expect(cwdOf(manager, result.session)).toBe(realpathSync(chosen));
    expect(manager.view.sessions.get(session.id)!.workspaceId).toBe(kept.workspaceId);
    expect(engine.alive.has(session.id)).toBe(true);
  });

  it("a conversation whose engine is already running (a / list asked it) is not moved either", () => {
    const { manager, engine, session, chosen } = setup();
    engine.alive.add(session.id);
    expect(manager.sessionFolder(session.id, chosen).moved).toBe(false);
  });

  it("the same folder chosen again changes nothing; a file or a missing folder is refused in one line", () => {
    const { manager, dir, session, chosen } = setup();
    const first = manager.sessionFolder(session.id, chosen);
    expect(manager.sessionFolder(session.id, chosen)).toMatchObject({ moved: true, session: { id: first.session.id, workspaceId: first.session.workspaceId } });
    writeFileSync(join(dir, "메모.txt"), "x");
    expect(() => manager.sessionFolder(session.id, join(dir, "메모.txt"))).toThrow(/폴더/);
    expect(() => manager.sessionFolder(session.id, join(dir, "없는 폴더"))).toThrow(/폴더/);
    expect(() => manager.sessionFolder(session.id, "상대 경로")).toThrow(/폴더/);
  });
});

describe("files dropped as paths", () => {
  it("attaches a file by its path, under the attachments' rules (a file, 25MB at most, a full path)", () => {
    const { manager, dir } = setup();
    const file = join(dir, "강의계획서.txt");
    writeFileSync(file, "1주차: 소개\n");
    const attachment = manager.attachLocal(file);
    expect(attachment).toMatchObject({ name: "강의계획서.txt", mime: "text/plain", size: Buffer.byteLength("1주차: 소개\n") });
    expect(manager.attachments.path(attachment.id)).toBeTruthy();
    expect(() => manager.attachLocal(dir)).toThrow(/파일/);
    expect(() => manager.attachLocal(join(dir, "없음.txt"))).toThrow(/없습니다/);
    expect(() => manager.attachLocal("강의계획서.txt")).toThrow(/전체 경로/);
    const big = join(dir, "큰 파일.bin");
    writeFileSync(big, Buffer.alloc(25 * 1024 * 1024 + 1));
    expect(() => manager.attachLocal(big)).toThrow(/25MB/);
  });
});

describe("the PC's own", () => {
  it("a paired phone cannot choose a PC folder or attach a PC file by its path", () => {
    const { manager, session } = setup();
    for (const [path, body] of [[`/api/sessions/${session.id}/folder`, { cwd: "/tmp" }], ["/api/attachments/local", { path: "/etc/hostname" }]] as const) {
      let refused: unknown = null;
      try { scopedRoute(manager, "POST", path, body as Record<string, unknown>); } catch (error) { refused = error; }
      expect(refused, path).toMatchObject({ status: 403, code: "CAPABILITY_DENIED" });
    }
  });
});
