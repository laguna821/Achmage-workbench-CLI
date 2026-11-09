import { createHash } from "node:crypto";
import { ATTENTION_LABEL, type AttentionEvent, type AttentionKind, type AttentionList, type AttentionPayload, type AttentionPresence, type AttentionTarget, type SequencedEvent, type Session, type TranscriptItem } from "@workbench/contracts";
import type { EventBus } from "./bus.ts";
import type { Store } from "./store.ts";
import { HttpError } from "./errors.ts";

const KEY = "attention:v1";
const MAX_RECORDS = 2000;
const PRESENCE_TTL = 40_000;
type Hooks = {
  hostId: string;
  session(id: string): Session | undefined;
  items(id: string): TranscriptItem[];
  hidden(workId: string, sessionId: string): boolean;
  enabled(): boolean;
  now?: () => number;
  deliver?: (payload: AttentionPayload) => Promise<{ status: "sent" | "unavailable" | "unknown"; detail?: string }>;
};

/** The host records live attention before delivery. Opening a window never replays a job or an OS alert. */
export class Notifications {
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly hooks: Hooks;
  private readonly now: () => number;
  private readonly records = new Map<string, AttentionEvent>();
  private readonly presence = new Map<string, AttentionPresence & { at: number }>();
  private readonly deliveries = new Set<(row: AttentionEvent, payload: AttentionPayload) => void>();
  private readonly unsubscribe: () => void;
  private closed = false;

  constructor(store: Store, bus: EventBus, hooks: Hooks) {
    this.store = store; this.bus = bus; this.hooks = hooks; this.now = hooks.now ?? Date.now;
    const raw = store.getMeta(KEY);
    if (raw) for (const row of JSON.parse(raw) as AttentionEvent[]) {
      // Delivery may have reached the OS before the previous process stopped. Do not repeat it.
      this.records.set(row.id, row.delivery === "pending" ? { ...row, delivery: "unknown", deliveryError: "호스트가 다시 시작되어 알림 전송 결과를 확인하지 못했습니다." } : row);
    }
    if (raw) this.persist(false);
    this.unsubscribe = bus.subscribe(event => {
      if (event.type === "item.upserted" || event.type === "work.removed") {
        // Nested publish would otherwise deliver seq N+1 before N to later SSE listeners.
        queueMicrotask(() => { if (!this.closed) this.accept(event); });
      }
    });
  }
  close() { this.closed = true; this.unsubscribe(); this.presence.clear(); this.deliveries.clear(); }
  /** Live producer only. Subscribing never replays historical or uncertain OS deliveries. */
  subscribeDelivery(listener: (row: AttentionEvent, payload: AttentionPayload) => void) { this.deliveries.add(listener); return () => { this.deliveries.delete(listener); }; }
  deliverable(id: string) {
    const row = this.require(id), session = this.hooks.session(row.taskRef.sessionId)!;
    return row.readAt === null && this.hooks.enabled() && !session.muted && !this.visible(session.id) && (row.kind !== "input_needed" || row.resolvedAt === null);
  }
  private persist(emit = true) {
    if (this.records.size > MAX_RECORDS) {
      const oldest = [...this.records.values()].sort((a, b) => a.createdAt - b.createdAt);
      // Pending approvals stay available even after being marked read.
      for (const row of oldest) {
        if (this.records.size <= MAX_RECORDS) break;
        if (row.kind !== "input_needed" || row.resolvedAt !== null) this.records.delete(row.id);
      }
    }
    this.store.setMeta(KEY, JSON.stringify([...this.records.values()]));
    if (emit) this.bus.publish({ type: "attention.changed" });
  }
  private accessible(row: AttentionEvent) {
    const session = this.hooks.session(row.taskRef.sessionId);
    return Boolean(session && session.hostId === this.hooks.hostId && session.workId === row.workId
      && (session.workspaceId ?? null) === row.taskRef.workspaceId && !this.hooks.hidden(row.workId, session.id));
  }
  list(): AttentionList {
    const events = [...this.records.values()].filter(row => this.accessible(row)).sort((a, b) => b.createdAt - a.createdAt);
    return { events, unread: events.filter(row => row.readAt === null).length };
  }
  private require(id: string) {
    const row = this.records.get(id);
    if (!row || !this.accessible(row)) throw new HttpError(404, "attention_missing", "이 호스트에서 알림의 작업을 찾을 수 없습니다.");
    return row;
  }
  target(id: string): AttentionTarget {
    const row = this.require(id), session = this.hooks.session(row.taskRef.sessionId)!;
    return { hostId: this.hooks.hostId, workId: row.workId, sessionId: session.id, itemId: row.itemId,
      artifactId: session.documentAgent?.artifactId ?? null, pageId: session.pageAgent?.pageId ?? null, taskRef: row.taskRef };
  }
  read(id: string): AttentionEvent {
    const row = this.require(id);
    if (row.readAt !== null) return row;
    const next = { ...row, readAt: this.now() };
    this.records.set(id, next); this.persist();
    return next;
  }
  observe(input: AttentionPresence) {
    if (!input || typeof input.clientId !== "string" || !/^[\w:.-]{1,96}$/.test(input.clientId) || typeof input.visible !== "boolean"
      || (input.sessionId !== null && typeof input.sessionId !== "string")) throw new HttpError(400, "attention_presence", "화면 상태를 확인할 수 없습니다.");
    if (input.sessionId !== null) {
      const session = this.hooks.session(input.sessionId);
      if (!session || session.hostId !== this.hooks.hostId || this.hooks.hidden(session.workId, session.id)) throw new HttpError(404, "attention_session", "알림을 확인할 세션이 없습니다.");
    }
    this.expirePresence();
    if (!input.visible) this.presence.delete(input.clientId);
    else {
      if (this.presence.size >= 64 && !this.presence.has(input.clientId)) throw new HttpError(429, "attention_clients", "연결된 화면이 너무 많습니다.");
      this.presence.set(input.clientId, { ...input, at: this.now() });
    }
    return { ok: true };
  }
  private expirePresence() {
    for (const [id, entry] of this.presence) if (this.now() - entry.at >= PRESENCE_TTL) this.presence.delete(id);
  }
  private visible(sessionId: string) {
    this.expirePresence();
    return [...this.presence.values()].some(entry => entry.visible && entry.sessionId === sessionId);
  }
  private payload(row: AttentionEvent): AttentionPayload {
    return { title: "Achmage Workbench", body: ATTENTION_LABEL[row.kind], attentionId: row.id };
  }
  /** At most one foreground client may use an OS fallback if the host has no delivery adapter. */
  claim(id: string, clientId: unknown) {
    if (typeof clientId !== "string" || !/^[\w:.-]{1,96}$/.test(clientId)) throw new HttpError(400, "attention_client", "알림을 받을 화면 ID가 필요합니다.");
    const row = this.require(id), session = this.hooks.session(row.taskRef.sessionId)!;
    if (row.delivery !== "unavailable" || row.readAt !== null || !this.hooks.enabled() || session.muted || this.visible(session.id)) return { claimed: false, payload: null };
    // Persist before replying. Lost replies are not permission to show the notification twice.
    this.records.set(id, { ...row, delivery: "unknown", deliveryError: "화면에 알림 표시를 요청했습니다." }); this.persist();
    return { claimed: true, payload: this.payload(row) };
  }
  private accept(event: SequencedEvent) {
    if (event.type === "work.removed") {
      for (const [id, row] of this.records) if (row.workId === event.workId) this.records.delete(id);
      this.persist(); return;
    }
    if (event.type !== "item.upserted") return;
    const session = this.hooks.session(event.sessionId), item = event.item;
    if (!session || session.hostId !== this.hooks.hostId || session.importedHistory?.kind === "archive" || this.hooks.hidden(session.workId, session.id)) return;
    if (item.kind === "approval" && item.decision !== null) {
      let changed = false;
      for (const [id, row] of this.records) if (row.taskRef.sessionId === session.id && row.itemId === item.id && row.resolvedAt === null) {
        this.records.set(id, { ...row, resolvedAt: this.now() }); changed = true;
      }
      if (changed) this.persist();
      return;
    }
    const kind: AttentionKind | null = item.kind === "approval" && item.decision === null ? "input_needed"
      : item.kind === "turnEnd" && item.cause !== "stop" ? item.status === "completed" ? "completed" : "failed" : null;
    if (!kind) return;
    const id = createHash("sha256").update(JSON.stringify([this.hooks.hostId, session.id, item.id, kind])).digest("hex");
    if (this.records.has(id)) return;
    const items = this.hooks.items(session.id), index = items.findIndex(entry => entry.id === item.id);
    const before = index < 0 ? [] : items.slice(0, index);
    const request = before.findLast(entry => entry.kind === "user" && !entry.steered);
    const requestId = item.kind === "turnEnd" && item.requestId ? item.requestId : request?.id.replace(/^user:/, "");
    if (!requestId) return;
    const runId = `${session.id}/${requestId}`, parent = this.store.getMeta(`task-parent:${runId}`), now = this.now();
    const seen = this.visible(session.id), enabled = this.hooks.enabled() && !session.muted;
    const row: AttentionEvent = { id, kind, workId: session.workId, itemId: item.id, createdAt: now,
      readAt: seen ? now : null, resolvedAt: kind === "input_needed" ? null : now,
      delivery: !enabled || seen ? "suppressed" : this.hooks.deliver ? "pending" : "unavailable", deliveryError: null,
      taskRef: { hostId: session.hostId, workspaceId: session.workspaceId ?? null, sessionId: session.id, nativeSessionId: session.nativeSessionId,
        runId, parentRunId: parent ? JSON.parse(parent) as string | null : null, executorKind: session.pageAgent ? "browser" : session.documentAgent ? "office" : "session" } };
    this.records.set(id, row); this.persist();
    if (enabled && !seen) for (const listener of this.deliveries) {
      try { listener(row, this.payload(row)); } catch { /* The independent push adapter retains its own failure state. */ }
    }
    if (row.delivery === "pending") void this.deliver(row);
  }
  private async deliver(row: AttentionEvent) {
    try {
      const result = await this.hooks.deliver!(this.payload(row));
      if (this.closed || !this.records.has(row.id)) return;
      this.records.set(row.id, { ...this.records.get(row.id)!, delivery: result.status, deliveryError: result.detail ?? null });
    } catch {
      if (this.closed || !this.records.has(row.id)) return;
      this.records.set(row.id, { ...this.records.get(row.id)!, delivery: "unknown", deliveryError: "운영체제 알림의 전송 결과를 확인하지 못했습니다." });
    }
    this.persist();
  }
}
