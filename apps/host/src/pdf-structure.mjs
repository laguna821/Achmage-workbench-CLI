import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createPdfStructureHandlers } from '../../../vendor/ieumoffice/apps/shell/src/main/pdf-structure/handlers.ts';
import { StructureJobRunner } from '../../../vendor/ieumoffice/apps/shell/src/main/pdf-structure/runner.ts';
import { officeResultStore } from './office-results.mjs';
import { pdfiumWasmPath, hbSubsetWasmPath, pdfOcrHelpers } from './pdf-resource.mjs';
import { repoRoot, shipped } from './resources.ts';

export function pdfStructure(directory, isGranted) {
  const runner = new StructureJobRunner(() => {
    const root = repoRoot(), entry = shipped('host/pdf-structure-job.mjs') ?? (root && join(root, 'apps/host/dist/pdf-structure-job.mjs'));
    if (!entry) throw new Error('PDF 구조 작업 실행 파일이 없습니다.');
    const child = fork(entry, [], { execArgv: [], serialization: 'advanced', stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    // Drain diagnostics without copying document contents into the main log.
    child.stderr?.resume();
    child.on('error', () => child.emit('exit', -1));
    return { postMessage: message => child.send(message), kill: () => child.kill(), on: (event, listener) => child.on(event, listener) };
  }, () => ({ wasmPath: pdfiumWasmPath(), hbSubsetWasmPath: hbSubsetWasmPath(), ocrHelperPaths: pdfOcrHelpers(), userDataDir: directory }));
  const targets = new Map();
  const handlers = createPdfStructureHandlers({ runner, store: () => officeResultStore(directory), isGranted,
    pickPath: async (owner, request) => targets.get(`${owner}:${basename(request.defaultPath)}`) ?? null,
    hashFile: async path => createHash('sha256').update(await readFile(path)).digest('hex'), caseInsensitivePaths: process.platform !== 'linux' });
  return { handlers, async pickTarget(owner, source, path, kind) {
    const key = `${owner}:${basename(path)}`; targets.set(key, path);
    try { return await handlers.pickTarget(owner, { path: source, kind, defaultName: basename(path) }); }
    finally { targets.delete(key); }
  }, running: () => runner.running(), close: () => runner.cancelAll() };
}
