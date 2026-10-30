import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pdfHostPlugin } from './pdf-platform.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const pin = readFileSync(new URL('../vendor/ieumoffice.PINNED', import.meta.url), 'utf8').match(/^commit: (.+)$/m)?.[1];
if (execFileSync('git', ['-C', `${root}vendor/ieumoffice`, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== pin) throw new Error('Ieum source differs from the reviewed pin');
await build({
  absWorkingDir: root,
  entryPoints: { host: 'apps/host/src/main.ts', 'hwp-cli': 'apps/host/src/hwp-cli.ts' },
  outdir: 'apps/host/dist', outExtension: { '.js': '.mjs' },
  bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'warning',
  plugins: [pdfHostPlugin()],
  banner: { js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" },
});
