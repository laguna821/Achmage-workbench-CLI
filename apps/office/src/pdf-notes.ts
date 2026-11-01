import type { PdfNoteAction } from "../../../packages/contracts/src/pdf-notes.ts";
import { listen, post } from "./bridge.ts";

export function noteRequests(ready: () => void = () => {}) {
  const waiting = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  listen(message => {
    if (message.type === "office:note-ready") { ready(); return; }
    if (message.type !== "office:pdf-note-result") return;
    const pending = waiting.get(message.requestId); if (!pending) return;
    waiting.delete(message.requestId);
    if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.value);
  });
  return <T>(action: PdfNoteAction, request?: unknown) => new Promise<T>((resolve, reject) => {
    if (waiting.size > 16) { reject(new Error("노트 요청을 처리 중입니다.")); return; }
    const requestId = crypto.randomUUID(), timer = setTimeout(() => { waiting.delete(requestId); reject(new Error("노트 요청을 마치지 못했습니다.")); }, 600_000);
    waiting.set(requestId, { resolve: value => { clearTimeout(timer); resolve(value as T); }, reject: error => { clearTimeout(timer); reject(error); } });
    post({ type: "office:pdf-note", requestId, action, request });
  });
}
