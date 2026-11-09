import type { OfficeTurnFinish, OfficeTurnReceipt, OfficeTurnStart } from "../../../packages/contracts/src/office-ai.ts";
import type { IpcStreamChunk } from "../../../vendor/ieumoffice/packages/agent-core/src/electron-transport.ts";
import type { Events, Gateway } from "./bridge.ts";
import { maintainOfficeTurn } from "./execution-heartbeat.ts";

/** The original long-job engine owns batching/resume; this adapter records its one user run. */
export function createOfficeJob(gateway: Gateway, artifactId: string, events: Events, prepare: () => Promise<{ revision: number }>, background: OfficeTurnStart["background"] = "epub-translation", execution?: { turnId: string; token: string; finish(status: OfficeTurnFinish["status"], error?: string): Promise<void> }) {
  type Run = { turnId: string; api: ReturnType<Gateway["aiSession"]>; seq: number; release(): void };
  let run: Run | null = null;
  let starting: Promise<void> | null = null;
  let finishing: Promise<void> | null = null;
  const streams = new Map<string, AbortController>();
  const stop = () => { for (const stream of streams.values()) stream.abort(); };
  window.addEventListener("pagehide", stop);
  return {
    busy: () => run !== null || starting !== null,
    stop,
    dispose: () => { stop(); run?.release(); window.removeEventListener("pagehide", stop); },
    start(instruction: string): Promise<void> {
      if (finishing) return finishing.then(() => this.start(instruction));
      if (run) return Promise.resolve();
      return starting ??= (async () => {
        if (execution) {
          run = { turnId: execution.turnId, api: gateway.aiSession(artifactId, execution.token), seq: 0, release: () => {} };
          return;
        }
        const { revision } = await prepare(), turnId = crypto.randomUUID();
        let api = gateway.aiSession(artifactId);
        const receipt = await api.json<OfficeTurnReceipt>("turn-start", { turnId, instruction, revision, background });
        if (receipt.duplicate || receipt.status !== "running") throw new Error("이미 처리된 문서 AI 요청입니다.");
        if (receipt.executionToken) api = gateway.aiSession(artifactId, receipt.executionToken);
        run = { turnId, api, seq: 0, release: receipt.executionToken ? maintainOfficeTurn(api, turnId, stop) : () => {} };
      })().finally(() => { starting = null; });
    },
    finish(status: OfficeTurnFinish["status"], text: string): Promise<void> {
      if (finishing) return finishing;
      const current = run; if (!current) return Promise.resolve();
      return finishing = (async () => {
        try {
          try { await current.api.json("turn-events", { turnId: current.turnId, seq: ++current.seq, events: [{ kind: "assistant", id: "document-job-result", text, streaming: false }] }); }
          finally { if (execution) await execution.finish(status, status === "failed" ? text : undefined); else await current.api.json("turn-finish", { turnId: current.turnId, status }); }
        } finally { current.release(); if (run === current) run = null; }
      })().finally(() => { finishing = null; });
    },
    async aiStream(request: { requestId: string } & Record<string, unknown>) {
      if (!run) throw new Error("문서 AI 작업 기록을 먼저 준비해 주세요.");
      if (streams.has(request.requestId)) throw new Error("이미 진행 중인 문서 AI 호출입니다.");
      const current = run, controller = new AbortController(); streams.set(request.requestId, controller);
      let terminal = false;
      void current.api.stream({ ...request, turnId: current.turnId }, value => {
        const chunk = value as IpcStreamChunk;
        if (chunk.requestId !== request.requestId) throw new Error("문서 AI 응답의 요청 번호가 다릅니다.");
        terminal ||= chunk.type === "done" || chunk.type === "error";
        events.emit("aiStream", chunk);
      }, controller.signal).then(() => { if (!terminal) throw new Error("문서 AI 응답이 완료 기록 없이 끝났습니다."); }).catch(error => {
        if (!terminal) events.emit("aiStream", controller.signal.aborted ? { requestId: request.requestId, type: "done" } : { requestId: request.requestId, type: "error", error: error instanceof Error ? error.message : String(error) });
      }).finally(() => streams.delete(request.requestId));
    },
    async aiStreamCancel(requestId: string) {
      if (!streams.has(requestId)) return;
      try { await run?.api.json("cancel", { requestId, requestOnly: true }); }
      catch { streams.get(requestId)?.abort(); }
    },
    onAiStream: events.on("aiStream"),
  };
}
