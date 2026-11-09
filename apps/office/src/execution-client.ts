import type { OfficeExecutionObservation } from "../../../packages/contracts/src/office-execution.ts";
import type { AgentRunResult } from "../../../vendor/ieumoffice/packages/agent-core/src/loop.ts";
import { type Gateway, post } from "./bridge.ts";
import { lockOfficeExecution } from "./execution-adapter.ts";
import { executionQuestionFields } from "./execution-question.ts";

type Api = ReturnType<Gateway["aiSession"]>;
let approval: HTMLDivElement | null = null;
function showQuestion(observation: OfficeExecutionObservation | null, api: Api) {
  const item = observation?.items.slice().reverse().find(item => item.kind === "approval" && item.decision === null);
  if (item?.kind !== "approval") { approval?.remove(); approval = null; return; }
  if (approval?.dataset.id === item.id) return;
  approval?.remove(); approval = document.createElement("div"); approval.dataset.id = item.id;
  approval.setAttribute("role", "dialog"); approval.setAttribute("aria-label", "문서 AI 확인");
  approval.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:100000;max-width:480px;max-height:70vh;overflow:auto;padding:16px;border:1px solid #888;border-radius:12px;background:Canvas;color:CanvasText;box-shadow:0 4px 24px #0003";
  const text = document.createElement("p"); text.textContent = item.title; approval.append(text);
  const readResponse = item.officeInteraction ? executionQuestionFields(approval, item.officeInteraction.fields) : undefined;
  for (const [label, decision] of [["답변하고 계속", "accept"], ["취소", "decline"]] as const) {
    const button = document.createElement("button"); button.textContent = label; button.style.marginRight = "8px";
    button.onclick = () => {
      button.disabled = true;
      void api.json("executor-answer", { turnId: observation!.receipt.turnId, itemId: item.id, decision, ...(readResponse && decision === "accept" ? { response: readResponse() } : {}) }).then(() => { approval?.remove(); approval = null; }, error => { button.disabled = false; text.textContent = String(error.message); });
    };
    approval.append(button);
  }
  document.body.append(approval);
}
export function remoteOfficeRun(api: Api, turnId: string) {
  let detached = false;
  return {
    detach() { detached = true; },
    cancel() { void api.json("executor-stop", { turnId }).catch(() => {}); },
    async wait(onText: (text: string) => void): Promise<AgentRunResult> {
      let last = "", failures = 0;
      while (!detached) {
        let terminalError: Error | undefined;
        try {
          const value = await api.json<OfficeExecutionObservation>("executor-observe", { turnId }); failures = 0;
          const text = value.items.filter(item => item.kind === "assistant").map(item => item.text).join("\n\n");
          if (text !== last) { last = text; onText(text); }
          showQuestion(value, api);
          if (value.receipt.status !== "running") {
            lockOfficeExecution(false); showQuestion(null, api); post({ type: "office:execution-refresh" });
            if (value.receipt.status === "failed") {
              const notice = value.items.slice().reverse().find(item => item.kind === "notice");
              terminalError = new Error(notice?.kind === "notice" ? notice.text : "문서 AI 작업을 마치지 못했습니다.");
            } else return { text, cancelled: value.receipt.status === "interrupted", turnLimit: false };
          }
        } catch (error) {
          if (++failures >= 5) throw error;
        }
        if (terminalError) throw terminalError;
        await new Promise(resolve => setTimeout(resolve, 750));
      }
      return { text: last, cancelled: false, turnLimit: false };
    },
  };
}
/** A reopened view observes the existing owner, including its pending question.
 * It never acquires a writer or resubmits the original instruction. */
export function observeOfficeExecution(api: () => Api | null, busy: () => boolean) {
  let stopped = false, running = false, sawRun = false;
  const poll = async () => {
    const current = api(); if (stopped || running || busy() || !current) return;
    running = true;
    try {
      const value = await current.json<OfficeExecutionObservation | null>("executor-current", {});
      if (stopped) return;
      lockOfficeExecution(Boolean(value)); showQuestion(value, current);
      if (value) sawRun = true;
      else if (sawRun) { sawRun = false; post({ type: "office:execution-refresh" }); }
    } catch { /* A grant or connection can change; observation never starts work. */ }
    finally { running = false; }
  };
  const timer = window.setInterval(() => void poll(), 1500); void poll();
  window.addEventListener("pagehide", () => { stopped = true; clearInterval(timer); }, { once: true });
}
