/**
 * A hidden editor rests (0.5.3 A10). The Workbench window keeps an editor's frame loaded while its tab
 * is not on screen (until tab sleep), and the editors keep their timers and frame loops running there:
 * the preferences read every 2.5 s, the dirty check every 2 s, Excel's grid backstop four times a
 * second and its paint loops on every animation frame — 7–9.5 % of a core for three hidden Excel tabs
 * in WebKitGTK (perf-measure-webkit §4).
 *
 * While the window says the frame is not shown, every repeating timer (setInterval) of the page stops
 * and every animation frame asked for waits. When it is shown again each timer that came due meanwhile
 * runs once (the catch-up) and then keeps its old period, and the waiting frames run. One-shot timers
 * (setTimeout) are not touched: a reply being waited for still times out.
 *
 * The page stays awake (never rests) while something holds it: a document AI turn (turn-activity), a
 * flush / keep-copy / rebase in flight, and for a short while after any message from the window (an
 * export, a control request), so whatever the window asks of a hidden editor is done as before. A page
 * told nothing (an independent executor's own window, a headless export) never rests.
 *
 * An editor page with unsaved edits never rests (the coordinator's safety rule): before every rest the
 * editor's own dirty check (`restWhenClean`, the same one its MCP status uses) is asked; dirty, or no
 * answer within 5 s, and the page stays awake — its autosave, dirty check and keep-copy run on time as
 * today — and it is asked again every 5 s (and at once when the editor reports clean). An editor that
 * gives no check never rests.
 */

type Handler = (...args: unknown[]) => void;
type Repeat = { win: Window; fn: Handler; args: unknown[]; ms: number; native: number | null; lastRun: number };
type Frame = { win: Window; callback: FrameRequestCallback; native: number | null };
type Natives = {
  setInterval: Window["setInterval"]; clearInterval: Window["clearInterval"]; clearTimeout: Window["clearTimeout"];
  requestAnimationFrame: Window["requestAnimationFrame"]; cancelAnimationFrame: Window["cancelAnimationFrame"];
};

/** A dirty (or silent) editor is asked again after this. */
const CHECK_AGAIN_MS = 5_000;

/** Our own timer and frame ids, far above what the engine hands out, so a stray clearTimeout of a native id never hits ours. */
const ID_BASE = 1_000_000_000;

export function createPageRest(options: { wakeMs?: number; now?: () => number } = {}) {
  const wakeMs = options.wakeMs ?? 10_000;
  const now = options.now ?? (() => Date.now());
  const natives = new Map<Window, Natives>();
  const repeats = new Map<number, Repeat>();
  const frames = new Map<number, Frame>();
  let nextId = ID_BASE;
  let frameShown = true, pageVisible = true, holds = 0, nudged = false, nudgeTimer: ReturnType<typeof setTimeout> | null = null;

  let check: (() => boolean | Promise<boolean>) | null = null;
  /** The last check said clean, and nothing happened since that could have changed it. */
  let confirmed = false, checking = false, generation = 0;
  let recheck: ReturnType<typeof setTimeout> | null = null;
  const wantsRest = () => check !== null && !(frameShown && pageVisible) && holds === 0 && !nudged;
  const resting = () => wantsRest() && confirmed;
  let wasResting = false;
  /** Something happened that may have made the document dirty: the next rest asks again. */
  const invalidate = () => { generation++; confirmed = false; };
  const ask = () => {
    if (checking || !check || recheck !== null) return;
    const asked = generation;
    const answer = (dirty: boolean) => {
      checking = false;
      if (asked !== generation) return apply();
      if (dirty) { recheck = setTimeout(() => { recheck = null; apply(); }, CHECK_AGAIN_MS); return; }
      confirmed = true;
      apply();
    };
    checking = true;
    let result: boolean | Promise<boolean>;
    try { result = check(); } catch { result = true; }
    if (typeof result === "boolean") return answer(result);
    let settled = false;
    const late = setTimeout(() => { if (!settled) { settled = true; answer(true); } }, CHECK_AGAIN_MS);
    result.then((dirty) => dirty !== false, () => true).then((dirty) => { if (settled) return; settled = true; clearTimeout(late); answer(dirty); });
  };

  const startRepeat = (repeat: Repeat) => {
    const native = natives.get(repeat.win)!;
    repeat.native = native.setInterval(() => { repeat.lastRun = now(); repeat.fn(...repeat.args); }, repeat.ms);
  };
  const stopRepeat = (repeat: Repeat) => {
    if (repeat.native !== null) natives.get(repeat.win)!.clearInterval(repeat.native);
    repeat.native = null;
  };
  const askFrame = (id: number, frame: Frame) => {
    frame.native = natives.get(frame.win)!.requestAnimationFrame((time) => {
      if (frames.get(id) !== frame) return;
      frames.delete(id);
      frame.callback(time);
    });
  };

  /** Apply the current state: stop everything on rest; on waking catch up once and start again. */
  const apply = () => {
    if (!wantsRest()) invalidate();
    else if (!confirmed) ask();
    const rest = resting();
    if (rest === wasResting) return;
    wasResting = rest;
    if (rest) {
      for (const repeat of repeats.values()) stopRepeat(repeat);
      return;
    }
    const at = now();
    for (const [id, repeat] of [...repeats]) {
      if (repeats.get(id) !== repeat) continue;
      if (at - repeat.lastRun >= repeat.ms) {
        repeat.lastRun = at;
        try { repeat.fn(...repeat.args); } catch (error) { setTimeout(() => { throw error; }); }
      }
      if (repeats.get(id) === repeat && repeat.native === null) startRepeat(repeat);
    }
    for (const [id, frame] of frames) if (frame.native === null) askFrame(id, frame);
  };

  return {
    /** Put the page's timers and frames of this window under the rest (the page itself, the Hangul studio frame). */
    install(win: Window) {
      if (natives.has(win)) return;
      const native: Natives = {
        setInterval: win.setInterval.bind(win), clearInterval: win.clearInterval.bind(win), clearTimeout: win.clearTimeout.bind(win),
        requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
      };
      natives.set(win, native);
      const clear = (id: number | undefined, fallback: (id?: number) => void) => {
        const repeat = id === undefined ? undefined : repeats.get(id);
        if (!repeat) return fallback(id);
        repeats.delete(id!);
        stopRepeat(repeat);
      };
      win.setInterval = ((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
        if (typeof handler !== "function") return native.setInterval(handler, ms, ...args);
        const id = ++nextId;
        const repeat: Repeat = { win, fn: handler as Handler, args, ms: Math.max(0, Number(ms) || 0), native: null, lastRun: now() };
        repeats.set(id, repeat);
        if (!resting()) startRepeat(repeat);
        return id;
      }) as Window["setInterval"];
      win.clearInterval = ((id?: number) => clear(id, native.clearInterval)) as Window["clearInterval"];
      win.clearTimeout = ((id?: number) => clear(id, native.clearTimeout)) as Window["clearTimeout"];
      win.requestAnimationFrame = (callback: FrameRequestCallback) => {
        const id = ++nextId;
        const frame: Frame = { win, callback, native: null };
        frames.set(id, frame);
        if (!resting()) askFrame(id, frame);
        return id;
      };
      win.cancelAnimationFrame = (id: number) => {
        const frame = frames.get(id);
        if (!frame) return native.cancelAnimationFrame(id);
        frames.delete(id);
        if (frame.native !== null) native.cancelAnimationFrame(frame.native);
      };
    },
    /** The editor's own dirty check: without one the page never rests; with it, only while clean. */
    restWhenClean(dirty: () => boolean | Promise<boolean>) { check = dirty; invalidate(); apply(); },
    /** The editor reported its dirty state: dirty wakes it now; clean lets a waiting rest ask again at once. */
    dirtyHint(dirty: boolean) {
      if (dirty) { invalidate(); apply(); return; }
      if (recheck !== null) { clearTimeout(recheck); recheck = null; }
      apply();
    },
    /** The window says whether this editor's frame is on screen. */
    shown(value: boolean) { frameShown = value; apply(); },
    /** Whether the person can see this editor now (its frame shown and the app window visible). */
    onScreen: () => frameShown && pageVisible,
    /** The page's own visibility (the whole app window minimised or behind). */
    pageVisible(value: boolean) { pageVisible = value; apply(); },
    /** Keep the page awake until the returned function is called (an AI turn). */
    hold(_reason: string) {
      holds++;
      invalidate();
      apply();
      let released = false;
      return () => { if (released) return; released = true; holds--; apply(); };
    },
    /** A message from the window: awake for a while, so what it asks of a hidden editor is done. */
    nudge() {
      if (nudgeTimer !== null) clearTimeout(nudgeTimer);
      // Awake first (timers start), then the end of the wake, so a timer due at the same moment runs first.
      nudged = true;
      invalidate();
      apply();
      nudgeTimer = setTimeout(() => { nudgeTimer = null; nudged = false; apply(); }, wakeMs);
    },
    resting,
  };
}

export type PageRest = ReturnType<typeof createPageRest>;
