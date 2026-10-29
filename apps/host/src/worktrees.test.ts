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
import { removeWorktree } from "./worktrees.ts";

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
  it("shares one workspace across sessions and blocks removal while any of them is running", async () => {
    const { manager, work } = setup();
    const first = await manager.createIsolatedSession(work.id, { provider: "codex" });
    const second = manager.createSession(work.id, { provider: "codex", workspaceId: first.workspaceId });
    expect(second.worktree).toEqual(first.worktree);
    manager.sink.updateSession(second.id, { status: "running" });
    await expect(manager.discardWorktree(first.id)).rejects.toThrow("실행 중");
    expect(existsSync(first.worktree!.path)).toBe(true);
    manager.sink.updateSession(second.id, { status: "idle" });
    await manager.discardWorktree(first.id);
    expect(existsSync(first.worktree!.path)).toBe(false);
    expect(manager.snapshot().sessions.filter((entry) => entry.workspaceId === first.workspaceId).every((entry) => entry.archivedAt !== null)).toBe(true);
    expect(manager.workspaces.get(first.workspaceId!).removedAt).not.toBeNull();
    expect(() => manager.updateWorkspace(first.workspaceId!, { archived: false })).toThrow("제거된");
  });

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

  it("review and apply preserve both indexes, including a partially staged file", async () => {
    const { manager, work, repo } = setup();
    const session = await manager.createIsolatedSession(work.id, { provider: "codex" });
    const copy = session.worktree!.path;
    writeFileSync(join(copy, "README.md"), "스테이지한 줄\n");
    git(copy, "add", "README.md");
    writeFileSync(join(copy, "README.md"), "최종 작업 줄\n");
    writeFileSync(join(copy, "새 파일.md"), "새 파일\n");
    const indexPath = git(copy, "rev-parse", "--path-format=absolute", "--git-path", "index").trim();
    const originalIndex = git(repo, "rev-parse", "--path-format=absolute", "--git-path", "index").trim();
    const before = readFileSync(indexPath);
    const rootBefore = readFileSync(originalIndex);
    const changes = await manager.worktreeChanges(session.id);
    expect(changes.files).toContainEqual({ path: "새 파일.md", status: "added" });
    expect(changes.diff).toContain("+최종 작업 줄");
    expect(readFileSync(indexPath)).toEqual(before);
    await manager.applyWorktree(session.id);
    expect(readFileSync(indexPath)).toEqual(before);
    expect(readFileSync(originalIndex)).toEqual(rootBefore);
    expect(readFileSync(join(repo, "새 파일.md"), "utf8")).toBe("새 파일\n");
  });

  it("keeps literal tab/newline names and applies new empty and binary files", async () => {
    const { manager, work, repo } = setup();
    const session = await manager.createIsolatedSession(work.id, { provider: "codex" });
    const copy = session.worktree!.path;
    const name = process.platform === "win32" ? "공백 파일.md" : "탭\t줄\n파일.md";
    writeFileSync(join(copy, name), "이름을 보존\n");
    writeFileSync(join(copy, "empty.txt"), "");
    const bytes = Buffer.from([0, 255, 0, 1, 2]);
    writeFileSync(join(copy, "new.bin"), bytes);
    const changes = await manager.worktreeChanges(session.id);
    expect(changes.files).toContainEqual({ path: name, status: "added" });
    await manager.applyWorktree(session.id);
    expect(readFileSync(join(repo, name), "utf8")).toBe("이름을 보존\n");
    expect(readFileSync(join(repo, "empty.txt"))).toHaveLength(0);
    expect(readFileSync(join(repo, "new.bin"))).toEqual(bytes);
  });

  it("does not archive a session or report success when a locked worktree cannot be removed", async () => {
    const { manager, work, repo } = setup();
    const session = await manager.createIsolatedSession(work.id, { provider: "codex" });
    git(repo, "worktree", "lock", session.worktree!.path);
    await expect(manager.discardWorktree(session.id)).rejects.toThrow(/격리 사본/);
    expect(existsSync(session.worktree!.path)).toBe(true);
    expect(manager.snapshot().sessions.find((entry) => entry.id === session.id)?.archivedAt).toBeNull();
  });

  it("keeps a branch with commits that have not been merged into the original", async () => {
    const { manager, work, repo } = setup();
    const session = await manager.createIsolatedSession(work.id, { provider: "codex" });
    writeFileSync(join(session.worktree!.path, "committed.md"), "보존할 커밋\n");
    git(session.worktree!.path, "add", ".");
    git(session.worktree!.path, "commit", "-qm", "keep this history");
    await manager.discardWorktree(session.id);
    expect(existsSync(session.worktree!.path)).toBe(false);
    expect(git(repo, "branch", "--list", session.worktree!.branch)).toContain(session.worktree!.branch);
  });

  it("refuses stale branch metadata before deleting anything", async () => {
    const { manager, work, repo } = setup();
    const session = await manager.createIsolatedSession(work.id, { provider: "codex" });
    await expect(removeWorktree({ ...session.worktree!, branch: "main" })).rejects.toThrow(/브랜치/);
    expect(existsSync(session.worktree!.path)).toBe(true);
    expect(git(repo, "branch", "--list", "main")).toContain("main");
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
