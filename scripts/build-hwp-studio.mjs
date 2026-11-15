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
replace("from './rhwp-patches.mjs'", `from ${JSON.stringify(pathToFileURL(join(upstreamScripts, 'rhwp-patches.mjs')).href)}`);
replace("from 'vite'", `from ${JSON.stringify(pathToFileURL(join(ieum, 'node_modules/vite/dist/node/index.js')).href)}`);
replace('const SCRIPTS = dirname(fileURLToPath(import.meta.url))', `const SCRIPTS = ${JSON.stringify(upstreamScripts)}`);
replace("const CORE_DIR = dirname(require.resolve('@rhwp/core'))", `const CORE_DIR = ${JSON.stringify(core)}`);
replace("const wasmPkg = dirname(require.resolve('@rhwp/core'))", 'const wasmPkg = CORE_DIR');
// rhwp-studio v0.9.0 (H4b). Ieum's builder knows v0.8.7 only; for the 0.9.0 engine:
//  - its pinned commit (a moved tag still stops the build);
//  - the studio is cloned from a local rhwp checkout when HWP_STUDIO_FROM names one (no network),
//    else from GitHub as before;
//  - upstream's AI assistant is left out exactly as upstream's own switch does it (RHWP_WITHOUT_AI=1
//    → `__RHWP_AI__` false, so main.ts never imports the AI module and its provider SDKs);
//    `__RHWP_COMPARE_DEBUG__` (a debug overlay) is off;
//  - the three files outside rhwp-studio/ that 0.9.0's studio imports are checked out too;
//  - the studio patches come from scripts/hwp-studio-090.mjs (Ieum's, minus the ones 0.9.0 made
//    unnecessary, with the one whose text is gone redone), and they take part in the build stamp.
const studio090 = join(root, 'scripts/hwp-studio-090.mjs');
const { STUDIO_COMMIT_090, unwantedStudioFiles090, CANVASKIT_TRACES, STATUS_TIMING_TRACES } = await import(pathToFileURL(studio090).href);
let studioEnv = process.env;
if (engine.rhwp.tag === 'v0.9.0') {
  if (engine.rhwp.commit !== STUDIO_COMMIT_090) throw new Error('The 0.9.0 engine and studio name different commits');
  replace("  'v0.8.7': '1a76570e833917d15817415a53c09ad61ab3203f',\n", `  'v0.8.7': '1a76570e833917d15817415a53c09ad61ab3203f',\n  'v0.9.0': '${STUDIO_COMMIT_090}',\n`);
  const from = process.env.HWP_STUDIO_FROM;
  if (from) {
    if (!existsSync(join(from, '.git'))) throw new Error(`HWP_STUDIO_FROM is not a git checkout: ${from}`);
    replace("const REPO = 'https://github.com/edwardkim/rhwp.git'", `const REPO = ${JSON.stringify(pathToFileURL(resolve(from)).href)}`);
    // a local clone copies only the checked-out files' blobs (the reference holds gigabytes of samples)
    replace("['clone', '--depth', '1', '--branch', TAG, '--filter=blob:none', '--no-checkout', REPO, CACHE]", "['clone', '--no-hardlinks', '--upload-pack', 'git -c uploadpack.allowFilter=true upload-pack', '--depth', '1', '--branch', TAG, '--filter=blob:none', '--no-checkout', REPO, CACHE]");
  }
  replace("  '/npm/hwpctrl-ocx/src/',\n", "  '/npm/hwpctrl-ocx/src/',\n  '/rhwp-shared/',\n  '/assets/fonts/enclosed-pua-metrics.json',\n  '/src/renderer/square_gradient.sksl',\n");
  // upstream's committed root glue of another engine build (public/rhwp.js and its two .d.ts) is
  // never loaded (the studio reaches the engine through '@wasm'): not checked out, not shipped (M6)
  replace("  '!/rhwp-studio/public/samples',\n", "  '!/rhwp-studio/public/samples',\n  '!/rhwp-studio/public/rhwp.js',\n  '!/rhwp-studio/public/rhwp.d.ts',\n  '!/rhwp-studio/public/rhwp_bg.wasm.d.ts',\n");
  replace("      __RHWP_HWPCTRL__: 'true',\n", "      __RHWP_HWPCTRL__: 'true',\n      __RHWP_AI__: JSON.stringify(process.env.RHWP_WITHOUT_AI !== '1'),\n      __RHWP_COMPARE_DEBUG__: 'false',\n");
  replace('    plugins: [rhwpPatches(...STUDIO_PATCHES)],', `    plugins: [(await import(${JSON.stringify(pathToFileURL(studio090).href)})).studioPatches090()],`);
  // 0.9.0's rhwp-shared/ (the PDF import worker, started only when the engine imports PDF; ours does
  // not) reaches the engine as ../../pkg/rhwp.js, the repository's wasm-pack output: the same engine.
  replace("        '@wasm': wasmPkg,\n", "        '@wasm': wasmPkg,\n        '../../pkg/rhwp.js': join(wasmPkg, 'rhwp.js'),\n");
  replace('  hash.update(TAG)\n', `  hash.update(TAG)\n  hash.update(${JSON.stringify(createHash('sha256').update(readFileSync(studio090)).update(builder).digest('hex'))})\n`);
  studioEnv = { ...process.env, RHWP_WITHOUT_AI: '1' };
}
const adapted = join(root, 'node_modules/.cache/workbench-hwp/build-studio.mjs');
mkdirSync(dirname(adapted), { recursive: true }); writeFileSync(adapted, builder);
execFileSync(process.execPath, [adapted], { cwd: ieum, stdio: 'inherit', env: studioEnv });
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
if (engine.rhwp.tag === 'v0.9.0') {
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
