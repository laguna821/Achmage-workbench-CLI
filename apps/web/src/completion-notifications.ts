import { PROVIDER_LABEL, type SequencedEvent, type Session } from "@workbench/contracts";

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
