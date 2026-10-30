import { openXmind, sheetsToOutline } from "../../../vendor/ieumoffice/packages/xmind-engine/src/index.ts";

export const MINDMAP_MAX_BYTES = 200_000_000;

/** Inspect both the opened revision and submitted saves with the original zip/format gate. */
export async function inspectMindmap(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > MINDMAP_MAX_BYTES) return "rejected";
  return (await openXmind(bytes)).status;
}

export async function mindmapText(bytes) {
  if (bytes.byteLength > MINDMAP_MAX_BYTES) throw new Error("마인드맵 파일이 너무 큽니다.");
  const opened = await openXmind(bytes);
  if (opened.status !== "ok") throw new Error(`마인드맵을 읽지 못했습니다: ${opened.status}`);
  return sheetsToOutline(opened.document.sheets);
}
