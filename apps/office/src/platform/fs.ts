// Files for IeumOffice's editor code inside the editor page's worker, kept in memory: the
// document's working copy (Workbench keeps the revisions) and the few files the code writes for
// itself (recent lists, settings). Nothing here reaches the user's disk.
import { Buffer } from "buffer";
import { EventEmitter } from "./emitter.ts";

type Encoding = "utf8" | "utf-8" | "ascii" | "latin1" | "binary" | "base64" | "base64url" | "hex" | "ucs2" | "utf16le";
import path from "path-browserify";

const { posix } = path;

type Data = Uint8Array;
const files = new Map<string, { data: Data; mtimeMs: number }>();
const dirs = new Set<string>(["/"]);

const norm = (path: string) => posix.resolve("/", String(path));
const failure = (code: string, op: string, path: string) => Object.assign(new Error(`${code}: ${op} '${path}'`), { code, path, syscall: op });

function bytesOf(data: unknown, encoding?: string): Data {
  if (typeof data === "string") return Buffer.from(data, (encoding ?? "utf8") as Encoding);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
  throw new TypeError("unsupported data");
}

function encodingOf(options: unknown) {
  return typeof options === "string" ? options : (options as { encoding?: string } | undefined)?.encoding;
}

function ensureDir(path: string) {
  let dir = posix.dirname(path);
  const missing: string[] = [];
  while (!dirs.has(dir)) {
    missing.push(dir);
    dir = posix.dirname(dir);
  }
  for (const entry of missing) dirs.add(entry);
}

/** For Workbench's own code (and the WASI layer, wasi.ts): files and folders by absolute path. */
export const vfs = {
  write(path: string, data: Data) {
    const at = norm(path);
    ensureDir(at);
    files.set(at, { data, mtimeMs: Date.now() });
  },
  read(path: string): Data | null {
    return files.get(norm(path))?.data ?? null;
  },
  stat(path: string): { directory: boolean; size: number; mtimeMs: number } | null {
    const at = norm(path);
    const file = files.get(at);
    if (file) return { directory: false, size: file.data.length, mtimeMs: file.mtimeMs };
    return dirs.has(at) ? { directory: true, size: 0, mtimeMs: 0 } : null;
  },
  list(path: string): { name: string; directory: boolean }[] {
    const at = norm(path);
    const prefix = at === "/" ? "/" : `${at}/`;
    const out: { name: string; directory: boolean }[] = [];
    for (const file of files.keys()) if (file.startsWith(prefix) && !file.slice(prefix.length).includes("/")) out.push({ name: file.slice(prefix.length), directory: false });
    for (const dir of dirs) if (dir !== at && dir.startsWith(prefix) && !dir.slice(prefix.length).includes("/")) out.push({ name: dir.slice(prefix.length), directory: true });
    return out;
  },
  mkdir(path: string) {
    mkdirSync(path);
  },
  remove(path: string) {
    return files.delete(norm(path));
  },
  removeDir(path: string) {
    const at = norm(path);
    if (vfs.list(at).length) return false;
    return dirs.delete(at);
  },
};

class Stats {
  readonly size: number;
  readonly mtimeMs: number;
  readonly mtime: Date;
  private readonly directory: boolean;
  constructor(size: number, mtimeMs: number, directory: boolean) {
    this.size = size;
    this.mtimeMs = mtimeMs;
    this.mtime = new Date(mtimeMs);
    this.directory = directory;
  }
  isFile() {
    return !this.directory;
  }
  isDirectory() {
    return this.directory;
  }
  isSymbolicLink() {
    return false;
  }
}

export function existsSync(path: string) {
  const at = norm(path);
  return files.has(at) || dirs.has(at);
}
export function statSync(path: string) {
  const at = norm(path);
  const file = files.get(at);
  if (file) return new Stats(file.data.length, file.mtimeMs, false);
  if (dirs.has(at)) return new Stats(0, 0, true);
  throw failure("ENOENT", "stat", at);
}
export const lstatSync = statSync;
export function readFileSync(path: string, options?: unknown) {
  const at = norm(path);
  const file = files.get(at);
  if (!file) throw failure("ENOENT", "open", at);
  const encoding = encodingOf(options);
  const bytes = Buffer.from(file.data);
  return encoding ? bytes.toString(encoding as Encoding) : bytes;
}
export function writeFileSync(path: string, data: unknown, options?: unknown) {
  vfs.write(path, bytesOf(data, encodingOf(options)));
}
export function appendFileSync(path: string, data: unknown, options?: unknown) {
  const before = vfs.read(path) ?? new Uint8Array();
  vfs.write(path, Buffer.concat([before, bytesOf(data, encodingOf(options))]));
}
export function mkdirSync(path: string) {
  const at = norm(path);
  ensureDir(posix.join(at, "x"));
  return at;
}
export function readdirSync(path: string, options?: { withFileTypes?: boolean }) {
  const at = norm(path);
  if (!dirs.has(at)) throw failure("ENOENT", "scandir", at);
  const prefix = at === "/" ? "/" : `${at}/`;
  const names = new Map<string, boolean>();
  for (const file of files.keys()) if (file.startsWith(prefix) && !file.slice(prefix.length).includes("/")) names.set(file.slice(prefix.length), false);
  for (const dir of dirs) if (dir !== at && dir.startsWith(prefix) && !dir.slice(prefix.length).includes("/")) names.set(dir.slice(prefix.length), true);
  if (!options?.withFileTypes) return [...names.keys()];
  return [...names].map(([name, directory]) => ({ name, isFile: () => !directory, isDirectory: () => directory, isSymbolicLink: () => false }));
}
export function unlinkSync(path: string) {
  if (!files.delete(norm(path))) throw failure("ENOENT", "unlink", norm(path));
}
export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }) {
  const at = norm(path);
  if (files.delete(at)) return;
  if (dirs.has(at) && options?.recursive) {
    for (const file of [...files.keys()]) if (file.startsWith(`${at}/`)) files.delete(file);
    for (const dir of [...dirs]) if (dir === at || dir.startsWith(`${at}/`)) dirs.delete(dir);
    return;
  }
  if (!options?.force) throw failure("ENOENT", "rm", at);
}
export function renameSync(from: string, to: string) {
  const file = files.get(norm(from));
  if (!file) throw failure("ENOENT", "rename", norm(from));
  files.delete(norm(from));
  vfs.write(to, file.data);
}
export function copyFileSync(from: string, to: string) {
  const file = files.get(norm(from));
  if (!file) throw failure("ENOENT", "copyfile", norm(from));
  vfs.write(to, file.data.slice());
}
export function realpathSync(path: string) {
  return norm(path);
}
export function accessSync(path: string) {
  if (!existsSync(path)) throw failure("ENOENT", "access", norm(path));
}
// ── file descriptors (the sync API: open, read, write, close) ──
type Descriptor = { path: string; data: Uint8Array; size: number; pos: number; writable: boolean; append: boolean };
const descriptors = new Map<number, Descriptor>();
let nextDescriptor = 100;

export function openSync(path: string, flags: string | number = "r") {
  const at = norm(path);
  const mode = typeof flags === "number" ? "r" : flags;
  const exists = files.has(at);
  if (mode.includes("x") && exists) throw failure("EEXIST", "open", at);
  if (mode.startsWith("r") && !exists) throw failure("ENOENT", "open", at);
  if (dirs.has(at)) throw failure("EISDIR", "open", at);
  const truncate = mode.startsWith("w");
  const data = truncate || !exists ? new Uint8Array() : files.get(at)!.data.slice();
  if (!exists || truncate) vfs.write(at, data);
  const fd = nextDescriptor++;
  descriptors.set(fd, { path: at, data, size: data.length, pos: 0, writable: mode !== "r", append: mode.startsWith("a") });
  return fd;
}
function descriptor(fd: number) {
  const entry = descriptors.get(fd);
  if (!entry) throw failure("EBADF", "fd", String(fd));
  return entry;
}
export function writeSync(fd: number, data: Uint8Array | string, offset?: number, length?: number, position?: number | null) {
  const entry = descriptor(fd);
  if (!entry.writable) throw failure("EBADF", "write", entry.path);
  const chunk = typeof data === "string" ? Buffer.from(data) : data.subarray(offset ?? 0, (offset ?? 0) + (length ?? data.length - (offset ?? 0)));
  const at = entry.append ? entry.size : (position ?? entry.pos);
  if (at + chunk.length > entry.data.length) {
    const grown = new Uint8Array(Math.max(at + chunk.length, entry.data.length * 2, 4096));
    grown.set(entry.data.subarray(0, entry.size));
    entry.data = grown;
  }
  entry.data.set(chunk, at);
  entry.size = Math.max(entry.size, at + chunk.length);
  if (position === undefined || position === null) entry.pos = at + chunk.length;
  return chunk.length;
}
export function readSync(fd: number, buffer: Uint8Array, offset = 0, length = buffer.length - offset, position: number | null = null) {
  const entry = descriptor(fd);
  const from = position ?? entry.pos;
  const chunk = entry.data.subarray(from, Math.min(entry.size, from + length));
  buffer.set(chunk, offset);
  if (position === null) entry.pos = from + chunk.length;
  return chunk.length;
}
export function fsyncSync(fd: number) {
  const entry = descriptor(fd);
  if (entry.writable) vfs.write(entry.path, entry.data.slice(0, entry.size));
}
export function closeSync(fd: number) {
  fsyncSync(fd);
  descriptors.delete(fd);
}
export function fstatSync(fd: number) {
  const entry = descriptor(fd);
  return new Stats(entry.size, Date.now(), false);
}

/** A whole file as one chunk (for hashing code that reads files as streams). */
export function createReadStream(path: string) {
  const stream = new EventEmitter();
  queueMicrotask(() => {
    try {
      const data = readFileSync(path);
      stream.emit("data", data);
      stream.emit("end");
      stream.emit("close");
    } catch (error) {
      stream.emit("error", error);
    }
  });
  return Object.assign(stream, { destroy: () => stream, pipe: <T>(target: T) => target });
}
export function createWriteStream(): never {
  throw failure("ENOTSUP", "createWriteStream", "(streams)");
}
export function watch() {
  return { close: () => undefined, on: () => undefined };
}
export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 };

/** A file opened for reading (fs/promises `open`). */
class FileHandle {
  private readonly data: Data;
  constructor(data: Data) {
    this.data = data;
  }
  async read(buffer: Uint8Array, offset = 0, length = buffer.length - offset, position: number | null = 0) {
    const start = position ?? 0;
    const chunk = this.data.subarray(start, start + length);
    buffer.set(chunk, offset);
    return { bytesRead: chunk.length, buffer };
  }
  async readFile(options?: unknown) {
    const encoding = encodingOf(options);
    const bytes = Buffer.from(this.data);
    return encoding ? bytes.toString(encoding as Encoding) : bytes;
  }
  async stat() {
    return new Stats(this.data.length, Date.now(), false);
  }
  async close() {}
}

export const promises = {
  readFile: async (path: string, options?: unknown) => readFileSync(path, options),
  writeFile: async (path: string, data: unknown, options?: unknown) => writeFileSync(path, data, options),
  appendFile: async (path: string, data: unknown, options?: unknown) => appendFileSync(path, data, options),
  mkdir: async (path: string) => mkdirSync(path),
  readdir: async (path: string, options?: { withFileTypes?: boolean }) => readdirSync(path, options),
  stat: async (path: string) => statSync(path),
  lstat: async (path: string) => statSync(path),
  unlink: async (path: string) => unlinkSync(path),
  rm: async (path: string, options?: { recursive?: boolean; force?: boolean }) => rmSync(path, options),
  rename: async (from: string, to: string) => renameSync(from, to),
  copyFile: async (from: string, to: string) => copyFileSync(from, to),
  access: async (path: string) => accessSync(path),
  realpath: async (path: string) => realpathSync(path),
  mkdtemp: async (prefix: string) => {
    const path = `${prefix}${Math.random().toString(36).slice(2, 8)}`;
    mkdirSync(path);
    return norm(path);
  },
  open: async (path: string) => {
    const file = files.get(norm(path));
    if (!file) throw failure("ENOENT", "open", norm(path));
    return new FileHandle(file.data);
  },
};

export default {
  existsSync,
  statSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  rmSync,
  renameSync,
  copyFileSync,
  realpathSync,
  accessSync,
  openSync,
  writeSync,
  readSync,
  fsyncSync,
  closeSync,
  fstatSync,
  createWriteStream,
  createReadStream,
  watch,
  constants,
  promises,
};
