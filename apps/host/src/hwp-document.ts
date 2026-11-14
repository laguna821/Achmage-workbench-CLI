/**
 * One Hangul document opened with the repository's engine (the same build Ieum's text reader in
 * third_party/ieumoffice/file-parse/hwp.ts loads, which stays exactly as generated), freed when
 * `use` returns. The save fingerprint and the proposal check count what a file holds with it.
 */
import { readFileSync } from "node:fs";
import { assertZipInflatesWithinLimits } from "../../../third_party/ieumoffice/zip-gate/index.ts";
import { hwpWasmPath } from "./hwp-resource.ts";

type Engine = typeof import("../../../third_party/hop/rhwp-core/rhwp.js");
export type HwpEngineDocument = InstanceType<Engine["HwpDocument"]>;

let engine: Promise<Engine> | null = null;
function loadEngine(): Promise<Engine> {
  if (!engine) {
    const loading = (async () => {
      const mod = await import("../../../third_party/hop/rhwp-core/rhwp.js");
      // wasm-bindgen keeps one instance per module: a second init (Ieum's reader) reuses it
      await mod.default({ module_or_path: readFileSync(hwpWasmPath()) });
      return mod;
    })();
    engine = loading;
    loading.catch(() => { if (engine === loading) engine = null; });
  }
  return engine;
}

export async function withHwpDocument<T>(bytes: Uint8Array, use: (doc: HwpEngineDocument) => T): Promise<T> {
  // HWPX is a zip the engine inflates itself: the same gate as every other reader first
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) await assertZipInflatesWithinLimits(bytes);
  const { HwpDocument } = await loadEngine();
  let doc: HwpEngineDocument;
  try { doc = new HwpDocument(new Uint8Array(bytes)); }
  catch (thrown) { throw new Error(`Could not read the HWP document: ${thrown instanceof Error ? thrown.message : String(thrown)}`); }
  try { return use(doc); } finally { doc.free(); }
}
