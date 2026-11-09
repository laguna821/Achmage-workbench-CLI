import type { OfficeExecutionState, OfficeInteractionRequest, OfficeInteractionResponse } from "../../../packages/contracts/src/office-execution.ts";
import { type Init, type Gateway, listen, post } from "./bridge.ts";

type Adapter = { ready(): boolean; capture(): OfficeExecutionState; execute(instruction: string, state: OfficeExecutionState): boolean | Promise<boolean>; lock(locked: boolean): void };
let adapter: Adapter | null = null, executor: Init["execution"], api: ReturnType<Gateway["aiSession"]> | null = null;
let locked = false, admitted = false;
export const isOfficeExecutor = () => Boolean(executor);
export function reportOfficeExecutionError(error: unknown) {
  if (executor) post({ type: "office:error", message: error instanceof Error ? error.message : String(error) });
}
export function registerOriginalExecutor(value: Adapter) {
  adapter = value; value.lock(locked);
  return () => { if (adapter === value) adapter = null; };
}
export function captureOfficeExecution() { return adapter?.ready() ? adapter.capture() : null; }
export function lockOfficeExecution(value: boolean) { locked = value; adapter?.lock(value); }
export function installOfficeExecutor(init: Init, gateway: Gateway) {
  executor = init.execution; api = gateway.aiSession(init.artifact.id, init.execution ? init.token : undefined);
  if (!executor) return;
  let pending: { instruction: string; state: OfficeExecutionState } | null = null;
  let starting = false;
  const run = async () => {
    if (!pending || admitted || starting || !adapter?.ready()) return;
    const request = pending;
    starting = true;
    try {
      if (await adapter.execute(request.instruction, request.state)) { admitted = true; pending = null; clearInterval(timer); }
    } catch (error) {
      admitted = true; pending = null; clearInterval(timer);
      post({ type: "office:error", message: error instanceof Error ? error.message : String(error) });
    } finally { starting = false; }
  };
  const timer = window.setInterval(() => void run(), 100);
  listen(message => { if (message.type === "office:execute" && !admitted && !pending) { pending = message; void run(); } });
  window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
}
/** An original boolean confirmation waits on the existing transcript approval.
 * Reopening the main UI answers the same question; absence is never acceptance. */
async function ask(prompt: string, fields?: OfficeInteractionRequest["fields"]) {
  if (!executor || !api) throw new Error("독립 문서 실행기의 확인 요청이 아닙니다.");
  const id = crypto.randomUUID();
  let state = await api.json<{ decision: "accept" | "decline" | "expired" | null; response?: OfficeInteractionResponse }>("turn-question", { turnId: executor.turnId, id, prompt, ...(fields ? { fields } : {}) });
  while (state.decision === null) {
    await new Promise(resolve => setTimeout(resolve, 800));
    state = await api.json("turn-question", { turnId: executor.turnId, id });
  }
  if (state.decision === "expired") throw new Error("문서 확인 요청이 취소되었습니다.");
  return state;
}
export async function askOfficeExecutionQuestion(prompt: string) { return (await ask(prompt)).decision === "accept"; }
/** The original resolver receives explicit choices/text, including cancellation. */
export async function askOfficeExecutionInteraction(request: OfficeInteractionRequest): Promise<OfficeInteractionResponse | null> {
  const state = await ask(request.prompt, request.fields);
  return state.decision === "accept" ? state.response ?? {} : null;
}
