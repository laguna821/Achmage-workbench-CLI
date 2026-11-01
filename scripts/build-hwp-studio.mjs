// Build Ieum's offline HWP studio from its pinned rhwp source. No Electron runtime is shipped.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ieum = join(root, 'vendor/ieumoffice');
const pinned = readFileSync(join(root, 'vendor/ieumoffice.PINNED'), 'utf8').match(/^commit: (.+)$/m)?.[1];
const commit = execFileSync('git', ['-C', ieum, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (commit !== pinned) throw new Error('Ieum checkout differs from its pin');
const core = join(root, 'third_party/hop/rhwp-core');
const engine = JSON.parse(readFileSync(join(core, 'package.json'), 'utf8'));
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
if (hash(join(core, 'rhwp_bg.wasm')) !== engine.rhwp.wasmSha256) throw new Error('The HWP engine WASM differs from the pinned manifest');
if (engine.rhwp.ieumCommit !== commit) throw new Error('Combined HWP engine differs from the Ieum pin');
// Run the original builder with only its engine paths redirected. Its renderer/plugin patches
// and pinned studio remain unchanged; never edit the upstream checkout's source files.
const upstreamScripts = join(ieum, 'apps/hwp/scripts');
let builder = readFileSync(join(upstreamScripts, 'build-studio.mjs'), 'utf8');
const replace = (needle, value) => {
  if (builder.split(needle).length !== 2) throw new Error(`HWP build hook changed: ${needle}`);
  builder = builder.replace(needle, value);
};
replace("from './rhwp-patches.mjs'", `from ${JSON.stringify(pathToFileURL(join(upstreamScripts, 'rhwp-patches.mjs')).href)}`);
replace("from 'vite'", `from ${JSON.stringify(pathToFileURL(join(ieum, 'node_modules/vite/dist/node/index.js')).href)}`);
replace('const SCRIPTS = dirname(fileURLToPath(import.meta.url))', `const SCRIPTS = ${JSON.stringify(upstreamScripts)}`);
replace("const CORE_DIR = dirname(require.resolve('@rhwp/core'))", `const CORE_DIR = ${JSON.stringify(core)}`);
replace("const wasmPkg = dirname(require.resolve('@rhwp/core'))", 'const wasmPkg = CORE_DIR');
const adapted = join(root, 'node_modules/.cache/workbench-hwp/build-studio.mjs');
mkdirSync(dirname(adapted), { recursive: true }); writeFileSync(adapted, builder);
execFileSync(process.execPath, [adapted], { cwd: ieum, stdio: 'inherit' });
const built = join(ieum, 'apps/hwp/public/studio');
const output = join(root, 'apps/office/public/studio');
if (!existsSync(join(built, 'index.html'))) throw new Error('HWP studio output is missing');
const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
const wasm = files(built).filter((file) => file.endsWith('.wasm')).find((file) => hash(file) === engine.rhwp.wasmSha256);
if (!wasm) throw new Error('The studio does not contain the pinned engine WASM');
// Only this generated directory belongs to the builder.
rmSync(output, { recursive: true, force: true }); mkdirSync(dirname(output), { recursive: true }); cpSync(built, output, { recursive: true });
cpSync(join(root, 'third_party/hop/LICENSE'), join(output, 'LICENSE-hop.txt'));
writeFileSync(join(output, 'build.json'), JSON.stringify({ schemaVersion: 1, ieumCommit: commit, rhwpCommit: engine.rhwp.commit, engineVersion: engine.version, wasm: relative(built, wasm).split(sep).join('/'), wasmSha256: engine.rhwp.wasmSha256, studioStamp: readFileSync(join(built, '.stamp'), 'utf8').trim() }, null, 2) + '\n');
console.log(`HWP studio ${engine.version}: ${relative(root, output)} (shared browser/host WASM)`);
