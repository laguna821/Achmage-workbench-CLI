// Files for IeumOffice's editor code inside the editor page's worker, kept in memory: the
// document's working copy (Workbench keeps the revisions) and the few files the code writes for
// itself (recent lists, settings). Nothing here reaches the user's disk.
import { Buffer } from "buffer";

type Encoding = "utf8" | "utf-8" | "ascii" | "latin1" | "binary" | "base64" | "base64url" | "hex" | "ucs2" | "utf16le";
import { posix } from "path-browserify";

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

/** For Workbench's own code: put and take a file. */
export const vfs = {
  write(path: string, data: Data) {
    const at = norm(path);
    ensureDir(at);
    files.set(at, { data, mtimeMs: Date.now() });
  },
  read(path: string): Data | null {
    return files.get(norm(path))?.data ?? null;
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
export function openSync(): never {
  throw failure("ENOTSUP", "open", "(file descriptors)");
}
export function createWriteStream(): never {
  throw failure("ENOTSUP", "createWriteStream", "(streams)");
}
export function createReadStream(): never {
  throw failure("ENOTSUP", "createReadStream", "(streams)");
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
  createWriteStream,
  createReadStream,
  watch,
  constants,
  promises,
};
