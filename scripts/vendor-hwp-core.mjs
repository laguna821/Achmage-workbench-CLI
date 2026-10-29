// The save flow and read/write corrections used by Ieum's HWP renderer. Keep exact source hashes.
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
const names = ['hwp5-file', 'tracked-changes', 'field-kinds', 'section-tails', 'tab-widths', 'save-plan', 'save-fixes', 'memos'];
const files = [...names.map((name) => [`apps/hwp/src/main/${name}.ts`, `hwp/${name}.ts`]), ['packages/file-parse/src/hwp.ts', 'file-parse/hwp.ts'], ['apps/hwp/src/renderer/save-flow.ts', 'hwp/save-flow.ts']];
const sha = (data) => createHash('sha256').update(data).digest('hex');
const manifest = { source: 'https://github.com/pblsketch/openoffice', commit, changes: 'Attribution headers; explicit .ts imports; local HWP contract/ZIP gate/file parser; pinned shared WASM resource resolver', files: [] };
for (const [input, output] of files) {
  const original = readFileSync(join(source, input), 'utf8');
  let text = original.replace(/\bfrom (['"])(\.[^'"]+)\1/g, (_, q, path) => `from ${q}${path.endsWith('.ts') ? path : path + '.ts'}${q}`)
    .replaceAll("'../shared/ipc.ts'", "'../../../packages/contracts/src/hwp.ts'")
    .replaceAll("'@genoffice/file-parse'", "'../file-parse/hwp.ts'")
    .replaceAll("'@genoffice/docx-engine'", "'../zip-gate/index.ts'")
    .replaceAll("'@rhwp/core'", "'../../../vendor/ieumoffice/vendor/rhwp-core/rhwp.js'");
  if (output === 'hwp/save-flow.ts') text = text.replace('  HwpApi,', '  HwpSaveApi as HwpApi,');
  if (output === 'file-parse/hwp.ts') {
    text = text.replace("import { createRequire } from 'node:module'\n", '').replace("import { join } from 'node:path'\n", '');
    const start = text.indexOf('function rhwpWasmPath(): string {'), end = text.indexOf('\nlet engine:', start);
    if (start < 0 || end < 0) throw new Error('HWP parser resource hook changed upstream');
    text = text.slice(0, start) + "import { hwpWasmPath as rhwpWasmPath } from '../../../apps/host/src/hwp-resource.ts'\n" + text.slice(end);
  }
  text = `// Adapted from IeumOffice ${input} @ ${commit}.\n// Apache-2.0; see ../LICENSE and ../NOTICE. Changes recorded in hwp.manifest.json.\n` + text;
  const path = join(destination, output);
  if (mode === '--write') { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
  else if (readFileSync(path, 'utf8') !== text) throw new Error(`Vendored HWP source differs: ${output}`);
  manifest.files.push({ source: input, output, sourceSha256: sha(original), outputSha256: sha(text) });
}
const path = join(destination, 'hwp.manifest.json'), json = JSON.stringify(manifest, null, 2) + '\n';
if (mode === '--write') writeFileSync(path, json); else if (readFileSync(path, 'utf8') !== json) throw new Error('HWP manifest differs');
console.log(`${mode.slice(2)}: ${files.length} HWP preservation/read files @ ${commit.slice(0, 12)}`);
