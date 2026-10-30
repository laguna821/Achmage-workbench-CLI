import { PDF_MAX_BYTES, PDF_REQUEST_MAX_BYTES, type PdfRequest } from "../../../packages/contracts/src/pdf.ts";
import { HttpError } from "./errors.ts";

export function decodePdfRequest(body: Buffer): { request: PdfRequest; source: Buffer | null } {
  const bad = () => new HttpError(422, "invalid_pdf_request", "PDF 처리 요청이 올바르지 않습니다.");
  if (body.length < 6) throw bad();
  const length = body.readUInt32BE(0);
  if (length < 2 || length > PDF_REQUEST_MAX_BYTES || length + 4 > body.length || body.length - length - 4 > PDF_MAX_BYTES) throw bad();
  let request: unknown;
  try { request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.subarray(4, length + 4))); } catch { throw bad(); }
  if (!request || typeof request !== "object" || Array.isArray(request)) throw bad();
  return { request: request as PdfRequest, source: body.length === length + 4 ? null : body.subarray(length + 4) };
}
