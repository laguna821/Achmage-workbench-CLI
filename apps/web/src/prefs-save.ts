import { useCallback, useEffect, useRef, useState } from "react";
import type { UiPrefs } from "@workbench/contracts";

export type PrefsPatch = UiPrefs | ((current: UiPrefs) => UiPrefs);

/**
 * The screen preferences, edited at once on screen and saved to the gateway after a short pause.
 * Every change builds on the LATEST preferences — what this window changed and has not seen saved yet,
 * else the gateway's last — read from refs, never from the render a callback was made in (composer-056:
 * a fold that waited for the double-click window used the preferences of its click and folded again a
 * folder unfolded meanwhile). The answer to a save clears the local copy only when nothing newer is waiting.
 */
export function usePrefsSaver(server: UiPrefs, save: ((prefs: UiPrefs) => Promise<{ prefs: UiPrefs }>) | null, onSaved: (prefs: UiPrefs) => void, onError: (error: unknown) => void, pause = 250) {
  const [local, setLocal] = useState<UiPrefs | null>(null);
  /** What this window changed and the gateway has not answered for yet (null: nothing). */
  const waiting = useRef<UiPrefs | null>(null);
  /** The gateway's preferences as last known (its answers are taken in at once, before the next render). */
  const known = useRef(server);
  known.current = server;
  const timer = useRef<number | undefined>(undefined);
  const calls = useRef({ save, onSaved, onError });
  calls.current = { save, onSaved, onError };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const change = useCallback((patch: PrefsPatch) => {
    const base = waiting.current ?? known.current;
    const next = { ...base, ...(typeof patch === "function" ? patch(base) : patch) };
    waiting.current = next;
    setLocal(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const sending = waiting.current;
      const { save: send } = calls.current;
      if (!sending || !send) return;
      void send(sending)
        .then((saved) => {
          known.current = saved.prefs;
          calls.current.onSaved(saved.prefs);
          if (waiting.current === sending) { waiting.current = null; setLocal(null); }
        })
        .catch((error: unknown) => calls.current.onError(error));
    }, pause);
  }, [pause]);
  return { local, save: change };
}
