import { ApiRequestError } from "../../api.ts";

// One writer per note in this window. Every page showing a note (two panes may show the same one)
// sends its writes through the note's one line: each goes after the one before it has returned, with
// the revision the person saw carried forward over the revisions this window's own writes made — so
// the person never conflicts with themselves. When the gateway refuses a write because the note is
// not what the person saw, the writes already waiting behind it are not sent: their base is stale
// too, and the person is asked once.

/** A write that was not sent: one before it was refused ("behind"), or its page was left ("left"). */
export class NoteWriteSkipped extends Error {
  readonly why: "behind" | "left";
  constructor(why: "behind" | "left") {
    super(why === "left" ? "노트를 떠나서 쓰지 않았습니다." : "앞선 쓰기가 받아들여지지 않아 보내지 않았습니다. 노트를 확인한 뒤 다시 해 주세요.");
    this.why = why;
  }
}

/** The gateway refused because the note is not what the person saw (changed, moved, or its properties do not read). */
export const isStale = (error: unknown) => error instanceof ApiRequestError && error.status === 409 && (error.code === "note_changed" || error.code === "note_moved" || error.code === "note_unreadable");

type Line = { tail: Promise<unknown>; own: Map<number | null, number | null>; refusals: number };
// Per gateway (the object the writes are sent with), then per note.
const lines = new WeakMap<object, Map<string, Line>>();

function lineOf(gateway: object, note: string): Line {
  let notes = lines.get(gateway);
  if (!notes) lines.set(gateway, (notes = new Map()));
  let line = notes.get(note);
  if (!line) notes.set(note, (line = { tail: Promise.resolve(), own: new Map(), refusals: 0 }));
  return line;
}

/**
 * Send a write to `note` after the ones already waiting for it. `seen` is the revision the person
 * saw; `make` is called with the base to send (`seen`, moved on over this window's own writes since)
 * and `revisionOf` reads the revision its result left the note at. `shows` says which note the
 * sending page shows when the write's turn comes (null: the page is gone): a write for a note its
 * page does not show is not sent — what was typed for it stays kept under its own note.
 */
export function sendNoteWrite<T>(gateway: object, note: string, seen: number | null, make: (base: number | null) => Promise<T>, revisionOf: (result: T) => number | null, shows?: () => string | null): Promise<T> {
  const line = lineOf(gateway, note);
  const refusals = line.refusals;
  const job = line.tail.then(async () => {
    if (shows && shows() !== note) throw new NoteWriteSkipped("left");
    if (line.refusals !== refusals) throw new NoteWriteSkipped("behind");
    let base = seen;
    for (let hops = 0; line.own.has(base) && hops < 1000; hops += 1) base = line.own.get(base)!;
    let result: T;
    try {
      result = await make(base);
    } catch (error) {
      if (isStale(error)) {
        line.refusals += 1;
        // The note moved on by another hand: what this window's writes made no longer leads to it.
        line.own.clear();
      }
      throw error;
    }
    const made = revisionOf(result);
    if (made !== base) {
      line.own.set(base, made);
      // The note is at `made` now: nothing of ours has moved it on from there.
      line.own.delete(made);
    }
    return result;
  });
  line.tail = job.catch(() => undefined);
  return job;
}
