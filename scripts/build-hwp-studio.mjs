// Build Ieum's offline HWP studio from its pinned rhwp source. No Electron runtime is shipped.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { IEUM_HWP_DIR, IEUM_HWP_PIN_FILE } from './ieum-earlier-source.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ieum = join(root, IEUM_HWP_DIR);
const pinned = readFileSync(join(root, IEUM_HWP_PIN_FILE), 'utf8').match(/^commit: (.+)$/m)?.[1];
const commit = execFileSync('git', ['-C', ieum, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (commit !== pinned) throw new Error('Ieum checkout differs from its pin');
// The engine the gateway runs (third_party/hop/engine.ts): the studio is built around the same one.
const { ENGINE_DIR } = await import(pathToFileURL(join(root, 'third_party/hop/engine.ts')).href);
const core = join(root, ENGINE_DIR);
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
const need = (needle) => { if (builder.split(needle).length !== 2) throw new Error(`HWP build hook changed: ${needle}`); };
replace("from './rhwp-patches.mjs'", `from ${JSON.stringify(pathToFileURL(join(upstreamScripts, 'rhwp-patches.mjs')).href)}`);
// the adapted copy runs from node_modules/.cache: its two sibling imports point back at upstream's scripts
replace("from './hanja-dict.mjs'", `from ${JSON.stringify(pathToFileURL(join(upstreamScripts, 'hanja-dict.mjs')).href)}`);
replace("from 'vite'", `from ${JSON.stringify(pathToFileURL(join(ieum, 'node_modules/vite/dist/node/index.js')).href)}`);
replace('const SCRIPTS = dirname(fileURLToPath(import.meta.url))', `const SCRIPTS = ${JSON.stringify(upstreamScripts)}`);
replace("const CORE_DIR = dirname(require.resolve('@rhwp/core'))", `const CORE_DIR = ${JSON.stringify(core)}`);
replace("  const wasmPkg = dirname(require.resolve('@rhwp/core'))", '  const wasmPkg = CORE_DIR');
// rhwp-studio v0.9.0. Since IeumOffice v0.13.0 upstream's builder builds v0.9.0 itself (its pinned commit,
// the rhwp-shared/ sparse entries and engine alias, `__RHWP_AI__` false: no studio AI assistant, its
// provider SDKs never imported); what stays Workbench's own:
//  - the studio is cloned from a local rhwp checkout when HWP_STUDIO_FROM names one (no network);
//  - upstream's committed root glue of another engine build (public/rhwp.js and its two .d.ts) is
//    never loaded (the studio reaches the engine through '@wasm'): not checked out, not shipped (M6);
//  - `__RHWP_COMPARE_DEBUG__` (a debug overlay) is off;
//  - the studio patches come from scripts/hwp-studio-090.mjs (Ieum's, then Workbench's own), and they
//    take part in the build stamp;
//  - the Hanja dictionary (한자 변환) is never fetched by the build: it is taken from upstream's cache, or
//    seeded into it from HWP_HANJA_FROM (checked against upstream's pinned sha256), else the build stops.
const studio090 = join(root, 'scripts/hwp-studio-090.mjs');
const { STUDIO_COMMIT_090, unwantedStudioFiles090, CANVASKIT_TRACES, STATUS_TIMING_TRACES } = await import(pathToFileURL(studio090).href);
if (engine.rhwp.tag !== 'v0.9.0') throw new Error(`The Hangul studio is built for rhwp v0.9.0 only (engine ${engine.rhwp.tag})`);
if (engine.rhwp.commit !== STUDIO_COMMIT_090) throw new Error('The 0.9.0 engine and studio name different commits');
need(`  'v0.9.0': '${STUDIO_COMMIT_090}',\n`);
const from = process.env.HWP_STUDIO_FROM;
if (from) {
  if (!existsSync(join(from, '.git'))) throw new Error(`HWP_STUDIO_FROM is not a git checkout: ${from}`);
  replace("const REPO = 'https://github.com/edwardkim/rhwp.git'", `const REPO = ${JSON.stringify(pathToFileURL(resolve(from)).href)}`);
  // a local clone copies only the checked-out files' blobs (the reference holds gigabytes of samples)
  replace("        'clone',\n        '--depth',\n", "        'clone',\n        '--no-hardlinks',\n        '--upload-pack',\n        'git -c uploadpack.allowFilter=true upload-pack',\n        '--depth',\n");
}
replace("  '!/rhwp-studio/public/samples',\n", "  '!/rhwp-studio/public/samples',\n  '!/rhwp-studio/public/rhwp.js',\n  '!/rhwp-studio/public/rhwp.d.ts',\n  '!/rhwp-studio/public/rhwp_bg.wasm.d.ts',\n");
need("      __RHWP_AI__: 'false',\n");
replace("      __RHWP_AI__: 'false',\n", "      __RHWP_AI__: 'false',\n      __RHWP_COMPARE_DEBUG__: 'false',\n");
replace('    plugins: [rhwpPatches(...STUDIO_PATCHES), sharedEngine],', `    plugins: [(await import(${JSON.stringify(pathToFileURL(studio090).href)})).studioPatches090(), sharedEngine],`);
replace('  hash.update(TAG)\n', `  hash.update(TAG)\n  hash.update(${JSON.stringify(createHash('sha256').update(readFileSync(studio090)).update(builder).digest('hex'))})\n`);
const { HANJA_COMMIT, HANJA_SHA256 } = await import(pathToFileURL(join(upstreamScripts, 'hanja-dict.mjs')).href);
need("const HANJA_CACHE = join(APP, 'node_modules', '.cache', 'libhangul-hanja')");
const hanja = join(ieum, 'apps/hwp/node_modules/.cache/libhangul-hanja', HANJA_COMMIT, 'hanja.txt');
if (!existsSync(hanja)) {
  const seed = process.env.HWP_HANJA_FROM;
  const candidates = seed ? [seed, join(seed, 'hanja.txt'), join(seed, HANJA_COMMIT, 'hanja.txt')] : [];
  const found = candidates.find((file) => existsSync(file) && statSync(file).isFile());
  if (!found) throw new Error(`The Hanja dictionary is not in the studio's build cache and the build does not fetch it: set HWP_HANJA_FROM to libhangul's data/hanja/hanja.txt at ${HANJA_COMMIT} (sha256 ${HANJA_SHA256})`);
  if (hash(found) !== HANJA_SHA256) throw new Error(`HWP_HANJA_FROM is not libhangul's hanja.txt at ${HANJA_COMMIT}: ${found}`);
  mkdirSync(dirname(hanja), { recursive: true }); cpSync(found, hanja);
}
if (hash(hanja) !== HANJA_SHA256) throw new Error(`The cached Hanja dictionary differs from libhangul ${HANJA_COMMIT}: ${hanja}`);
const adapted = join(root, 'node_modules/.cache/workbench-hwp/build-studio.mjs');
mkdirSync(dirname(adapted), { recursive: true }); writeFileSync(adapted, builder);
execFileSync(process.execPath, [adapted], { cwd: ieum, stdio: 'inherit' });
const built = join(ieum, 'apps/hwp/public/studio');
const output = join(root, 'apps/office/public/studio');
if (!existsSync(join(built, 'index.html'))) throw new Error('HWP studio output is missing');
const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
const wasm = files(built).filter((file) => file.endsWith('.wasm')).find((file) => hash(file) === engine.rhwp.wasmSha256);
if (!wasm) throw new Error('The studio does not contain the pinned engine WASM');
// The studio carries no AI assistant of its own (the app has one AI, in its own dock) and no
// provider endpoint: a build where upstream's switch did not take fails here.
const providerTraces = ['@anthropic-ai/sdk', 'api.anthropic.com', 'api.openai.com', 'generativelanguage.googleapis.com'];
for (const file of files(built).filter((file) => /\.(js|mjs|html)$/.test(file))) {
  const text = readFileSync(file, 'utf8');
  const found = providerTraces.filter((trace) => text.includes(trace));
  if (found.length) throw new Error(`The studio build carries an AI provider (${found.join(', ')}): ${relative(built, file)}`);
}
// The 0.9.0 studio draws with Canvas2D only and carries no second engine glue (review M6): neither
// the CanvasKit renderer chunk nor its WASM nor upstream's root rhwp.js may be in the output, and no
// built JS may still name the CanvasKit chunk or WASM.
{
  const unwanted = unwantedStudioFiles090(files(built).map((file) => relative(built, file).split(sep).join('/')));
  if (unwanted.length) throw new Error(`The studio build carries files it never loads: ${unwanted.join(', ')}`);
  for (const file of files(built).filter((file) => /\.(js|mjs|html)$/.test(file))) {
    const text = readFileSync(file, 'utf8');
    const found = CANVASKIT_TRACES.filter((trace) => text.includes(trace));
    if (found.length) throw new Error(`The studio build still reaches CanvasKit (${found.join(', ')}): ${relative(built, file)}`);
    const timing = STATUS_TIMING_TRACES.filter((trace) => text.includes(trace));
    if (timing.length) throw new Error(`The studio's status line still shows a load time (${timing.join(', ')}): ${relative(built, file)}`);
  }
}
// Only this generated directory belongs to the builder.
rmSync(output, { recursive: true, force: true }); mkdirSync(dirname(output), { recursive: true }); cpSync(built, output, { recursive: true });
cpSync(join(root, 'third_party/hop/LICENSE'), join(output, 'LICENSE-hop.txt'));
// The minimal fallback faces (OFL; licence travels with them). Upstream's own font table already
// names these files under fonts/; the build that strips upstream's font folder leaves them out.
cpSync(join(root, 'third_party/hop/fonts'), join(output, 'fonts'), { recursive: true });
writeFileSync(join(output, 'build.json'), JSON.stringify({ schemaVersion: 1, ieumCommit: commit, rhwpCommit: engine.rhwp.commit, engineVersion: engine.version, wasm: relative(built, wasm).split(sep).join('/'), wasmSha256: engine.rhwp.wasmSha256, studioStamp: readFileSync(join(built, '.stamp'), 'utf8').trim() }, null, 2) + '\n');
console.log(`HWP studio ${engine.version}: ${relative(root, output)} (shared browser/host WASM)`);
