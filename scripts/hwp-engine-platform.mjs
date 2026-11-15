// Ieum's vendored code that Workbench bundles or tests (its CLI's document AI, packages/cli/src/formats/
// hwp-edit.ts; its file parser and memo reader) imports the engine as '@rhwp/core', which resolves to
// Ieum's own engine build (vendor/ieumoffice/vendor/rhwp-core). Workbench runs ONE engine
// (third_party/hop/engine.ts) and hands that code its WASM (GENOFFICE_RHWP_WASM): the JavaScript that
// drives the WASM must be the same build's, or the WASM does not even load (rhwp 0.9.0 against Ieum's
// 0.8.7 glue: "LinkError … function import requires a callable"). Every '@rhwp/core' import from
// vendor/ieumoffice/ resolves to the selector instead (H4b).
import { fileURLToPath } from 'node:url';
const engine = fileURLToPath(new URL('../third_party/hop/engine.ts', import.meta.url));
export function hwpEngineResolve(source, importer = '') {
  if (source !== '@rhwp/core' || !importer) return null;
  return importer.replaceAll('\\', '/').includes('/vendor/ieumoffice/') ? engine : null;
}
export function hwpEnginePlugin() {
  return { name: 'workbench-hwp-engine', setup(build) {
    build.onResolve({ filter: /^@rhwp\/core$/ }, ({ path, importer }) => {
      const resolved = hwpEngineResolve(path, importer);
      return resolved ? { path: resolved } : null;
    });
  } };
}
