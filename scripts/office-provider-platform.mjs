import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const source = fileURLToPath(new URL('../vendor/ieumoffice/packages/ai-provider/src/', import.meta.url)).replaceAll('\\', '/');
const locator = `${source}subscription/locate`;
const adapter = fileURLToPath(new URL('../apps/host/src/office-subscription-locate.mjs', import.meta.url));

/** Only original provider imports are redirected; the adapter can import the original. */
export function officeProviderResolve(specifier, importer = '') {
  importer = importer.replaceAll('\\', '/');
  if (!importer.startsWith(source) || !specifier.startsWith('.')) return null;
  const target = resolve(dirname(importer), specifier).replaceAll('\\', '/').replace(/\.ts$/, '');
  return target === locator ? adapter : null;
}

export function officeProviderHostPlugin() {
  return { name: 'workbench-office-provider-platform', setup(build) {
    build.onResolve({ filter: /locate(?:\.ts)?$/ }, ({ path, importer }) => {
      const resolved = officeProviderResolve(path, importer);
      return resolved ? { path: resolved } : null;
    });
  } };
}
