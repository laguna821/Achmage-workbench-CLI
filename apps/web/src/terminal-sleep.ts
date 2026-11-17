import { useEffect, useRef, useState } from "react";

/**
 * A terminal tab that is not shown releases its view (0.5.3, B4): the window's xterm, its WebGL context
 * (browsers keep about 16 live ones) and its output polling. Shown again, it is rebuilt from the gateway's
 * screen model (the screen plus 2,000 lines, apps/host/src/terminals.ts TERMINAL_SCROLLBACK). A switch back
 * within the grace time keeps the view as it was.
 */
export const TERMINAL_SLEEP_MS = 10_000;

export class ViewSleep {
  awake = true;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly graceMs: number;
  private readonly onChange: (awake: boolean) => void;
  constructor(graceMs: number, onChange: (awake: boolean) => void) { this.graceMs = graceMs; this.onChange = onChange; }
  set(visible: boolean) {
    if (visible) {
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      if (!this.awake) { this.awake = true; this.onChange(true); }
    } else if (this.awake && !this.timer) {
      this.timer = setTimeout(() => { this.timer = null; this.awake = false; this.onChange(false); }, this.graceMs);
    }
  }
  dispose() { if (this.timer) clearTimeout(this.timer); this.timer = null; }
}

/** Whether a terminal's view should be held: true while shown, and for the grace time after it is hidden. */
export function useTerminalAwake(visible: boolean, graceMs = TERMINAL_SLEEP_MS) {
  const [awake, setAwake] = useState(true);
  const sleep = useRef<ViewSleep | null>(null);
  if (!sleep.current) sleep.current = new ViewSleep(graceMs, setAwake);
  useEffect(() => { sleep.current?.set(visible); }, [visible]);
  useEffect(() => () => sleep.current?.dispose(), []);
  return awake;
}
