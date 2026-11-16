import type { OfficeExecutionObservation } from "../../../packages/contracts/src/office-execution.ts";
import type { AgentRunResult } from "../../../vendor/ieumoffice/packages/agent-core/src/loop.ts";
import { type Gateway, post } from "./bridge.ts";
import { lockOfficeExecution } from "./execution-adapter.ts";
import { executionQuestionFields } from "./execution-question.ts";
import { HWP_EDIT_TOOLS, reportTurnActivity } from "./turn-activity.ts";

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
/** Tool lines and answer of an observed executor turn, told once each (turn-activity.ts). */
function reportObserved(value: OfficeExecutionObservation, seen: Map<string, string>) {
  for (const item of value.items) {
    if (item.kind !== "tool" || seen.get(item.id) === item.status) continue;
    seen.set(item.id, item.status);
    const detail = item.detail ?? "", name = detail.includes("\n") ? detail.slice(0, detail.indexOf("\n")) : item.tool;
    reportTurnActivity({ kind: "tool", id: item.id, name, title: item.title, status: item.status === "running" ? "running" : item.status === "failed" ? "failed" : "completed", edit: HWP_EDIT_TOOLS.has(name) });
  }
}
const terminalStatus = (error: unknown) => Boolean(error && typeof error === "object" && "status" in error && [401, 403, 404, 409].includes(Number((error as { status: unknown }).status)));
export function remoteOfficeRun(api: Api, turnId: string) {
  let detached = false;
  const seen = new Map<string, string>();
  reportTurnActivity({ kind: "remote", turnId });
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
          reportObserved(value, seen);
          if (text !== last) { last = text; onText(text); reportTurnActivity({ kind: "text", text }); }
          showQuestion(value, api);
          if (value.receipt.status !== "running") {
            lockOfficeExecution(false); showQuestion(null, api); post({ type: "office:execution-refresh" });
            const notice = value.items.slice().reverse().find(item => item.kind === "notice");
            reportTurnActivity({ kind: "end", status: value.receipt.status, ...(notice?.kind === "notice" && value.receipt.status !== "completed" ? { error: notice.text } : {}) });
            if (value.receipt.status === "failed") {
              terminalError = new Error(notice?.kind === "notice" ? notice.text : "문서 AI 작업을 마치지 못했습니다.");
            } else return { text, cancelled: value.receipt.status === "interrupted", turnLimit: false };
          }
        } catch (error) {
          // The gateway no longer confirms this turn (restarted, grant gone, unreachable): nothing
          // this view could save is protected by the hold any more, so it ends here with the reason.
          // 0.5.1 threw without releasing it, and the observer below kept it (the editor stayed inert).
          if (terminalStatus(error) || ++failures >= 5) {
            lockOfficeExecution(false); showQuestion(null, api);
            reportTurnActivity({ kind: "end", status: "lost", error: "문서 AI 작업의 연결이 끊겼습니다. 문서를 다시 열어 결과를 확인해 주세요." });
            throw error;
          }
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
  let stopped = false, running = false, sawRun = false, failures = 0;
  const seen = new Map<string, string>();
  const poll = async () => {
    const current = api(); if (stopped || running || busy() || !current) return;
    running = true;
    try {
      const value = await current.json<OfficeExecutionObservation | null>("executor-current", {});
      if (stopped) return;
      failures = 0;
      lockOfficeExecution(Boolean(value)); showQuestion(value, current);
      reportTurnActivity({ kind: "observed", turnId: value?.receipt.turnId ?? null });
      if (value) { sawRun = true; reportObserved(value, seen); }
      else if (sawRun) { sawRun = false; post({ type: "office:execution-refresh" }); }
    } catch (error) {
      // A grant or connection can change; observation never starts work. But a hold it cannot
      // confirm is not kept: three failed looks (≈4.5 s) or a refusal release it (0.5.1 kept it).
      if (!stopped && !busy() && (terminalStatus(error) || ++failures >= 3)) {
        failures = 0; lockOfficeExecution(false); showQuestion(null, current);
        if (sawRun) { sawRun = false; reportTurnActivity({ kind: "observed", turnId: null }); }
      }
    }
    finally { running = false; }
  };
  const timer = window.setInterval(() => void poll(), 1500); void poll();
  window.addEventListener("pagehide", () => { stopped = true; clearInterval(timer); }, { once: true });
}
