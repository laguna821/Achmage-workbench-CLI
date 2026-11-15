import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Artifact, DocumentAccess, DocumentPresence, DocumentRegistration, DocumentViewInput } from "@workbench/contracts";
import { HttpError } from "./errors.ts";
import { DirectoryOperations, physicalPath, withinDirectory } from "./directory-operations.ts";
import { DocumentExecutionLeases, samePhysicalFile, type DocumentExecutionLease, type ExecutorMode } from "./document-execution-lease.ts";

const TTL = 60_000;
/** A writer whose window renews every 10 s and missed that is taken to be gone (U38). */
const MISSED_HEARTBEAT = 15_000;
type LiveView = { presence: DocumentPresence; file: string; token: string | null };
const id = (value: unknown): value is string => typeof value === "string" && /^[\w-]{1,100}$/.test(value);

export function documentAccess(req: IncomingMessage): DocumentAccess | undefined {
  const viewId = req.headers["x-workbench-view"], writeToken = req.headers["x-workbench-write"];
  if (viewId === undefined && writeToken === undefined) return undefined;
  if (!id(viewId) || (writeToken !== undefined && (typeof writeToken !== "string" || writeToken.length > 100))) throw new HttpError(400, "invalid_editor_access", "문서 편집 권한 형식이 올바르지 않습니다.");
  return { viewId, writeToken: typeof writeToken === "string" && writeToken ? writeToken : null };
}

/** One live writer per physical file, including duplicate Artifact IDs or symlink aliases. */
export class DocumentRegistry {
  readonly executions: DocumentExecutionLeases;
  private readonly views = new Map<string, LiveView>();
  private readonly artifact: (id: string) => Artifact;
  private readonly now: () => number;
  private readonly directories: DirectoryOperations;
  constructor(artifact: (id: string) => Artifact, now = Date.now, directories = new DirectoryOperations()) { this.artifact = artifact; this.now = now; this.directories = directories; this.executions = new DocumentExecutionLeases(now); }

  private file(path: string) {
    return physicalPath(path);
  }
  private prune() {
    const now = this.now();
    for (const [key, entry] of this.views) if (entry.presence.expiresAt <= now) this.views.delete(key);
  }
  list(): DocumentPresence[] {
    this.prune();
    return [...this.views.values()].map(({ presence }) => ({ ...presence }));
  }
  /** Authorization lookup includes admitted executors without pretending they
   * are visible UI presences in list()/forArtifact(). */
  authority(viewId: string | undefined): DocumentPresence | null {
    this.prune();
    if (!viewId) return null;
    const view = this.views.get(viewId);
    if (view) return { ...view.presence };
    const lease = this.executions.list().find(lease => lease.id === viewId || lease.sourceAccess.viewId === viewId);
    return lease ? { ...this.executionPresence(lease), viewId } : null;
  }
  ownerViewId(viewId: string) { return this.executions.list().find(lease => lease.id === viewId)?.sourceAccess.viewId ?? viewId; }
  forArtifact(artifactId: string): DocumentPresence[] {
    this.prune();
    const file = this.file(this.artifact(artifactId).path);
    return [...this.views.values()].filter((entry) => samePhysicalFile(entry.file, file)).map(({ presence }) => ({ ...presence }));
  }
  private writer(file: string) {
    return [...this.views.values()].find((entry) => samePhysicalFile(entry.file, file) && entry.presence.mode === "write") ?? null;
  }
  open(artifactId: string, input: DocumentViewInput): DocumentRegistration {
    if (!input || typeof input !== "object" || !id(input.viewId) || input.viewId.startsWith("execution-") || !id(input.windowId) || (input.sessionId != null && !id(input.sessionId))) throw new HttpError(400, "invalid_editor_view", "문서 창 정보가 올바르지 않습니다.");
    if (input.revision !== undefined && (!Number.isSafeInteger(input.revision) || input.revision < 1)) throw new HttpError(400, "invalid_editor_revision", "문서 판 번호가 올바르지 않습니다.");
    this.prune();
    const artifact = this.artifact(artifactId), file = this.file(artifact.path);
    this.directories.assertAvailable(file);
    let entry = this.views.get(input.viewId);
    if (entry && (entry.presence.artifactId !== artifactId || entry.presence.windowId !== input.windowId || entry.file !== file)) throw new HttpError(409, "editor_identity_changed", "문서의 위치나 창이 바뀌었습니다. 편집 내용을 보존하고 다시 열어 주세요.");
    if (!entry) {
      if (this.views.size >= 4096) throw new HttpError(429, "too_many_editors", "열린 문서 창이 너무 많습니다.");
      entry = { file, token: null, presence: { viewId: input.viewId, windowId: input.windowId, artifactId, sessionId: input.sessionId ?? null, label: String(input.label ?? artifact.name).slice(0, 120), mode: "read", dirty: false, revision: artifact.revision, expiresAt: this.now() + TTL } };
      this.views.set(input.viewId, entry);
    }
    // An explicit claim: a writer that missed its heartbeat (its window disappeared without saying so)
    // and has nothing unsaved gives way at once. Unsaved edits keep the lease until it runs out.
    const stale = input.claim === true ? this.writer(file) : null;
    if (stale && stale !== entry && !stale.presence.dirty && this.now() - (stale.presence.expiresAt - TTL) > MISSED_HEARTBEAT) this.views.delete(stale.presence.viewId);
    if (input.claim === true && !this.writer(file) && !this.executions.writer(file)) {
      entry.token = randomBytes(24).toString("base64url");
      entry.presence.mode = "write";
    }
    entry.presence = { ...entry.presence, expiresAt: this.now() + TTL, ...(typeof input.dirty === "boolean" ? { dirty: input.dirty } : {}), ...(input.revision !== undefined ? { revision: input.revision } : {}), ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}) };
    const writer = this.writer(file), execution = this.executions.writer(file);
    return { view: { ...entry.presence }, writer: execution ? this.executionPresence(execution) : writer ? { ...writer.presence } : null, writeToken: entry.token };
  }
  close(viewId: string, windowId: string) {
    const entry = this.views.get(viewId);
    if (entry?.presence.windowId === windowId) this.views.delete(viewId);
  }
  assertWrite(artifactId: string, access?: DocumentAccess) {
    this.assertPath(this.artifact(artifactId).path, access);
  }
  private executionPresence(lease: DocumentExecutionLease): DocumentPresence {
    return { viewId: lease.id, windowId: lease.id, artifactId: lease.artifactId, sessionId: lease.sessionId, label: "진행 중인 문서 AI", mode: lease.writable ? "write" : "read", dirty: false, revision: this.artifact(lease.artifactId).revision, expiresAt: lease.expiresAt };
  }
  acquireExecution(artifactId: string, owner: string, sessionId: string, access: DocumentAccess, writable = true, mode: ExecutorMode = "ui-required") {
    this.assertWrite(artifactId, access);
    const artifact = this.artifact(artifactId);
    if (this.forArtifact(artifactId).some(view => view.dirty)) throw new HttpError(409, "office_unsaved_target", "현재 문서의 편집 내용을 먼저 저장한 뒤 AI 작업을 시작해 주세요.");
    const sourceAccess = this.executions.list().find(lease => lease.id === access.viewId)?.sourceAccess ?? access;
    return this.executions.acquire({ artifactId, owner, sessionId, sourceAccess, path: artifact.path, baseRevision: artifact.revision, baseHash: artifact.sha256, writable, mode });
  }
  assertDirectoryIdle(path: string) {
    this.prune();
    const root = this.file(path);
    if (this.executions.list().some(lease => withinDirectory(root, lease.physicalFileIdentity))) throw new HttpError(423, "editor_busy", "이 폴더에서 문서 AI 작업이 진행 중입니다. 작업을 마치거나 중지한 뒤 진행해 주세요.");
    for (const entry of this.views.values()) {
      if (withinDirectory(root, entry.file) && (entry.presence.mode === "write" || entry.presence.dirty)) {
        throw new HttpError(423, "editor_busy", "이 폴더의 문서를 편집 중인 탭이나 창이 있습니다. 저장하고 닫은 뒤 파일 변경 작업을 진행해 주세요.");
      }
    }
  }
  assertPath(path: string, access?: DocumentAccess) {
    this.prune();
    const file = this.file(path), writer = this.writer(file);
    this.directories.assertAvailable(file);
    if (access && this.executions.access(path, access)) return;
    const execution = this.executions.writer(file);
    if (execution) {
      // The legacy renderer and its run share one in-memory document. This is
      // transitional ui-required ownership, not an independent renderer claim.
      if (execution.mode === "ui-required" && access?.viewId === execution.sourceAccess.viewId && access.writeToken === execution.sourceAccess.writeToken) return;
      throw new HttpError(423, "document_execution_busy", "이 문서에서 AI 편집 작업이 진행 중입니다. 작업을 마치거나 중지한 뒤 편집해 주세요.");
    }
    if (access) {
      const entry = this.views.get(access.viewId);
      if (!entry || entry.file !== file || entry.presence.mode !== "write" || !access.writeToken || entry.token !== access.writeToken) throw new HttpError(423, "editor_access_lost", "이 창의 편집 권한을 확인하지 못했습니다. 편집 내용은 유지했습니다. 편집 권한을 다시 받아 주세요.");
      return;
    }
    // Existing CLI/API clients can still write a file nobody has open for editing.
    if (writer) throw new HttpError(423, "editor_busy", "다른 탭이나 창에서 이 문서를 편집하고 있습니다. 그 편집기에서 저장하거나 닫은 뒤 다시 시도해 주세요.");
  }
}
