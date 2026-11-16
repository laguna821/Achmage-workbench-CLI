// A small streaming tar reader for the pacman package (`.pkg.tar.zst`: zstd from `node:zlib`, pax/ustar
// from bsdtar). It writes only the entries under one prefix into one folder and refuses anything that
// would land outside it. Used by the update helper for a Linux user-folder install.
import { createReadStream, mkdirSync, symlinkSync, chmodSync, createWriteStream, linkSync, lstatSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { createZstdDecompress } from "node:zlib";

export class TarRefused extends Error {}
type Entry = { name: string; type: string; size: number; mode: number; link: string };

const text = (block: Buffer, start: number, length: number) => { const raw = block.subarray(start, start + length); const end = raw.indexOf(0); return raw.subarray(0, end < 0 ? raw.length : end).toString("utf8"); };
const octal = (block: Buffer, start: number, length: number) => { const value = text(block, start, length).trim(); return value ? parseInt(value, 8) : 0; };
function pax(body: Buffer) {
  const out: Record<string, string> = {};
  let at = 0;
  while (at < body.length) {
    const space = body.indexOf(32, at); if (space < 0) break;
    const length = Number(body.subarray(at, space).toString("ascii")); if (!Number.isSafeInteger(length) || length <= 0) break;
    const record = body.subarray(space + 1, at + length - 1).toString("utf8"), eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    at += length;
  }
  return out;
}

/** Inside `root`, never on it or above it. */
export function safeJoin(root: string, name: string) {
  if (!name || isAbsolute(name) || name.includes("\0") || name.split(/[\\/]/).includes("..")) throw new TarRefused(`unsafe entry: ${JSON.stringify(name).slice(0, 80)}`);
  const target = resolve(root, normalize(name));
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new TarRefused(`unsafe entry: ${JSON.stringify(name).slice(0, 80)}`);
  return target;
}

/**
 * Make `dir` (inside `root`) as real folders, never through a link: every existing component is checked with
 * lstat, and one that is a link (or not a folder) refuses the archive (security review L1).
 */
function realFolders(root: string, dir: string) {
  const rel = relative(root, dir);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new TarRefused("entry leaves the folder");
  let at = root;
  for (const part of rel ? rel.split(sep) : []) {
    at = join(at, part);
    let stats; try { stats = lstatSync(at); } catch { mkdirSync(at, { mode: 0o755 }); continue; }
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new TarRefused(`a link or file is in the way: ${relative(root, at)}`);
  }
}
/** Ready to create `target`: its folders are real, and whatever sits at its place (never a folder) is removed, not written through. */
function freePlace(root: string, target: string) {
  realFolders(root, dirname(target));
  let stats; try { stats = lstatSync(target); } catch { return; }
  if (stats.isDirectory()) throw new TarRefused(`a folder is in the way: ${relative(root, target)}`);
  rmSync(target, { force: true });
}

/**
 * Extract `archive` (a .tar.zst) entries whose path starts with `prefix` (e.g. "usr/lib/achmage-workbench/")
 * into `destination`. Regular files, folders, and links that stay inside `destination` only. `maxBytes`
 * caps the total written.
 */
export async function extractPrefix(archive: string, prefix: string, destination: string, maxBytes = 6 * 1024 ** 3): Promise<{ files: number; bytes: number }> {
  mkdirSync(destination, { recursive: true, mode: 0o755 });
  const root = resolve(destination);
  let buffer: Buffer = Buffer.alloc(0), remaining = 0, padding = 0;
  let out: ReturnType<typeof createWriteStream> | null = null, longName: string | null = null, longLink: string | null = null, paxNext: Record<string, string> = {};
  let collect: Buffer[] | null = null, collectType = "";
  let files = 0, bytes = 0, ended = false;
  let outTarget = "", outMode = 0o644;
  // Symbolic links are made last, after every file and folder (so no entry is placed through one).
  const links: { target: string; link: string }[] = [];
  const finishFile = async () => {
    if (!out) return;
    const stream = out; out = null;
    await new Promise<void>((ok, fail) => stream.end((error?: Error | null) => error ? fail(error) : ok()));
    chmodSync(outTarget, outMode);
  };
  const begin = async (entry: Entry) => {
    if (entry.type === "x" || entry.type === "L" || entry.type === "K" || entry.type === "g") { collect = []; collectType = entry.type; return; }
    const name = entry.name.replace(/^\.\//, "");
    if (!name.startsWith(prefix) || name === prefix || name === prefix.replace(/\/$/, "")) return;
    const target = safeJoin(root, name.slice(prefix.length).replace(/\/$/, ""));
    if (entry.type === "5") { realFolders(root, target); return; }
    if (entry.type === "2") {
      // A link must resolve inside the folder (from where it really is: its folders are checked when it is made).
      const to = resolve(dirname(target), entry.link);
      const rel = relative(root, to);
      if (!entry.link || isAbsolute(entry.link) || entry.link.includes("\0") || rel.startsWith("..") || isAbsolute(rel)) throw new TarRefused(`link leaves the folder: ${name}`);
      links.push({ target, link: entry.link }); return;
    }
    if (entry.type === "1") {
      const linked = entry.link.replace(/^\.\//, "");
      if (!linked.startsWith(prefix)) throw new TarRefused(`hard link leaves the folder: ${name}`);
      const source = safeJoin(root, linked.slice(prefix.length));
      if (source === target) return; // the same member listed twice
      realFolders(root, dirname(source));
      if (!lstatSync(source).isFile()) throw new TarRefused(`hard link to something that is not a file: ${name}`);
      freePlace(root, target);
      linkSync(source, target); return;
    }
    if (entry.type !== "0" && entry.type !== "\0" && entry.type !== "" && entry.type !== "7") throw new TarRefused(`unsupported entry type ${entry.type}: ${name}`);
    freePlace(root, target);
    out = createWriteStream(target, { mode: 0o600, flags: "wx" });
    outTarget = target; outMode = (entry.mode & 0o755) || 0o644;
    files++;
  };
  const input = createReadStream(archive).pipe(createZstdDecompress());
  for await (const chunk of input as AsyncIterable<Buffer>) {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    while (!ended) {
      if (remaining > 0) {
        if (!buffer.length) break;
        const take = buffer.subarray(0, Math.min(remaining, buffer.length));
        buffer = buffer.subarray(take.length); remaining -= take.length;
        if (collect) (collect as Buffer[]).push(Buffer.from(take));
        else if (out) {
          bytes += take.length;
          if (bytes > maxBytes) throw new TarRefused("package too large");
          if (!(out as ReturnType<typeof createWriteStream>).write(take)) await new Promise(ok => (out as ReturnType<typeof createWriteStream>).once("drain", ok));
        }
        if (remaining === 0) {
          if (collect) {
            const body = Buffer.concat(collect as Buffer[]); collect = null;
            if (collectType === "x") paxNext = pax(body);
            else if (collectType === "L") longName = text(body, 0, body.length);
            else if (collectType === "K") longLink = text(body, 0, body.length);
          } else await finishFile();
        }
        continue;
      }
      if (padding > 0) { if (buffer.length < padding) break; buffer = buffer.subarray(padding); padding = 0; continue; }
      if (buffer.length < 512) break;
      const block = buffer.subarray(0, 512); buffer = buffer.subarray(512);
      if (block.every(byte => byte === 0)) { ended = true; break; }
      const magicPrefix = text(block, 257, 6).startsWith("ustar") ? text(block, 345, 155) : "";
      const header: Entry = { name: (magicPrefix ? `${magicPrefix}/` : "") + text(block, 0, 100), type: String.fromCharCode(block[156]!).replace("\0", "0"), size: octal(block, 124, 12), mode: octal(block, 100, 8), link: text(block, 157, 100) };
      if (!["x", "g", "L", "K"].includes(header.type)) {
        if (paxNext.path) header.name = paxNext.path; else if (longName) header.name = longName;
        if (paxNext.linkpath) header.link = paxNext.linkpath; else if (longLink) header.link = longLink;
        if (paxNext.size) header.size = Number(paxNext.size);
        paxNext = {}; longName = null; longLink = null;
      }
      await begin(header);
      remaining = ["5", "2", "1"].includes(header.type) ? 0 : header.size;
      padding = (512 - (header.size % 512)) % 512;
      if (["5", "2", "1"].includes(header.type)) { remaining = 0; padding = header.size ? padding : 0; }
      if (remaining === 0 && !collect) await finishFile();
      if (remaining === 0 && collect) { collect = null; }
    }
  }
  await finishFile();
  for (const { target, link } of links) { freePlace(root, target); symlinkSync(link, target); }
  return { files, bytes };
}
