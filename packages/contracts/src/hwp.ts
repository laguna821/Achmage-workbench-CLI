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

/** A bounded JSON prefix plus raw bytes, avoiding a second base64 document in memory. */
export function encodeHwpSave(metadata: HwpSaveMetadata, bytes: Uint8Array): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(metadata));
  if (json.length > 1_000_000) throw new Error("한글 저장 정보가 너무 큽니다.");
  const buffer = new ArrayBuffer(4 + json.length + bytes.length), out = new Uint8Array(buffer);
  new DataView(buffer).setUint32(0, json.length);
  out.set(json, 4); out.set(bytes, 4 + json.length);
  return buffer;
}
