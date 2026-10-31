import JSZip from "jszip";
import type { OfficeOutputFormat } from "../../../packages/contracts/src/office-output.ts";
import { HttpError } from "./errors.ts";

/** Copy bytes come from each original editor's serializer, never from a stale disk read. */
export async function checkOfficeCopy(bytes: Buffer, format: OfficeOutputFormat) {
  const bad = () => new HttpError(422, "invalid_office_copy", "현재 편집 내용의 파일 형식을 확인하지 못했습니다. 원본은 보존했습니다.");
  if (bytes.length > 200_000_000) throw new HttpError(413, "office_copy_large", "저장할 사본이 200MB를 넘습니다.");
  if (["md", "markdown", "html", "htm"].includes(format)) {
    try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw bad(); }
    return;
  }
  if (format === "pdf") {
    if (!bytes.subarray(0, 8).toString().startsWith("%PDF-")) throw bad();
    return;
  }
  if (format === "xmind") {
    const { inspectMindmap } = await import("./mindmap-ops.mjs");
    if (await inspectMindmap(bytes) !== "ok") throw bad();
    return;
  }
  if (format === "epub") {
    const { openEpubSession } = await import("./epub-ops.mjs");
    const opened = await openEpubSession(bytes);
    if (!opened.ok || opened.session.bookReadOnly()) throw bad();
    return;
  }
  const main = format === "docx" ? "word/document.xml" : format === "pptx" ? "ppt/presentation.xml" : ["xlsx", "xlsm"].includes(format) ? "xl/workbook.xml" : null;
  if (!main) throw bad(); // HWP/HWPX use the separate preservation codec.
  try {
    const zip = await JSZip.loadAsync(bytes);
    if (!zip.file("[Content_Types].xml") || !zip.file("_rels/.rels") || !zip.file(main)) throw bad();
    if (format === "xlsx" && zip.file("xl/vbaProject.bin")) throw new HttpError(422, "office_copy_macros", "매크로가 있는 문서는 .xlsm 확장자를 유지해 주세요.");
  } catch (error) { if (error instanceof HttpError) throw error; throw bad(); }
}
