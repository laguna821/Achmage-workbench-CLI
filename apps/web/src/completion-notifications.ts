import { PROVIDER_LABEL, type AttentionEvent, type AttentionList, type AttentionPayload, type AttentionTarget, type SequencedEvent, type Session, type Snapshot } from "@workbench/contracts";
import type { Api } from "./api.ts";

/** Live turn-end events survive React batching and include hidden document chats. */
export class CompletionNotifications {
  private readonly seen = new Set<string>();
  take(event: SequencedEvent, session: Session | undefined, title: string, enabled: boolean) {
    if (event.type !== "item.upserted" || event.item.kind !== "turnEnd" || event.item.status !== "completed") return null;
    const key = `${event.sessionId}:${event.item.id}`;
    if (this.seen.has(key)) return null;
    this.seen.add(key);
    if (this.seen.size > 512) this.seen.delete(this.seen.values().next().value!);
    if (!enabled || !session || session.muted || session.archivedAt) return null;
    return { title: `답이 왔습니다 · ${PROVIDER_LABEL[session.provider]}`, body: `${title} — ${session.purpose}`, session };
  }
}

type AttentionApi = Pick<Api, "attention" | "readAttention" | "attentionTarget" | "claimAttention" | "attentionPresence">;
export type AttentionState = { supported: boolean | null; list: AttentionList; loading: boolean; error: string | null; hostId: string | null };
const later = (a: number | null, b: number | null) => a === null ? b : b === null ? a : Math.max(a, b);
const problem = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Host-owned inbox, fed by the App's existing snapshot/event stream. No extra SSE or polling. */
export class AttentionInbox {
  readonly clientId = crypto.randomUUID();
  private readonly api: AttentionApi | null;
  private value: AttentionState = { supported: null, list: { events: [], unread: 0 }, loading: false, error: null, hostId: null };
  private readonly listeners = new Set<() => void>();
  private readonly claimed = new Set<string>();
  private epoch: string | undefined;
  private seq = -1;
  private version = 0;
  private wanted = false;
  private reading: Promise<void> | null = null;
  private presenceQueue: Promise<unknown> = Promise.resolve();
  constructor(api: AttentionApi | null) { this.api = api; }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getState = () => this.value;
  private publish(patch: Partial<AttentionState>) { this.value = { ...this.value, ...patch }; this.listeners.forEach(listener => listener()); }
  private list(events: AttentionEvent[]) {
    const before = new Map(this.value.list.events.map(entry => [entry.id, entry]));
    const merged = events.map(entry => {
      const previous = before.get(entry.id);
      return previous ? { ...entry, readAt: later(entry.readAt, previous.readAt), resolvedAt: later(entry.resolvedAt, previous.resolvedAt) } : entry;
    }).sort((a, b) => b.createdAt - a.createdAt);
    return { events: merged, unread: merged.filter(entry => entry.readAt === null).length };
  }
  snapshot(snapshot: Pick<Snapshot, "hostId" | "epoch" | "seq" | "attention">) {
    const changedHost = this.value.hostId !== snapshot.hostId || (this.epoch !== undefined && snapshot.epoch !== this.epoch);
    if (!changedHost && snapshot.seq < this.seq) return;
    if (changedHost) { this.seq = -1; this.claimed.clear(); this.value = { ...this.value, list: { events: [], unread: 0 }, error: null }; }
    this.epoch = snapshot.epoch; this.seq = snapshot.seq; this.version++;
    this.publish({ hostId: snapshot.hostId, supported: snapshot.attention !== undefined, list: this.list(snapshot.attention?.events ?? []), loading: false });
  }
  event(event: SequencedEvent) {
    if (event.seq <= this.seq) return;
    this.seq = event.seq;
    if (event.type === "attention.changed") { this.version++; void this.refresh(); }
  }
  refresh = (): Promise<void> => {
    if (!this.api || this.value.supported !== true) return Promise.resolve();
    this.wanted = true;
    if (this.reading) return this.reading;
    this.publish({ loading: true });
    this.reading = (async () => {
      while (this.wanted) {
        this.wanted = false;
        const version = this.version;
        try {
          const next = await this.api!.attention();
          if (version === this.version) this.publish({ list: this.list(next.events) });
        } catch (error) { if (version === this.version) this.publish({ error: problem(error) }); }
      }
    })().finally(() => { this.reading = null; this.publish({ loading: false }); });
    return this.reading;
  };
  clearError = () => this.publish({ error: null });
  reportError = (error: unknown) => this.publish({ error: problem(error) });
  read = async (id: string) => {
    if (!this.api || this.value.supported !== true) return;
    const hostId = this.value.hostId, epoch = this.epoch, known = this.value.list.events.some(row => row.id === id), entry = await this.api.readAttention(id);
    if (hostId !== this.value.hostId || epoch !== this.epoch || (known && !this.value.list.events.some(row => row.id === id))) return;
    this.version++; if (this.reading) this.wanted = true;
    this.publish({ list: this.list([entry, ...this.value.list.events.filter(row => row.id !== id)]) });
  };
  target = async (id: string): Promise<AttentionTarget> => {
    if (!this.api || this.value.supported !== true || !this.value.hostId) throw new Error("알림을 지원하는 호스트에 연결해 주세요.");
    const target = await this.api.attentionTarget(id), entry = this.value.list.events.find(row => row.id === id);
    if (target.hostId !== this.value.hostId || target.taskRef.hostId !== target.hostId || target.taskRef.sessionId !== target.sessionId
      || (entry && (entry.workId !== target.workId || entry.itemId !== target.itemId || entry.taskRef.sessionId !== target.sessionId || entry.taskRef.runId !== target.taskRef.runId))) throw new Error("알림의 호스트 또는 원문 대상이 달라졌습니다. 알림을 다시 불러와 주세요.");
    return target;
  };
  /** A failed/unknown claim is never automatically retried: the host may already own its receipt. */
  fallback = async (deliver: (payload: AttentionPayload) => Promise<void>) => {
    if (!this.api || this.value.supported !== true) return;
    const hostId = this.value.hostId;
    for (const entry of this.value.list.events) {
      if (entry.delivery !== "unavailable" || entry.readAt !== null || (entry.kind === "input_needed" && entry.resolvedAt !== null) || this.claimed.has(entry.id)) continue;
      this.claimed.add(entry.id);
      try {
        const claim = await this.api.claimAttention(entry.id, this.clientId);
        if (hostId !== this.value.hostId) return;
        if (claim.claimed && claim.payload?.attentionId === entry.id) await deliver(claim.payload);
      } catch (error) { this.reportError(`시스템 알림 전달을 확인하지 못했습니다. ${problem(error)}`); }
    }
  };
  presence(sessionId: string | null, visible: boolean, keepalive = false) {
    if (!this.api || this.value.supported !== true) return;
    const send = () => this.api!.attentionPresence({ clientId: this.clientId, sessionId, visible }, keepalive).catch(error => { if (!keepalive) this.reportError(`알림 접속 상태를 보내지 못했습니다. ${problem(error)}`); });
    this.presenceQueue = this.presenceQueue.then(send, send);
  }
}

/** Focus/session changes and a 15-second heartbeat describe UI presence only. */
export function watchAttentionPresence(inbox: AttentionInbox, session: () => string | null) {
  let key = "";
  const send = (force = false) => {
    const visible = !document.hidden && document.hasFocus(), sessionId = session(), next = `${visible}:${sessionId ?? ""}`;
    if (force || next !== key) { key = next; inbox.presence(sessionId, visible); }
  };
  const update = () => send();
  const leave = () => { key = ""; inbox.presence(session(), false, true); };
  window.addEventListener("focus", update); window.addEventListener("blur", update); document.addEventListener("visibilitychange", update); window.addEventListener("pagehide", leave);
  send(); const timer = window.setInterval(() => send(true), 15000);
  return { update, close: () => { clearInterval(timer); window.removeEventListener("focus", update); window.removeEventListener("blur", update); document.removeEventListener("visibilitychange", update); window.removeEventListener("pagehide", leave); leave(); } };
}
