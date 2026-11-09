import type { OfficeExecutionBoot } from "../../../packages/contracts/src/office-execution.ts";
import type { OfficePageMessage, OfficeHostMessage } from "@workbench/contracts";
import { createExecutorOutput } from "./executor-output.ts";

// The native child owns this parent. It receives only a one-use boot capability,
// never the main application's token or a generic filesystem/OS bridge.
const capability = location.hash.slice(1);
history.replaceState(null, "", location.pathname);
const headers = { authorization: `Bearer ${capability}` };
const boot = async () => {
  const response = await fetch("/api/office-executor/boot", { method: "POST", headers });
  if (!response.ok) throw new Error("독립 문서 실행기의 시작 권한이 끝났습니다.");
  return response.json() as Promise<OfficeExecutionBoot>;
};
try {
  const job = await boot();
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-modals");
  frame.style.cssText = "width:100vw;height:100vh;border:0";
  const send = (message: OfficeHostMessage) => frame.contentWindow?.postMessage(message, location.origin);
  const api = async (operation: string, body: unknown) => {
    const response = await fetch(`/api/artifacts/${job.init.artifact.id}/ai/${operation}`, { method: "POST",
      headers: { authorization: `Bearer ${job.init.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.message ?? "문서 실행 요청을 마치지 못했습니다.");
    return value;
  };
  const output = createExecutorOutput({
    request: message => api("executor-output", { ...message, turnId: job.init.execution!.turnId }),
    wait: () => new Promise(resolve => setTimeout(resolve, 800)),
    native: async (requestId, command) => {
      const bridge = (window as unknown as { __TAURI_INTERNALS__?: { invoke<T>(command: string, args: unknown): Promise<T> } }).__TAURI_INTERNALS__;
      if (!bridge) throw new Error("원본 문서 출력용 데스크톱 실행기가 없습니다.");
      return bridge.invoke("office_executor_output", { requestId, command });
    },
    commit: async message => {
      const query = new URLSearchParams({ turnId: job.init.execution!.turnId, planId: message.planId });
      if (message.sourceRevision !== undefined) query.set("sourceRevision", String(message.sourceRevision));
      if (message.generatedId) query.set("generatedId", message.generatedId);
      const response = await fetch(`/api/artifacts/${job.init.artifact.id}/ai/executor-output-commit?${query}`, {
        method: "POST", headers: { authorization: `Bearer ${job.init.token}`, "content-type": "application/octet-stream" }, body: message.bytes,
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.message ?? "문서 결과를 저장하지 못했습니다.");
      return value;
    },
  });
  let sent = false;
  const readiness = window.setTimeout(() => {
    void api("turn-finish", { turnId: job.init.execution!.turnId, status: "failed", error: "원본 편집기를 실행기에 연결하는 시간이 초과되었습니다." })
      .catch(() => {}).finally(() => { document.title = "workbench-office-executor:failed"; });
  }, 60_000);
  window.addEventListener("message", event => {
    if (event.source !== frame.contentWindow || event.origin !== location.origin) return;
    const message = event.data as OfficePageMessage;
    if (message?.type === "office:ready") send(job.init);
    if (message?.type === "office:execution-attached") clearTimeout(readiness);
    if (message?.type === "office:opened" && !sent) {
      sent = true; send({ type: "office:execute", instruction: job.instruction, state: job.state });
    }
    if (message?.type === "office:ai-request") {
      // Admission already saved the target and selected the immutable run's session.
      send({ type: "office:ai-result", requestId: message.requestId,
        ...(message.action === "prepare" ? { value: { revision: job.init.artifact.revision, token: job.init.token, sessionId: job.init.sessionId, referenceSnapshot: job.init.execution?.referenceSnapshot } }
          : { error: "진행 중인 문서 작업의 설정과 대화는 Workbench에서 변경해 주세요." }) });
    }
    if (message?.type === "office:references") {
      void api("executor-reference", { ...message, turnId: job.init.execution!.turnId, snapshot: job.init.execution!.referenceSnapshot
        }).then(value => send({ type: "office:references-result", requestId: message.requestId, value }),
        error => send({ type: "office:references-result", requestId: message.requestId, error: String(error.message) }));
    }
    if (message?.type === "office:output") {
      void output(message).then(value => send({ type: "office:output-result", requestId: message.requestId, value }),
        error => send({ type: "office:output-result", requestId: message.requestId, error: String(error.message) }));
    }
    if (message?.type === "office:error" || message?.type === "office:conflict") {
      void api("turn-finish", { turnId: job.init.execution!.turnId, status: "failed", error: message.message }).catch(() => {}).finally(() => { document.title = "workbench-office-executor:failed"; });
    }
  });
  frame.src = job.page; document.body.append(frame);
  let failures = 0;
  const timer = window.setInterval(() => {
    void fetch("/api/office-executor/state", { headers }).then(async response => {
      failures = 0;
      if (!response.ok || (await response.json()).stop) { clearInterval(timer); document.title = "workbench-office-executor:interrupted"; }
    }).catch(() => { if (++failures >= 30) { clearInterval(timer); document.title = "workbench-office-executor:interrupted"; } });
  }, 1000);
} catch { document.title = "workbench-office-executor:failed"; }
