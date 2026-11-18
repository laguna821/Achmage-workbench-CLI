import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
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

// HOP's look of the studio (hop-look): every role HOP's theme binds on the studio's tokens is bound by the role map
// in hangul-studio.css (on the app's colour set), and HOP's icon sheets are the ones the studio ships.
{
  const hop = readFileSync(resolve(folder, 'achmage-theme.css'), 'utf8');
  const hopBlock = /:root:root:root\s*\{([^}]*)\}/.exec(hop)?.[1] ?? '';
  const roles = [...hopBlock.matchAll(/(--(?!ach-)[\w-]+)\s*:/g)].map((match) => match[1]);
  if (roles.length < 30) throw new Error('HOP theme: role list not found in the pinned achmage-theme.css');
  const studio = readFileSync(resolve(root, 'apps/office/src/ui-adapters/hangul-studio.css'), 'utf8');
  const mapBlock = /__WB_ROOT__:root:root\s*\{([^}]*)\}/.exec(studio)?.[1] ?? '';
  const missing = roles.filter((role) => !new RegExp(`(^|[\\s;])${role}\\s*:`).test(mapBlock));
  if (missing.length) throw new Error(`HOP theme roles not bound by hangul-studio.css: ${missing.join(', ')}`);
  let sheets = 0;
  for (const asset of manifest.studioAssets ?? []) {
    const shipped = resolve(root, asset.shippedAs);
    if (!existsSync(shipped)) continue; // the studio is built output (apps/office/public/studio is not in git)
    if (createHash('sha256').update(readFileSync(shipped)).digest('hex') !== asset.sourceSha256) throw new Error(`studio icon sheet differs from HOP's: ${asset.shippedAs}`);
    sheets++;
  }
  console.log(`HOP: ${roles.length} theme roles bound by the studio's role map; ${sheets}/${(manifest.studioAssets ?? []).length} shipped icon sheets equal HOP's${sheets ? '' : ' (studio not built here)'}`);
}

// The rhwp 0.9.0 patch set (H4) and the engine built from it, beside the shipped 0.8.7 engine.
const set = JSON.parse(readFileSync(resolve(folder, 'patches-0.9.0/manifest.json'), 'utf8'));
for (const patch of set.patches) {
  if (patch.file.includes('/') || patch.file.includes('\\')) throw new Error(`0.9.0 patch outside its folder: ${patch.file}`);
  const actual = createHash('sha256').update(readFileSync(resolve(folder, 'patches-0.9.0', patch.file))).digest('hex');
  if (actual !== patch.sha256) throw new Error(`0.9.0 patch differs from its manifest: ${patch.file}`);
  // schema 2 (0.9.0-workbench.4): source ieum = IeumOffice's engine patch byte for byte; hop = HOP's
  // patch in its 0.9.0 form (its 0.8.7 original still in this repository); workbench = Workbench's own
  if (typeof patch.reason !== 'string' || !patch.reason || typeof patch.upstreamId !== 'string') throw new Error(`0.9.0 patch without reason/upstream id: ${patch.file}`);
  const ieum = patch.source === 'ieum' && patch.status === 'verbatim' && patch.file === `ieum-${patch.upstreamId.split('/').pop()}` && patch.sha256 === patch.upstreamSha256;
  const hop = patch.source === 'hop' && ['ported', 'unchanged', 'upstream-test', 're-based'].includes(patch.status) && /^HOP \d{4}$/.test(patch.upstreamId);
  const own = patch.source === 'workbench' && ['new', 'ported'].includes(patch.status) && /^Workbench \d{4}\b/.test(patch.upstreamId);
  if (!ieum && !hop && !own) throw new Error(`0.9.0 patch without source/status: ${patch.file}`);
  // the 0.8.7 original a HOP patch was made from is still the one in this repository
  if (patch.upstreamPath !== undefined) {
    const source = resolve(root, patch.upstreamPath);
    const rel = relative(root, source);
    if (!rel || isAbsolute(rel) || rel.startsWith('..')) throw new Error(`0.9.0 patch source outside the repository: ${patch.file}`);
    if (createHash('sha256').update(readFileSync(source)).digest('hex') !== patch.upstreamSha256) throw new Error(`0.9.0 patch source changed: ${patch.file} (${patch.upstreamPath})`);
  }
}
const engine = JSON.parse(readFileSync(resolve(folder, 'rhwp-core-0.9.0/package.json'), 'utf8')).rhwp;
if (engine.tag !== set.base.tag || engine.commit !== set.base.commit) throw new Error('0.9.0 engine and patch set name different commits');
if (JSON.stringify(engine.patches) !== JSON.stringify(set.patches.map((patch) => patch.file))) throw new Error('0.9.0 engine was not built from this patch set');
if (set.schema !== 2 || JSON.parse(readFileSync(resolve(folder, 'rhwp-core-0.9.0/package.json'), 'utf8')).version !== set.version) throw new Error('0.9.0 engine version differs from its patch set');
const wasm = createHash('sha256').update(readFileSync(resolve(folder, 'rhwp-core-0.9.0/rhwp_bg.wasm'))).digest('hex');
if (wasm !== engine.wasmSha256) throw new Error('0.9.0 engine WASM differs from its recorded hash');
console.log(`HOP: rhwp ${set.base.tag} patch set ${set.version} (${set.patches.length} patches: ${['ieum', 'hop', 'workbench'].map((kind) => `${set.patches.filter((patch) => patch.source === kind).length} ${kind}`).join(', ')}) and its engine checked`);
