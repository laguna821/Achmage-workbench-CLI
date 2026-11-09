import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { readFileSync, cpSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pdfHostPlugin } from './pdf-platform.mjs';
import { officeProviderHostPlugin } from './office-provider-platform.mjs';
import { officeFileParsePlugin } from './office-file-parse-platform.mjs';
import { extensionRuntimeExternals, copyExtensionRuntimeAssets } from '../extension-runtime/package-assets.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
await import('./emit-paseo-host.mjs');
const pin = readFileSync(new URL('../vendor/ieumoffice.PINNED', import.meta.url), 'utf8').match(/^commit: (.+)$/m)?.[1];
if (execFileSync('git', ['-C', `${root}vendor/ieumoffice`, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== pin) throw new Error('Ieum source differs from the reviewed pin');
await build({
  absWorkingDir: root,
  entryPoints: { 'voice-worker': 'vendor/paseo/voice-server/src/server/speech/providers/local/worker-process.ts', 'workbench-service': 'apps/host/src/daemon/cli.ts', host: 'apps/host/src/main.ts', 'hwp-cli': 'apps/host/src/hwp-cli.ts', 'office-reveal': 'apps/host/src/office-reveal.mjs', 'ieum-setup': 'apps/host/src/ieum-setup.ts', 'cleanup-legacy': 'apps/host/src/cleanup-legacy.ts', 'pdf-structure-job': 'apps/host/src/pdf-structure-job.mjs', 'workbench-client': 'packages/client/src/cli.ts', 'workbench-mcp': 'packages/client/src/mcp.ts' },
  outdir: process.env.WORKBENCH_HOST_BUILD_DIR ?? 'apps/host/dist', outExtension: { '.js': '.mjs' },
  external: extensionRuntimeExternals,
  bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'warning',
  define: {
    __WORKBENCH_GOOGLE_CLIENT_ID__: JSON.stringify(process.env.WORKBENCH_GOOGLE_CLIENT_ID ?? ''),
    __WORKBENCH_GOOGLE_CLIENT_SECRET__: JSON.stringify(process.env.WORKBENCH_GOOGLE_CLIENT_SECRET ?? ''),
  },
  plugins: [pdfHostPlugin(), officeProviderHostPlugin(), officeFileParsePlugin()],
  banner: { js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" },
});

await copyExtensionRuntimeAssets(process.env.WORKBENCH_HOST_BUILD_DIR ?? "apps/host/dist");

// Official import-only installer; preserves its Apache notice and package-relative helpers.
const desktopInstallerTarget = resolve(root, process.env.WORKBENCH_HOST_BUILD_DIR ?? "apps/host/dist", "node_modules/@workbench/agent-desktop-installer");
mkdirSync(desktopInstallerTarget, { recursive: true });
cpSync(`${root}vendor/agent-desktop/npm`, desktopInstallerTarget, { recursive: true });
