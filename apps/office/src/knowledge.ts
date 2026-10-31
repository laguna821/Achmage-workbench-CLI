import { listen, post } from "./bridge.ts";

/** Citation links use the same guarded parent navigation as document tabs. */
export function knowledgeNavigation(session: string | null) {
  const pending = new Map<string, { done(error?: string): void }>();
  listen(message => {
    if (message.type === "office:knowledge-result") pending.get(message.requestId)?.done(message.error);
    if (message.type === "office:grant" && message.sessionId !== session) {
      session = message.sessionId;
      for (const call of pending.values()) call.done("선택한 대화가 바뀌었습니다.");
    }
  });
  return (path: string) => new Promise<{ ok: boolean; error?: string }>(resolve => {
    if (pending.size) { resolve({ ok: false, error: "문서를 열고 있습니다." }); return; }
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => pending.get(requestId)?.done("문서를 여는 시간이 초과됐습니다."), 30000);
    pending.set(requestId, { done(error) {
      clearTimeout(timer); pending.delete(requestId);
      if (error) post({ type: "office:error", message: error });
      resolve(error ? { ok: false, error } : { ok: true });
    } });
    post({ type: "office:knowledge-open", requestId, path });
  });
}
