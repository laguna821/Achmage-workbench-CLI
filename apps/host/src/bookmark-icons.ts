import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { BookmarkNode, Bookmarks } from "@workbench/contracts";
import { writeAtomic } from "./atomic-write.ts";

// Site icons for the app's bookmarks (bookmarks2, 0.5.4). The gateway fetches a site's icon ONLY when a
// person opens one of its bookmarks or presses 아이콘 가져오기 — never a background crawl (that would tell
// every site at once). What it fetches, and the bounds (the SECURITY NOTE in ux/reports/bookmarks2-report.md):
// - only http / https, no user name or password in the address, and only for an address that IS a bookmark;
// - the bookmark's page (HTML only, at most 256 KB read) for its <link rel="icon">, then that icon or the
//   site's /favicon.ico — at most 3 requests per site, each with a 5 s time limit;
// - an icon's address must be on the page's registrable host (example.com for www.example.com);
// - at most ONE redirect per request, and only to the same registrable host;
// - no cookies, no credentials, no referrer; a plain Accept and a generic User-Agent;
// - an icon is at most 64 KB and must BE a raster image by its first bytes (PNG, ICO, GIF, JPEG, WebP);
//   SVG and anything else are refused, so no script-bearing file is ever handed to the app's screen;
// - kept in the app's data folder under the hash of its bytes, 20 MB in all (the oldest go first);
//   a site that had no usable icon is not asked again for a day unless 아이콘 가져오기 is pressed.

export const ICON_MAX = 64 * 1024;
const PAGE_MAX = 256 * 1024;
const TOTAL_MAX = 20 * 1024 * 1024;
const TIMEOUT = 5_000;
const RETRY_AFTER = 24 * 60 * 60 * 1000;
const TRIES_PER_SITE = 3;
const AGENT = "Mozilla/5.0 (compatible; AchmageWorkbench-icons)";

export type IconType = "image/png" | "image/x-icon" | "image/gif" | "image/jpeg" | "image/webp";
type Saved = { version: 1; sites: Record<string, { icon: string; at: number }>; files: Record<string, { type: IconType; size: number; at: number }>; tried: Record<string, number> };
type Fetch = typeof fetch;

/** What an icon's first bytes say it is; null for anything that is not one of the raster kinds kept (SVG included). */
export function sniffIcon(bytes: Uint8Array): IconType | null {
  const at = (index: number, ...values: number[]) => values.every((value, offset) => bytes[index + offset] === value);
  if (bytes.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (bytes.length >= 6 && at(0, 0x00, 0x00, 0x01, 0x00) && (bytes[4]! | bytes[5]! << 8) > 0) return "image/x-icon";
  if (bytes.length >= 6 && (at(0, 0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || at(0, 0x47, 0x49, 0x46, 0x38, 0x39, 0x61))) return "image/gif";
  if (bytes.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (bytes.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}

const SECOND_LEVEL = new Set(["co", "or", "go", "ac", "ne", "re", "pe", "com", "net", "org", "edu", "gov", "mil", "kg", "es", "ms", "hs", "sc"]);
/** The registrable host of a host name (no public-suffix list: the last two labels, three under a country's co./ac./go. …). */
export function siteOf(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (/^[\d.]+$/.test(host) || host.includes(":") || !host.includes(".")) return host;
  const labels = host.split(".");
  const take = labels.length >= 3 && labels.at(-1)!.length === 2 && SECOND_LEVEL.has(labels.at(-2)!) ? 3 : 2;
  return labels.slice(-take).join(".");
}

/** An address the fetcher may ask: http(s), no credentials. */
function fetchable(raw: string, base?: string): URL | null {
  try {
    const url = new URL(raw, base);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password ? url : null;
  } catch { return null; }
}

/** The icons a page names in its <link rel="icon">, best first; SVG ones are left out. */
export function iconLinks(html: string, page: URL): URL[] {
  const found: { url: URL; score: number }[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const attr = (name: string) => {
      const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
      return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").replace(/&amp;/g, "&").trim();
    };
    if (!attr("rel").toLowerCase().split(/\s+/).includes("icon")) continue;
    const href = attr("href"), type = attr("type").toLowerCase(), sizes = attr("sizes").toLowerCase();
    const url = href ? fetchable(href, page.href) : null;
    if (!url || type.includes("svg") || /\.svg$/i.test(url.pathname) || siteOf(url.hostname) !== siteOf(page.hostname)) continue;
    const score = (/\b(16x16|32x32)\b/.test(sizes) ? 4 : 0) + (type.includes("png") || /\.png$/i.test(url.pathname) ? 2 : 0) + (type.includes("icon") || /\.ico$/i.test(url.pathname) ? 1 : 0);
    if (!found.some((entry) => entry.url.href === url.href)) found.push({ url, score });
  }
  return found.sort((a, b) => b.score - a.score).map((entry) => entry.url);
}

/** One GET with the fetcher's rules: no cookies, at most one redirect to the same registrable host, `max` bytes, a time limit. */
async function fetchBounded(doFetch: Fetch, start: URL, max: number, accept: string, timeout: number): Promise<{ url: URL; type: string; bytes: Uint8Array } | null> {
  let url = start;
  for (let hop = 0; hop < 2; hop++) {
    const response = await doFetch(url, { method: "GET", redirect: "manual", credentials: "omit", referrerPolicy: "no-referrer",
      headers: { accept, "user-agent": AGENT }, signal: AbortSignal.timeout(timeout) });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      const next = fetchable(response.headers.get("location") ?? "", url.href);
      if (hop > 0 || !next || siteOf(next.hostname) !== siteOf(start.hostname)) return null;
      url = next; continue;
    }
    if (!response.ok || !response.body) { await response.body?.cancel().catch(() => {}); return null; }
    if (Number(response.headers.get("content-length") ?? 0) > max) { await response.body.cancel().catch(() => {}); return null; }
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) { await reader.cancel().catch(() => {}); return null; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return { url, type: (response.headers.get("content-type") ?? "").toLowerCase(), bytes };
  }
  return null;
}

export class BookmarkIcons {
  private readonly dir: string;
  private readonly index: string;
  private readonly fetch: Fetch;
  private readonly now: () => number;
  private readonly total: number;
  private readonly timeout: number;
  private state: Saved = { version: 1, sites: {}, files: {}, tried: {} };
  private readonly running = new Map<string, Promise<string | null>>();

  constructor(dir: string, options: { fetch?: Fetch; now?: () => number; totalMax?: number; timeoutMs?: number } = {}) {
    this.dir = dir; this.index = join(dir, "index.json");
    this.fetch = options.fetch ?? fetch; this.now = options.now ?? Date.now; this.total = options.totalMax ?? TOTAL_MAX; this.timeout = options.timeoutMs ?? TIMEOUT;
    try {
      const saved = JSON.parse(readFileSync(this.index, "utf8")) as Partial<Saved>;
      if (saved && typeof saved === "object") this.state = { version: 1, sites: saved.sites ?? {}, files: saved.files ?? {}, tried: saved.tried ?? {} };
    } catch { /* No icons yet, or a damaged index: start empty (the files are found again by their hash). */ }
  }

  private save() { mkdirSync(this.dir, { recursive: true }); writeAtomic(this.index, `${JSON.stringify(this.state)}\n`); }
  private static site(url: string): string | null { const parsed = fetchable(url); return parsed ? parsed.origin : null; }

  /** The icon (hash) kept for this address's site, if there is one. */
  iconOf(url: string): string | undefined {
    const site = BookmarkIcons.site(url), entry = site ? this.state.sites[site] : undefined;
    return entry && this.state.files[entry.icon] ? entry.icon : undefined;
  }

  /** The bookmarks with each item's icon (by hash) where its site has one. */
  decorate(view: Bookmarks): Bookmarks {
    const walk = (nodes: BookmarkNode[]): BookmarkNode[] => nodes.map((node) => {
      if (node.kind === "folder") return { ...node, children: walk(node.children) };
      const icon = this.iconOf(node.url);
      return icon ? { ...node, icon } : node;
    });
    return { ...view, items: walk(view.items) };
  }

  /** An icon's bytes and type (null when it is not kept). */
  read(hash: string): { type: IconType; bytes: Buffer } | null {
    const entry = /^[a-f0-9]{64}$/.test(hash) ? this.state.files[hash] : undefined;
    if (!entry) return null;
    try { return { type: entry.type, bytes: readFileSync(join(this.dir, hash)) }; } catch { return null; }
  }

  /**
   * The site's icon, fetched now if it has none: `force` (아이콘 가져오기) asks even a site that had no icon
   * a little while ago. Resolves to the hash, or null when none could be had; never throws.
   */
  ensure(url: string, force = false): Promise<string | null> {
    const site = BookmarkIcons.site(url);
    if (!site) return Promise.resolve(null);
    const kept = this.iconOf(url);
    if (kept) return Promise.resolve(kept);
    const tried = this.state.tried[site];
    if (!force && tried !== undefined && this.now() - tried < RETRY_AFTER) return Promise.resolve(null);
    let run = this.running.get(site);
    if (!run) {
      run = this.find(new URL(url)).catch(() => null).then((found) => { try { return this.keep(site, found); } catch { return null; } }).finally(() => this.running.delete(site));
      this.running.set(site, run);
    }
    return run;
  }

  private async find(page: URL): Promise<{ type: IconType; bytes: Uint8Array } | null> {
    const candidates: URL[] = [];
    try {
      const html = await fetchBounded(this.fetch, page, PAGE_MAX, "text/html", this.timeout);
      if (html && html.type.includes("html")) candidates.push(...iconLinks(new TextDecoder().decode(html.bytes), html.url));
    } catch { /* The page could not be read: /favicon.ico is still tried. */ }
    const fallback = new URL("/favicon.ico", page.origin);
    if (!candidates.some((entry) => entry.href === fallback.href)) candidates.push(fallback);
    // The page was the first request; the rest go to icons.
    for (const candidate of [...candidates.slice(0, TRIES_PER_SITE - 2), fallback].filter((entry, index, all) => all.findIndex((other) => other.href === entry.href) === index)) {
      try {
        const icon = await fetchBounded(this.fetch, candidate, ICON_MAX, "image/png,image/x-icon,image/*;q=0.8", this.timeout);
        const type = icon ? sniffIcon(icon.bytes) : null;
        if (icon && type) return { type, bytes: icon.bytes };
      } catch { /* The next one. */ }
    }
    return null;
  }

  private keep(site: string, found: { type: IconType; bytes: Uint8Array } | null): string | null {
    const now = this.now();
    if (!found) { this.state.tried[site] = now; this.save(); return null; }
    const hash = createHash("sha256").update(found.bytes).digest("hex");
    mkdirSync(this.dir, { recursive: true });
    if (!this.state.files[hash] || !existsSync(join(this.dir, hash))) writeAtomic(join(this.dir, hash), Buffer.from(found.bytes));
    this.state.files[hash] = { type: found.type, size: found.bytes.length, at: now };
    this.state.sites[site] = { icon: hash, at: now };
    delete this.state.tried[site];
    this.evict(hash);
    this.save();
    return this.state.files[hash] ? hash : null;
  }

  /** Bounded total: the icons used longest ago go first (never the one just kept). */
  private evict(keep: string) {
    let total = Object.values(this.state.files).reduce((sum, entry) => sum + entry.size, 0);
    const oldest = Object.entries(this.state.files).filter(([hash]) => hash !== keep).sort((a, b) => a[1].at - b[1].at);
    for (const [hash, entry] of oldest) {
      if (total <= this.total) break;
      rmSync(join(this.dir, hash), { force: true });
      delete this.state.files[hash]; total -= entry.size;
      for (const [site, use] of Object.entries(this.state.sites)) if (use.icon === hash) delete this.state.sites[site];
    }
  }
}
