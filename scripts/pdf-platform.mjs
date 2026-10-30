import { fileURLToPath } from 'node:url';
const pdfMain = fileURLToPath(new URL('../vendor/ieumoffice/apps/pdf/src/main/', import.meta.url)).replaceAll('\\', '/');
const host = (file) => fileURLToPath(new URL(`../apps/host/src/${file}`, import.meta.url));
export function pdfPlatformResolve(source, importer = '') {
  importer = importer.replaceAll('\\', '/');
  if (!importer.startsWith(pdfMain)) return null;
  if (source === './wasm-path') return host('pdf-resource.mjs');
  if (source === 'electron' && importer === `${pdfMain}image-edit.ts`) return host('pdf-image-codec.mjs');
  return null;
}
export function pdfHostPlugin() {
  return { name: 'workbench-pdf-platform', setup(build) {
    build.onResolve({ filter: /^(electron|\.\/wasm-path)$/ }, ({ path, importer }) => {
      const resolved = pdfPlatformResolve(path, importer);
      return resolved ? { path: resolved } : null;
    });
  } };
}
