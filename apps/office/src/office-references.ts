import type { OfficeAttachment, OfficeReferenceRequest } from "../../../packages/contracts/src/office-references.ts";
import { listen, post } from "./bridge.ts";

let attachments: () => readonly OfficeAttachment[] = () => [];
let pinned: readonly OfficeAttachment[] | null = null;
/** Called by the original files-skill factory through the pinned source adapter. */
export function bindOfficeFiles(get: () => readonly OfficeAttachment[]) {
  attachments = get;
  return () => pinned ?? get();
}

export function createOfficeReferences() {
  attachments = () => []; pinned = null;
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  listen((message) => {
    if (message.type !== "office:references-result") return;
    const request = pending.get(message.requestId);
    if (!request) return;
    pending.delete(message.requestId);
    if (message.error) request.reject(new Error(message.error)); else request.resolve(message.value);
  });
  const call = (input: Omit<Extract<OfficeReferenceRequest, { action: "add" }>, "type" | "requestId"> | Omit<Extract<OfficeReferenceRequest, { action: "read" }>, "type" | "requestId"> | { action: "list" | "pick" }): Promise<unknown> => new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("문서 참조 요청 시간이 초과됐습니다. 다시 선택해 주세요.")); }, input.action === "pick" ? 300_000 : 25_000);
    pending.set(requestId, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    post({ type: "office:references", requestId, ...input });
  });
  return {
    docs: { available: async () => true, list: () => call({ action: "list" }), pick: () => call({ action: "pick" }) },
    desktop: {
      addAttachmentPaths: async (paths: string[]) => {
        try { return await call({ action: "add", paths }); }
        catch (error) { return { accepted: [], rejected: [error instanceof Error ? error.message : String(error)] }; }
      },
      readAttachment: async (path: string, offset = 0, length = 24_000) => {
        try { return await call({ action: "read", path, offset, length }); }
        catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
      },
    },
    pin: () => { pinned = attachments().map((item) => ({ ...item })); return pinned.map((item) => item.path); },
    release: () => { pinned = null; },
  };
}
