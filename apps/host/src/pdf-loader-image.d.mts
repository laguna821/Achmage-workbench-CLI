import type { PdfLoader } from "./pdf-loader.ts";
export function ocrPdfImage(loader: PdfLoader, png: unknown): Promise<{ text: string; confidence: number; box: number[] }[] | null>;
