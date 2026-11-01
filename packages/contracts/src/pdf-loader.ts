export type PdfLoaderStatus = {
  version: string;
  supported: boolean;
  coreReady: boolean;
  ocrReady: boolean;
  state: "idle" | "installing" | "error";
  message: string | null;
  percent: number | null;
};

export type PdfExtractBlock = { page: number; text: string; box: [number, number, number, number] | null; kind: string };
export type PdfExtractResult = { pages: { page: number; text: string }[]; blocks: PdfExtractBlock[]; markdown: string; engine: "opendataloader" };
