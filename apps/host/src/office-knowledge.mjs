import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { readStarredItems, writeStarredItems, dropStarredItems, assignStarredGroup, starredGroupNames } from "../../../vendor/ieumoffice/apps/docs/src/main/starred-files.ts";
import { listKnowledgeFiles, searchSavedKnowledgeBase, readKnowledgeFilePage } from "../../../vendor/ieumoffice/apps/shell/src/main/knowledge-base.ts";
import { FileIndexStore } from "../../../vendor/ieumoffice/apps/shell/src/main/file-index/store.ts";
import { extractText } from "../../../vendor/ieumoffice/apps/shell/src/main/file-index/extract.ts";
import { setOpenFilesSource, withoutUnsavedFiles } from "../../../vendor/ieumoffice/packages/electron-utils/src/unsaved-files.ts";
import { isWorkbenchPath } from "./artifacts.ts";
import { HttpError } from "./errors.ts";

const currentDocuments = new AsyncLocalStorage();
setOpenFilesSource(() => {
  const documents = currentDocuments.getStore();
  return documents ? documents.registry.list().map(view => ({ filePath: documents.get(view.artifactId).path, dirty: view.dirty })) : [];
});
const invalid = () => new HttpError(400, "office_knowledge", "지식베이스 요청을 확인해 주세요.");
const denied = () => new HttpError(403, "office_knowledge_scope", "지식베이스에 등록된 파일만 읽을 수 있습니다.");
const stamp = value => `${value.mtimeMs}:${value.size}`;

/** Original star/group store, FTS tokenizer, redaction-aware parser and AI paging. */
export class OfficeKnowledge {
  constructor(dataDir, manager) {
    this.manager = manager; this.closed = false; this.queue = Promise.resolve();
    const root = join(dataDir, "office", "knowledge"); mkdirSync(root, { recursive: true });
    this.path = join(root, "starred.json"); this.index = new FileIndexStore(join(root, "index.sqlite"));
  }
  check(signal) { if (this.closed) throw new Error("지식베이스를 종료하고 있습니다."); signal?.throwIfAborted(); }
  physical(path) {
    if (typeof path !== "string" || !isAbsolute(path) || path.length > 8192 || isWorkbenchPath(path)) throw invalid();
    const physical = realpathSync(path);
    if (isWorkbenchPath(physical) || !statSync(physical).isFile()) throw invalid();
    return physical;
  }
  items() {
    this.check(); let key = "missing";
    try { const meta = statSync(this.path); key = `${stamp(meta)}:${meta.ino}`; } catch { /* first use */ }
    if (this.itemStamp !== key) { this.itemStamp = key; this.itemCache = readStarredItems(this.path); }
    return this.itemCache;
  }
  selected(path) {
    if (!this.items().some(item => item.path === path)) return false;
    try { return this.physical(path) === path; } catch { return false; }
  }
  paths(group) {
    return this.items().filter(item => group === undefined || (item.group ?? "") === group).flatMap(item => {
      // A replaced link must not turn a previously selected file into a different file.
      try { return this.physical(item.path) === item.path ? [item.path] : []; } catch { return []; }
    });
  }
  library() {
    const items = this.items(), files = new Map(listKnowledgeFiles(this.paths()).map(file => [file.path, file]));
    return { items: items.map(item => ({ ...item, missing: !files.has(item.path), ...(files.has(item.path) ? { file: files.get(item.path) } : {}) })), groups: starredGroupNames(items) };
  }
  async manage(action, input = {}, signal = new AbortController().signal) {
    this.check(signal);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
    if (action === "list") return this.library();
    if (action === "search") return this.search(input.query, input.limit ?? 20, input.group, signal);
    if (!Array.isArray(input.paths) || !input.paths.length || input.paths.length > 500 || input.paths.some(path => typeof path !== "string" || path.length > 8192)) throw invalid();
    if (input.group !== undefined && input.group !== null && (typeof input.group !== "string" || input.group.length > 200)) throw invalid();
    const items = this.items(); let next;
    if (action === "add") {
      const paths = [...new Set(input.paths.map(path => this.physical(path)))];
      next = [...items, ...paths.filter(path => !items.some(item => item.path === path)).map(path => ({ path, ...(input.group?.trim() ? { group: input.group.trim() } : {}) }))];
      if (next.length > 5000) throw new Error("지식베이스 파일은 5,000개까지 등록할 수 있습니다.");
    } else if (action === "remove") next = dropStarredItems(items, input.paths);
    else if (action === "group") next = assignStarredGroup(items, input.paths, input.group ?? null);
    else throw invalid();
    if (next) { writeStarredItems(this.path, next); this.itemStamp = null; }
    if (action === "remove") this.index.remove(input.paths);
    return this.library();
  }
  async refresh(signal) {
    const refresh = this.queue.catch(() => {}).then(async () => {
      this.check(signal);
      const paths = await withoutUnsavedFiles(this.paths(), path => path);
      const keep = new Set(paths);
      this.index.remove([...this.index.listAll().keys()].filter(path => !keep.has(path)));
      const fresh = new Set(this.index.pathsIndexedAsOnDisk(paths));
      for (const path of paths) {
        this.check(signal); if (fresh.has(path)) continue;
        let before; try { before = statSync(path); } catch { continue; }
        const text = await extractText(path);
        this.check(signal);
        if (!this.selected(path) || (await withoutUnsavedFiles([path], path => path)).length !== 1) continue;
        let after; try { after = statSync(path); } catch { continue; }
        if (stamp(before) !== stamp(after)) continue;
        this.index.upsert({ path, mtimeMs: after.mtimeMs, sizeBytes: after.size }, text.kind === "text" ? text.text : null, text.kind === "text" ? "ok" : text.kind);
      }
    });
    this.queue = refresh; return refresh;
  }
  async search(query, limit, group, signal) {
    if (typeof query !== "string" || query.length > 200 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20 || group !== undefined && typeof group !== "string") throw invalid();
    return currentDocuments.run(this.manager.documents, async () => {
      await this.refresh(signal); this.check(signal);
      const paths = this.index.pathsIndexedAsOnDisk(this.paths(group));
      const hits = await searchSavedKnowledgeBase((q, pool) => this.index.search(q, { limit: pool }).hits.map(hit => ({ ...hit, snippetText: (hit.snippet ?? []).map(part => part.text).join("") })), query, paths, limit);
      this.check(signal);
      const live = new Set(this.index.pathsIndexedAsOnDisk(await withoutUnsavedFiles(this.paths(group), path => path)));
      return hits.filter(hit => live.has(hit.path));
    });
  }
  async tool(name, args, signal) {
    this.check(signal);
    if (!Array.isArray(args)) throw invalid();
    if (name === "knowledge-list" && !args.length) return listKnowledgeFiles(this.paths());
    if (name === "knowledge-search" && args.length === 2) return this.search(args[0], args[1], undefined, signal);
    if (name !== "knowledge-read" || args.length !== 2 || typeof args[0] !== "string" || !Number.isSafeInteger(args[1]) || args[1] < 0) throw invalid();
    const path = args[0]; if (!this.selected(path)) throw denied();
    const before = statSync(path);
    const page = await currentDocuments.run(this.manager.documents, () => readKnowledgeFilePage(path, args[1]));
    this.check(signal);
    if (!this.selected(path) || stamp(before) !== stamp(statSync(path))) throw denied();
    const saved = await currentDocuments.run(this.manager.documents, () => withoutUnsavedFiles([path], path => path));
    if (!saved.length) throw new Error("편집 중인 지식베이스 파일을 저장한 뒤 다시 읽어 주세요.");
    return page;
  }
  open(artifactId, token, grants, path) {
    this.check();
    const access = grants.access(token), sessionId = grants.session(token);
    const view = this.manager.documents.registry.forArtifact(artifactId).find(item => item.viewId === access?.viewId);
    if (!grants.allows(token, artifactId) || !view || view.sessionId !== sessionId || !this.selected(path)) throw denied();
    const source = this.manager.documents.get(artifactId);
    if (sessionId) this.manager.office.scope(artifactId, sessionId);
    const target = this.manager.openFile(source.workId, path, source.workspaceId, sessionId ?? undefined);
    return { artifactId: target.id, workId: target.workId, workspaceId: target.workspaceId };
  }
  close() { this.closed = true; this.index.close(); }
}
