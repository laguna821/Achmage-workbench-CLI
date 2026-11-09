import type { Gateway } from "./bridge.ts";

/** Reports the executor's life, not whether a person currently sees its tab. */
export function maintainOfficeTurn(api: ReturnType<Gateway["aiSession"]>, turnId: string, lost: () => void) {
  let expiresAt = Date.now() + 120_000, pending = false, stopped = false;
  const tick = async () => {
    if (pending || stopped) return;
    pending = true;
    try { const result = await api.json<{ expiresAt: number }>("turn-heartbeat", { turnId }); if (!stopped) expiresAt = result.expiresAt; }
    catch (error) {
      const terminal = error && typeof error === "object" && "status" in error && [401, 403, 404, 409, 423].includes(Number(error.status));
      if (!stopped && (terminal || Date.now() >= expiresAt)) { stop(); lost(); }
    } finally { pending = false; }
  };
  const timer = window.setInterval(() => void tick(), 15_000);
  const stop = () => { stopped = true; window.clearInterval(timer); };
  return stop;
}
