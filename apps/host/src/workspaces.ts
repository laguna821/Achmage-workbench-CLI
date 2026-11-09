import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Artifact, CreateWorkspaceRequest, SessionWorktree, Work, Workspace } from "@workbench/contracts";
import type { Store } from "./store.ts";
import type { EventBus } from "./bus.ts";
import { HttpError } from "./errors.ts";
import { DirectoryOperations } from "./directory-operations.ts";

const key = (...parts: string[]) => `workspace-${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32)}`;
const inside = (cwd: string, path: string) => {
  const rel = relative(cwd, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/** Metadata only. Migration never reads, creates, moves or rewrites the user's files. */
export class Workspaces {
  readonly directoryOperations = new DirectoryOperations();
  private readonly store: Store;
  readonly hostId: string;
  private readonly bus: EventBus;
  constructor(store: Store, hostId: string, bus: EventBus) {
    this.store = store;
    this.hostId = hostId;
    this.bus = bus;
    this.migrate();
  }

  list() { return this.store.workspaces(); }
  get(id: string) {
    const workspace = this.list().find((entry) => entry.id === id);
    if (!workspace) throw new HttpError(404, "workspace_missing", "작업공간을 찾지 못했습니다.");
    return workspace;
  }

  private persist(workspace: Workspace, publish: boolean) {
    this.store.saveWorkspace(workspace);
    if (publish) this.bus.publish({ type: "workspace.upserted", workspace });
    return workspace;
  }

  private ensure(work: Work, cwd: string, worktree: SessionWorktree | null, hostId: string, managed: boolean, publish: boolean) {
    if (hostId === this.hostId) this.directoryOperations.assertAvailable(cwd);
    const id = key(work.id, hostId, worktree ? "worktree" : "folder", resolve(cwd), worktree?.path ?? "");
    const existing = this.list().find((entry) => entry.id === id);
    if (existing) return existing;
    return this.persist({ id, workId: work.id, hostId, label: worktree?.branch ?? (cwd === work.cwd ? "기본 작업공간" : basename(cwd)), kind: worktree ? "worktree" : "folder", cwd, managed, worktree, archivedAt: null, removedAt: null, createdAt: work.createdAt, updatedAt: work.createdAt }, publish);
  }

  defaultFor(work: Work, publish = true) {
    const saved = work.defaultWorkspaceId && this.list().find((entry) => entry.id === work.defaultWorkspaceId && entry.workId === work.id);
    return saved || this.ensure(work, work.cwd, null, this.hostId, work.cwdManaged, publish);
  }

  fromWorktree(work: Work, worktree: SessionWorktree, publish = true, hostId = this.hostId) {
    return this.ensure(publish ? { ...work, createdAt: Date.now() } : work, worktree.cwd, worktree, hostId, true, publish);
  }

  /** Connecting an external checkout does not grant ownership of its directory. */
  connectWorktree(work: Work, worktree: SessionWorktree, options: { managed: boolean; label?: string; parentWorkspaceId?: string | null }) {
    this.directoryOperations.assertAvailable(worktree.cwd);
    const existing = this.list().find((entry) => entry.workId === work.id && entry.hostId === this.hostId && resolve(entry.cwd) === worktree.cwd && entry.removedAt === null);
    if (existing?.kind === "worktree") return existing;
    const workspace = existing ?? this.ensure({ ...work, createdAt: Date.now() }, worktree.cwd, worktree, this.hostId, options.managed, false);
    return this.persist({ ...workspace, kind: "worktree", worktree, managed: existing ? false : options.managed, parentWorkspaceId: options.parentWorkspaceId ?? null, label: options.label?.trim().slice(0, 80) || worktree.branch || basename(worktree.cwd), updatedAt: Date.now() }, true);
  }

  requireActive(id: string, workId: string) {
    const workspace = this.get(id);
    if (workspace.workId !== workId) throw new HttpError(400, "workspace_project", "다른 프로젝트의 작업공간입니다.");
    if (workspace.archivedAt !== null || workspace.removedAt !== null) throw new HttpError(409, "workspace_archived", "보관되거나 제거된 작업공간입니다.");
    if (workspace.hostId !== this.hostId) throw new HttpError(409, "workspace_host", "이 컴퓨터에서 실행하는 작업공간이 아닙니다.");
    this.directoryOperations.assertAvailable(workspace.cwd);
    return workspace;
  }

  create(work: Work, request: CreateWorkspaceRequest) {
    if (typeof request.cwd !== "string" || !isAbsolute(request.cwd)) throw new HttpError(400, "workspace_path", "작업공간의 전체 폴더 경로가 필요합니다.");
    let cwd: string;
    try {
      cwd = realpathSync(request.cwd);
      if (!statSync(cwd).isDirectory()) throw new Error("not a directory");
    } catch { throw new HttpError(400, "workspace_path", "읽을 수 있는 폴더를 선택해 주세요."); }
    this.directoryOperations.assertAvailable(cwd);
    const existing = this.list().find((entry) => entry.workId === work.id && entry.hostId === this.hostId && resolve(entry.cwd) === cwd);
    if (existing) return existing;
    const workspace = this.ensure(work, cwd, null, this.hostId, false, false);
    return this.persist({ ...workspace, label: request.label?.trim().slice(0, 80) || workspace.label, createdAt: Date.now(), updatedAt: Date.now() }, true);
  }

  update(workspace: Workspace, patch: Partial<Pick<Workspace, "label" | "archivedAt" | "removedAt">>) {
    return this.persist({ ...workspace, ...patch, updatedAt: Date.now() }, true);
  }

  /** Creates an actual directory in the selected execution workspace, independently of AI. */
  createDirectory(id: string, input: unknown) {
    const selected = this.get(id), space = this.requireActive(id, selected.workId);
    const work = this.store.works().find(entry => entry.id === space.workId);
    if (!work || work.archivedAt) throw new HttpError(409, "workspace_archived", "보관한 프로젝트에는 폴더를 만들 수 없습니다.");
    if (typeof input !== "string" || !input.trim() || input.length > 2048) throw new HttpError(400, "directory_path", "새 폴더의 상대 경로를 입력해 주세요.");
    const path = input.trim().replace(/\\/g, "/"), parts = path.split("/");
    if (path.startsWith("/") || /^[a-z]:/i.test(path) || parts.some(part => !part || part === "." || part === ".." || /[\x00-\x1f<>:"|?*]/.test(part) || /[. ]$/.test(part)))
      throw new HttpError(400, "directory_path", "작업공간 안의 폴더 이름을 입력해 주세요. 절대 경로와 ..는 사용할 수 없습니다.");
    const root = realpathSync(space.cwd);
    let parent: string;
    try { parent = realpathSync(resolve(root, ...parts.slice(0, -1))); if (!statSync(parent).isDirectory()) throw Error(); }
    catch { throw new HttpError(400, "directory_parent", "상위 폴더를 먼저 만들거나 기존 폴더를 선택해 주세요."); }
    if (!inside(root, parent)) throw new HttpError(403, "directory_outside", "작업공간 밖으로 연결된 폴더에는 만들 수 없습니다.");
    const target = join(parent, parts.at(-1)!);
    this.directoryOperations.assertAvailable(target);
    try { mkdirSync(target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new HttpError(409, "directory_exists", "같은 이름의 파일 또는 폴더가 이미 있습니다.");
      if (["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw new HttpError(403, "directory_permission", "이 폴더에 새 폴더를 만들 권한이 없습니다.");
      throw error;
    }
    this.persist({ ...space, updatedAt: Date.now() }, true);
    return { workspaceId: space.id, path: target, relativePath: relative(root, target).split(sep).join("/") };
  }

  /** Explicit cwd wins for overlapping folders; otherwise choose the most specific existing root. */
  fileIdentity(workId: string, cwd: string, path: string, publish = true): Pick<Artifact, "workspaceId" | "relativePath"> {
    const work = this.store.works().find((entry) => entry.id === workId);
    if (!work) return {};
    const candidates = this.list().filter((entry) => entry.workId === workId && entry.hostId === this.hostId && inside(entry.cwd, path));
    const workspace = candidates.find((entry) => resolve(entry.cwd) === resolve(cwd))
      ?? candidates.sort((a, b) => b.cwd.length - a.cwd.length)[0]
      ?? this.ensure(work, dirname(path), null, this.hostId, false, publish);
    return { workspaceId: workspace.id, relativePath: relative(workspace.cwd, path).split(sep).join("/") };
  }

  private migrate() {
    const known = new Map(this.list().map((entry) => [entry.id, entry]));
    const linked = (id: string | undefined, workId: string) => !!id && known.get(id)?.workId === workId;
    // An older installed version can add rows after this version has already run. Repair only
    // those missing links instead of assuming a version marker proves every row is migrated.
    if (this.store.getMeta("workspaces.version") === "1"
      && this.store.works().every((entry) => linked(entry.defaultWorkspaceId, entry.id))
      && this.store.sessions().every((entry) => linked(entry.workspaceId, entry.workId))
      && this.store.artifacts().every((entry) => linked(entry.workspaceId, entry.workId) && entry.relativePath !== undefined)) return;
    this.store.transaction(() => {
      const works = this.store.works();
      for (const work of works) {
        const workspace = this.defaultFor(work, false);
        if (work.defaultWorkspaceId !== workspace.id) this.store.saveWork({ ...work, defaultWorkspaceId: workspace.id });
      }
      for (const session of this.store.sessions()) {
        const work = works.find((entry) => entry.id === session.workId);
        if (!work) continue; // Retain orphan records for diagnosis; never delete them.
        if (linked(session.workspaceId, session.workId)) continue;
        const workspace = session.worktree
          ? this.fromWorktree(work, session.worktree, false, session.hostId || this.hostId)
          : this.ensure(work, work.cwd, null, session.hostId || this.hostId, work.cwdManaged, false);
        this.store.saveSession({ ...session, workspaceId: workspace.id });
      }
      for (const artifact of this.store.artifacts()) {
        if (linked(artifact.workspaceId, artifact.workId) && artifact.relativePath !== undefined) continue;
        // Let the longest root win, including an existing worktree; an external file gets a folder boundary.
        this.store.saveArtifact({ ...artifact, ...this.fileIdentity(artifact.workId, dirname(artifact.path), artifact.path, false) });
      }
      this.store.setMeta("workspaces.version", "1");
    });
  }
}
