// Build Ieum's offline HWP studio from its pinned rhwp source. No Electron runtime is shipped.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ieum = join(root, 'vendor/ieumoffice');
const pinned = readFileSync(join(root, 'vendor/ieumoffice.PINNED'), 'utf8').match(/^commit: (.+)$/m)?.[1];
const commit = execFileSync('git', ['-C', ieum, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (commit !== pinned) throw new Error('Ieum checkout differs from its pin');
const core = join(ieum, 'vendor/rhwp-core');
const engine = JSON.parse(readFileSync(join(core, 'package.json'), 'utf8'));
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
if (hash(join(core, 'rhwp_bg.wasm')) !== engine.rhwp.wasmSha256) throw new Error('The HWP engine WASM differs from the pinned manifest');
execFileSync(process.execPath, [join(ieum, 'apps/hwp/scripts/build-studio.mjs')], { cwd: ieum, stdio: 'inherit' });
const built = join(ieum, 'apps/hwp/public/studio');
const output = join(root, 'apps/office/public/studio');
if (!existsSync(join(built, 'index.html'))) throw new Error('HWP studio output is missing');
const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
const wasm = files(built).filter((file) => file.endsWith('.wasm')).find((file) => hash(file) === engine.rhwp.wasmSha256);
if (!wasm) throw new Error('The studio does not contain the pinned engine WASM');
// Only this generated directory belongs to the builder.
rmSync(output, { recursive: true, force: true }); mkdirSync(dirname(output), { recursive: true }); cpSync(built, output, { recursive: true });
writeFileSync(join(output, 'build.json'), JSON.stringify({ schemaVersion: 1, ieumCommit: commit, rhwpCommit: engine.rhwp.commit, engineVersion: engine.version, wasm: relative(built, wasm).split('\\').join('/'), wasmSha256: engine.rhwp.wasmSha256, studioStamp: readFileSync(join(built, '.stamp'), 'utf8').trim() }, null, 2) + '\n');
console.log(`HWP studio ${engine.version}: ${relative(root, output)} (shared browser/host WASM)`);
