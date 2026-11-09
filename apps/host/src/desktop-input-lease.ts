import { HttpError } from "./errors.ts";

/** The physical keyboard/pointer is shared by all apps; browser DOM control has its own lease. */
export class DesktopInputLease {
  private current: { owner: string; cancel(): void } | null = null;
  get owner() { return this.current?.owner ?? null; }
  acquire(owner: string, cancel: () => void) {
    if (this.current) throw new HttpError(409, "desktop_input_busy", "다른 앱 작업이 키보드·마우스를 사용 중입니다.");
    const lease = { owner, cancel }; this.current = lease;
    return () => { if (this.current === lease) this.current = null; };
  }
  takeOver() { const lease = this.current; this.current = null; lease?.cancel(); }
}
