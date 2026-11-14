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
export type HwpSaveMetadata = { tabs?: MeasuredTab[]; memos?: MemoSnapshot[] | null; structure?: HwpStructure | null };
export type SaveMode = "save" | "saveAs";
/** The save-flow subset of Ieum's preload contract; excludes Electron and AI provider types. */
export type HwpSaveApi = {
  beginSave(mode: SaveMode): Promise<{ ok: true; path: string; format: HwpFormat } | { ok: true; canceled: true } | { ok: false; error: string; reason?: "tracked" | "memo" }>;
  newTabs(bytes: Uint8Array, format: HwpFormat): Promise<TabSpot[]>;
  commitSave(bytes: Uint8Array, tabs?: MeasuredTab[], options?: { auto?: boolean; memos?: MemoSnapshot[] | null; structure?: HwpStructure | null }): Promise<{ ok: true; path: string; backupPath?: string; tailsLost?: true; memosLost?: number } | { ok: false; error: string }>;
  abortSave(): void;
};

/** A bounded JSON prefix plus raw bytes, avoiding a second base64 document in memory. */
export function encodeHwpSave(metadata: HwpSaveMetadata, bytes: Uint8Array): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(metadata));
  if (json.length > 1_000_000) throw new Error("한글 저장 정보가 너무 큽니다.");
  const buffer = new ArrayBuffer(4 + json.length + bytes.length), out = new Uint8Array(buffer);
  new DataView(buffer).setUint32(0, json.length);
  out.set(json, 4); out.set(bytes, 4 + json.length);
  return buffer;
}
