import type { HwpStructure } from "../../../packages/contracts/src/hwp.ts";
import { hwpStructureOf, type HwpStructureSource } from "../../../packages/contracts/src/hwp-structure.ts";

// The built rhwp-studio exposes its command automation; its dispatcher's services hold the
// WasmBridge whose `doc` is the engine document the editor shows (rhwp-studio main.ts).
type StudioWindow = { rhwpStudio?: { automation?: { options?: { dispatcher?: { services?: { wasm?: { doc?: HwpStructureSource | null } } } } } } };

/** The studio's live structure, or why there is none (said once in the console; the save then goes without a report). */
export type StudioReport = { structure: HwpStructure } | { why: string };

/**
 * What the studio's LIVE document holds — after the person's edits and deletions, not what an
 * export wrote — counted by the same function the gateway counts the saved bytes with. When the
 * text census alone fails, the structure carries `textUnchecked` (S1). When the studio does not
 * expose its document, or it cannot be counted at all, `why` says which (never engine text).
 */
export function studioReport(given?: HTMLIFrameElement | null): StudioReport {
  let doc: HwpStructureSource | null | undefined;
  try {
    const frame = given === undefined ? document.querySelector<HTMLIFrameElement>(".hwp-editor-host iframe") : given;
    doc = (frame?.contentWindow as StudioWindow | null | undefined)?.rhwpStudio?.automation?.options?.dispatcher?.services?.wasm?.doc;
  } catch { doc = null; }
  if (!doc) return { why: "the studio's document is not reachable" };
  try { return { structure: hwpStructureOf(doc) }; }
  catch (error) { return { why: `the studio's document could not be counted (${error instanceof Error ? error.name : typeof error})` }; }
}

/** The structure alone (null without one). The build and census checks read `studioReport` (scripts/hwp-studio-harness.ts) to say why there is none. */
export function studioStructure(given?: HTMLIFrameElement | null): HwpStructure | null {
  const report = studioReport(given);
  return "structure" in report ? report.structure : null;
}
