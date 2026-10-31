// Pinned, Electron-free document asset helpers; Workbench policy stays in its host adapter.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), source = join(root, 'vendor/ieumoffice'), destination = join(root, 'third_party/ieumoffice');
const mode = process.argv[2] ?? '--check';
if (!['--write', '--check'].includes(mode)) throw new Error('Use --write or --check');
const commit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (commit !== readFileSync(join(root, 'vendor/ieumoffice.PINNED'), 'utf8').match(/^commit: (.+)$/m)?.[1]) throw new Error('Ieum source differs from its pin');
const files = [
  ['apps/markdown/src/main/asset-lifecycle.ts', 'text-assets/asset-lifecycle.ts'],
  ['packages/electron-utils/src/atomic-write.ts', 'text-assets/atomic-write.ts'],
  ['apps/html/src/main/preview-document.ts', 'text-assets/preview-document.ts'],
  ['apps/html/src/main/asset-mime.ts', 'text-assets/asset-mime.ts'],
  ['apps/html/src/main/asset-lifecycle.ts', 'text-assets/css-urls.ts'],
];
const sha = (data) => createHash('sha256').update(data).digest('hex');
const manifest = { source: 'https://github.com/pblsketch/openoffice', commit, changes: 'Attribution headers; explicit .ts import; inline image MIME type; extract the unchanged CSS URL scanner. Host uses create/read/SaveAs helpers and rollback of new assets, never historical asset cleanup.', files: [] };
for (const [input, output] of files) {
  const original = readFileSync(join(source, input), 'utf8');
  let text = original.replace("from './atomic-write'", "from './atomic-write.ts'")
    .replace("import type { ImageData } from '../shared/ipc'", "type ImageData = { mime: 'image/png' | 'image/jpeg' | 'image/gif' }");
  if (output.endsWith('/css-urls.ts')) {
    const start = original.indexOf('export interface CssUrlMatch {');
    const end = original.indexOf('/**\n * Every local source', start);
    if (start < 0 || end < start) throw new Error('Original CSS scanner markers changed');
    text = original.slice(start, end);
  }
  text = `// Adapted from IeumOffice ${input} @ ${commit}.\n// Apache-2.0; see ../LICENSE and ../NOTICE. Changes recorded in text-assets.manifest.json.\n` + text;
  const path = join(destination, output);
  if (mode === '--write') { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
  else if (readFileSync(path, 'utf8') !== text) throw new Error(`Vendored text asset source differs: ${output}`);
  manifest.files.push({ source: input, output, sourceSha256: sha(original), outputSha256: sha(text) });
}
const path = join(destination, 'text-assets.manifest.json'), json = JSON.stringify(manifest, null, 2) + '\n';
if (mode === '--write') writeFileSync(path, json); else if (readFileSync(path, 'utf8') !== json) throw new Error('Text asset manifest differs');
console.log(`${mode.slice(2)}: ${files.length} text asset helpers @ ${commit.slice(0, 12)}`);
