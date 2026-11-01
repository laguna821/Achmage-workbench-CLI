// Adapted from IeumOffice tools/build-rhwp-core.mjs @ 30ff4f051f067fcb2baf1ab416c40718c802ca35.
// Apache-2.0: third_party/ieumoffice/LICENSE. Builds only the combined pinned engine.
/**
 * Rebuilds vendor/rhwp-core: the rhwp engine (`@rhwp/core`) at the pinned tag
 * with the layout patches in vendor/rhwp-core/patches (decision 0050).
 *
 *   node tools/build-rhwp-core.mjs [--keep]
 *
 * Fetches the tag into node_modules/.cache/rhwp-core (without the multi-GB
 * sample documents), checks the commit, applies the patches in order, builds
 * with `wasm-pack build --target web --release` and copies the package files
 * into vendor/rhwp-core, recording the WASM hash in its package.json.
 *
 * Needs git, rustup (the tag's rust-toolchain.toml selects the toolchain and
 * the wasm32 target) and wasm-pack. The app build itself never runs this.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VENDOR = join(ROOT, 'third_party/hop/rhwp-core')
const MANIFEST = join(VENDOR, 'package.json')
const REPO = 'https://github.com/edwardkim/rhwp.git'
const PACKAGE_FILES = ['rhwp.js', 'rhwp.d.ts', 'rhwp_bg.wasm', 'rhwp_bg.wasm.d.ts']
const LICENSE_FILES = ['LICENSE', 'THIRD_PARTY_LICENSES.md']

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
const hop = JSON.parse(readFileSync(join(ROOT, 'third_party/hop/manifest.json'), 'utf8'))
const ieum = join(ROOT, 'vendor/ieumoffice')
if (execFileSync('git', ['-C', ieum, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== manifest.rhwp.ieumCommit) throw new Error('Ieum pin changed')
for (const patch of manifest.rhwp.hopPatches) {
  const source = hop.files.find(file => file.output === `patches/${patch}`)
  const hash = createHash('sha256').update(readFileSync(join(ROOT, 'third_party/hop/patches', patch))).digest('hex')
  if (!source || hash !== source.sourceSha256) throw new Error(`HOP patch differs from its pin: ${patch}`)
}
const { tag, commit, patches } = manifest.rhwp
const work = join(ROOT, 'node_modules', '.cache', 'rhwp-core-hop', tag)

function run(command, args, cwd, env = process.env) {
  console.log(`> ${command} ${args.join(' ')}`)
  execFileSync(command, args, { cwd, env, stdio: 'inherit' })
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] })
    .toString()
    .trim()
}

// A fresh checkout every time: patches apply to the pristine tag only.
rmSync(work, { recursive: true, force: true })
mkdirSync(dirname(work), { recursive: true })
// LF checkout so the patches (and rustfmt-formatted sources) apply verbatim on Windows.
run(
  'git',
  [
    '-c',
    'core.autocrlf=false',
    'clone',
    '--filter=blob:none',
    '--depth', '1',
    '--no-checkout',
    '--branch',
    tag,
    REPO,
    work,
  ],
  dirname(work),
)
git(['config', 'core.autocrlf', 'false'], work)
git(['sparse-checkout', 'set', '--no-cone', '/*', '!/samples/', '!/mydocs/', '!/docs/', '!/rhwp-studio/', '!/npm/', '!/assets/'], work)
git(['checkout', '--quiet', tag], work)
const head = git(['rev-parse', 'HEAD'], work)
if (head !== commit) {
  throw new Error(`rhwp ${tag} resolved to ${head}, expected ${commit}`)
}
for (const patch of patches) {
  run('git', ['apply', '--whitespace=nowarn', join(ROOT, 'vendor/ieumoffice/vendor/rhwp-core/patches', patch)], work)
}

for (const patch of manifest.rhwp.hopPatches) {
  run('git', ['apply', '--whitespace=nowarn', join(ROOT, 'third_party/hop/patches', patch)], work)
}

// Local paths would otherwise end up in the WASM (panic locations of the
// registry crates); map them to neutral prefixes as a CI build would have.
const cargoHome = process.env.CARGO_HOME ?? join(homedir(), '.cargo')
const env = {
  ...process.env,
  RUSTFLAGS: [
    process.env.RUSTFLAGS ?? '',
    `--remap-path-prefix=${cargoHome}=/cargo`,
    `--remap-path-prefix=${work}=/rhwp`,
  ]
    .join(' ')
    .trim(),
}
if (execFileSync('wasm-pack', ['--version'], { encoding: 'utf8' }).trim() !== 'wasm-pack 0.15.0') throw new Error('Use wasm-pack 0.15.0');
run('wasm-pack', ['build', '--target', 'web', '--release'], work, env)

for (const file of PACKAGE_FILES) copyFileSync(join(work, 'pkg', file), join(VENDOR, file))
for (const file of LICENSE_FILES) copyFileSync(join(work, file), join(VENDOR, file))
const wasm = readFileSync(join(VENDOR, 'rhwp_bg.wasm'))
for (const leak of [homedir(), work]) {
  if (wasm.includes(Buffer.from(leak))) {
    throw new Error(`rhwp_bg.wasm still contains the local path ${leak}`)
  }
}
manifest.rhwp.wasmSha256 = createHash('sha256').update(wasm).digest('hex')
writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`vendor/rhwp-core: built ${tag} + ${patches.length + manifest.rhwp.hopPatches.length} patches (${wasm.length} bytes)`)

if (!process.argv.includes('--keep') && existsSync(work)) {
  rmSync(work, { recursive: true, force: true })
}
