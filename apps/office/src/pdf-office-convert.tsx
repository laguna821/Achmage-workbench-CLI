import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PasswordDialog } from "@ieum/apps/pdf/src/renderer/PasswordDialog.tsx";
import { LocaleProvider } from "@ieum/apps/pdf/src/renderer/i18n/locale.tsx";
import type { Gateway, Init } from "./bridge.ts";
import { cancelOutput, commitGeneratedOutput, openExport, prepareOutput } from "./output.ts";

type Outcome = { ok: boolean; error?: string; message?: string; generatedId?: string; scannedDocument?: boolean; pageResults?: { page: number; status: string }[] };
function Password({ name, wrong, answer }: { name: string; wrong: boolean; answer(value: string | null): void }) {
  const [value, setValue] = useState("");
  return <PasswordDialog fileName={name} value={value} wrong={wrong} onChange={setValue} onSubmit={() => answer(value)} onCancel={() => answer(null)} />;
}

/** The original converters stay in a child process. The parent owns output selection/publication. */
export function pdfOfficeConvert(init: Init, gateway: Gateway, revision: () => number, flush: () => Promise<boolean>) {
  const instance = crypto.randomUUID(); let busy = false, stop = () => {};
  window.addEventListener("pagehide", () => { stop(); void gateway.closePdfStructure(init.artifact.id, instance); });
  return async (format: unknown) => {
    if (format !== "docx" && format !== "pptx" && format !== "xlsx") throw new Error("변환할 문서 형식을 확인해 주세요.");
    if (busy) throw new Error("이미 문서 변환이 진행 중입니다.");
    busy = true;
    let plan: Awaited<ReturnType<typeof prepareOutput>> = null, root: ReturnType<typeof createRoot> | null = null, node: HTMLDivElement | null = null;
    let jobId: string | null = null, canceled = false, answer: ((value: string | null) => void) | null = null;
    const title = `PDF → ${{ docx: "Word", pptx: "PowerPoint", xlsx: "Excel" }[format]}`;
    let snapshot = revision();
    const call = (operation: string, args: unknown[], progress: (value: unknown) => void = () => {}) => gateway.pdfStructure<Outcome>(init.artifact.id, snapshot, instance, operation, args, progress);
    const cancel = () => { canceled = true; answer?.(null); if (jobId) void call("cancel", [jobId]).catch(() => {}); };
    stop = cancel;
    const show = (text: string, waiting = false) => root!.render(<LocaleProvider initial="ko"><div className="pdf-modal-mask" onKeyDown={e => { e.stopPropagation(); if (e.key === "Escape") cancel(); }}>
      <div className="pdf-modal" role="dialog" aria-modal="true" aria-label={title}><h2>{title}</h2><p role="status" style={{ whiteSpace: "pre-wrap" }}>{text}</p><div className="pdf-modal-actions">
        <button autoFocus className="pdf-modal-btn" onClick={() => waiting ? answer?.("") : cancel()}>{waiting ? "확인" : "취소"}</button>
      </div></div></div></LocaleProvider>);
    try {
      if (!(await flush())) return false;
      snapshot = revision();
      plan = await prepareOutput(snapshot, format, crypto.randomUUID(), { defaultName: init.artifact.name.replace(/\.pdf$/i, `.${format}`), longJob: true });
      if (!plan || canceled) return false;
      node = document.createElement("div"); node.dataset.pdfOfficeConversion = format; document.body.append(node); root = createRoot(node);
      let password: string | undefined, result: Outcome;
      while (true) {
        if (canceled) return false;
        jobId = `office-${crypto.randomUUID()}`;
        show("문서를 변환하고 있습니다…");
        result = await call("convert-office", [{ path: init.artifact.path, format, jobId, ...(password === undefined ? {} : { password }) }], value => {
          const progress = value as { done?: number; total?: number };
          if (!canceled) show(`문서를 변환하고 있습니다… ${progress.done ?? 0}/${progress.total ?? 0}쪽`);
        });
        jobId = null;
        if (canceled || result.error === "cancelled") return false;
        if (result.ok) break;
        if (result.error !== "password-required") throw new Error(result.message || "문서 변환에 실패했습니다.");
        const next = await new Promise<string | null>(resolve => {
          answer = resolve;
          root!.render(<LocaleProvider initial="ko"><div onKeyDown={e => { e.stopPropagation(); if (e.key === "Escape") cancel(); }}><Password key={crypto.randomUUID()} name={init.artifact.name} wrong={password !== undefined} answer={resolve} /></div></LocaleProvider>);
        });
        answer = null; if (next === null) return false; password = next;
      }
      if (!result.generatedId) throw new Error("변환 결과를 받지 못했습니다.");
      const saved = await commitGeneratedOutput(plan.id, result.generatedId, snapshot); plan = null;
      const pages = result.pageResults ?? [], warnings: string[] = [];
      const affected = pages.filter(page => page.status !== "ok" && (format !== "docx" || page.status !== "ocr")).map(page => page.page);
      const ocr = pages.filter(page => page.status === "ocr").map(page => page.page);
      if (result.scannedDocument) warnings.push(format === "xlsx" ? "스캔 페이지는 셀로 변환할 수 없어 각 시트에 안내 행을 넣었습니다." : "스캔 문서입니다. 페이지를 이미지로 내보냈으므로 이미지 속 텍스트는 편집할 수 없습니다.");
      else if (affected.length) warnings.push(format === "xlsx" ? `${affected.join(", ")}쪽은 셀로 변환하지 못해 해당 시트에 안내 행을 넣었습니다.` : `${affected.join(", ")}쪽은 레이아웃을 유지하기 위해 페이지 이미지로 내보냈습니다.`);
      if (format === "docx" && ocr.length) warnings.push(`${ocr.join(", ")}쪽은 로컬 OCR로 텍스트를 복원했습니다. 결과를 검토해 주세요.`);
      if (warnings.length) {
        await new Promise<string | null>(resolve => { answer = resolve; show(warnings.join("\n\n"), true); }); answer = null;
      }
      if (!canceled) await openExport(saved.path);
      return true;
    } finally {
      if (plan) await cancelOutput(plan.id).catch(() => {});
      root?.unmount(); node?.remove(); busy = false; stop = () => {};
    }
  };
}
