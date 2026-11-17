/**
 * The conversations this window shows, told to the gateway (0.5.3 A11): an idle engine of a conversation
 * that is not on screen is closed after about 2.5 minutes instead of 10. Said once per change, after the
 * screen settles (a tab switch passes through several renders), and again after the gateway came back.
 */
export function createShownReporter(send: (ids: string[]) => Promise<unknown>, settleMs = 500) {
  let wanted: string[] = [], told: string | null = null, timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    const key = wanted.join(",");
    if (key === told) return;
    told = key;
    const ids = wanted;
    void Promise.resolve().then(() => send(ids)).catch(() => { if (told === key) told = null; });
  };
  const schedule = () => { if (timer === null) timer = setTimeout(flush, settleMs); };
  return {
    report(ids: Iterable<string>) { wanted = [...new Set(ids)].sort(); schedule(); },
    /** The gateway may have forgotten (it restarted): say it again. */
    again() { told = null; schedule(); },
  };
}

/** This window's own id for what it shows (one per window or phone page). */
export const SHOWN_CLIENT = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Math.random()).slice(2);
