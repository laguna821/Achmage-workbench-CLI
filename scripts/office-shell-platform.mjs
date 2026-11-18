// The gateway bundles IeumOffice's in-app MCP CLI runner (apps/shell/src/main/mcp/cli-runner.ts). Since v0.13.0 it
// takes decodeChunksUtf8 from the electron-utils barrel, whose other modules import Electron itself (drop-open.ts,
// renderer-protocol.ts): the gateway takes the one module that defines it (console-output.ts), as the barrel does.
import { fileURLToPath } from 'node:url';
const runner = fileURLToPath(new URL('../vendor/ieumoffice/apps/shell/src/main/mcp/cli-runner.ts', import.meta.url)).replaceAll('\\', '/');
const consoleOutput = fileURLToPath(new URL('../vendor/ieumoffice/packages/electron-utils/src/console-output.ts', import.meta.url));
export function officeShellResolve(source, importer = '') {
  return source === '@genoffice/electron-utils' && importer.replaceAll('\\', '/') === runner ? consoleOutput : null;
}
export function officeShellHostPlugin() {
  return { name: 'workbench-office-shell-platform', setup(build) {
    build.onResolve({ filter: /^@genoffice\/electron-utils$/ }, ({ path, importer }) => {
      const resolved = officeShellResolve(path, importer);
      return resolved ? { path: resolved } : null;
    });
  } };
}
