/** Bounded blob cache. Visible thumbnails/gallery own leases; inactive blobs are evicted. */
export class MediaCache {
  private entries = new Map<string, { promise: Promise<string>; refs: number; bytes: number; url: string | null; used: number }>();
  private readonly load: (key: string) => Promise<Blob>;
  private readonly maxBytes: number;
  private readonly maxIdle: number;
  constructor(load: (key: string) => Promise<Blob>, maxBytes = 64 * 1024 * 1024, maxIdle = 24) {
    this.load = load; this.maxBytes = maxBytes; this.maxIdle = maxIdle;
  }
  retain(key: string) {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { promise: Promise.resolve(""), refs: 0, bytes: 0, url: null, used: Date.now() };
      const own = entry;
      own.promise = this.load(key).then(blob => {
        own.url = URL.createObjectURL(blob); own.bytes = blob.size;
        this.evict(); return own.url;
      }).catch(error => { if (this.entries.get(key) === own) this.entries.delete(key); throw error; });
      this.entries.set(key, own);
    }
    entry.refs++; entry.used = Date.now();
    let released = false;
    return { promise: entry.promise, release: () => {
      if (released) return; released = true; entry!.refs--; entry!.used = Date.now(); this.evict();
    } };
  }
  private evict() {
    let bytes = [...this.entries.values()].reduce((n, entry) => n + entry.bytes, 0);
    const idle = [...this.entries.entries()].filter(([, entry]) => !entry.refs && entry.url).sort((a, b) => a[1].used - b[1].used);
    let remaining = idle.length;
    for (const [key, entry] of idle) {
      if (bytes <= this.maxBytes && remaining <= this.maxIdle) break;
      URL.revokeObjectURL(entry.url!); this.entries.delete(key); bytes -= entry.bytes; remaining--;
    }
  }
}
