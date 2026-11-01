import { extname } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { type CachedSearchRow, SearchIndex } from "./search-index.ts";
import { type FastFindDocument, type FastFindMetadata, SearchService } from "./search-service.ts";

export type SearchProgress = { phase: "idle" | "indexing" | "ready" | "error"; indexed: number; total: number; error: string | null };
type Part = { key: string; offset: number };
const CHUNK = 48_000;
const OVERLAP = 256;

/** Full source text stays in the local cache; long messages use bounded, overlapping paragraph
 * chunks in the engine. Every result maps back to the original message/document identity. */
export function searchChunks(text: string): { text: string; offset: number }[] {
  if (text.length <= CHUNK) return [{ text, offset: 0 }];
  const out: { text: string; offset: number }[] = [];
  for (let from = 0; from < text.length;) {
    let to = Math.min(text.length, from + CHUNK);
    if (to < text.length) {
      const paragraph = text.lastIndexOf("\n\n", to);
      if (paragraph > from + CHUNK / 2) to = paragraph + 2;
      if (/[\uD800-\uDBFF]/.test(text[to - 1]!)) to -= 1;
    }
    out.push({ text: text.slice(from, to), offset: from });
    if (to === text.length) break;
    from = to - OVERLAP;
    if (/[\uDC00-\uDFFF]/.test(text[from]!)) from -= 1;
  }
  return out;
}

/** One host's cache-to-worker projection. UI, saved views and AI share this instance.
 * Notifications only enqueue keys: their committed rows are read in the next event turn. */
export class SearchProjection {
  readonly service: SearchService;
  private readonly parts = new Map<string, Part[]>();
  private readonly sources = new Map<string, { source: string; offset: number }>();
  private readonly dirty = new Set<string>();
  private readonly unsubscribe: () => void;
  private revision = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private boot: Promise<void> | null = null;
  private first: Promise<void> | null = null;
  private chain = Promise.resolve();
  private reset = false;
  private closed = false;
  private progress: SearchProgress = { phase: "idle", indexed: 0, total: 0, error: null };
  private readonly index: SearchIndex;
  private readonly metadata: (row: CachedSearchRow) => Partial<FastFindMetadata>;

  constructor(index: SearchIndex, metadata: (row: CachedSearchRow) => Partial<FastFindMetadata>, service = new SearchService()) {
    this.index = index; this.metadata = metadata;
    this.service = service;
    this.unsubscribe = index.subscribe((keys) => {
      if (keys === null) this.reset = true;
      else for (const key of keys) this.dirty.add(key);
      if (this.boot && !this.timer) {
        this.timer = setTimeout(() => { this.timer = null; void this.flush().catch((error: unknown) => this.failed(error)); }, 20);
        this.timer.unref();
      }
    });
  }

  state(): SearchProgress { return { ...this.progress }; }
  source(key: string) { return this.sources.get(key) ?? null; }
  keys(source: string): string[] { return this.parts.get(source)?.map((p) => p.key) ?? []; }

  private failed(error: unknown) {
    this.progress = { ...this.progress, phase: "error", error: error instanceof Error ? error.message : String(error) };
  }

  /** The first batch is searchable before the remaining raw cache has been loaded. */
  ready(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("검색 서비스가 종료되었습니다."));
    if (this.first) return this.first;
    let done!: () => void, fail!: (error: unknown) => void;
    this.first = new Promise<void>((resolve, reject) => { done = resolve; fail = reject; });
    this.progress = { phase: "indexing", indexed: 0, total: this.index.stats().rows, error: null };
    this.boot = (async () => {
      await this.service.start();
      let after = 0, initial = true;
      while (!this.closed) {
        let count = 0;
        await this.serial(async () => {
          // Read after earlier queued mutations, otherwise a stale bootstrap snapshot could
          // overwrite a newer edit with a higher worker revision.
          const rows = this.index.cached({ after, limit: 100 });
          if (!rows.length) return;
          await this.put(rows); after = rows.at(-1)!.id; count = rows.length;
        });
        if (!count) break;
        this.progress.indexed += count;
        if (initial) { initial = false; done(); }
        await nextTurn();
      }
      done();
      if (!this.closed) {
        await this.flush();
        this.progress = { ...this.progress, phase: "ready", indexed: this.index.stats().rows, total: this.index.stats().rows };
      }
    })().catch((error: unknown) => { this.failed(error); fail(error); throw error; });
    // UI callers can use the first batch without awaiting completion; keep a handled background
    // promise, while settled() still reports any eventual error to strict AI/API callers.
    void this.boot.catch(() => {});
    return this.first;
  }

  async settled() { await this.ready(); await this.boot; await this.flush(); }

  private serial(fn: () => Promise<void>) {
    const next = this.chain.then(fn);
    this.chain = next.catch(() => {});
    return next;
  }

  private async put(rows: CachedSearchRow[]) {
    const docs: FastFindDocument[] = [], removed: { key: string; revision: number }[] = [];
    for (const row of rows) {
      const revision = ++this.revision;
      const chunks = searchChunks(row.body);
      const parts = chunks.map((chunk, n): Part => ({ key: n ? `${row.key}\u001f${n}${extname(row.path ?? "")}` : row.key, offset: chunk.offset }));
      for (const old of this.parts.get(row.key) ?? []) if (!parts.some((p) => p.key === old.key)) {
        removed.push({ key: old.key, revision }); this.sources.delete(old.key);
      }
      this.parts.set(row.key, parts);
      for (let n = 0; n < parts.length; n++) {
        const part = parts[n]!;
        this.sources.set(part.key, { source: row.key, offset: part.offset });
        docs.push({ key: part.key, revision, mtime: row.at / 1000, text: chunks[n]!.text,
          fields: { ...row.fields, title: n ? "" : row.fields.title, aliases: n ? [] : row.fields.aliases,
            properties: row.fields.properties.map(([key, values]) => ({ key, values: values ?? [] })) },
          metadata: { kind: row.kind, scope: row.scope, workId: row.workId, sessionId: row.sessionId,
            ...this.metadata(row), dedupKey: row.key },
        });
      }
    }
    for (let i = 0; i < removed.length; i += 100) await this.service.remove(removed.slice(i, i + 100));
    // Bound both count and bytes: a huge source message cannot exceed the protocol's 32MB frame.
    let batch: FastFindDocument[] = [], bytes = 0;
    for (const doc of docs) {
      const size = Buffer.byteLength(JSON.stringify(doc));
      if (batch.length && (batch.length >= 100 || bytes + size > 8 * 1024 * 1024)) {
        await this.service.upsert(batch); batch = []; bytes = 0;
      }
      batch.push(doc); bytes += size;
    }
    if (batch.length) await this.service.upsert(batch);
  }

  async flush(): Promise<void> {
    if (!this.boot || this.closed) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    await this.serial(async () => {
      if (this.reset) {
        this.reset = false;
        const deleted = [...this.sources.keys()].map((key) => ({ key, revision: ++this.revision }));
        for (let i = 0; i < deleted.length; i += 100) await this.service.remove(deleted.slice(i, i + 100));
        this.parts.clear(); this.sources.clear();
        // A rebuild can put existing keys back in the same synchronous transaction.
        let after = 0;
        for (;;) {
          const rows = this.index.cached({ after, limit: 100 });
          if (!rows.length) break;
          await this.put(rows); after = rows.at(-1)!.id;
          await nextTurn();
        }
      }
      while (this.dirty.size && !this.closed) {
        const keys = [...this.dirty].slice(0, 100);
        keys.forEach((key) => this.dirty.delete(key));
        const rows = this.index.cached({ keys, limit: 100 });
        const live = new Set(rows.map((row) => row.key));
        const removed = keys.filter((key) => !live.has(key)).flatMap((key) => {
          const parts = this.parts.get(key) ?? []; this.parts.delete(key);
          return parts.map((part) => { this.sources.delete(part.key); return { key: part.key, revision: ++this.revision }; });
        });
        for (let i = 0; i < removed.length; i += 100) await this.service.remove(removed.slice(i, i + 100));
        await this.put(rows);
      }
    });
  }

  async close() {
    this.closed = true; this.unsubscribe();
    if (this.timer) clearTimeout(this.timer);
    await this.boot?.catch(() => {}); await this.chain;
    await this.service.close();
  }
}
