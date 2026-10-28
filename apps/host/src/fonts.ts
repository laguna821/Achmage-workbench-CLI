import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// System fonts for the office editors: which installed face a requested family draws with (the
// system's own resolution, fontconfig), and that face's bytes. The slides editor measures text
// with them in the page, and the page draws with the same family, so lines break where they are
// drawn. Font files are read only; a face is named by an opaque id, never by a path from the page.

export type FaceMatch = {
  id: string;
  /** The family the system draws for the request. */
  family: string;
  style: string;
  /** The requested family itself is installed (not a stand-in for it). */
  installed: boolean;
};

const faces = new Map<string, { path: string; index: number }>();
const matches = new Map<string, FaceMatch | null>();
let families: Set<string> | null = null;

const key = (family: string) => family.toLowerCase().replace(/[\s_-]+/g, "");

/** Every family name the system lists (each face's names, localized ones included). */
function installedFamilies() {
  if (families) return families;
  families = new Set();
  try {
    const out = execFileSync("fc-list", ["--format", "%{family}\\n"], { encoding: "utf8", timeout: 10_000, maxBuffer: 32 * 1024 * 1024 });
    for (const line of out.split("\n")) for (const name of line.split(",")) if (name.trim()) families.add(key(name));
  } catch {
    // No fontconfig: nothing is known to be installed.
  }
  return families;
}

/** fontconfig pattern syntax: `-`, `:`, `,` and `\` in a family are escaped. */
const escapeFamily = (family: string) => family.replace(/[\\:,-]/g, (c) => `\\${c}`);

export function matchFont(family: string, bold: boolean, italic: boolean, lang?: string): FaceMatch | null {
  if (process.platform !== "linux") return null;
  const wanted = `${family}|${bold ? 1 : 0}${italic ? 1 : 0}|${lang ?? ""}`;
  if (matches.has(wanted)) return matches.get(wanted)!;
  let match: FaceMatch | null = null;
  try {
    const pattern = `${escapeFamily(family)}:weight=${bold ? 200 : 80}:slant=${italic ? 100 : 0}${lang ? `:lang=${lang}` : ""}`;
    const out = execFileSync("fc-match", ["--format", "%{file}\\t%{index}\\t%{family[0]}\\t%{style[0]}", pattern], { encoding: "utf8", timeout: 5000 });
    const [path, index, found, style] = out.split("\t");
    if (path && /\.(ttf|otf|ttc|otc)$/i.test(path)) {
      const id = createHash("sha1").update(`${path}#${index}`).digest("hex").slice(0, 20);
      faces.set(id, { path, index: Number(index) || 0 });
      match = { id, family: found || family, style: style ?? "", installed: installedFamilies().has(key(family)) };
    }
  } catch {
    // fc-match missing or failed: the editor measures with its built-in estimate.
  }
  matches.set(wanted, match);
  return match;
}

/** One face as a standalone font file (a collection's face is split out: FontFace and opentype.js take single faces). */
export function fontFace(id: string): Buffer | null {
  const face = faces.get(id);
  if (!face) return null;
  try {
    return extractFace(readFileSync(face.path), face.index);
  } catch {
    return null;
  }
}

/** The face at `index` of a font collection, or the file itself when it is a single font. */
export function extractFace(file: Buffer, index: number): Buffer {
  if (file.toString("ascii", 0, 4) !== "ttcf") return file;
  const count = file.readUInt32BE(8);
  if (index < 0 || index >= count) throw new Error("no such face");
  const at = file.readUInt32BE(12 + 4 * index);
  const tables = file.readUInt16BE(at + 4);
  const entries: { dir: number; offset: number; length: number; to: number }[] = [];
  for (let table = 0; table < tables; table += 1) {
    const dir = at + 12 + 16 * table;
    entries.push({ dir, offset: file.readUInt32BE(dir + 8), length: file.readUInt32BE(dir + 12), to: 0 });
  }
  let size = 12 + 16 * entries.length;
  for (const entry of entries) {
    entry.to = size;
    size += (entry.length + 3) & ~3;
  }
  const out = Buffer.alloc(size);
  file.copy(out, 0, at, at + 12);
  entries.forEach((entry, table) => {
    file.copy(out, 12 + 16 * table, entry.dir, entry.dir + 8);
    out.writeUInt32BE(entry.to, 12 + 16 * table + 8);
    out.writeUInt32BE(entry.length, 12 + 16 * table + 12);
    file.copy(out, entry.to, entry.offset, entry.offset + entry.length);
  });
  return out;
}
