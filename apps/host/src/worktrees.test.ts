import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AccessMode, ApprovalDecision, ProviderStatus, Session, Work } from "@workbench/contracts";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";
import { emptyStatus, type AdapterSink, type ProviderAdapter } from "./providers/types.ts";

// "격리 사본": a session working in a git worktree, reviewed and applied (or thrown away).

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" });

class CwdEngine implements ProviderAdapter {
  readonly provider = "codex" as const;
  cwds: string[] = [];
  private readonly sink: () => AdapterSink;
  constructor(sink: () => AdapterSink) {
    this.sink = sink;
  }
  async init() {}
  status(): ProviderStatus {
    return emptyStatus("codex");
  }
  async refreshStatus() {
    return this.status();
  }
  async login() {
    return { url: null, message: "" };
  }
  async send(session: Session & { access: AccessMode }, work: Work, _text: string, turnKey: string) {
    this.cwds.push(work.cwd);
    this.sink().upsertItem(session.id, { kind: "turnEnd", id: `end:${turnKey}`, status: "completed", durationMs: 1, at: Date.now() });
    this.sink().updateSession(session.id, { status: "idle" });
  }
  async interrupt() {}
  async answerApproval(_session: Session, _itemId: string, _decision: ApprovalDecision) {
    return false;
  }
  async shutdown() {}
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(repository = true) {
  const dir = mkdtempSync(join(tmpdir(), "wb-worktree-"));
  dirs.push(dir);
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "notes"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "첫 줄\n");
  if (repository) {
    git(repo, "init", "-q", "-b", "main");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "start");
  }
  const manager = new SessionManager(new Store(join(dir, "state.sqlite")), new EventBus(), { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works"), dataDir: join(dir, "data") });
  const engine = new CwdEngine(() => manager.sink);
  manager.registerAdapter(engine);
  const work = manager.createWork({ title: "w", cwd: join(repo, "notes") });
  return { manager, engine, work, repo };
}

describe("격리 사본", () => {
  it("works in a worktree on a branch of its own, in the work's subfolder", async () => {
    const { manager, engine, work, repo } = setup();
    const session = await manager.createIsolatedSession(work.id, { provider: "codex" });
    expect(session.worktree).toMatchObject({ root: repo, branch: expect.stringMatching(/^workbench\//) });
    expect(session.worktree!.cwd).toBe(join(session.worktree!.path, "notes"));
    expect(readFileSync(join(session.worktree!.path, "README.md"), "utf8")).toBe("첫 줄\n");
    await manager.send(session.id, "r1", "고쳐 줘");
    expect(engine.cwds).toEqual([session.worktree!.cwd]);
  });

  it("shows changed and new files, applies them to the original, and keeps the copy", async () => {
    const { manager, work, repo } = setup();
    const session = await manager.createIsolatedSession(work.id, { provider: "codex" });
    writeFileSync(join(session.worktree!.path, "README.md"), "첫 줄\n둘째 줄\n");
    writeFileSync(join(session.worktree!.cwd, "새 노트.md"), "새로 쓴 노트\n");
    const changes = await manager.worktreeChanges(session.id);
    expect(changes.files).toEqual(expect.arrayContaining([{ path: "README.md", status: "modified" }, { path: "notes/새 노트.md", status: "added" }]));
    expect(changes.diff).toContain("+둘째 줄");
    await manager.applyWorktree(session.id);
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("첫 줄\n둘째 줄\n");
    expect(readFileSync(join(repo, "notes", "새 노트.md"), "utf8")).toBe("새로 쓴 노트\n");
    expect(existsSync(session.worktree!.path)).toBe(true);
  });

  it("refuses to apply over the same lines changed in the original, changing nothing", async () => {
    const { manager, work, repo } = setup();
    const session = await manager.createIsolatedSession(work.id, { provider: "codex" });
    writeFileSync(join(session.worktree!.path, "README.md"), "사본에서 고친 줄\n");
    writeFileSync(join(repo, "README.md"), "원래 폴더에서 고친 줄\n");
    await expect(manager.applyWorktree(session.id)).rejects.toThrow(/그대로 적용할 수 없습니다/);
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("원래 폴더에서 고친 줄\n");
  });

  it("throws the copy and its branch away and archives the session", async () => {
    const { manager, work, repo } = setup();
    const session = await manager.createIsolatedSession(work.id, { provider: "codex" });
    await manager.discardWorktree(session.id);
    expect(existsSync(session.worktree!.path)).toBe(false);
    expect(git(repo, "branch", "--list", session.worktree!.branch).trim()).toBe("");
    expect(manager.snapshot().sessions.find((entry) => entry.id === session.id)?.archivedAt).toBeTypeOf("number");
  });

  it("makes no session outside a git repository", async () => {
    const { manager, work } = setup(false);
    await expect(manager.createIsolatedSession(work.id, { provider: "codex" })).rejects.toThrow(/git 저장소가 아니어서/);
    expect(manager.snapshot().sessions).toHaveLength(0);
  });
});
