import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { basename } from "node:path";
import JSZip from "jszip";
import type { TurnFiles } from "./files.ts";

// What a file HOLDS (unit 9, review N11, fix rounds 1 and 2): a stored value written into a file the
// AI made never goes to the chat. Only the values in the 비밀 보관함 are looked for (every form the
// scrubber knows, 8+ characters), never the redactor's generic shapes; with nothing stored nothing
// is read and files go as before. The bytes of EVERY file are searched as they are, whatever its name
// or kind, for each form written in UTF-8, UTF-16 (LE/BE), UTF-32 (LE/BE) and, for a value with
// Hangul, CP949/EUC-KR, so no decoding is guessed. Files are read as a stream with a window as long
// as the longest form, in slices small enough that the gateway's event loop is never held for long,
// and a stop (멈춰) ends the scan. Containers are known by their CONTENT: a zip (the Office / Hangul /
// EPUB / jar / whl family whatever the name) is opened member by member, a gzip stream unpacked, a
// tar (by its "ustar" header) walked member by member (round 3, ruling D), one container inside
// another at most (a gzip'd tar counts as one); XML is also read as words with its tags out, so a
// value split over runs is found. What cannot be opened (7z, rar, xz, bzip2, zstd, PDF, an HWP file,
// an encrypted zip, a container over the limits or nested deeper) is "opaque": it goes, and the chat
// is told its name with its member path ("proj.tar › docs/plan.docx"). A file that cannot be read,
// or whose scan fails, is held (fail closed).

export type Needles = { bytes: Buffer[]; texts: string[]; longestBytes: number; longestText: number };
export type HoldReason = "secret-content" | "unreadable";
export type ScanResult = HoldReason | "opaque" | "stopped" | null;

/** The most a zip-like file may be to be opened (it is read whole), and the most its members may unpack to. */
export const ARCHIVE_BYTES = 64 * 1024 * 1024;
const UNPACKED_BYTES = 256 * 1024 * 1024;
const XML_NAME = /\.(xml|rels|x?html?|opf|ncx|svg)$/i;
/** XML read as words this many characters at a time before the event loop gets a turn. */
const XML_PIECE = 256 * 1024;
/** Bytes searched for one form at a time before the event loop gets a turn (~a few ms per slice). */
const SLICE_WORK = 24 * 1024 * 1024;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
const unescaped = (xml: string) => xml.replace(/&(amp|lt|gt|quot|apos);/g, (_all, name: string) => ENTITIES[name]!).replace(/&#(x[0-9a-f]+|\d+);/gi, (_all, code: string) => { try { return String.fromCodePoint(code[0] === "x" || code[0] === "X" ? parseInt(code.slice(1), 16) : Number(code)); } catch { return ""; } });
/** The words of XML: tags out, entities read; `tight` also drops the layout whitespace between tags. */
const words = (xml: string, tight: boolean) => unescaped((tight ? xml.replace(/>\s+</g, "><") : xml).replace(/<[^>]*>/g, ""));

let cp949: Map<string, Buffer> | null = null;
/** Hangul and the other characters of CP949 as their two bytes (built once, from the runtime's decoder). */
function cp949Table(): Map<string, Buffer> {
  if (cp949) return cp949;
  cp949 = new Map();
  const decoder = new TextDecoder("euc-kr");
  for (let lead = 0x81; lead <= 0xfe; lead += 1) {
    for (let trail = 0x41; trail <= 0xfe; trail += 1) {
      const bytes = Buffer.from([lead, trail]);
      const char = decoder.decode(bytes);
      if (char.length === 1 && char !== "�" && !cp949.has(char)) cp949.set(char, bytes);
    }
  }
  return cp949;
}

function encodings(form: string): Buffer[] {
  const utf16le = Buffer.from(form, "utf16le");
  const utf16be = Buffer.from(utf16le);
  utf16be.swap16();
  const points = [...form].map((char) => char.codePointAt(0)!);
  const utf32le = Buffer.alloc(points.length * 4), utf32be = Buffer.alloc(points.length * 4);
  points.forEach((point, index) => { utf32le.writeUInt32LE(point, index * 4); utf32be.writeUInt32BE(point, index * 4); });
  const out = [Buffer.from(form, "utf8"), utf16le, utf16be, utf32le, utf32be];
  if (/[^\x00-\x7f]/.test(form)) {
    const table = cp949Table();
    const parts = [...form].map((char) => (char.charCodeAt(0) < 0x80 ? Buffer.from(char, "latin1") : table.get(char)));
    if (parts.every(Boolean)) out.push(Buffer.concat(parts as Buffer[]));
  }
  return out;
}

/** What to look for: every form of every stored value, in every encoding a text file may use. */
export function needlesOf(forms: readonly string[]): Needles {
  const seen = new Set<string>(), bytes: Buffer[] = [];
  for (const form of forms) for (const encoded of encodings(form)) {
    const key = encoded.toString("hex");
    if (!seen.has(key)) { seen.add(key); bytes.push(encoded); }
  }
  const texts = [...new Set(forms)];
  return { bytes, texts, longestBytes: Math.max(1, ...bytes.map((needle) => needle.length)), longestText: Math.max(1, ...texts.map((text) => text.length)) };
}

export const turn = () => new Promise<void>((done) => setImmediate(done));

/**
 * Whether a window holds a needle. A needle that starts with NUL bytes (UTF-16BE, UTF-32BE) is looked
 * for from its first other byte: a plain search for it in a run of NUL bytes (a database page, a
 * binary) tries every position and is hundreds of times slower.
 */
function holds(window: Buffer, needle: Buffer): boolean {
  let anchor = 0;
  while (anchor < needle.length && needle[anchor] === 0) anchor += 1;
  if (anchor === 0 || anchor === needle.length) return window.includes(needle);
  const rest = needle.subarray(anchor);
  for (let at = window.indexOf(rest, anchor); at >= 0; at = window.indexOf(rest, at + 1)) {
    if (window.subarray(at - anchor, at).every((byte) => byte === 0)) return true;
  }
  return false;
}

/** A running byte search over a stream: the window keeps the last bytes so a value across two reads is found. */
class ByteScan {
  private tail = Buffer.alloc(0);
  private readonly slice: number;
  private readonly needles: Needles;
  private readonly stopped: () => boolean;
  constructor(needles: Needles, stopped: () => boolean) {
    this.needles = needles;
    this.stopped = stopped;
    this.slice = Math.max(16 * 1024, Math.floor(SLICE_WORK / Math.max(1, needles.bytes.length)));
  }
  /** "hit", "stopped" or null (go on). */
  async push(chunk: Uint8Array): Promise<"hit" | "stopped" | null> {
    for (let at = 0; at < chunk.length; at += this.slice) {
      if (this.stopped()) return "stopped";
      const window = Buffer.concat([this.tail, chunk.subarray(at, at + this.slice)]);
      if (this.needles.bytes.some((needle) => holds(window, needle))) return "hit";
      this.tail = window.subarray(Math.max(0, window.length - this.needles.longestBytes + 1));
      if (at + this.slice < chunk.length) await turn();
    }
    return null;
  }
}

/** XML read as words, as it streams: cut after a tag's end so no tag or entity is split. */
class XmlScan {
  private pending = "";
  private readonly decoder = new TextDecoder("utf-8");
  private readonly tails = ["", "", ""];
  private readonly needles: Needles;
  constructor(needles: Needles) {
    this.needles = needles;
  }
  /**
   * The text up to the last tag end, read in pieces of at most XML_PIECE characters with the event
   * loop given a turn between them (a member can come in one large chunk). True: a value was found.
   */
  async push(chunk: Uint8Array | null): Promise<boolean> {
    this.pending += chunk ? this.decoder.decode(chunk, { stream: true }) : this.decoder.decode();
    for (let first = true; ; first = false) {
      if (!this.pending) return false;
      const piece = this.pending.slice(0, XML_PIECE);
      let cut = piece.lastIndexOf(">") + 1;
      if (cut <= 0) {
        // No tag end yet: wait for more, unless this is the end or a whole piece has none.
        if (chunk && this.pending.length < XML_PIECE) return false;
        cut = piece.length;
      }
      if (!first) await turn();
      const part = this.pending.slice(0, cut);
      this.pending = this.pending.slice(cut);
      if (this.look(part)) return true;
    }
  }

  /** The last part ended with a tag's end: the layout whitespace starting this one lies between two tags. */
  private afterTag = false;

  private look(part: string): boolean {
    // The tight view drops whitespace between tags also where a read boundary falls between them (NEW-M3).
    const tight = this.afterTag ? part.replace(/^\s+(?=<)/, "") : part;
    this.afterTag = part.endsWith(">");
    const views = [words(part, false), words(tight, true), unescaped(part)];
    return views.some((view, index) => {
      const text = this.tails[index] + view;
      this.tails[index] = text.slice(Math.max(0, text.length - this.needles.longestText + 1));
      return this.needles.texts.some((needle) => text.includes(needle));
    });
  }
}

/** What a stream of bytes is, by its first bytes. */
type Kind = "zip" | "gzip" | "tar" | "opaque" | "plain";
const ZIP = [Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.from([0x50, 0x4b, 0x07, 0x08])];
/** Packed or compressed kinds this check cannot open: 7z, rar, xz, bzip2, zstd, PDF (its text streams are compressed). */
const OPAQUE = ["377abcaf271c", "526172211a07", "fd377a585a00", "425a68", "28b52ffd", "25504446"].map((hex) => Buffer.from(hex, "hex"));
/** An OLE file named .hwp: the Hangul body streams are compressed. */
const OLE = Buffer.from("d0cf11e0a1b11ae1", "hex");
function kindOf(head: Buffer, name: string): Kind {
  const starts = (magic: Buffer) => head.length >= magic.length && head.subarray(0, magic.length).equals(magic);
  if (ZIP.some(starts)) return "zip";
  if (head[0] === 0x1f && head[1] === 0x8b) return "gzip";
  if (OPAQUE.some(starts) || (starts(OLE) && /\.hwp$/i.test(name))) return "opaque";
  if (head.length >= 262 && head.subarray(257, 262).toString("latin1") === "ustar") return "tar";
  return "plain";
}

/** The first chunk of a stream, and the whole stream again (that chunk first). */
async function peek(chunks: AsyncIterable<Uint8Array>): Promise<{ head: Buffer; all: AsyncIterable<Uint8Array> } | null> {
  const iterator = chunks[Symbol.asyncIterator]();
  let first = await iterator.next();
  while (!first.done && !first.value.length) first = await iterator.next();
  if (first.done) return null;
  const head = Buffer.from(first.value);
  return { head, all: { async *[Symbol.asyncIterator]() { yield head; for (let next = await iterator.next(); !next.done; next = await iterator.next()) yield next.value; } } };
}

/** What a scan of one stream found: a value, a stop, or that some of it could not be opened (it may go, named). */
type Found = "hit" | "stopped" | "opaque" | null;
/** `opaque`: the paths of what could not be opened ("proj.tar › docs/plan.docx"), for the chat. */
type Scan = { needles: Needles; stopped: () => boolean; budget: { left: number }; opaque: string[] };

/**
 * One stream of bytes, whatever it is: its bytes are searched as they are (every encoding of every
 * form); a zip (by its magic) is opened member by member and a gzip stream unpacked and searched the
 * same way (a tar inside holds its members as they are), one container inside another at most; what
 * cannot be opened is "opaque". XML is also read as words. Anything that throws is the caller's.
 */
async function scanStream(chunks: AsyncIterable<Uint8Array>, name: string, scan: Scan, depth: number, path: string = name, unwrapped = false): Promise<Found> {
  const peeked = await peek(chunks);
  if (!peeked) return null;
  const kind = kindOf(peeked.head, name);
  const named = (): Found => { if (!scan.opaque.includes(path)) scan.opaque.push(path); return "opaque"; };
  const bytes = new ByteScan(scan.needles, scan.stopped);
  const xml = kind === "plain" && (XML_NAME.test(name) || /^\s*<\?xml/.test(peeked.head.subarray(0, 64).toString("latin1"))) ? new XmlScan(scan.needles) : null;
  if (kind === "zip") {
    // Read whole (JSZip needs it), its raw bytes searched on the way (a stored member is there as it is).
    const parts: Buffer[] = [];
    let size = 0, over = false;
    for await (const chunk of peeked.all) {
      const found = await bytes.push(chunk);
      if (found) return found;
      size += chunk.length;
      if (size > ARCHIVE_BYTES) over = true;
      if (!over) parts.push(Buffer.from(chunk));
      else parts.length = 0;
    }
    if (over || depth >= 2) return named();
    return scanArchive(Buffer.concat(parts), scan, depth + 1, path);
  }
  if (kind === "tar") {
    // A tar's members are its bytes as they are, between 512-byte headers: each member is scanned
    // by content; a container member is opened one level down (a tar straight out of a gzip is one
    // container with it). Too deep: its raw bytes only, and named.
    if (depth >= 2) return (await rawOnly(peeked.all, bytes)) ?? named();
    return scanTar(peeked.all, scan, unwrapped ? depth : depth + 1, path, bytes);
  }
  if (kind === "gzip") {
    if (depth >= 2) return (await rawOnly(peeked.all, bytes)) ?? named();
    // Unpacked as a stream (zlib works off the event loop); its bytes go through the same search, a tar's members included.
    const gunzip = createGunzip();
    const input = Readable.from(peeked.all);
    input.on("error", (error) => gunzip.destroy(error));
    input.pipe(gunzip);
    try {
      return await scanStream(budgeted(gunzip, scan.budget), name.replace(/\.t?gz$/i, (ext) => (ext.toLowerCase() === ".tgz" ? ".tar" : "")), scan, depth + 1, path, true);
    } finally {
      input.destroy();
      gunzip.destroy();
    }
  }
  for await (const chunk of peeked.all) {
    const found = await bytes.push(chunk);
    if (found) return found;
    if (xml && (await xml.push(chunk))) return "hit";
  }
  if (xml && (await xml.push(null))) return "hit";
  return kind === "opaque" ? named() : null;
}

/** Bytes pulled from a stream as needed: whole headers, and members as streams of their own. */
class Pull {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly iterator: AsyncIterator<Uint8Array>;
  private ended = false;
  constructor(chunks: AsyncIterable<Uint8Array>) {
    this.iterator = chunks[Symbol.asyncIterator]();
  }
  private async more(): Promise<boolean> {
    if (this.ended) return false;
    const next = await this.iterator.next();
    if (next.done) { this.ended = true; return false; }
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, next.value]) : Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
    return true;
  }
  /** Exactly `count` bytes (fewer only at the end). */
  async read(count: number): Promise<Buffer> {
    while (this.buffer.length < count && (await this.more()));
    const out = this.buffer.subarray(0, Math.min(count, this.buffer.length));
    this.buffer = this.buffer.subarray(out.length);
    return out;
  }
  /** The next `count` bytes as a stream; `taken.count`: how many it gave. */
  take(count: number, taken: { count: number }): AsyncIterable<Uint8Array> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        while (taken.count < count) {
          if (!self.buffer.length && !(await self.more())) return;
          const part = self.buffer.subarray(0, Math.min(count - taken.count, self.buffer.length));
          self.buffer = self.buffer.subarray(part.length);
          taken.count += part.length;
          yield part;
        }
      },
    };
  }
  async skip(count: number) {
    const taken = { count: 0 };
    for await (const part of this.take(count, taken)) void part;
  }
}

/** A number of a tar header: octal text, or base-256 when the first byte has its high bit set. */
function tarNumber(field: Buffer): number {
  if (field[0]! & 0x80) {
    let value = 0;
    for (let index = 1; index < field.length; index += 1) value = value * 256 + field[index]!;
    return value;
  }
  const text = field.toString("latin1").replace(/\0.*$/s, "").trim();
  return text ? parseInt(text, 8) || 0 : 0;
}

/**
 * A tar walked member by member (ruling D). Headers (and long names, pax records) are searched as
 * bytes; every file member goes through the same scan by content at `depth` (a zip, gzip or tar
 * member is opened there under the same limits). Members not opened are named by their path.
 */
async function scanTar(chunks: AsyncIterable<Uint8Array>, scan: Scan, depth: number, path: string, bytes: ByteScan): Promise<Found> {
  const pull = new Pull(chunks);
  let opaque = false, longName: string | null = null, paxName: string | null = null;
  for (;;) {
    if (scan.stopped()) return "stopped";
    const header = await pull.read(512);
    if (header.length < 512 || header.every((byte) => byte === 0)) break;
    const found = await bytes.push(header);
    if (found) return found;
    const size = tarNumber(header.subarray(124, 136));
    const padded = size + ((512 - (size % 512)) % 512);
    const type = String.fromCharCode(header[156] || 0x30);
    const field = (from: number, to: number) => header.subarray(from, to).toString("utf8").replace(/\0.*$/s, "");
    const prefix = header.subarray(257, 262).toString("latin1") === "ustar" ? field(345, 500) : "";
    const member = longName ?? paxName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longName = paxName = null;
    if (type === "L" || type === "x" || type === "g" || type === "K") {
      // A long name or a pax record: read whole (small), searched as bytes.
      const data = await pull.read(Math.min(padded, 1024 * 1024));
      if (padded > data.length) await pull.skip(padded - data.length);
      const hit = await bytes.push(data);
      if (hit) return hit;
      const text = data.subarray(0, size).toString("utf8");
      if (type === "L") longName = text.replace(/\0.*$/s, "");
      if (type === "x") paxName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(text)?.[1] ?? null;
      continue;
    }
    if (type !== "0" && type !== "7" && type !== "\0" && type !== "S") {
      // Any other member with data (a vendor type): its bytes are searched as they are (round 4, NEW-M-a).
      if (size > 0) {
        const taken = { count: 0 };
        for await (const chunk of pull.take(size, taken)) { const hit = await bytes.push(chunk); if (hit) return hit; }
        await pull.skip(padded - taken.count);
      } else await pull.skip(padded);
      continue;
    }
    // A GNU sparse member (S): its data is the file's regions without the holes, read by content as a file's (round 4, NEW-M-a).
    const taken = { count: 0 };
    const result = await scanStream(pull.take(size, taken), basename(member), scan, depth, `${path} › ${member}`);
    if (result === "hit" || result === "stopped") return result;
    if (result === "opaque") opaque = true;
    await pull.skip(padded - taken.count);
  }
  return opaque ? "opaque" : null;
}

/** The raw bytes only (a container too deep to open). */
async function rawOnly(chunks: AsyncIterable<Uint8Array>, bytes: ByteScan): Promise<Found> {
  for await (const chunk of chunks) {
    const found = await bytes.push(chunk);
    if (found) return found;
  }
  return null;
}

/** Unpacked bytes counted against the budget; over it, the stream ends as "too big" (Unpacked). */
async function* budgeted(stream: AsyncIterable<Uint8Array>, budget: { left: number }): AsyncIterable<Uint8Array> {
  for await (const chunk of stream) {
    budget.left -= chunk.length;
    if (budget.left < 0) throw new Unpacked();
    yield chunk;
  }
}

/** JSZip's own chunked reader of a member (not in its type declarations). */
type MemberStream = { on(event: "data", listener: (chunk: Uint8Array) => void): MemberStream; on(event: "error", listener: (error: unknown) => void): MemberStream; on(event: "end", listener: () => void): MemberStream; pause(): void; resume(): void };

/** A zip member's bytes as they unpack (JSZip yields between its own chunks). */
function memberChunks(entry: JSZip.JSZipObject, budget: { left: number }): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      const stream = (entry as unknown as { internalStream(type: "uint8array"): MemberStream }).internalStream("uint8array");
      const queue: Uint8Array[] = [];
      let done = false, failed: unknown = null, wake: (() => void) | null = null;
      stream.on("data", (chunk: Uint8Array) => { queue.push(chunk); stream.pause(); wake?.(); })
        .on("error", (error: unknown) => { failed = error; wake?.(); })
        .on("end", () => { done = true; wake?.(); });
      try {
        stream.resume();
        for (;;) {
          const chunk = queue.shift();
          if (chunk) {
            budget.left -= chunk.length;
            if (budget.left < 0) throw new Unpacked();
            yield chunk;
            stream.resume();
            continue;
          }
          if (failed) throw failed;
          if (done) return;
          await new Promise<void>((resolve) => { wake = resolve; });
          wake = null;
        }
      } finally { stream.pause(); }
    },
  };
}

class Unpacked extends Error {}

async function scanArchive(bytes: Uint8Array, scan: Scan, depth: number, path: string): Promise<Found> {
  const named = (what: string): Found => { if (!scan.opaque.includes(what)) scan.opaque.push(what); return "opaque"; };
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(bytes); } catch (error) {
    // An encrypted zip cannot be opened (it may go, named); a broken one is the caller's (held).
    if (/encrypt/i.test(String(error))) return named(path);
    throw error;
  }
  let opaque = false;
  for (const entry of Object.values(zip.files)) {
    if (scan.stopped()) return "stopped";
    if (entry.dir) continue;
    let found: Found;
    try {
      found = await scanStream(memberChunks(entry, scan.budget), basename(entry.name), scan, depth, `${path} › ${entry.name}`);
    } catch (error) {
      if (error instanceof Unpacked) return named(path);
      if (/encrypt/i.test(String(error))) { opaque = true; named(`${path} › ${entry.name}`); continue; }
      throw error;
    }
    if (found === "hit" || found === "stopped") return found;
    if (found === "opaque") opaque = true;
  }
  return opaque ? "opaque" : null;
}

/**
 * Why a file must not go to a chat ("secret-content": a stored value is in it; "unreadable": it
 * could not be read or its scan failed, so it is held), "opaque" when it may go but part of it could
 * not be opened (the chat is told its name), "stopped" (the person said 멈춰), or null.
 */
export async function contentReason(path: string, name: string, needles: Needles, stopped: () => boolean = () => false, source?: () => AsyncIterable<Uint8Array>, opaque: string[] = []): Promise<ScanResult> {
  // `opaque`: filled with the paths of what could not be opened (the file's name, or "a.tar › b.7z").
  const scan: Scan = { needles, stopped, budget: { left: UNPACKED_BYTES }, opaque };
  try {
    // `source`: the bytes of a file already opened (the browser sweep opens without following links).
    if (!source) await stat(path);
    const found = await scanStream(source ? source() : createReadStream(path, { highWaterMark: 1024 * 1024 }), basename(name), scan, 0);
    return found === "hit" ? "secret-content" : found;
  } catch (error) {
    // Over the unpacking budget: it may go, named. Anything else that throws: held (fail closed).
    if (error instanceof Unpacked) { opaque.splice(0, opaque.length, basename(name)); return "opaque"; }
    return "unreadable";
  }
}

/**
 * A turn's files with those whose content may not go taken out, and the names of those that go
 * though part of them could not be opened. Nothing is read when `needles` is null (nothing stored).
 */
export async function withheld(found: TurnFiles, needles: Needles | null, stopped: () => boolean = () => false): Promise<TurnFiles & { held: { name: string; reason: HoldReason }[]; opaque: string[]; stopped: boolean }> {
  if (!needles || !needles.bytes.length) return { ...found, held: [], opaque: [], stopped: false };
  const files: TurnFiles["files"] = [], held: { name: string; reason: HoldReason }[] = [], opaque: string[] = [];
  for (const file of found.files) {
    const parts: string[] = [];
    const reason = await contentReason(file.path, file.name, needles, stopped, undefined, parts);
    if (reason === "stopped") return { ...found, files: [], held, opaque, stopped: true };
    // Named by what could not be opened inside it ("proj.tar › docs/a.7z"), or by its own name.
    if (reason === "opaque") opaque.push(...(parts.length ? parts : [file.name]));
    if (reason && reason !== "opaque") held.push({ name: file.name, reason });
    else files.push(file);
  }
  return { ...found, files, held, opaque, stopped: false };
}
