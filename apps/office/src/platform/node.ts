// Small Node built-ins IeumOffice's editor code uses, for the editor page's worker: paths, hashes,
// compression, and the few process helpers that have nothing to do in a browser.
import { sha1 } from "@noble/hashes/legacy.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { Buffer } from "buffer";

type Encoding = "utf8" | "utf-8" | "ascii" | "latin1" | "binary" | "base64" | "base64url" | "hex" | "ucs2" | "utf16le";
import * as pako from "pako";
import path from "path-browserify";

// ── node:path (posix) ────────────────────────────────────────────────────
export const { basename, dirname, extname, join, normalize, relative, resolve, isAbsolute, parse, format, sep, delimiter } = path;
export const posix = path;
export const win32 = path;

// ── node:crypto ──────────────────────────────────────────────────────────
const HASHES: Record<string, (data: Uint8Array) => Uint8Array> = { sha1, sha256, sha512 };

export function createHash(algorithm: string) {
  const hash = HASHES[algorithm.toLowerCase()];
  if (!hash) throw new Error(`hash ${algorithm} is not available in the editor`);
  const parts: Uint8Array[] = [];
  const self = {
    update(data: string | Uint8Array, encoding?: Encoding) {
      parts.push(typeof data === "string" ? Buffer.from(data, encoding ?? "utf8") : data);
      return self;
    },
    digest(encoding?: Encoding) {
      const out = Buffer.from(hash(Buffer.concat(parts)));
      return encoding ? out.toString(encoding) : out;
    },
  };
  return self;
}
export const randomUUID = () => crypto.randomUUID();
export const randomBytes = (size: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(size)));
export const randomInt = (min: number, max?: number) => {
  const [low, high] = max === undefined ? [0, min] : [min, max];
  return low + Math.floor(Math.random() * (high - low));
};

// ── node:zlib ────────────────────────────────────────────────────────────
const out = (bytes: Uint8Array) => Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
export const deflateSync = (data: Uint8Array, options?: pako.DeflateFunctionOptions) => out(pako.deflate(data, options));
export const inflateSync = (data: Uint8Array) => out(pako.inflate(data));
export const deflateRawSync = (data: Uint8Array, options?: pako.DeflateFunctionOptions) => out(pako.deflateRaw(data, options));
export const inflateRawSync = (data: Uint8Array) => out(pako.inflateRaw(data));
export const gzipSync = (data: Uint8Array) => out(pako.gzip(data));
export const gunzipSync = (data: Uint8Array) => out(pako.ungzip(data));
export const unzipSync = (data: Uint8Array) => out(pako.inflate(data));
export const constants = { Z_NO_FLUSH: 0, Z_FINISH: 4, Z_BEST_COMPRESSION: 9, Z_DEFAULT_COMPRESSION: -1 };
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
export function crc32(data: Uint8Array | string, value = 0) {
  const bytes = typeof data === "string" ? Buffer.from(data) : data;
  let crc = (value ^ 0xffffffff) >>> 0;
  for (let index = 0; index < bytes.length; index += 1) crc = CRC_TABLE[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// ── node:os ──────────────────────────────────────────────────────────────
export const homedir = () => "/home/workbench";
export const tmpdir = () => "/tmp";
export const platform = () => "linux";
export const hostname = () => "workbench";
export const EOL = "\n";
export const cpus = () => [];
export const totalmem = () => 0;
export const freemem = () => 0;
export const userInfo = () => ({ username: "workbench", homedir: homedir() });

// ── node:child_process, node:stream/promises, node:url ───────────────────
const unavailable = (what: string) => new Error(`${what} is not available in the editor`);
export function execFile(_file: string, ...rest: unknown[]) {
  const callback = rest.find((arg): arg is (error: Error) => void => typeof arg === "function");
  queueMicrotask(() => callback?.(unavailable("execFile")));
  return { on: () => undefined, kill: () => false };
}
export const spawn = () => {
  throw unavailable("spawn");
};
export const pipeline = () => Promise.reject(unavailable("stream pipeline"));
export const fileURLToPath = (url: string | URL) => decodeURIComponent(new URL(String(url)).pathname);
export const pathToFileURL = (file: string) => new URL(`file://${encodeURI(file)}`);

export default {
  basename,
  dirname,
  extname,
  join,
  normalize,
  relative,
  resolve,
  isAbsolute,
  parse,
  format,
  sep,
  delimiter,
  posix,
  win32,
  createHash,
  randomUUID,
  randomBytes,
  randomInt,
  deflateSync,
  inflateSync,
  deflateRawSync,
  inflateRawSync,
  gzipSync,
  gunzipSync,
  unzipSync,
  constants,
  crc32,
  homedir,
  tmpdir,
  platform,
  hostname,
  EOL,
  cpus,
  totalmem,
  freemem,
  userInfo,
  execFile,
  spawn,
  pipeline,
  fileURLToPath,
  pathToFileURL,
};
