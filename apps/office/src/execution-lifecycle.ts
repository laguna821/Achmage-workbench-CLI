type Status = "completed" | "failed" | "interrupted";
/** A single admitted request can contain several ORIGINAL loops and their final
 * QC/output work. A loop finishing must not release its parent's physical lease. */
export function createExecutionLifecycle(options: { save(): Promise<void>; finish(status: Status, error?: string): Promise<void> }) {
  let held = false, ended = false, optional = 0, status: Status = "completed", error: string | undefined;
  const controller = new AbortController();
  const record = (next: Status, reason?: string) => {
    if (next !== "completed" && status === "completed") { status = next; error = reason; }
    if (next !== "completed") controller.abort();
  };
  return {
    get held() { return held; },
    get ended() { return ended; },
    signal: controller.signal,
    cancel() { record("interrupted"); },
    async optional<T>(work: () => Promise<T>) { optional++; try { return await work(); } finally { optional--; } },
    async segment(next: Status, reason?: string) {
      if (!(optional && next === "failed")) record(next, reason);
      if (!held && !ended) { ended = true; await options.finish(status, error); }
    },
    async execute(work: (signal: AbortSignal) => Promise<void>) {
      if (held || ended) throw new Error("이미 연결된 문서 실행입니다. 다시 실행하지 않았습니다.");
      held = true;
      try { await work(controller.signal); await options.save(); }
      catch (cause) { record(controller.signal.aborted ? "interrupted" : "failed", cause instanceof Error ? cause.message : String(cause)); }
      finally { ended = true; held = false; await options.finish(status, error); }
      return true;
    },
  };
}
export type ExecutionLifecycle = ReturnType<typeof createExecutionLifecycle>;
