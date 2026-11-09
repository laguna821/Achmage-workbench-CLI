import type { OfficeOutputRequest } from "../../../packages/contracts/src/office-output.ts";
type Services = {
  request(body: Record<string, unknown>): Promise<any>;
  commit(message: Extract<OfficeOutputRequest, { action: "commit" }>): Promise<unknown>;
  native(requestId: string, command: Record<string, unknown>): Promise<any>;
  wait(): Promise<void>;
};
const decode = (base64: string) => Uint8Array.from(atob(base64), value => value.charCodeAt(0)).buffer;
/** The original renderer supplies its original SVG/HTML/browser job. Only the
 * host can choose an output path, and only the native parent can render it. */
export function createExecutorOutput(services: Services) {
  const request = async (body: Record<string, unknown>) => {
    for (;;) { const value = await services.request(body); if (!value?.pending) return value; await services.wait(); }
  };
  return async (message: OfficeOutputRequest): Promise<any> => {
    const native = (kind: string, value: Record<string, unknown>) => services.native(message.requestId, { kind, ...value });
    if (message.action === "prepare" || message.action === "cancel") return request(message);
    if (message.action === "commit") return services.commit(message);
    if (message.action === "browser") return native("browser", { command: message.command });
    if (message.action === "html-render") return decode((await native("html-pdf", { job: message.job })).base64);
    if (message.action === "print" || message.action === "html-print") {
      const answer = await request({ action: "native-confirm", requestId: message.requestId, kind: "print" });
      if (!answer?.accepted) return null;
      await native(message.action === "print" ? "svg-print" : "html-print", { job: message.job });
      return null;
    }
    if (message.action === "pdf" || message.action === "html-pdf") {
      const plan = await request({ action: "prepare", requestId: message.requestId, revision: message.revision, format: "pdf" });
      if (!plan) return null;
      try {
        const value = await native(message.action === "pdf" ? "svg-pdf" : "html-pdf", { job: message.job });
        return await services.commit({ type: "office:output", requestId: message.requestId, action: "commit", planId: plan.id,
          sourceRevision: message.revision, bytes: decode(value.base64), intent: "export" });
      } catch (error) { await request({ action: "cancel", planId: plan.id }).catch(() => {}); throw error; }
    }
    if (message.action === "images-prepare") {
      const { job, ...body } = message, plan = await request(body);
      if (!plan) return null;
      try { return { id: plan.id, pdfBase64: (await native("html-pdf", { job })).base64 }; }
      catch (error) { await request({ action: "images-finish", id: plan.id, success: false }).catch(() => {}); throw error; }
    }
    if (["images-write", "images-finish", "pdf-images-prepare", "pdf-images-write", "pdf-images-finish"].includes(message.action)) return request(message);
    throw new Error("파일 열기·폴더 표시·발표 창은 Workbench 문서 목록에서 실행해 주세요. 독립 실행기의 출력 기록에서 저장한 결과 경로를 확인할 수 있습니다.");
  };
}
