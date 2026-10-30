/** A bounded request followed by optional working-copy bytes. No renderer file path is used for IO. */
export const PDF_MAX_BYTES = 200_000_000;
export const PDF_REQUEST_MAX_BYTES = 80_000_000;
export type PdfRequest = Record<string, unknown>;
export type PdfSaveResult = {
  revision: number;
  skippedTextEdits: { editIndex: number; pageIndex: number; reason: string }[];
  skippedTextInserts: { editIndex: number; pageIndex: number; reason: string }[];
  skippedImageEdits: { editIndex: number; pageIndex: number; reason: string }[];
};
export function encodePdfRequest(request: PdfRequest, bytes?: ArrayBuffer): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(request));
  if (json.length > PDF_REQUEST_MAX_BYTES || (bytes?.byteLength ?? 0) > PDF_MAX_BYTES) throw new Error("PDF 처리 용량 한도를 넘었습니다.");
  const buffer = new ArrayBuffer(4 + json.length + (bytes?.byteLength ?? 0));
  new DataView(buffer).setUint32(0, json.length);
  new Uint8Array(buffer).set(json, 4);
  if (bytes) new Uint8Array(buffer).set(new Uint8Array(bytes), 4 + json.length);
  return buffer;
}
