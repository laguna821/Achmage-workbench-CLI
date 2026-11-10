#!/usr/bin/env node
// A real native-webview check of the production driver, independent of any installed user app.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw Error(`Missing ${name} value`);
  return args[index + 1];
}
const out = resolve(option('--out-dir', join(repo, 'browser-native-evidence')));
const binary = resolve(option('--binary', join(repo, 'apps/desktop/src-tauri/target/release/examples', process.platform === 'win32' ? 'browser-check.exe' : 'browser-check')));
const timeoutMs = Number(option('--timeout-ms', '120000'));
if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) throw Error('Invalid --timeout-ms');
await mkdir(out, { recursive: true });
const startedAt = new Date().toISOString();
const isolation = await mkdtemp(join(tmpdir(), 'achmage-browser-native-'));
const identifier = `kr.achmage.browsercheck.${randomUUID().replaceAll('-', '')}`;
const dataRoot = process.platform === 'darwin' ? join(homedir(), 'Library/Application Support')
  : process.platform === 'win32' ? process.env.LOCALAPPDATA
  : process.env.XDG_DATA_HOME && isAbsolute(process.env.XDG_DATA_HOME) ? process.env.XDG_DATA_HOME : join(homedir(), '.local/share');
if (!dataRoot) throw Error('Unable to find the disposable app-data parent');
const dataLink = join(dataRoot, identifier);
const profileRoot = join(isolation, 'profiles');
const nativeReportPath = join(out, 'native.json');
let child, timedOut = false, failure, native;
let exitCode = null, signal = null;
const server = createServer((request, response) => {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  if (path === '/shell') {
    response.end('<!doctype html><meta name="viewport" content="width=device-width"><title>Native driver check shell</title><style>html,body{margin:0;width:100%;height:100%;background:#e9eef4}</style><p>Isolated native shared browser check</p>');
  } else if (path === '/page-a' || path === '/page-b') {
    response.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>${path}</title><style>body{margin:16px}iframe{width:240px;height:100px}</style><label>Search<input id="search" aria-label="native-search" autocomplete="off"></label><script>window.inputEvents=0;document.querySelector('#search').addEventListener('input',()=>window.inputEvents++)</script><iframe src="/iframe-child" title="independent frame URL"></iframe>`);
  } else if (path === '/iframe-child') {
    response.end('<!doctype html><title>Frame title must not become tab title</title><p>Frame content, separate URL</p>');
  } else { response.statusCode = 404; response.end('Not found'); }
});
const sourceFiles = [
  'apps/desktop/src-tauri/examples/browser-check.rs',
  'apps/desktop/src-tauri/src/shared_browser.rs',
  'apps/desktop/src-tauri/src/shared_browser.js',
  'apps/desktop/src-tauri/src/browser_driver/mod.rs',
  'apps/desktop/src-tauri/src/browser_driver/webkitgtk.rs',
  'apps/desktop/src-tauri/src/browser_driver/webview2.rs',
  'apps/desktop/src-tauri/src/browser_driver/wkwebview.rs',
];
const sourceDigests = Object.fromEntries(await Promise.all(sourceFiles.map(async path => [path, createHash('sha256').update(await readFile(join(repo, path))).digest('hex')])));
try {
  await access(binary);
  await mkdir(profileRoot, { recursive: true });
  await mkdir(dataRoot, { recursive: true });
  // Every run owns a new identifier. A junction on Windows needs no symlink privilege.
  await symlink(profileRoot, dataLink, process.platform === 'win32' ? 'junction' : 'dir');
  if (await realpath(dataLink) !== await realpath(profileRoot)) throw Error('Profile isolation link differs from its temporary target');
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  await rm(nativeReportPath, { force: true });
  const log = createWriteStream(join(out, 'native.log'));
  child = spawn(binary, [], { cwd: repo, env: { ...process.env,
    BROWSER_CHECK_BASE_URL: base, BROWSER_CHECK_REPORT: nativeReportPath,
    BROWSER_CHECK_IDENTIFIER: identifier, BROWSER_CHECK_PROFILE_ROOT: isolation,
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      // This PID belongs solely to the harness launched above; never touch another app.
      child.kill();
      const force = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 3000);
      force.unref();
      reject(Error(`Native browser check exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, endedBy) => { clearTimeout(timer); exitCode = code; signal = endedBy; resolveExit(); });
  }).finally(() => { child.stdout.unpipe(log); child.stderr.unpipe(log); log.end(); });
  native = JSON.parse(await readFile(nativeReportPath, 'utf8'));
  if (exitCode !== 0 || native.ok !== true || native.checks?.length < 10 || !native.checks.every(check => check.passed === true)) throw Error(native.error ?? `Native check exited ${exitCode}`);
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  server.closeAllConnections();
  if (server.listening) await new Promise(resolveClose => server.close(resolveClose));
  // Leave a timed-out run's profile isolated rather than deleting data still used by its process.
  if (!timedOut) {
    try {
      await rm(dataLink, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
      await rm(isolation, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
    } catch (error) { failure = [failure, `Disposable profile cleanup failed: ${error.message}`].filter(Boolean).join('; '); }
  }
}
const result = {
  scope: 'Real standalone Tauri native shared_browser.rs implementation; common frontend tests are a separate CI step. This does not certify the installed Workbench UI.',
  platform: process.platform, arch: process.arch, startedAt, finishedAt: new Date().toISOString(),
  ok: !failure, binary, sourceDigests, exitCode, signal, timedOut, nativeReport: nativeReportPath,
  error: failure ?? null, native: native ?? null,
  ...(timedOut ? { retainedIsolatedProfile: isolation, retainedDataLink: dataLink } : {}),
};
await writeFile(join(out, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ok: result.ok, platform: result.platform, report: join(out, 'result.json'), error: result.error }));
if (failure) process.exitCode = 1;
