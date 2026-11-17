import type { SequencedEvent } from "@workbench/contracts";

/**
 * The window's live events on their way into its state (perf G1).
 *
 * A4: the gateway sends many events a second while an answer streams (one per token). Each used to be its own
 * dispatch, so its own render of the whole window. Here they wait for the next frame and are applied together,
 * in the order they came — one render per frame. Nothing is dropped or reordered; `flush()` applies at once.
 *
 * Point 5: a conversation whose tab is not on screen gets its status only (session.upserted: 진행 중, 확인 필요,
 * 끝남, 새 답 — those always go through). Its items (item.upserted / item.delta) are kept aside, not in the
 * rendered state, until `unpark(id)` when its tab is shown again: then everything that arrived is applied
 * at once, before anything that came after. The gateway stores every item as before.
 */
export type EventPump = {
  push: (event: SequencedEvent) => void;
  /** Apply what is waiting now. */
  flush: () => void;
  /** The conversation is on screen again: what was kept aside is applied now (with what waits for the frame). */
  unpark: (sessionId: string) => void;
  /** Items are kept aside for this conversation (it was not on screen when they came). */
  isParked: (sessionId: string) => boolean;
  /** A resync reloads the state: what was kept aside belongs to transcripts that are gone. */
  reset: () => void;
};

/** One run per animation frame; a timer stands in where frames do not run (a window that is not drawn). */
export function nextFrame(run: () => void): () => void {
  let done = false;
  const once = () => { if (done) return; done = true; window.cancelAnimationFrame(frame); window.clearTimeout(timer); run(); };
  const frame = window.requestAnimationFrame(once);
  const timer = window.setTimeout(once, 50);
  return () => { done = true; window.cancelAnimationFrame(frame); window.clearTimeout(timer); };
}

const sessionOfItem = (event: SequencedEvent) => (event.type === "item.upserted" || event.type === "item.delta" ? event.sessionId : null);

export function createEventPump({ apply, parked, onAside, schedule = nextFrame, limit = 5000 }: {
  /** `shown`: the conversation whose kept-aside items these are (unpark), now on screen again. */
  apply: (events: SequencedEvent[], shown?: string) => void;
  /** The first item of a conversation was kept aside: its loaded transcript is behind from now on. */
  onAside?: (sessionId: string) => void;
  /** This conversation is not on screen (and its transcript is loaded): its items wait. */
  parked: (sessionId: string) => boolean;
  schedule?: (run: () => void) => () => void;
  /** Kept-aside items of one conversation are applied in one batch once this many wait (bounded memory). */
  limit?: number;
}): EventPump {
  let queue: SequencedEvent[] = [];
  let cancel: (() => void) | null = null;
  const aside = new Map<string, SequencedEvent[]>();
  const flush = () => {
    cancel?.(); cancel = null;
    if (!queue.length) return;
    const batch = queue; queue = [];
    apply(batch);
  };
  const later = () => { if (!cancel) cancel = schedule(() => { cancel = null; flush(); }); };
  return {
    push(event) {
      const id = sessionOfItem(event);
      const kept = id ? aside.get(id) : undefined;
      if (id && (kept || parked(id))) {
        const list = kept ?? [];
        list.push(event);
        if (!kept) { aside.set(id, list); onAside?.(id); }
        if (list.length >= limit) { queue.push(...list); list.length = 0; later(); }
        return;
      }
      queue.push(event);
      later();
    },
    flush,
    unpark(sessionId) {
      const kept = aside.get(sessionId);
      if (!kept) return;
      aside.delete(sessionId);
      // What was kept aside came before what waits in the queue for this conversation (nothing does: its items were all kept).
      cancel?.(); cancel = null;
      const batch = [...kept, ...queue]; queue = [];
      apply(batch, sessionId);
    },
    isParked: (sessionId) => aside.has(sessionId),
    reset() { aside.clear(); },
  };
}
