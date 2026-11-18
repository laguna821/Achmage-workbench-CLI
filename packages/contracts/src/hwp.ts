/** Ieum HWP save metadata, kept independent of its Electron/AI preload types. */
import type { HwpTextCounts } from "./hwp-text.ts";
export type HwpFormat = "hwp" | "hwpx";
export type TabSpot = { sec: number; para: number; cells: { table: number; cell: number; para: number }[]; tab: number; tabs: number };
export type TabMeasure = { width: number; type: number; fill: number };
export type MeasuredTab = TabSpot & TabMeasure;
export type MemoSnapshot = {
  author: string; date: string | null; text: string; place: string;
  sectionIndex: number | null; paraIndex: number | null; startCharIdx: number | null; endCharIdx: number | null;
  path: { type: "cell" | "textbox"; controlIndex: number; cellIndex?: number; paraIndex: number }[] | null;
};
/**
 * What a Hangul document holds (apps/host/src/hwp-structure.ts counts it). Sent with a save, it is
 * what the editor's live document holds at export time, so a deliberate deletion is not a loss.
 */
export type HwpStructure = {
  sections: number;
  /** top-level paragraphs per section */
  paragraphs: number[];
  /** controls anywhere in the document (tables in cells and text boxes too), by kind */
  objects: Record<string, number>;
  /** fields by type (click-here, form…); memo fields are counted as `memos` */
  fields: Record<string, number>;
  memos: number;
  /** paragraph numbering / outline definitions, and styles */
  numberings: number;
  styles: number;
  /** the font names the document's text uses */
  fonts: string[];
  /** characters per container kind (body, table cells, text boxes, notes, headers, footers, memos — packages/contracts/src/hwp-text.ts); absent when the text census could not be computed */
  chars?: HwpTextCounts;
  /** sha256 over all that text in a fixed walking order (never the text); not a refusal reason */
  textSha256?: string;
  /** containers the text census cannot read, counted per kind (packages/contracts/src/hwp-text.ts `HWP_UNREAD_LABELS`); a drop is a loss. With `chars`. */
  unread?: Record<string, number>;
  /** set instead of `chars`/`textSha256`/`unread` when the text census could not be computed: the step and error kind, never document text */
  textUnchecked?: string;
};
/**
 * What other programs show of a file without opening it: its first lines and first page (IeumOffice
 * v0.13.0, decision 0146). A save writes the preview of the document as it is now over the one the
 * engine carried from the opened file, so text deleted since does not stay in the file.
 */
export type SavePreview = {
  /** the text, lines ended by CR LF, table rows as `<cell><cell>` as Hangul writes them */
  text: string;
  /** the first page as PNG, or null when it could not be drawn */
  image: Uint8Array | null;
};
/** The largest preview picture taken (IeumOffice's MAX_PREVIEW_IMAGE_BYTES); a larger one goes as none (a blank picture). */
export const HWP_PREVIEW_IMAGE_MAX = 4 * 1024 * 1024;
/** Characters of preview text sent; Hangul keeps 1,022 (the gateway cuts it there). */
export const HWP_PREVIEW_TEXT_MAX = 4096;
/** A save's preview as it travels in the JSON prefix: the picture as base64. */
export type HwpSavePreviewWire = { text: string; image: string | null };
/** `preview`: null = the editor could not make one (a blank one is written, never the stale one); absent = keep the file's (a recovery copy). */
export type HwpSaveMetadata = { tabs?: MeasuredTab[]; memos?: MemoSnapshot[] | null; structure?: HwpStructure | null; preview?: HwpSavePreviewWire | null };
/** The JSON prefix's cap: the metadata (1 MB) and a preview picture as base64. */
export const HWP_SAVE_METADATA_MAX = 1_000_000 + Math.ceil(HWP_PREVIEW_IMAGE_MAX / 3) * 4 + HWP_PREVIEW_TEXT_MAX * 4 + 1024;

function base64Of(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
/** The preview for the wire: the text cut to the cap, a picture over the cap sent as none. */
export function hwpPreviewWire(preview: SavePreview | null): HwpSavePreviewWire | null {
  if (!preview || typeof preview.text !== "string") return null;
  const image = preview.image instanceof Uint8Array && preview.image.length > 0 && preview.image.length <= HWP_PREVIEW_IMAGE_MAX ? base64Of(preview.image) : null;
  return { text: Array.from(preview.text).slice(0, HWP_PREVIEW_TEXT_MAX).join(""), image };
}
export type SaveMode = "save" | "saveAs";
/** The save-flow subset of Ieum's preload contract; excludes Electron and AI provider types. */
export type HwpSaveApi = {
  /** `export: "pdf"`: Save As picked PDF; nothing is saved, the renderer writes the PDF copy to `path` (v0.13.0) */
  beginSave(mode: SaveMode): Promise<{ ok: true; path: string; format: HwpFormat } | { ok: true; path: string; export: "pdf" } | { ok: true; canceled: true } | { ok: false; error: string; reason?: "tracked" | "memo" }>;
  newTabs(bytes: Uint8Array, format: HwpFormat): Promise<TabSpot[]>;
  commitSave(bytes: Uint8Array, tabs?: MeasuredTab[], options?: { auto?: boolean; memos?: MemoSnapshot[] | null; structure?: HwpStructure | null; preview?: SavePreview | null }): Promise<{ ok: true; path: string; backupPath?: string; tailsLost?: true; memosLost?: number } | { ok: false; error: string }>;
  abortSave(): void;
};

/** A bounded JSON prefix plus raw bytes, avoiding a second base64 document in memory. */
export function encodeHwpSave(metadata: HwpSaveMetadata, bytes: Uint8Array): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(metadata));
  if (json.length > HWP_SAVE_METADATA_MAX) throw new Error("한글 저장 정보가 너무 큽니다.");
  const buffer = new ArrayBuffer(4 + json.length + bytes.length), out = new Uint8Array(buffer);
  new DataView(buffer).setUint32(0, json.length);
  out.set(json, 4); out.set(bytes, 4 + json.length);
  return buffer;
}
