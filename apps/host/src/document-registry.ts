import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { IncomingMessage } from "node:http";
import type { Artifact, DocumentAccess, DocumentPresence, DocumentRegistration, DocumentViewInput } from "@workbench/contracts";
import { HttpError } from "./errors.ts";

const TTL = 60_000;
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
  private readonly views = new Map<string, LiveView>();
  private readonly artifact: (id: string) => Artifact;
  private readonly now: () => number;
  constructor(artifact: (id: string) => Artifact, now = Date.now) { this.artifact = artifact; this.now = now; }

  private file(path: string) {
    let file: string;
    try { file = realpathSync.native(path); } catch { file = resolve(path); }
    return process.platform === "win32" ? file.toLowerCase() : file;
  }
  private prune() {
    const now = this.now();
    for (const [key, entry] of this.views) if (entry.presence.expiresAt <= now) this.views.delete(key);
  }
  list(): DocumentPresence[] {
    this.prune();
    return [...this.views.values()].map(({ presence }) => ({ ...presence }));
  }
  forArtifact(artifactId: string): DocumentPresence[] {
    this.prune();
    const file = this.file(this.artifact(artifactId).path);
    return [...this.views.values()].filter((entry) => entry.file === file).map(({ presence }) => ({ ...presence }));
  }
  private writer(file: string) {
    return [...this.views.values()].find((entry) => entry.file === file && entry.presence.mode === "write") ?? null;
  }
  open(artifactId: string, input: DocumentViewInput): DocumentRegistration {
    if (!input || typeof input !== "object" || !id(input.viewId) || !id(input.windowId) || (input.sessionId != null && !id(input.sessionId))) throw new HttpError(400, "invalid_editor_view", "문서 창 정보가 올바르지 않습니다.");
    if (input.revision !== undefined && (!Number.isSafeInteger(input.revision) || input.revision < 1)) throw new HttpError(400, "invalid_editor_revision", "문서 판 번호가 올바르지 않습니다.");
    this.prune();
    const artifact = this.artifact(artifactId), file = this.file(artifact.path);
    let entry = this.views.get(input.viewId);
    if (entry && (entry.presence.artifactId !== artifactId || entry.presence.windowId !== input.windowId || entry.file !== file)) throw new HttpError(409, "editor_identity_changed", "문서의 위치나 창이 바뀌었습니다. 편집 내용을 보존하고 다시 열어 주세요.");
    if (!entry) {
      if (this.views.size >= 4096) throw new HttpError(429, "too_many_editors", "열린 문서 창이 너무 많습니다.");
      entry = { file, token: null, presence: { viewId: input.viewId, windowId: input.windowId, artifactId, sessionId: input.sessionId ?? null, label: String(input.label ?? artifact.name).slice(0, 120), mode: "read", dirty: false, revision: artifact.revision, expiresAt: this.now() + TTL } };
      this.views.set(input.viewId, entry);
    }
    if (input.claim === true && !this.writer(file)) {
      entry.token = randomBytes(24).toString("base64url");
      entry.presence.mode = "write";
    }
    entry.presence = { ...entry.presence, expiresAt: this.now() + TTL, ...(typeof input.dirty === "boolean" ? { dirty: input.dirty } : {}), ...(input.revision !== undefined ? { revision: input.revision } : {}), ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}) };
    const writer = this.writer(file);
    return { view: { ...entry.presence }, writer: writer ? { ...writer.presence } : null, writeToken: entry.token };
  }
  close(viewId: string, windowId: string) {
    const entry = this.views.get(viewId);
    if (entry?.presence.windowId === windowId) this.views.delete(viewId);
  }
  assertWrite(artifactId: string, access?: DocumentAccess) {
    this.assertPath(this.artifact(artifactId).path, access);
  }
  assertPath(path: string, access?: DocumentAccess) {
    this.prune();
    const file = this.file(path), writer = this.writer(file);
    if (access) {
      const entry = this.views.get(access.viewId);
      if (!entry || entry.file !== file || entry.presence.mode !== "write" || !access.writeToken || entry.token !== access.writeToken) throw new HttpError(423, "editor_access_lost", "이 창의 편집 권한을 확인하지 못했습니다. 편집 내용은 유지했습니다. 편집 권한을 다시 받아 주세요.");
      return;
    }
    // Existing CLI/API clients can still write a file nobody has open for editing.
    if (writer) throw new HttpError(423, "editor_busy", "다른 탭이나 창에서 이 문서를 편집하고 있습니다. 그 편집기에서 저장하거나 닫은 뒤 다시 시도해 주세요.");
  }
}
