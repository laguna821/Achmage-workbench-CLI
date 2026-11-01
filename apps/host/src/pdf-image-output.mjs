import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { buildExportImagePaths, hasValidExportPageNumbers } from '../../../vendor/ieumoffice/apps/pdf/src/main/export-images.ts';
import { isWorkbenchPath } from './artifacts.ts';
import { HttpError } from './errors.ts';

const stores = new WeakMap(), fail = message => new HttpError(409, 'pdf_images', message);
const png = bytes => bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
export function pdfImageOutputs(documents) {
  let store = stores.get(documents); if (!store) stores.set(documents, store = new PdfImageOutputs(documents)); return store;
}
/** Only parent-selected new folders; a failed job removes only its own unfinished files. */
class PdfImageOutputs {
  constructor(documents) {
    this.documents = documents; this.jobs = new Map(); this.closed = false;
    this.timer = setInterval(() => { void this.prune().catch(() => {}); }, 1000); this.timer.unref();
  }
  scope(artifactId, access) {
    const source = this.documents.get(artifactId), view = this.documents.registry.list().find(v => v.viewId === access?.viewId && v.artifactId === artifactId);
    if (this.closed || source.format !== 'pdf' || !view) throw fail('그림을 내보낼 PDF 문서 창을 다시 확인해 주세요.');
    return { source, view };
  }
  own(artifactId, id, access) {
    const job = this.jobs.get(id), { source, view } = this.scope(artifactId, access);
    if (!job || job.canceled || job.artifactId !== artifactId || job.viewId !== view.viewId || job.sessionId !== view.sessionId || job.sourcePath !== source.path) throw fail('이 문서에서 시작한 그림 출력만 사용할 수 있습니다.');
    return job;
  }
  async discard(id) { const job = this.jobs.get(id); if (!job) return; if (job.busy) { job.canceled = true; return; } this.jobs.delete(id); await rm(job.path, { recursive: true, force: true }); }
  async prune() {
    const views = this.documents.registry.list();
    for (const [id, job] of this.jobs) if (Date.now() > job.expires || !views.some(v => v.viewId === job.viewId && v.artifactId === job.artifactId && v.sessionId === job.sessionId)) await this.discard(id);
  }
  async prepare(artifactId, revision, parent, name, access) {
    await this.prune(); const { source, view } = this.scope(artifactId, access);
    if (!Number.isSafeInteger(revision) || revision < 1 || revision > source.revision || typeof parent !== 'string' || parent.length > 4096 || !parent.trim() || parent.includes('\0') || typeof name !== 'string' || name.length > 200 || /[\x00-\x1f]/.test(name)) throw fail('그림을 저장할 폴더와 문서 이름을 확인해 주세요.');
    if (this.jobs.size >= 8) throw fail('진행 중인 그림 출력을 마친 뒤 다시 시도해 주세요.');
    const root = await realpath(resolve(dirname(source.path), parent));
    if (!(await lstat(root)).isDirectory() || isWorkbenchPath(root) || /(?:^|[\\/])\.git(?:[\\/]|$)/.test(root)) throw fail('그림을 저장할 일반 폴더를 선택해 주세요.');
    const safeName = name.replace(/[/\\:*?"<>|]/g, '_').slice(0, 80).trim() || 'PDF';
    const path = await mkdtemp(join(root, `${safeName}-images-`)), id = randomUUID();
    this.jobs.set(id, { id, path, artifactId, sourcePath: source.path, revision, viewId: view.viewId, sessionId: view.sessionId, busy: false, canceled: false, expires: Date.now() + 30 * 60_000 });
    try { this.own(artifactId, id, access); } catch (error) { await this.discard(id); throw error; }
    return { id };
  }
  async run(artifactId, id, access, revision, task) {
    const job = this.own(artifactId, id, access);
    if (job.busy || job.complete || job.revision !== revision) throw fail('그림 출력이 진행 중이거나 원본 판이 바뀌었습니다.');
    job.busy = true;
    try { const value = await task(job.path); this.own(artifactId, id, access); job.complete = true; return value; }
    catch (error) { job.canceled = true; throw error; }
    finally { job.busy = false; if (job.canceled) await this.discard(id); }
  }
  async write(artifactId, id, request, access) {
    const job = this.own(artifactId, id, access), { images, pageNumbers, baseName } = request ?? {};
    if (!Array.isArray(images) || !images.length || images.length > 1000 || !hasValidExportPageNumbers(pageNumbers, images.length) || typeof baseName !== 'string' || baseName.length > 200 || /[\x00-\x1f]/.test(baseName)) throw fail('출력할 페이지 그림을 확인해 주세요.');
    return this.run(artifactId, id, access, job.revision, async path => {
      const targets = buildExportImagePaths(path, baseName, pageNumbers); let size = 0;
      for (let i = 0; i < images.length; i++) {
        this.own(artifactId, id, access); const encoded = images[i];
        if (typeof encoded !== 'string' || encoded.length > 70_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw fail('PNG 그림 형식이나 크기를 확인해 주세요.');
        const bytes = Buffer.from(encoded, 'base64'); size += bytes.length;
        if (!png(bytes) || size > 200_000_000) throw fail('PNG 그림이 아니거나 그림 출력 합계가 200MB를 넘습니다.');
        await writeFile(targets[i], bytes, { flag: 'wx', mode: 0o600 });
      }
      return { ok: true };
    });
  }
  async finish(artifactId, id, success, access) {
    if (success === false && !this.jobs.has(id)) return { ok: true, canceled: true };
    const job = this.own(artifactId, id, access);
    if (typeof success !== 'boolean') throw fail('그림 출력 완료 상태를 확인해 주세요.');
    if (!success) { await this.discard(id); return { ok: true, canceled: true }; }
    if (job.busy || !job.complete) throw fail('그림 출력을 마친 뒤 확인해 주세요.');
    try {
      const files = []; let size = 0;
      for (const name of await readdir(job.path)) {
        const path = join(job.path, name), info = await lstat(path); size += info.size;
        if (!info.isFile() || info.isSymbolicLink() || !name.endsWith('.png') || size > 200_000_000 || files.length >= 1000 || !png(await readFile(path))) throw fail('출력한 그림을 확인하지 못했습니다.');
        files.push(path);
      }
      this.own(artifactId, id, access);
      if (!files.length) { await this.discard(id); return { ok: true, files: [] }; }
      this.jobs.delete(id); return { ok: true, path: job.path, files: files.sort() };
    } catch (error) { await this.discard(id); throw error; }
  }
  async close() { this.closed = true; clearInterval(this.timer); await Promise.all([...this.jobs.keys()].map(id => this.discard(id))); }
}
