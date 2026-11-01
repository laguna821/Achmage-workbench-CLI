import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeFileSearchSettings, probeDecision, SearchReranker } from "../../../vendor/ieumoffice/apps/shell/src/main/file-index/rerank.ts";
import { fetchTransport } from "../../../vendor/ieumoffice/apps/shell/src/main/file-index/decider.ts";
import { FileIndexStore } from "../../../vendor/ieumoffice/apps/shell/src/main/file-index/store.ts";
import { extractText } from "../../../vendor/ieumoffice/apps/shell/src/main/file-index/extract.ts";
import { withoutUnsavedFiles } from "../../../vendor/ieumoffice/packages/electron-utils/src/unsaved-files.ts";
import { withOfficeDocuments } from "./office-open-files.mjs";
import { OfficeVault } from "./office-vault.ts";
import { HttpError } from "./errors.ts";

const REF = "__wb_file_search_key_", object = value => value && typeof value === "object" && !Array.isArray(value);
const hash = value => createHash("sha256").update(value).digest("hex"), stamp = info => `${info.mtimeMs}:${info.size}:${info.ino}`;
const fail = message => new HttpError(409, "office_file_search", message);
export function mapFileSearchKeys(raw, map) {
  if (!object(raw)) return raw;
  const keys = raw.keys ?? raw.jevKeys;
  return { ...raw, keys: Object.fromEntries(Object.entries(object(keys) ? keys : {}).map(([id, value]) => [id, typeof value === "string" && value ? map(value) : ""])) };
}
export const importedFileSearch = (value, map) => object(value) ? normalizeFileSearchSettings(mapFileSearchKeys(value, map)) : null;

/** Original settings, probe and reranker. Only already visible file candidates enter its index. */
export class OfficeFileSearch {
  constructor(dataDir, injected = {}) {
    this.directory = join(dataDir, "office"); this.path = join(this.directory, "file-search-settings.json");
    this.vault = injected.vault ?? new OfficeVault(dataDir); this.ownsVault = !injected.vault;
    this.send = injected.send ?? fetchTransport; this.queue = Promise.resolve(); this.rankQueue = Promise.resolve();
    this.cached = null; this.closed = false; this.active = new Set(); this.index = null; this.ranker = null; this.epoch = null;
  }
  current() {
    let raw = null;
    if (existsSync(this.path)) {
      const info = lstatSync(this.path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 2_000_000) throw fail("파일 검색 설정을 읽지 못했습니다. 현재 파일을 보존했습니다.");
      raw = readFileSync(this.path, "utf8");
    }
    if (this.cached?.raw === raw) return this.cached;
    let parsed = {}; try { if (raw !== null) parsed = JSON.parse(raw); } catch { throw fail("파일 검색 설정 JSON을 확인해 주세요. 현재 파일을 보존했습니다."); }
    if (!object(parsed)) throw fail("파일 검색 설정 형식을 확인해 주세요.");
    const refs = new Map(), settings = normalizeFileSearchSettings(mapFileSearchKeys(parsed, value => {
      const ref = `${REF}${randomUUID()}__`; refs.set(ref, value); return ref;
    }));
    return this.cached = { raw, parsed, settings, refs, revision: hash(raw === null ? "missing" : `file:${raw}`) };
  }
  snapshot() { const c = this.current(); return { revision: c.revision, settings: structuredClone(c.settings) }; }
  async plain(value, current = this.current()) {
    if (value.startsWith(REF)) {
      value = current.refs.get(value); if (value === undefined) throw fail("보관된 검색 키가 바뀌었습니다. 설정을 다시 열어 주세요.");
      return value.startsWith("sealed:v1:") ? this.vault.open(value) : value;
    }
    if (value.startsWith("sealed:")) throw fail("보관된 검색 키는 설정에서 다시 읽어 주세요.");
    return value;
  }
  async execution(draft) {
    const settings = normalizeFileSearchSettings(draft), endpoint = settings.endpoint;
    settings.keys = { ...settings.keys, [endpoint]: await this.plain(settings.keys[endpoint]) };
    return settings;
  }
  write(draft, revision, options = {}) {
    const next = this.queue.then(() => this.save(draft, revision, options)); this.queue = next.catch(() => {}); return next;
  }
  async save(draft, revision, { backup = false, signal, beforeCommit } = {}) {
    const c = this.current(), check = () => {
      signal?.throwIfAborted(); if (this.closed || this.current().revision !== revision) throw fail("파일 검색 설정이 바뀌었습니다. 설정을 다시 열어 주세요."); beforeCommit?.();
    };
    check(); if (!object(draft)) throw fail("파일 검색 설정을 확인해 주세요.");
    const settings = normalizeFileSearchSettings(draft);
    for (const [id, value] of Object.entries(settings.keys)) {
      const previous = value.startsWith(REF) ? c.refs.get(value) : undefined;
      settings.keys[id] = previous?.startsWith("sealed:v1:") ? previous : await this.vault.seal(await this.plain(value, c));
    }
    const next = { ...c.parsed, ...settings }; delete next.jevKeys; delete next.jevEndpoint;
    let backupPath = null, backupBytes;
    if (backup && c.raw !== null) {
      const bytes = Buffer.from(c.raw), chunks = [];
      for (let i = 0; i < bytes.length; i += 6000) chunks.push(await this.vault.seal(bytes.subarray(i, i + 6000).toString("base64")));
      backupPath = join(this.directory, `file-search-settings.${randomUUID()}.sealed-backup.json`);
      backupBytes = JSON.stringify({ version: 1, encoding: "base64", sha256: hash(bytes), chunks });
    }
    check(); mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      if (backupPath) writeFileSync(backupPath, backupBytes, { flag: "wx", mode: 0o600 });
      writeFileSync(temp, JSON.stringify(next, null, 2), { flag: "wx", mode: 0o600 }); check(); renameSync(temp, this.path);
    } finally { rmSync(temp, { force: true }); }
    return { snapshot: this.snapshot(), backup: backupPath };
  }
  async probe(draft, signal) {
    try {
      signal?.throwIfAborted(); const settings = await this.execution(draft); signal?.throwIfAborted();
      return await probeDecision(settings, (url, body, key, deadline) => this.send(url, body, key, signal ? AbortSignal.any([signal, deadline]) : deadline));
    } catch (error) { return { ok: false, error: error instanceof HttpError ? error.message : "연결 검사를 마치지 못했습니다." }; }
  }
  rank(query, candidates, documents, allowed, signal) {
    const next = this.rankQueue.then(() => withOfficeDocuments(documents, () => this.rankNow(query, candidates, allowed, signal))).catch(() => null);
    this.rankQueue = next.catch(() => {}); return next;
  }
  async rankNow(query, candidates, allowed, signal) {
    const c = this.current(); if (!c.settings.rerank || !query.trim() || candidates.length < 2 || this.closed || signal?.aborted) return null;
    const controller = new AbortController(); this.active.add(controller);
    const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    try {
      const settings = await this.execution(c.settings); combined.throwIfAborted();
      const safe = await withoutUnsavedFiles([...new Set(candidates)].slice(0, 20).filter(allowed), path => path);
      this.index ??= new FileIndexStore(":memory:");
      const files = [], stamps = new Map();
      for (const path of safe) {
        combined.throwIfAborted();
        let before; try { before = statSync(path); if (!before.isFile() || realpathSync(path) !== path) continue; } catch { continue; }
        const extracted = await extractText(path); combined.throwIfAborted();
        let after; try { after = statSync(path); } catch { continue; }
        if (extracted.kind !== "text" || stamp(before) !== stamp(after) || !allowed(path)) continue;
        this.index.upsert({ path, mtimeMs: after.mtimeMs, sizeBytes: after.size }, extracted.text, "ok");
        files.push(path); stamps.set(path, stamp(after));
      }
      const live = path => {
        try { return allowed(path) && realpathSync(path) === path && stamps.get(path) === stamp(statSync(path)); } catch { return false; }
      };
      const check = async () => {
        combined.throwIfAborted();
        if (this.current().revision !== c.revision || files.some(path => !live(path)) || (await withoutUnsavedFiles(files, path => path)).length !== files.length) throw fail("검색할 파일이나 설정이 바뀌었습니다.");
      };
      await check(); const epoch = [c.revision, ...files.map(path => `${path}:${stamps.get(path)}`)].join("\n");
      if (this.epoch !== epoch) {
        this.epoch = epoch;
        this.ranker = new SearchReranker(this.index, async (url, body, key, deadline) => {
          await this.running.check(); return this.send(url, body, key, AbortSignal.any([deadline, this.running.signal]));
        });
      }
      this.running = { check, signal: combined };
      const result = await this.ranker.rerank(query.trim().slice(0, 200), files, settings); await check();
      return result;
    } catch { return null; }
    finally { this.running = null; this.active.delete(controller); }
  }
  async rankPage(query, page, manager, signal) {
    const hits = page.groups.flatMap(group => group.hits), paths = hits.map(hit => manager.finder.fileForHit(hit)).filter(Boolean).slice(0, 20);
    const allowed = path => hits.some(hit => manager.finder.fileForHit(hit) === path);
    const result = await this.rank(query, paths, manager.documents, allowed, signal); if (!result) return page;
    const order = new Map(result.order.map((path, i) => [path, i]));
    const groups = page.groups.map(group => {
      const ranked = hit => order.has(manager.finder.fileForHit(hit));
      const files = group.hits.filter(ranked).sort((a, b) => order.get(manager.finder.fileForHit(a)) - order.get(manager.finder.fileForHit(b)));
      let at = 0; return { ...group, hits: group.hits.map(hit => ranked(hit) ? files[at++] : hit) };
    });
    return { ...page, groups, reranked: true };
  }
  close() { if (this.closed) return; this.closed = true; for (const active of this.active) active.abort(); void this.rankQueue.finally(() => this.index?.close()); if (this.ownsVault) this.vault.close(); }
}
