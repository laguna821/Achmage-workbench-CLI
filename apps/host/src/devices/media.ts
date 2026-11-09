import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Attachment, DeviceGrant, TranscriptItem } from "@workbench/contracts";
import { ensurePrivateDirectory, ensurePrivateFile, writePrivateFileAtomicSync } from "@workbench/paseo-server-transport/private-files";
import type { SessionManager } from "../sessions.ts";
import { HttpError } from "../errors.ts";

const ATTACHMENT_ID = /^[a-f0-9]{64}\.[a-z0-9]{1,10}$/;
type UploadOwner = { deviceId: string; workId: string; attachmentId: string; createdAt: number };
type MediaState = { version: 1; hostId: string; uploads: UploadOwner[] };
const denied = () => new HttpError(403, "attachment_scope_denied", "이 기기에서 사용할 수 없는 첨부입니다.");
const unavailable = () => new HttpError(500, "remote_media_store", "원격 첨부 권한 기록을 확인할 수 없습니다. 원본 기록은 보존했습니다.");

function references(item: TranscriptItem, id: string): boolean {
  if (item.kind === "user") return item.attachments?.some(attachment => attachment.id === id) ?? false;
  if (item.kind === "tool") return item.images?.some(attachment => attachment.id === id) ?? false;
  if (item.kind === "assistant") return item.media?.some(media => media.attachment.id === id) ?? false;
  return false;
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/.test(value);
}

/** A scope adapter over the existing global attachment store, never another file store.
 * Callers pass the current authenticated grant and authorize the operation separately.
 */
export class RemoteMediaAccess {
  private readonly manager: SessionManager;
  private readonly hostId: string;
  private readonly directory: string;
  private readonly file: string;
  private state: MediaState;

  constructor(dataDir: string, manager: SessionManager) {
    this.manager = manager;
    this.hostId = manager.snapshot().hostId;
    this.directory = join(dataDir, "devices");
    this.file = join(this.directory, "media.json");
    this.checkPath(this.directory, true, false);
    ensurePrivateDirectory(this.directory);
    this.checkPath(this.directory, true, true);
    this.checkPath(this.file, false, false);
    if (existsSync(this.file)) {
      ensurePrivateFile(this.file);
      this.checkPath(this.file, false, true);
      try { this.state = this.readState(JSON.parse(readFileSync(this.file, "utf8"))); }
      catch { throw unavailable(); }
    } else {
      this.state = { version: 1, hostId: this.hostId, uploads: [] };
      writePrivateFileAtomicSync(this.file, JSON.stringify(this.state) + "\n");
      this.checkPath(this.file, false, true);
    }
  }

  /** Called only after this device's upload has been saved by manager.attachments. */
  remember(grant: DeviceGrant, workId: string, attachment: Attachment): void {
    if (!this.live(grant) || !grant.workIds.includes(workId) || !this.manager.view.works.has(workId)) throw denied();
    if (!attachment || typeof attachment.id !== "string" || !ATTACHMENT_ID.test(attachment.id)) throw denied();
    this.manager.attachments.path(attachment.id);
    this.checkPath(this.directory, true, true);
    this.checkPath(this.file, false, true);
    if (this.state.uploads.some(upload => upload.deviceId === grant.deviceId && upload.workId === workId && upload.attachmentId === attachment.id)) return;
    const next: MediaState = {
      ...this.state,
      uploads: [...this.state.uploads, { deviceId: grant.deviceId, workId, attachmentId: attachment.id, createdAt: Date.now() }],
    };
    writePrivateFileAtomicSync(this.file, JSON.stringify(next) + "\n");
    this.checkPath(this.file, false, true);
    this.state = next;
  }

  /** Returns a currently allowed work, never authority merely because a global ID exists. */
  workFor(grant: DeviceGrant, attachmentId: string): string | null {
    if (!this.live(grant) || typeof attachmentId !== "string" || !ATTACHMENT_ID.test(attachmentId)) return null;
    try { this.manager.attachments.path(attachmentId); } catch { return null; }
    const allowed = new Set(grant.workIds.filter(workId => this.manager.view.works.has(workId)));
    if (!allowed.size) return null;
    const uploaded = this.state.uploads.find(upload =>
      upload.deviceId === grant.deviceId && upload.attachmentId === attachmentId && allowed.has(upload.workId));
    if (uploaded) return uploaded.workId;
    for (const session of this.manager.view.sessions.values()) {
      if (!allowed.has(session.workId)) continue;
      if (session.queued.some(queued => queued.attachments?.some(attachment => attachment.id === attachmentId))) return session.workId;
      if (this.manager.items(session.id).items.some(item => references(item, attachmentId))) return session.workId;
    }
    return null;
  }

  /** Existing HTTP requests consume attachments[]. DrawRequest has no attachment-ID
   * fields; its via/insertInto targets and document refs belong to the route scope.
   */
  requireReferences(grant: DeviceGrant, body: Record<string, unknown>): void {
    if (body.attachments === undefined || body.attachments === null) return;
    if (!Array.isArray(body.attachments) || body.attachments.length > 20) {
      throw new HttpError(400, "remote_attachment_shape", "첨부 목록을 확인해 주세요.");
    }
    for (const attachment of body.attachments) {
      if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)
        || typeof attachment.id !== "string" || !this.workFor(grant, attachment.id)) throw denied();
    }
  }

  private live(grant: DeviceGrant): boolean {
    return grant.hostId === this.hostId && identifier(grant.deviceId) && grant.activatedAt !== null
      && grant.revokedAt === null && (grant.expiresAt === null || grant.expiresAt > Date.now());
  }
  private checkPath(path: string, directory: boolean, privateMode: boolean): void {
    let stat;
    try { stat = lstatSync(path); }
    catch (error) {
      if (!privateMode && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
      || (privateMode && process.platform !== "win32" && (stat.mode & 0o777) !== (directory ? 0o700 : 0o600))) throw unavailable();
  }
  private readState(value: unknown): MediaState {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
    const state = value as Record<string, unknown>;
    if (state.version !== 1 || state.hostId !== this.hostId || !Array.isArray(state.uploads)) throw unavailable();
    const uploads = state.uploads.map((value): UploadOwner => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
      const row = value as Record<string, unknown>;
      if (!identifier(row.deviceId) || !identifier(row.workId) || typeof row.attachmentId !== "string"
        || !ATTACHMENT_ID.test(row.attachmentId) || typeof row.createdAt !== "number"
        || !Number.isSafeInteger(row.createdAt) || row.createdAt < 0) throw unavailable();
      return { deviceId: row.deviceId, workId: row.workId, attachmentId: row.attachmentId, createdAt: row.createdAt };
    });
    return { version: 1, hostId: this.hostId, uploads };
  }
}
