// The second engine target of rebuild-hwp-engine.mjs (`--target 0.9.0`): rhwp v0.9.0 with the
// patch set third_party/hop/patches-0.9.0 (0.9.0-workbench.4: IeumOffice v0.13.0's engine patches
// byte for byte, minus the PDF-import ones, then HOP's and Workbench's), built WITHOUT PDF
// import, into third_party/hop/rhwp-core-0.9.0. The shipped 0.8.7 engine is not touched.
// The manifest is the source of the order and the engine version; the build writes both into the
// engine's package.json.
//
//   node scripts/rebuild-hwp-engine.mjs --target 0.9.0 [--from GIT_URL_OR_PATH] [--keep] [--allow-network]
//
// The compile runs WITHOUT network (H4b): cargo is offline (`CARGO_NET_OFFLINE=true`, `--locked`; the
// crates of v0.9.0's Cargo.lock must already be in CARGO_HOME) and the wasm-pack step runs in its own
// network namespace (`unshare --net --map-current-user`, unprivileged), because wasm-pack 0.15.0
// asks crates.io for its own newest version on every build and has no switch to stop it (the check
// runs on a side thread; without a network it fails quietly). wasm-bindgen and wasm-opt must already
// be in wasm-pack's cache. `--allow-network` runs wasm-pack as before (a machine without `unshare`).
//
// --from: where the tag is cloned from; default github.com/edwardkim/rhwp. A local checkout that
// holds the tag (e.g. a reference clone) is cloned with --no-hardlinks (blobs on demand, only the
// checked-out ones) and needs no network; the
// commit is checked either way. Needs git, rustup (v0.9.0's rust-toolchain.toml selects Rust 1.93.1
// and wasm32-unknown-unknown) and wasm-pack 0.15.0. Cargo resolves crates from v0.9.0's Cargo.lock.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const REPO = 'https://github.com/edwardkim/rhwp.git'
const PACKAGE_FILES = ['rhwp.js', 'rhwp.d.ts', 'rhwp_bg.wasm', 'rhwp_bg.wasm.d.ts']
const LICENSE_FILES = ['LICENSE', 'THIRD_PARTY_LICENSES.md']
// PDF import (pdf-import, pdf-jbig2, pdf-jpeg2000, pdf-icc) is off: the editor does not import PDF.
export const FEATURES = ['console_error_panic_hook', 'wasm-api']
// v0.9.0 compiles files under /assets and /mydocs/{manual,tech/agent_roadmap} into the crate
// (include_str!/include_bytes!), so only the sample documents, reference PDFs, docs and the
// studio/npm folders are left out of the checkout.
const SPARSE = ['/*', '!/samples/', '!/pdf/', '!/docs/', '!/rhwp-studio/', '!/npm/', '!/mydocs/', '/mydocs/manual/', '/mydocs/tech/agent_roadmap/']

const sha256 = (data) => createHash('sha256').update(data).digest('hex')

/** The 0.9.0 patch set as its manifest pins it; throws if a file differs from its recorded hash. */
export function patchSet090(root) {
  const folder = join(root, 'third_party/hop/patches-0.9.0')
  const manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8'))
  for (const patch of manifest.patches) {
    if (patch.file.includes('/') || patch.file.includes('\\')) throw new Error(`0.9.0 patch outside its folder: ${patch.file}`)
    if (sha256(readFileSync(join(folder, patch.file))) !== patch.sha256) throw new Error(`0.9.0 patch differs from its manifest: ${patch.file}`)
    // schema 2: an Ieum patch is carried byte for byte (its hash is the upstream file's)
    if (manifest.schema >= 2 && patch.status === 'verbatim' && patch.sha256 !== patch.upstreamSha256) throw new Error(`0.9.0 patch marked verbatim differs from upstream: ${patch.file}`)
  }
  return { folder, manifest }
}

export async function rebuild090(root, argv) {
  const vendor = join(root, 'third_party/hop/rhwp-core-0.9.0')
  const pinPath = join(vendor, 'package.json')
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  const { folder, manifest } = patchSet090(root)
  const { tag, commit } = pin.rhwp
  if (manifest.base.tag !== tag || manifest.base.commit !== commit) throw new Error('0.9.0 patch set and engine pin name different commits')
  const patches = manifest.patches.map((patch) => patch.file)
  // the pin records what was built: the manifest's order (and, schema 2, its version) replace the old ones
  pin.rhwp.patches = patches
  if (manifest.version) pin.version = manifest.version
  // rhwp.ieumCommit stays the vendored Ieum pin the studio is built from (build-hwp-studio.mjs checks it);
  // the IeumOffice commit the engine patches were copied from is recorded beside it
  if (manifest.ieum?.commit) pin.rhwp.ieumPatchesCommit = manifest.ieum.commit
  const fromIndex = argv.indexOf('--from')
  const fromArg = fromIndex >= 0 ? argv[fromIndex + 1] : REPO
  const local = !/^[a-z]+:\/\//.test(fromArg) && existsSync(fromArg)
  const from = local ? `file://${isAbsolute(fromArg) ? fromArg : resolve(fromArg)}` : fromArg
  const work = join(root, 'node_modules', '.cache', 'rhwp-core-hop', tag)

  const run = (command, args, cwd, env = process.env) => {
    console.log(`> ${command} ${args.join(' ')}`)
    execFileSync(command, args, { cwd, env, stdio: 'inherit' })
  }
  const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim()

  rmSync(work, { recursive: true, force: true })
  mkdirSync(dirname(work), { recursive: true })
  run('git', ['-c', 'core.autocrlf=false', 'clone', ...(local ? ['--no-hardlinks', '--upload-pack', 'git -c uploadpack.allowFilter=true upload-pack'] : []), '--filter=blob:none', '--depth', '1', '--no-checkout', '--branch', tag, from, work], dirname(work))
  git(['config', 'core.autocrlf', 'false'], work)
  git(['sparse-checkout', 'set', '--no-cone', ...SPARSE], work)
  git(['checkout', '--quiet', tag], work)
  const head = git(['rev-parse', 'HEAD'], work)
  if (head !== commit) throw new Error(`rhwp ${tag} resolved to ${head}, expected ${commit}`)
  for (const patch of patches) run('git', ['apply', '--whitespace=nowarn', join(folder, patch)], work)

  const cargoHome = process.env.CARGO_HOME ?? join(homedir(), '.cargo')
  const env = {
    ...process.env,
    CARGO_NET_OFFLINE: 'true',
    RUSTFLAGS: [process.env.RUSTFLAGS ?? '', `--remap-path-prefix=${cargoHome}=/cargo`, `--remap-path-prefix=${work}=/rhwp`].join(' ').trim(),
  }
  const wasmPack = execFileSync('wasm-pack', ['--version'], { encoding: 'utf8' }).trim()
  if (wasmPack !== 'wasm-pack 0.15.0') throw new Error('Use wasm-pack 0.15.0')
  const rustc = execFileSync('rustc', ['--version'], { cwd: work, encoding: 'utf8' }).trim()
  if (!rustc.startsWith('rustc 1.93.1 ')) throw new Error(`v0.9.0 is built with Rust 1.93.1, found ${rustc}`)
  const wasmPackArgs = ['build', '--target', 'web', '--release', '--', '--locked', '--no-default-features', '--features', FEATURES.join(',')]
  if (argv.includes('--allow-network')) run('wasm-pack', wasmPackArgs, work, env)
  else run('unshare', ['--net', '--map-current-user', '--', 'wasm-pack', ...wasmPackArgs], work, env)

  mkdirSync(vendor, { recursive: true })
  for (const file of PACKAGE_FILES) copyFileSync(join(work, 'pkg', file), join(vendor, file))
  for (const file of LICENSE_FILES) copyFileSync(join(work, file), join(vendor, file))
  const wasm = readFileSync(join(vendor, 'rhwp_bg.wasm'))
  // the build's own folders, the home folder (under ux/run-isolated.sh a temporary one) and any home
  // folder prefix at all (the real one is not the home folder there)
  for (const leak of [homedir(), work, '/home/', '/Users/']) {
    if (wasm.includes(Buffer.from(leak))) throw new Error(`rhwp_bg.wasm still contains the local path ${leak}`)
  }
  pin.rhwp.features = FEATURES
  pin.rhwp.wasmPack = wasmPack.replace('wasm-pack ', '')
  pin.rhwp.rustc = rustc
  pin.rhwp.wasmBytes = statSync(join(vendor, 'rhwp_bg.wasm')).size
  pin.rhwp.wasmSha256 = sha256(wasm)
  writeFileSync(pinPath, `${JSON.stringify(pin, null, 2)}\n`)
  console.log(`third_party/hop/rhwp-core-0.9.0: built ${tag} + ${patches.length} patches, PDF import off (${wasm.length} bytes, sha256 ${pin.rhwp.wasmSha256})`)
  if (!argv.includes('--keep') && existsSync(work)) rmSync(work, { recursive: true, force: true })
}
