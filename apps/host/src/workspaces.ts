import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Artifact, CreateWorkspaceRequest, SessionWorktree, Work, Workspace } from "@workbench/contracts";
import type { Store } from "./store.ts";
import type { EventBus } from "./bus.ts";
import { HttpError } from "./errors.ts";

const key = (...parts: string[]) => `workspace-${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32)}`;
const inside = (cwd: string, path: string) => {
  const rel = relative(cwd, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/** Metadata only. Migration never reads, creates, moves or rewrites the user's files. */
export class Workspaces {
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

  requireActive(id: string, workId: string) {
    const workspace = this.get(id);
    if (workspace.workId !== workId) throw new HttpError(400, "workspace_project", "다른 프로젝트의 작업공간입니다.");
    if (workspace.archivedAt !== null || workspace.removedAt !== null) throw new HttpError(409, "workspace_archived", "보관되거나 제거된 작업공간입니다.");
    if (workspace.hostId !== this.hostId) throw new HttpError(409, "workspace_host", "이 컴퓨터에서 실행하는 작업공간이 아닙니다.");
    return workspace;
  }

  create(work: Work, request: CreateWorkspaceRequest) {
    if (typeof request.cwd !== "string" || !isAbsolute(request.cwd)) throw new HttpError(400, "workspace_path", "작업공간의 전체 폴더 경로가 필요합니다.");
    let cwd: string;
    try {
      cwd = realpathSync(request.cwd);
      if (!statSync(cwd).isDirectory()) throw new Error("not a directory");
    } catch { throw new HttpError(400, "workspace_path", "읽을 수 있는 폴더를 선택해 주세요."); }
    const existing = this.list().find((entry) => entry.workId === work.id && entry.hostId === this.hostId && resolve(entry.cwd) === cwd);
    if (existing) return existing;
    const workspace = this.ensure(work, cwd, null, this.hostId, false, false);
    return this.persist({ ...workspace, label: request.label?.trim().slice(0, 80) || workspace.label, createdAt: Date.now(), updatedAt: Date.now() }, true);
  }

  update(workspace: Workspace, patch: Partial<Pick<Workspace, "label" | "archivedAt" | "removedAt">>) {
    return this.persist({ ...workspace, ...patch, updatedAt: Date.now() }, true);
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
