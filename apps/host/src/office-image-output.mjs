import { realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ImageExportSessions } from "../../../vendor/ieumoffice/apps/markdown/src/main/image-export.ts";
import { isWorkbenchPath } from "./artifacts.ts";
import { HttpError } from "./errors.ts";

const fail = (message) => new HttpError(409, "image_output", message);
/** Original page writer, owned by the live document view and a parent-chosen folder. */
export class OfficeImageOutputs {
  constructor(documents) {
    this.documents = documents; this.sessions = new ImageExportSessions(); this.jobs = new Map();
    this.sequence = 0; this.queue = Promise.resolve(); this.closed = false;
    this.timer = setInterval(() => { void this.reconcile().catch(() => {}); }, 30_000);
    this.timer.unref();
  }
  run(task) { const next = this.queue.then(task); this.queue = next.catch(() => {}); return next; }
  scope(artifactId, access) {
    const source = this.documents.get(artifactId);
    const view = this.documents.registry.list().find(v => v.viewId === access?.viewId && v.artifactId === artifactId);
    if (this.closed || !view || source.format !== "markdown") throw fail("그림으로 내보낼 Markdown 문서 창을 다시 확인해 주세요.");
    return { source, view };
  }
  async discard(id) {
    const job = this.jobs.get(id); if (!job) return;
    this.jobs.delete(id); await this.sessions.dispose(job.owner);
  }
  async prune() {
    const views = this.documents.registry.list();
    for (const [id, job] of this.jobs) if (job.expires < Date.now() || !views.some(v => v.viewId === job.viewId && v.artifactId === job.artifactId && v.sessionId === job.sessionId)) await this.discard(id);
  }
  reconcile() { return this.run(() => this.prune()); }
  prepare(artifactId, revision, parent, name, access) {
    return this.run(async () => {
      await this.prune();
      const { source, view } = this.scope(artifactId, access);
      if (!Number.isSafeInteger(revision) || revision < 1 || revision > source.revision) throw fail("문서 판 번호를 다시 확인해 주세요.");
      if (typeof parent !== "string" || !parent.trim() || parent.length > 4096 || parent.includes("\0") || typeof name !== "string" || name.length > 255 || /[\x00-\x1f]/.test(name)) throw fail("그림을 저장할 폴더와 이름을 확인해 주세요.");
      const directory = realpathSync(resolve(dirname(source.path), parent));
      if (!statSync(directory).isDirectory() || isWorkbenchPath(directory)) throw fail("그림을 저장할 일반 폴더를 선택해 주세요.");
      if (this.jobs.size >= 8) throw fail("진행 중인 그림 출력을 마친 뒤 다시 시도해 주세요.");
      const owner = ++this.sequence, id = await this.sessions.start(owner, directory, name);
      this.jobs.set(id, { owner, artifactId, viewId: view.viewId, sessionId: view.sessionId, size: 0, expires: Date.now() + 30 * 60_000 });
      try { this.scope(artifactId, access); await this.prune(); if (!this.jobs.has(id)) throw fail("문서 창이 닫혔습니다."); }
      catch (error) { await this.discard(id); throw error; }
      return { id };
    });
  }
  own(artifactId, id, access) {
    const job = this.jobs.get(id), { view } = this.scope(artifactId, access);
    if (!job || job.artifactId !== artifactId || job.viewId !== view.viewId || job.sessionId !== view.sessionId) throw fail("이 문서에서 시작한 그림 출력만 사용할 수 있습니다.");
    return job;
  }
  write(artifactId, id, page, base64, access) {
    return this.run(async () => {
      await this.prune(); const job = this.own(artifactId, id, access);
      if (typeof base64 !== "string" || base64.length > 70_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || !Number.isSafeInteger(page) || page > 1000) throw fail("출력할 PNG 그림의 형식이나 크기를 확인해 주세요.");
      const size = Buffer.byteLength(base64, "base64");
      if (job.size + size > 200_000_000) throw fail("그림 출력 합계가 200MB를 넘습니다. 문서를 나눠 출력해 주세요.");
      await this.sessions.write(job.owner, id, page, base64);
      job.size += size; job.expires = Date.now() + 30 * 60_000;
      return { ok: true };
    });
  }
  finish(artifactId, id, success, access) {
    return this.run(async () => {
      await this.prune();
      if (success === false && !this.jobs.has(id)) return { ok: true, canceled: true };
      const job = this.own(artifactId, id, access);
      if (typeof success !== "boolean") throw fail("그림 출력 완료 상태가 올바르지 않습니다.");
      try {
        const path = await this.sessions.finish(job.owner, id, success);
        return path ? { ok: true, path } : { ok: true, canceled: true };
      } finally { this.jobs.delete(id); }
    });
  }
  close() {
    this.closed = true; clearInterval(this.timer);
    return this.run(async () => { for (const id of this.jobs.keys()) await this.discard(id); });
  }
}
