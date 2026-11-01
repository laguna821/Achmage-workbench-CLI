import type { OfficeTurnFinish, OfficeTurnReceipt } from "../../../packages/contracts/src/office-ai.ts";
import type { IpcStreamChunk } from "../../../vendor/ieumoffice/packages/agent-core/src/electron-transport.ts";
import type { Events, Gateway } from "./bridge.ts";

/** The original long-job engine owns batching/resume; this adapter records its one user run. */
export function createOfficeJob(gateway: Gateway, artifactId: string, events: Events, prepare: () => Promise<{ revision: number }>) {
  type Run = { turnId: string; api: ReturnType<Gateway["aiSession"]>; seq: number };
  let run: Run | null = null;
  let starting: Promise<void> | null = null;
  const streams = new Map<string, AbortController>();
  const stop = () => { for (const stream of streams.values()) stream.abort(); };
  window.addEventListener("pagehide", stop);
  return {
    busy: () => run !== null || starting !== null,
    stop,
    start(instruction: string): Promise<void> {
      if (run) return Promise.resolve();
      return starting ??= (async () => {
        const { revision } = await prepare(), api = gateway.aiSession(artifactId), turnId = crypto.randomUUID();
        const receipt = await api.json<OfficeTurnReceipt>("turn-start", { turnId, instruction, revision, background: "epub-translation" });
        if (receipt.duplicate || receipt.status !== "running") throw new Error("이미 처리된 번역 요청입니다.");
        run = { turnId, api, seq: 0 };
      })().finally(() => { starting = null; });
    },
    async finish(status: OfficeTurnFinish["status"], text: string) {
      const current = run; if (!current) return;
      try {
        try { await current.api.json("turn-events", { turnId: current.turnId, seq: ++current.seq, events: [{ kind: "assistant", id: "book-result", text, streaming: false }] }); }
        finally { await current.api.json("turn-finish", { turnId: current.turnId, status }); }
      } finally { if (run === current) run = null; }
    },
    async aiStream(request: { requestId: string } & Record<string, unknown>) {
      if (!run) throw new Error("번역 작업 기록을 먼저 준비해 주세요.");
      if (streams.has(request.requestId)) throw new Error("이미 진행 중인 번역 호출입니다.");
      const current = run, controller = new AbortController(); streams.set(request.requestId, controller);
      let terminal = false;
      void current.api.stream({ ...request, turnId: current.turnId }, value => {
        const chunk = value as IpcStreamChunk;
        if (chunk.requestId !== request.requestId) throw new Error("번역 응답의 요청 번호가 다릅니다.");
        terminal ||= chunk.type === "done" || chunk.type === "error";
        events.emit("aiStream", chunk);
      }, controller.signal).then(() => { if (!terminal) throw new Error("번역 응답이 완료 기록 없이 끝났습니다."); }).catch(error => {
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
