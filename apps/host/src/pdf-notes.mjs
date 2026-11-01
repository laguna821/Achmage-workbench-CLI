import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createNoteLinkService, parseNoteInsertRequest, parseNoteOpenRequest } from "../../../vendor/ieumoffice/apps/pdf/src/main/note-link.ts";
import { officeResultStore } from "./office-results.mjs";
import { isWorkbenchPath } from "./artifacts.ts";
import { HttpError } from "./errors.ts";

const fail = message => new HttpError(409, "pdf_note", message);
/** The original note service owns link/quote rules; only a live Markdown writer takes text. */
export class PdfNotes {
  constructor(manager, bus) {
    this.manager = manager; this.bus = bus; this.context = new AsyncLocalStorage(); this.owners = new Map(); this.nextOwner = 0;
    this.pending = new Map(); this.completed = new Map(); this.closed = false;
    this.store = officeResultStore(join(manager.documents.dataDir, "office"));
    const current = () => { const value = this.context.getStore(); if (!value) throw fail("노트 요청이 없습니다."); value.check(); return value; };
    this.service = createNoteLinkService({
      store: () => this.store,
      hashFile: async path => createHash("sha256").update(await readFile(path)).digest("hex"),
      // Workbench creates new PDFs at a chosen, already saved path.
      isUntitled: () => false, noteWord: () => "노트",
      pickNotePath: async (_owner, defaultPath) => {
        const ctx = current();
        if (ctx.input.selectedPath === undefined) { ctx.choosePath = defaultPath; return null; }
        return this.notePath(ctx.input.selectedPath, true);
      },
      createNoteFile: async (path, text) => {
        current(); await this.notePath(path, true); current();
        try { await writeFile(path, text, { encoding: "utf8", flag: "wx", mode: 0o600 }); return true; }
        catch (error) { if (error.code === "EEXIST") return false; throw error; }
      },
      host: () => ({ openNote: path => this.open(current(), path), insertIntoNote: (path, text) => this.open(current(), path, text) }),
    });
    this.unsubscribe = bus.subscribe(event => {
      if (event.type === "artifact.upserted" && event.artifact.format === "pdf") void this.service.afterSave(event.artifact.path);
    });
    this.timer = setInterval(() => this.prune(), 1000); this.timer.unref();
  }
  prune() {
    const live = new Set(this.manager.documents.registry.list().map(view => view.viewId));
    for (const [path, entry] of this.pending) if (Date.now() - entry.at > 300_000 || entry.viewId && !live.has(entry.viewId)) this.pending.delete(path);
    for (const [id, entry] of this.completed) if (Date.now() - entry.at > 600_000) this.completed.delete(id);
    for (const id of this.owners.keys()) if (!live.has(id)) this.owners.delete(id);
  }
  async notePath(raw, mayCreate = false) {
    if (typeof raw !== "string" || raw.length > 8192 || !isAbsolute(raw)) throw fail("노트 파일의 전체 경로를 선택해 주세요.");
    const requested = resolve(/\.md$/i.test(raw) ? raw : `${raw}.md`);
    const path = join(await realpath(dirname(requested)), basename(requested));
    if (isWorkbenchPath(path) || /(?:^|[\\/])\.git(?:[\\/]|$)/.test(path)) throw fail("작업 관리 폴더 밖에 노트를 저장해 주세요.");
    try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw fail("일반 Markdown 파일을 선택해 주세요."); }
    catch (error) { if (!(mayCreate && error.code === "ENOENT")) throw error; }
    return path;
  }
  scope(artifactId, token, grants) {
    const documents = this.manager.documents, access = grants.access(token), session = grants.session(token);
    const check = () => {
      const view = documents.registry.list().find(view => view.viewId === access?.viewId && view.artifactId === artifactId);
      if (this.closed || !grants.allows(token, artifactId) || !view || view.sessionId !== session) throw fail("노트를 요청한 문서 창이나 대화가 바뀌었습니다.");
      return view;
    };
    check(); return { artifact: documents.get(artifactId), access, check };
  }
  async open(ctx, raw, text) {
    const path = await this.notePath(raw); ctx.check(); this.prune();
    const current = this.pending.get(path);
    if (text && (current?.texts.length >= 20 || [...this.pending.values()].reduce((n, value) => n + value.texts.join("").length, 0) + text.length > 2_000_000)) throw fail("노트 탭에서 추가된 내용을 확인한 뒤 다시 보내 주세요.");
    const tracked = this.manager.openFile(ctx.artifact.workId, path, ctx.artifact.workspaceId);
    const writer = this.manager.documents.registry.forArtifact(tracked.id).find(view => view.mode === "write");
    ctx.target = writer ? this.manager.documents.get(writer.artifactId) : tracked;
    if (text) {
      const entry = current ?? { texts: [], viewId: writer?.viewId ?? null, at: Date.now() };
      entry.texts.push(text); entry.at = Date.now(); this.pending.set(path, entry);
      this.bus.publish({ type: "office.note.ready", artifactId: ctx.target.id });
    }
    return true;
  }
  async action(artifactId, token, grants, action, input = {}) {
    const scope = this.scope(artifactId, token, grants);
    if (action === "take") {
      if (scope.artifact.format !== "markdown") throw fail("Markdown 노트에서만 내용을 받을 수 있습니다.");
      this.manager.documents.registry.assertWrite(artifactId, scope.access);
      const path = await this.notePath(scope.artifact.path); scope.check(); this.prune();
      const pending = this.pending.get(path);
      if (!pending || pending.viewId && pending.viewId !== scope.access.viewId) return [];
      this.pending.delete(path); return pending.texts;
    }
    if (scope.artifact.format !== "pdf" || !["open", "insert"].includes(action) || !input || typeof input !== "object" || typeof input.requestId !== "string" || !/^[\w-]{1,100}$/.test(input.requestId)) throw fail("PDF 노트 요청을 확인해 주세요.");
    const request = action === "insert" ? parseNoteInsertRequest(input.request) : parseNoteOpenRequest(input.request);
    if (!request) throw fail("노트에 넣을 본문과 쪽 번호를 확인해 주세요.");
    const key = `${scope.access.viewId}:${input.requestId}`, fingerprint = JSON.stringify([action, request, input.selectedPath]);
    const done = this.completed.get(key);
    if (done) { if (done.fingerprint !== fingerprint) throw fail("노트 요청 내용이 바뀌었습니다."); return done.value; }
    if (!this.owners.has(scope.access.viewId)) this.owners.set(scope.access.viewId, ++this.nextOwner);
    const ctx = { ...scope, input, choosePath: null, target: null };
    const result = await this.context.run(ctx, () => this.service[action](this.owners.get(scope.access.viewId), scope.artifact.path, request));
    scope.check();
    const value = { ...result, ...(ctx.choosePath ? { choosePath: ctx.choosePath } : {}), ...(ctx.target ? { artifact: ctx.target } : {}) };
    if (result.ok) { this.completed.set(key, { value, fingerprint, at: Date.now() }); if (this.completed.size > 256) this.completed.delete(this.completed.keys().next().value); }
    return value;
  }
  close() { this.closed = true; clearInterval(this.timer); this.unsubscribe(); this.pending.clear(); this.completed.clear(); }
}
