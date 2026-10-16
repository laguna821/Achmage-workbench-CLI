import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  applyItemEvent,
  type ApprovalDecision,
  type CreateSessionRequest,
  type CreateWorkRequest,
  type Folder,
  type Provider,
  type ProviderStatus,
  type Session,
  type Snapshot,
  type TranscriptItem,
  type UiPrefs,
  type UpdateSessionRequest,
  type Work,
} from "@workbench/contracts";
import type { EventBus } from "./bus.ts";
import type { AdapterSink, LoginStart, ProviderAdapter } from "./providers/types.ts";
import type { Store } from "./store.ts";
import { adaptTitle, titleFor } from "./titles.ts";

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const hashText = (text: string) => createHash("sha256").update(text).digest("hex");

export type ManagerOptions = {
  hostId: string;
  hostLabel: string;
  /** Parent directory for works started without a folder. */
  managedWorksDir: string;
};

const DEFAULT_PURPOSE = /^대화 \d+$/;

/** Plain start of a reply for overview cards. */
export function previewOf(text: string) {
  const flat = plain(text);
  return flat.length > 180 ? `${flat.slice(0, 180).trimEnd()}…` : flat;
}

function plain(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`~|]+/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export class SessionManager {
  private readonly folders = new Map<string, Folder>();
  private readonly works = new Map<string, Work>();
  private readonly sessions = new Map<string, Session>();
  private readonly transcripts = new Map<string, TranscriptItem[]>();
  private readonly dirtyItems = new Map<string, Set<string>>();
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly adapters = new Map<Provider, ProviderAdapter>();
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly options: ManagerOptions;

  constructor(store: Store, bus: EventBus, options: ManagerOptions) {
    this.store = store;
    this.bus = bus;
    this.options = options;
    for (const folder of store.folders()) this.folders.set(folder.id, folder);
    for (const work of store.works()) this.works.set(work.id, { ...work, titleSource: work.titleSource ?? "auto" });
    // Rows written by older versions may lack newer fields.
    for (const session of store.sessions()) this.sessions.set(session.id, {
        ...session,
        effort: session.effort ?? null,
        engineModel: session.engineModel ?? null,
        engineEffort: session.engineEffort ?? null,
        preview: session.preview ?? null,
        previewAt: session.previewAt ?? null,
        purposeSource: session.purposeSource ?? (DEFAULT_PURPOSE.test(session.purpose) ? "auto" : "user"),
      });
    this.backfillOverview();
    this.recoverAfterRestart();
  }

  /** Sessions from before auto titles and previews: derive both once from their stored transcript. */
  private backfillOverview() {
    for (const session of this.sessions.values()) {
      if (session.previewAt !== null && !DEFAULT_PURPOSE.test(session.purpose)) continue;
      const items = this.store.items(session.id);
      const requests = items.flatMap((item) => (item.kind === "user" ? [item.text] : []));
      const lastReply = items.findLast((item) => item.kind === "assistant" && item.text.trim());
      const patch: Partial<Session> = {};
      if (requests.length && session.purposeSource === "auto" && DEFAULT_PURPOSE.test(session.purpose)) {
        patch.purpose = titleFor(requests) ?? session.purpose;
      }
      if (lastReply && lastReply.kind === "assistant" && session.previewAt === null) {
        patch.preview = previewOf(lastReply.text);
        patch.previewAt = lastReply.at;
      }
      if (Object.keys(patch).length) this.saveSession({ ...session, ...patch });
    }
  }


  /** Adapters report through this sink; every change is persisted and published. */
  readonly sink: AdapterSink = {
    upsertItem: (sessionId, item) => {
      if (item.kind === "turnEnd") {
        this.finishStreaming(sessionId);
      }
      const items = this.loadItems(sessionId);
      this.transcripts.set(sessionId, applyItemEvent(items, { type: "item.upserted", sessionId, item }));
      this.store.saveItem(sessionId, item);
      this.bus.publish({ type: "item.upserted", sessionId, item });
      if (item.kind === "assistant" && !item.streaming && item.text.trim()) {
        this.sink.updateSession(sessionId, { preview: previewOf(item.text), previewAt: Date.now() });
      }
      if (item.kind === "user" || item.kind === "turnEnd") this.retitle(sessionId);
    },
    delta: (sessionId, itemId, textDelta) => {
      const items = this.loadItems(sessionId);
      this.transcripts.set(sessionId, applyItemEvent(items, { type: "item.delta", sessionId, itemId, textDelta }));
      this.markDirty(sessionId, itemId);
      this.bus.publish({ type: "item.delta", sessionId, itemId, textDelta });
    },
    updateSession: (sessionId, patch) => {
      const session = this.sessions.get(sessionId);
      if (!session) return;
      this.saveSession({ ...session, ...patch, updatedAt: Date.now() });
    },
    providerStatus: (status) => {
      this.bus.publish({ type: "provider.status", status });
    },
  };

  registerAdapter(adapter: ProviderAdapter) {
    this.adapters.set(adapter.provider, adapter);
  }

  private adapter(provider: Provider) {
    const adapter = this.adapters.get(provider);
    if (!adapter) throw new HttpError(500, "provider_unavailable", `${provider} adapter is not registered`);
    return adapter;
  }

  /**
   * Engine processes do not survive an app restart. Anything that looked active is shown as
   * stopped instead of pretending it is still running; the next message resumes the session.
   */
  private recoverAfterRestart() {
    for (const session of this.sessions.values()) {
      if (session.status === "idle" || session.status === "error") continue;
      const items = this.loadItems(session.id);
      for (const item of items) {
        if (item.kind === "approval" && item.decision === null) {
          this.sink.upsertItem(session.id, { ...item, decision: "expired" });
        }
      }
      this.sink.upsertItem(session.id, {
        kind: "notice",
        id: `restart:${Date.now()}`,
        level: "info",
        text: "앱이 다시 시작되어 진행 중이던 응답이 멈췄습니다. 이어서 요청하면 같은 세션에서 계속합니다.",
        at: Date.now(),
      });
      this.saveSession({ ...session, status: "idle", activity: null, updatedAt: Date.now() });
    }
  }

  snapshot(): Snapshot {
    return {
      protocolVersion: PROTOCOL_VERSION,
      seq: this.bus.currentSeq,
      hostId: this.options.hostId,
      hostLabel: this.options.hostLabel,
      folders: [...this.folders.values()],
      works: [...this.works.values()],
      sessions: [...this.sessions.values()],
      providers: [...this.adapters.values()].map((adapter) => adapter.status()),
      prefs: this.prefs(),
    };
  }

  prefs(): UiPrefs {
    try {
      return JSON.parse(this.store.getMeta("ui.prefs") ?? "{}") as UiPrefs;
    } catch {
      return {};
    }
  }

  setPrefs(prefs: unknown): UiPrefs {
    if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) {
      throw new HttpError(400, "invalid_prefs", "화면 설정 형식이 올바르지 않습니다.");
    }
    const json = JSON.stringify(prefs);
    if (json.length > 64_000) throw new HttpError(413, "prefs_too_large", "화면 설정이 너무 큽니다.");
    this.store.setMeta("ui.prefs", json);
    const saved = JSON.parse(json) as UiPrefs;
    this.bus.publish({ type: "prefs.updated", prefs: saved });
    return saved;
  }

  items(sessionId: string) {
    this.requireSession(sessionId);
    return { seq: this.bus.currentSeq, items: this.loadItems(sessionId) };
  }

  createFolder(name: string, parentId: string | null): Folder {
    const trimmed = name.trim();
    if (!trimmed) throw new HttpError(400, "invalid_name", "폴더 이름이 비어 있습니다.");
    if (parentId && !this.folders.has(parentId)) throw new HttpError(404, "folder_not_found", "상위 폴더가 없습니다.");
    const siblings = [...this.folders.values()].filter((folder) => folder.parentId === parentId);
    const folder: Folder = { id: randomUUID(), parentId, name: trimmed, sort: siblings.length };
    this.folders.set(folder.id, folder);
    this.store.saveFolder(folder);
    this.bus.publish({ type: "folder.upserted", folder });
    return folder;
  }

  createWork(request: CreateWorkRequest): Work {
    const title = request.title.trim() || "새 작업";
    const folderId = request.folderId ?? null;
    if (folderId && !this.folders.has(folderId)) throw new HttpError(404, "folder_not_found", "폴더가 없습니다.");
    const id = randomUUID();
    let cwd = request.cwd?.trim() || null;
    const cwdManaged = !cwd;
    if (!cwd) {
      cwd = join(this.options.managedWorksDir, id);
      mkdirSync(cwd, { recursive: true });
    }
    const now = Date.now();
    const work: Work = { id, title, titleSource: request.titleSource ?? "auto", folderId, cwd, cwdManaged, activeSessionId: null, createdAt: now, updatedAt: now };
    this.saveWork(work);
    return work;
  }

  updateWork(workId: string, patch: Partial<Pick<Work, "title" | "folderId" | "activeSessionId">>): Work {
    const work = this.requireWork(workId);
    if (patch.activeSessionId && this.sessions.get(patch.activeSessionId)?.workId !== workId) {
      throw new HttpError(400, "invalid_session", "다른 작업의 세션입니다.");
    }
    const next: Work = { ...work, ...patch, updatedAt: Date.now() };
    if (patch.title !== undefined) {
      // A name typed by hand stays; clearing it hands the title back to the automatic one.
      const title = patch.title.trim();
      next.title = title ? title.slice(0, 80) : work.title;
      next.titleSource = title ? "user" : "auto";
    }
    this.saveWork(next);
    if (next.titleSource === "auto" && patch.title !== undefined) this.retitleWork(workId, true);
    return this.requireWork(workId);
  }

  createSession(workId: string, request: CreateSessionRequest): Session {
    const work = this.requireWork(workId);
    if (request.provider !== "claude" && request.provider !== "codex") {
      throw new HttpError(400, "invalid_provider", "지원하지 않는 엔진입니다.");
    }
    const now = Date.now();
    const count = [...this.sessions.values()].filter((session) => session.workId === workId).length;
    const session: Session = {
      id: randomUUID(),
      workId,
      provider: request.provider,
      hostId: this.options.hostId,
      nativeSessionId: null,
      purpose: request.purpose?.trim() || `대화 ${count + 1}`,
      purposeSource: request.purpose?.trim() ? "user" : "auto",
      model: request.model ?? null,
      effort: request.effort ?? null,
      engineModel: null,
      engineEffort: null,
      preview: null,
      previewAt: null,
      status: "idle",
      activity: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    this.saveSession(session);
    this.saveWork({ ...work, activeSessionId: session.id, updatedAt: now });
    return session;
  }

  /** Rename, or pick the model / effort used from the next turn on. */
  updateSession(sessionId: string, patch: UpdateSessionRequest): Session {
    const session = this.requireSession(sessionId);
    const next = { ...session, updatedAt: Date.now() };
    if (patch.purpose !== undefined) {
      // A name typed by hand stays; clearing it hands the name back to the automatic title.
      const trimmed = patch.purpose.trim();
      next.purpose = trimmed ? trimmed.slice(0, 60) : session.purpose;
      next.purposeSource = trimmed ? "user" : "auto";
    }
    if (patch.model !== undefined) next.model = patch.model || null;
    if (patch.effort !== undefined) next.effort = patch.effort || null;
    this.saveSession(next);
    if (patch.purpose !== undefined && next.purposeSource === "auto") this.retitle(sessionId, true);
    return this.requireSession(sessionId);
  }

  async send(sessionId: string, requestId: string, text: string): Promise<{ duplicate: boolean }> {
    const session = this.requireSession(sessionId);
    const trimmed = text.trim();
    if (!requestId) throw new HttpError(400, "missing_request_id", "requestId가 필요합니다.");
    if (!trimmed) throw new HttpError(400, "empty_message", "보낼 내용이 없습니다.");
    const seen = this.store.findRequest(requestId);
    if (seen) {
      if (seen.sessionId !== sessionId || seen.textHash !== hashText(trimmed)) {
        throw new HttpError(409, "request_id_conflict", "같은 requestId로 다른 요청을 보냈습니다.");
      }
      return { duplicate: true };
    }
    if (session.status !== "idle" && session.status !== "error") {
      throw new HttpError(409, "session_busy", "이 세션은 아직 응답 중입니다.");
    }
    this.store.saveRequest(requestId, sessionId, hashText(trimmed));
    const work = this.requireWork(session.workId);
    this.sink.upsertItem(sessionId, { kind: "user", id: `user:${requestId}`, text: trimmed, at: Date.now() });
    this.sink.updateSession(sessionId, { status: "starting", activity: "응답 준비 중", lastError: null });
    this.saveWork({ ...work, activeSessionId: sessionId, updatedAt: Date.now() });
    try {
      await this.adapter(session.provider).send(this.requireSession(sessionId), work, trimmed, requestId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.sink.upsertItem(sessionId, { kind: "notice", id: `error:${requestId}`, level: "error", text: `보내지 못했습니다: ${message}`, at: Date.now() });
      this.sink.updateSession(sessionId, { status: "error", activity: null, lastError: message });
    }
    return { duplicate: false };
  }

  async interrupt(sessionId: string) {
    const session = this.requireSession(sessionId);
    await this.adapter(session.provider).interrupt(session);
  }

  async answerApproval(sessionId: string, itemId: string, decision: ApprovalDecision) {
    const session = this.requireSession(sessionId);
    if (decision !== "accept" && decision !== "decline") {
      throw new HttpError(400, "invalid_decision", "accept 또는 decline만 가능합니다.");
    }
    const handled = await this.adapter(session.provider).answerApproval(session, itemId, decision);
    if (!handled) {
      throw new HttpError(409, "approval_not_pending", "이미 처리되었거나 만료된 승인 요청입니다.");
    }
  }

  /** Probe engines after the UI can connect; results arrive as provider.status events. */
  initProviders() {
    return Promise.all([...this.adapters.values()].map((adapter) => adapter.init().catch(() => undefined)));
  }

  login(provider: Provider): Promise<LoginStart> {
    return this.adapter(provider).login();
  }

  async refreshProviders(): Promise<ProviderStatus[]> {
    return Promise.all([...this.adapters.values()].map((adapter) => adapter.refreshStatus()));
  }

  async shutdown() {
    this.flush();
    await Promise.all([...this.adapters.values()].map((adapter) => adapter.shutdown()));
  }

  /** Automatic titles follow the requests (no model call); see titles.ts. */
  private retitle(sessionId: string, fresh = false) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.purposeSource === "auto") {
      const requests = this.requestsOf([sessionId]);
      const current = fresh || DEFAULT_PURPOSE.test(session.purpose) || requests.length <= 1 ? null : session.purpose;
      const purpose = adaptTitle(requests, current);
      if (purpose && purpose !== session.purpose) this.saveSession({ ...session, purpose, updatedAt: Date.now() });
    }
    this.retitleWork(session.workId);
  }

  private retitleWork(workId: string, fresh = false) {
    const work = this.works.get(workId);
    if (!work || work.titleSource !== "auto") return;
    const sessionIds = [...this.sessions.values()].filter((session) => session.workId === workId).map((session) => session.id);
    const requests = this.requestsOf(sessionIds);
    if (!requests.length) return;
    const title = adaptTitle(requests, fresh || requests.length <= 1 ? null : work.title);
    if (title && title !== work.title) this.saveWork({ ...this.requireWork(workId), title });
  }

  /** Requests of the given sessions, oldest first. */
  private requestsOf(sessionIds: string[]) {
    return sessionIds
      .flatMap((id) => this.loadItems(id).flatMap((item) => (item.kind === "user" ? [{ at: item.at, text: item.text }] : [])))
      .sort((a, b) => a.at - b.at)
      .map((entry) => entry.text);
  }

  /** An interrupted or failed turn may never send a final message; stop showing it as in progress. */
  private finishStreaming(sessionId: string) {
    for (const item of this.loadItems(sessionId)) {
      if (item.kind === "assistant" && item.streaming) {
        this.sink.upsertItem(sessionId, { ...item, streaming: false });
      } else if (item.kind === "tool" && item.status === "running") {
        this.sink.upsertItem(sessionId, { ...item, status: "failed" });
      }
    }
  }

  private loadItems(sessionId: string) {
    let items = this.transcripts.get(sessionId);
    if (!items) {
      items = this.store.items(sessionId);
      this.transcripts.set(sessionId, items);
    }
    return items;
  }

  /** Streaming deltas are persisted in batches; the final item upsert also persists. */
  private markDirty(sessionId: string, itemId: string) {
    let set = this.dirtyItems.get(sessionId);
    if (!set) {
      set = new Set();
      this.dirtyItems.set(sessionId, set);
    }
    set.add(itemId);
    this.flushTimer ??= setTimeout(() => this.flush(), 500);
  }

  private flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    for (const [sessionId, ids] of this.dirtyItems) {
      for (const item of this.loadItems(sessionId)) {
        if (ids.has(item.id)) this.store.saveItem(sessionId, item);
      }
    }
    this.dirtyItems.clear();
  }

  private saveWork(work: Work) {
    this.works.set(work.id, work);
    this.store.saveWork(work);
    this.bus.publish({ type: "work.upserted", work });
  }

  private saveSession(session: Session) {
    this.sessions.set(session.id, session);
    this.store.saveSession(session);
    this.bus.publish({ type: "session.upserted", session });
  }

  private requireWork(workId: string) {
    const work = this.works.get(workId);
    if (!work) throw new HttpError(404, "work_not_found", "작업을 찾지 못했습니다.");
    return work;
  }

  private requireSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new HttpError(404, "session_not_found", "세션을 찾지 못했습니다.");
    return session;
  }
}
