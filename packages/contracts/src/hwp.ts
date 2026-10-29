/** Ieum HWP save metadata, kept independent of its Electron/AI preload types. */
export type HwpFormat = "hwp" | "hwpx";
export type TabSpot = { sec: number; para: number; cells: { table: number; cell: number; para: number }[]; tab: number; tabs: number };
export type TabMeasure = { width: number; type: number; fill: number };
export type MeasuredTab = TabSpot & TabMeasure;
export type MemoSnapshot = {
  author: string; date: string | null; text: string; place: string;
  sectionIndex: number | null; paraIndex: number | null; startCharIdx: number | null; endCharIdx: number | null;
  path: { type: "cell" | "textbox"; controlIndex: number; cellIndex?: number; paraIndex: number }[] | null;
};
export type HwpSaveMetadata = { tabs?: MeasuredTab[]; memos?: MemoSnapshot[] | null };
export type SaveMode = "save" | "saveAs";
/** The save-flow subset of Ieum's preload contract; excludes Electron and AI provider types. */
export type HwpSaveApi = {
  beginSave(mode: SaveMode): Promise<{ ok: true; path: string; format: HwpFormat } | { ok: true; canceled: true } | { ok: false; error: string; reason?: "tracked" | "memo" }>;
  newTabs(bytes: Uint8Array, format: HwpFormat): Promise<TabSpot[]>;
  commitSave(bytes: Uint8Array, tabs?: MeasuredTab[], options?: { auto?: boolean; memos?: MemoSnapshot[] | null }): Promise<{ ok: true; path: string; backupPath?: string; tailsLost?: true; memosLost?: number } | { ok: false; error: string }>;
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
