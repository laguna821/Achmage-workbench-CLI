import type { PdfRequest, PdfSaveResult } from "../../../packages/contracts/src/pdf.ts";
export function inspectPdf(bytes: Uint8Array, editable?: boolean): Promise<{ pages: number; encrypted: boolean }>;
export function editPdf(bytes: Uint8Array, request: PdfRequest): Promise<{ bytes: Buffer } & Omit<PdfSaveResult, "revision">>;
export function copyPdf(bytes: Uint8Array, request: PdfRequest, redaction?: boolean): Promise<{ bytes: Buffer } & Omit<PdfSaveResult, "revision">>;
export function queryPdf(bytes: Uint8Array, operation: string, request: PdfRequest): Promise<unknown>;
export function transformPdf(bytes: Uint8Array, operation: string, request: PdfRequest): Promise<Buffer>;
export function listEditFonts(): string[];
export function canDrawText(text: string, font?: string, bold?: boolean, italic?: boolean): boolean;
