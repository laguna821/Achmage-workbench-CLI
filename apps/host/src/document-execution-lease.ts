import { randomBytes, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import type { DocumentAccess } from "@workbench/contracts";
import { physicalPath } from "./directory-operations.ts";
import { HttpError } from "./errors.ts";

export type ExecutorMode = "host" | "independent-renderer" | "ui-required";
export type DocumentExecutionLease = {
  id: string;
  owner: string;
  artifactId: string;
  sessionId: string;
  physicalFileIdentity: string;
  generation: number;
  mode: ExecutorMode;
  writable: boolean;
  baseRevision: number;
  baseHash: string;
  access: DocumentAccess;
  sourceAccess: DocumentAccess;
  expiresAt: number;
};
const TTL = 120_000;
function inode(path: string) {
  try { const stat = statSync(path, { bigint: true }); return stat.ino ? `${stat.dev}:${stat.ino}` : null; }
  catch { return null; }
}
export function samePhysicalFile(a: string, b: string) {
  if (physicalPath(a) === physicalPath(b)) return true;
  const identity = inode(a);
  return identity !== null && identity === inode(b);
}
const stale = () => new HttpError(423, "STALE_WRITER", "문서 작업의 실행 권한이 끝났습니다. 늦게 도착한 변경은 저장하지 않았습니다.");

/** Execution authority belongs to an admitted run, never a UI presence heartbeat.
 * A fresh host uses fresh random capabilities; interrupted jobs cannot be replayed
 * against a newly acquired writer, including through another artifact or symlink. */
export class DocumentExecutionLeases {
  private readonly leases = new Map<string, DocumentExecutionLease>();
  private generation = 0;
  private readonly now: () => number;
  constructor(now = Date.now) { this.now = now; }

  acquire(input: Omit<DocumentExecutionLease, "id" | "generation" | "access" | "expiresAt" | "physicalFileIdentity"> & { path: string }): DocumentExecutionLease {
    this.prune();
    const file = physicalPath(input.path);
    if (input.writable && this.writer(file)) throw new HttpError(423, "document_execution_busy", "이 문서에서 다른 AI 편집 작업이 진행 중입니다.");
    if (this.leases.size >= 512) throw new HttpError(429, "document_execution_limit", "진행 중인 문서 작업이 너무 많습니다.");
    const { path: _path, ...fields } = input;
    const id = `execution-${randomUUID()}`;
    const lease: DocumentExecutionLease = { ...fields, sourceAccess: { ...input.sourceAccess }, id, physicalFileIdentity: file,
      generation: ++this.generation, access: { viewId: id, writeToken: randomBytes(24).toString("base64url") }, expiresAt: this.now() + TTL };
    this.leases.set(id, lease);
    return this.copy(lease);
  }
  private copy(lease: DocumentExecutionLease) { return { ...lease, access: { ...lease.access }, sourceAccess: { ...lease.sourceAccess } }; }
  private prune() { for (const [id, lease] of this.leases) if (lease.expiresAt <= this.now()) this.leases.delete(id); }
  list() { this.prune(); return [...this.leases.values()].map(lease => this.copy(lease)); }
  writer(path: string) { return this.list().find(lease => lease.writable && samePhysicalFile(path, lease.physicalFileIdentity)) ?? null; }
  require(lease: DocumentExecutionLease, path = lease.physicalFileIdentity) {
    this.prune();
    const current = this.leases.get(lease.id);
    if (!current || current.generation !== lease.generation || current.owner !== lease.owner || current.access.writeToken !== lease.access.writeToken
      || physicalPath(path) !== current.physicalFileIdentity) throw stale();
    return this.copy(current);
  }
  access(path: string, access: DocumentAccess): DocumentExecutionLease | null {
    if (!access.viewId.startsWith("execution-")) return null;
    this.prune();
    const lease = this.leases.get(access.viewId);
    if (!lease || !access.writeToken || lease.access.writeToken !== access.writeToken || physicalPath(path) !== lease.physicalFileIdentity) throw stale();
    if (!lease.writable) throw new HttpError(403, "document_execution_readonly", "이 문서 읽기 작업에는 편집 권한이 없습니다.");
    return this.copy(lease);
  }
  renew(lease: DocumentExecutionLease) {
    this.require(lease);
    const current = this.leases.get(lease.id)!;
    current.expiresAt = this.now() + TTL;
    return this.copy(current);
  }
  mode(lease: DocumentExecutionLease, mode: ExecutorMode) {
    this.require(lease);
    const current = this.leases.get(lease.id)!;
    current.mode = mode;
    return this.copy(current);
  }
  release(lease: DocumentExecutionLease) {
    const current = this.leases.get(lease.id);
    if (current?.generation === lease.generation && current.access.writeToken === lease.access.writeToken) this.leases.delete(lease.id);
  }
}
