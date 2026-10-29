import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { posix } from "node:path";
import type { PkmCard, VaultNote } from "@workbench/contracts";
import { excerptOf, firstImage, noteDate, noteTags, parseFrontmatter, splitFrontmatter, valuesOf, type FrontmatterValue } from "./frontmatter.ts";
import { noteTitle, type NoteEntry, type VaultMirror } from "./vault.ts";

// Notes of the vault mirror as cards and as read-only pages. A note is read once per change
// (cached by its time and size), and only the head of a long note is read for its card.

const HEAD_BYTES = 48 * 1024;
const NOTE_LIMIT = 4 * 1024 * 1024;
/** A picture file by its name (what `![[…]]` and `<img src>` can point at). */
const IMAGE_NAME = /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i;
const vaultThumb = (path: string | null): PkmCard["thumb"] => (path ? { vault: path } : null);

export type NoteMeta = {
  title: string;
  excerpt: string;
  tags: string[];
  /** `date created` when written in the note. */
  created: number | null;
  properties: [string, FrontmatterValue][];
  stage: string | null;
  thumb: PkmCard["thumb"];
};

/** The first bytes of a file as text (a cut multi-byte character at the end is dropped). */
function head(path: string, bytes: number) {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read).toString("utf8").replace(/�+$/, "");
  } finally {
    closeSync(fd);
  }
}

/** The DIKM stage of a note as written (`DIKM_단계:` values, first one). */
export const stageOf = (properties: [string, FrontmatterValue][]) =>
  properties.find(([key]) => /^DIKM_단계:?$/i.test(key.trim()))?.[1]?.[0] ?? null;

export class VaultNotes {
  private readonly mirror: VaultMirror;
  private readonly cache = new Map<string, { key: string; meta: NoteMeta }>();

  constructor(mirror: VaultMirror) {
    this.mirror = mirror;
  }

  /** Where a picture a note shows lives in the vault: `![[name]]` by name, `![](path)` next to the note. */
  resolveImage(notePath: string, image: { kind: "embed" | "link"; target: string }): string | null {
    const index = this.mirror.current;
    if (!index) return null;
    const target = decodeURIComponent(image.target.replace(/\\/g, "/")).replace(/^\.\//, "");
    const folder = notePath.includes("/") ? notePath.slice(0, notePath.lastIndexOf("/")) : "";
    if (image.kind === "link" || target.includes("/")) {
      const candidates = [folder ? `${folder}/${target}` : target, target].map((path) => posix.normalize(path)).filter((path) => !path.startsWith(".."));
      for (const candidate of candidates) if (index.imagePaths.has(candidate)) return candidate;
    }
    return index.images.get(target.split("/").pop()!.toLowerCase()) ?? null;
  }

  /** Card facts of a note, read again only when the file changed. */
  meta(entry: NoteEntry): NoteMeta {
    const key = `${entry.mtime}:${entry.size}`;
    const cached = this.cache.get(entry.path);
    if (cached?.key === key) return cached.meta;
    let meta: NoteMeta = { title: noteTitle(entry.path), excerpt: "", tags: [], created: null, properties: [], stage: null, thumb: null };
    if (entry.ext === ".md") {
      try {
        const text = head(this.mirror.resolve(entry.path), HEAD_BYTES);
        const { yaml, body } = splitFrontmatter(text);
        const properties = parseFrontmatter(yaml);
        const image = firstImage(body);
        meta = {
          title: valuesOf(properties, "title")[0]?.trim() || noteTitle(entry.path),
          excerpt: excerptOf(body),
          tags: noteTags(properties, body),
          created: noteDate(valuesOf(properties, "date created")[0]),
          properties,
          stage: stageOf(properties),
          thumb: !image ? null : image.kind === "url" ? { url: image.target } : vaultThumb(this.resolveImage(entry.path, { kind: image.kind, target: image.target })),
        };
      } catch {
        // Unreadable right now: shown by its name until it changes.
      }
    }
    this.cache.set(entry.path, { key, meta });
    return meta;
  }

  card(entry: NoteEntry, pinned: boolean, sessions: number): PkmCard {
    const meta = this.meta(entry);
    const folder = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "";
    return {
      kind: "note",
      id: entry.path,
      title: meta.title,
      excerpt: meta.excerpt,
      tags: meta.tags,
      date: meta.created ?? entry.mtime,
      dateKind: meta.created ? "created" : "modified",
      thumb: meta.thumb,
      pinned,
      stage: meta.stage,
      sessions,
      where: folder,
    };
  }

  /** A whole note, read-only, with its links and pictures resolved to vault paths. */
  note(path: string, sessions: number): VaultNote {
    const index = this.mirror.current;
    const entry = index?.notes.get(path);
    if (!index || !entry) throw new Error("그 노트가 볼트에 없습니다.");
    const absolutePath = this.mirror.resolve(path);
    const buffer = readFileSync(absolutePath);
    const text = buffer.subarray(0, NOTE_LIMIT).toString("utf8");
    const { yaml, body } = splitFrontmatter(text);
    const properties = parseFrontmatter(yaml);
    const byName = new Map<string, string>();
    for (const note of index.notes.keys()) {
      const name = noteTitle(note).toLowerCase();
      if (!byName.has(name)) byName.set(name, note);
    }
    const links: Record<string, string | null> = {};
    // Notes put into this one (`![[note]]`, not pictures) resolve the way links do.
    for (const match of body.matchAll(/(!?)\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) {
      const target = match[2]!.trim();
      if (match[1] && IMAGE_NAME.test(target)) continue;
      const direct = index.notes.has(target) ? target : index.notes.has(`${target}.md`) ? `${target}.md` : null;
      links[target] = direct ?? byName.get(target.split("/").pop()!.replace(/\.md$/i, "").toLowerCase()) ?? null;
    }
    const embeds: Record<string, string | null> = {};
    for (const match of body.matchAll(/!\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]|!\[[^\]]*\]\(\s*<?([^)>\s]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
      const target = (match[1] ?? match[2] ?? "").trim();
      if (!IMAGE_NAME.test(target) || /^[a-z]+:/i.test(target)) continue;
      embeds[target] = this.resolveImage(path, { kind: match[1] ? "embed" : "link", target });
    }
    // Pictures written as HTML (`<img src="그림/a.png" width="300">`) sit next to the note too.
    for (const match of body.matchAll(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi)) {
      const target = match[1]!.trim();
      if (!IMAGE_NAME.test(target) || /^[a-z]+:/i.test(target)) continue;
      embeds[target] = this.resolveImage(path, { kind: "link", target });
    }
    const meta = this.meta(entry);
    return {
      path,
      absolutePath,
      title: meta.title,
      body: buffer.length > NOTE_LIMIT ? `${body}\n\n_(노트가 길어 앞부분만 보입니다.)_` : body,
      properties,
      tags: noteTags(properties, body),
      date: meta.created ?? entry.mtime,
      links,
      embeds,
      sessions,
    };
  }
}
