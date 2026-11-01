import { cancelOutput, commitOutput, prepareOutput } from "./output.ts";
import { confirmOdtReport, exportOdt, type ExportResult, type ReportDialog } from "./text-word-engine.mjs";
import type { OfficeOutputPlan } from "../../../packages/contracts/src/office-output.ts";

/** The original report asks before a lossy conversion is written. Render its text
 * as text nodes in the trusted editor; document HTML cannot supply this dialog. */
function showReport(options: ReportDialog): Promise<{ response: number }> {
  return new Promise(resolve => {
    const dialog = document.createElement("dialog");
    dialog.className = "workbench-export-report";
    dialog.style.cssText = "max-width:520px;max-height:80vh;padding:24px;border:1px solid #bbb;border-radius:12px;overflow:auto;color:#222;background:#fff;font:14px system-ui";
    const title = document.createElement("h2"); title.textContent = options.title ?? "ODT로 내보내기";
    const message = document.createElement("p"); message.textContent = options.message;
    const detail = document.createElement("p"); detail.style.whiteSpace = "pre-wrap"; detail.textContent = options.detail ?? "";
    const footer = document.createElement("div"); footer.style.cssText = "display:flex;justify-content:flex-end;gap:12px";
    let response = options.cancelId ?? 1;
    for (const [index, label] of (options.buttons ?? ["저장", "취소"]).entries()) {
      const button = document.createElement("button"); button.type = "button"; button.textContent = label;
      button.style.cssText = "font:inherit;padding:8px 16px;cursor:pointer";
      button.onclick = () => { response = index; dialog.close(); };
      footer.append(button);
    }
    dialog.append(title, message, detail, footer);
    dialog.onclose = () => { dialog.remove(); resolve({ response }); };
    document.body.append(dialog); dialog.showModal();
    (footer.children[options.cancelId ?? 1] as HTMLButtonElement | undefined)?.focus();
  });
}

/** Both text editors export their own live Word bytes. ODT uses those same bytes. */
export async function exportTextWord(revision: number, format: "docx" | "odt", docx: () => Promise<Uint8Array>, open = false): Promise<ExportResult> {
  let plan: OfficeOutputPlan | null = null;
  const pick = async () => { plan = await prepareOutput(revision, format); return plan?.path ?? null; };
  const write = async (_path: string, bytes: Uint8Array) => {
    if (!plan) throw new Error("내보낼 위치를 다시 선택해 주세요.");
    await commitOutput(plan.id, Uint8Array.from(bytes).buffer, open ? "open" : "export");
  };
  try {
    if (format === "odt") return await exportOdt({ pickPath: pick, docx, confirm: report => confirmOdtReport(report, showReport, "ko"), write });
    const path = await pick(); if (!path) return { ok: true, canceled: true };
    await write(path, await docx()); return { ok: true, path };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  finally { if (plan) await cancelOutput((plan as OfficeOutputPlan).id).catch(() => {}); }
}

export function markdownWordBytes(base64: string): Uint8Array {
  if (typeof base64 !== "string" || !base64 || base64.length > 267_000_000) throw new Error("내보낼 Word 문서의 크기나 내용을 확인해 주세요.");
  return Uint8Array.from(atob(base64), char => char.charCodeAt(0));
}
