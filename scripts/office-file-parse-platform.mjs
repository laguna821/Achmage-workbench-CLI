import { fileURLToPath } from 'node:url';
const parser = fileURLToPath(new URL('../vendor/ieumoffice/packages/file-parse/src/parse.ts', import.meta.url));
export function officeFileParseResolve(path, importer) {
  if (importer === parser && path === './hwp') return fileURLToPath(new URL('../third_party/ieumoffice/file-parse/hwp.ts', import.meta.url));
  return null;
}
export function officeFileParsePlugin() {
  return { name: 'workbench-office-file-parse', setup(build) {
    build.onResolve({ filter: /^\.\/hwp$/ }, ({ path, importer }) => {
      const resolved = officeFileParseResolve(path, importer);
      return resolved ? { path: resolved } : null;
    });
  } };
}
