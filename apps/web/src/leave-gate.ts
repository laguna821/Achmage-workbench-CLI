/** A pane keeps its current editor until saving succeeds. Repeated clicks share the save;
 * only the newest requested destination may replace the view when it finishes. */
export class LeaveGate {
  private serial = 0;
  private latest = new Map<string, number>();
  private pending = new Map<string, Promise<void>>();

  run(id: string, guard: (() => Promise<void>) | null, proceed: () => void, failed: (error: unknown) => void, saveKey = id) {
    const request = ++this.serial;
    this.latest.set(id, request);
    if (!guard) { proceed(); return; }
    let saving = this.pending.get(saveKey);
    if (!saving) {
      saving = Promise.resolve().then(guard);
      this.pending.set(saveKey, saving);
      const clear = () => { if (this.pending.get(saveKey) === saving) this.pending.delete(saveKey); };
      void saving.then(clear, clear);
    }
    void saving.then(() => {
      if (this.latest.get(id) === request) proceed();
    }, (error: unknown) => {
      if (this.latest.get(id) === request) failed(error);
    });
  }
}
