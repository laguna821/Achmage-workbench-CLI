import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const folder = resolve(root, 'third_party/hop');
const manifest = JSON.parse(readFileSync(resolve(folder, 'manifest.json'), 'utf8'));
for (const file of manifest.files) {
  const path = resolve(folder, file.output);
  const rel = relative(root, path);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new Error('HOP source path outside the repository');
  const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (actual !== file.outputSha256) throw new Error(`HOP source differs from reviewed adaptation: ${file.output}`);
}
console.log(`HOP: ${manifest.files.length} pinned source adaptations checked`);

// The rhwp 0.9.0 patch set (H4) and the engine built from it, beside the shipped 0.8.7 engine.
const set = JSON.parse(readFileSync(resolve(folder, 'patches-0.9.0/manifest.json'), 'utf8'));
for (const patch of set.patches) {
  if (patch.file.includes('/') || patch.file.includes('\\')) throw new Error(`0.9.0 patch outside its folder: ${patch.file}`);
  const actual = createHash('sha256').update(readFileSync(resolve(folder, 'patches-0.9.0', patch.file))).digest('hex');
  if (actual !== patch.sha256) throw new Error(`0.9.0 patch differs from its manifest: ${patch.file}`);
  // a 0.9.0 form of an Ieum/HOP patch (ported/unchanged/upstream-test), or a change of Workbench's own (new)
  const own = patch.status === 'new' && /^Workbench \d{4}$/.test(patch.origin);
  const carried = ['ported', 'unchanged', 'upstream-test'].includes(patch.status) && /^(Ieum|HOP) \d{4}$/.test(patch.origin);
  if (!own && !carried) throw new Error(`0.9.0 patch without origin/status: ${patch.file}`);
  // the 0.8.7 original it was made from is still the vendored one
  if (patch.source !== undefined) {
    const source = resolve(root, patch.source);
    const rel = relative(root, source);
    if (!rel || isAbsolute(rel) || rel.startsWith('..')) throw new Error(`0.9.0 patch source outside the repository: ${patch.file}`);
    if (createHash('sha256').update(readFileSync(source)).digest('hex') !== patch.sourceSha256) throw new Error(`0.9.0 patch source changed: ${patch.file} (${patch.source})`);
  }
}
const engine = JSON.parse(readFileSync(resolve(folder, 'rhwp-core-0.9.0/package.json'), 'utf8')).rhwp;
if (engine.tag !== set.base.tag || engine.commit !== set.base.commit) throw new Error('0.9.0 engine and patch set name different commits');
if (JSON.stringify(engine.patches) !== JSON.stringify(set.patches.map((patch) => patch.file))) throw new Error('0.9.0 engine was not built from this patch set');
const wasm = createHash('sha256').update(readFileSync(resolve(folder, 'rhwp-core-0.9.0/rhwp_bg.wasm'))).digest('hex');
if (wasm !== engine.wasmSha256) throw new Error('0.9.0 engine WASM differs from its recorded hash');
console.log(`HOP: rhwp ${set.base.tag} patch set (${set.patches.length} patches) and its engine checked`);
