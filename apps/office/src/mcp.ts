import type { OfficeMcpRequest } from "../../../packages/contracts/src/office-mcp.ts";
import { listen, post, type Init } from "./bridge.ts";
import { officeAiBusy, officeCopyBusy } from "./copy.ts";
import { recovery } from "./recovery.ts";

export type McpResult = { requestId: string; ok: boolean; result?: unknown; error?: string };

/** Correlation for the original Word/Sheets renderer bridges. */
export function originalMcp(send: (message: { requestId: string; command: string; payload: unknown }) => void) {
  let ready = false;
  const pending = new Map<string, (result: McpResult) => void>();
  return {
    ready: () => ready,
    signal: () => { ready = true; },
    result: (result: McpResult) => pending.get(result.requestId)?.(result),
    run: (command: string, payload: unknown = {}) => new Promise<unknown>((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timer = window.setTimeout(() => { pending.delete(requestId); reject(new Error("원본 편집기에서 명령 완료를 확인하지 못했습니다.")); }, 110_000);
      pending.set(requestId, result => {
        window.clearTimeout(timer); pending.delete(requestId);
        if (result.ok) resolve(result.result); else reject(new Error(result.error || "편집기 명령이 실패했습니다."));
      });
      send({ requestId, command, payload });
    }),
  };
}

/** Authenticated parent frame → fixed original editor operations; no eval. */
export function installMcp(init: Init, handlers: {
  ready(): boolean | Promise<boolean>;
  dirty(): boolean | Promise<boolean>;
  run(request: Exclude<OfficeMcpRequest, { kind: "close" | "status" }>): Promise<unknown>;
  afterReply?(): void;
}) {
  let queue = Promise.resolve(), closing = false;
  listen(message => {
    if (message.type !== "office:mcp") return;
    queue = queue.catch(() => {}).then(async () => {
      const { requestId, request } = message;
      try {
        if (closing || init.readOnly) throw new Error("문서가 닫혔거나 읽기 전용입니다.");
        if (!await handlers.ready()) { post({ type: "office:mcp-result", requestId, reply: { status: "not_ready" } }); return; }
        if (request.kind !== "status" && (officeAiBusy() || officeCopyBusy())) throw new Error("현재 문서의 AI·저장 작업을 마친 뒤 다시 요청해 주세요.");
        let value: unknown;
        if (request.kind === "status") value = { dirty: await handlers.dirty() };
        else if (request.kind === "close") {
          if (!request.discard && await handlers.dirty()) throw new Error("저장 뒤 새 편집이 생겼습니다. 다시 저장하거나 명시적으로 버리고 닫아 주세요.");
          await recovery.discard(init.artifact.id); closing = true; value = { closed: true };
        } else value = await handlers.run(request);
        post({ type: "office:mcp-result", requestId, reply: { status: "ok", result: { value } } });
      } catch (error) {
        post({ type: "office:mcp-result", requestId, reply: { status: "error", error: { reason: "editor_error", message: error instanceof Error ? error.message : String(error) } } });
      } finally { handlers.afterReply?.(); }
    });
  });
}
