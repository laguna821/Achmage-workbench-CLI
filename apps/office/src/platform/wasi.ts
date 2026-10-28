// WASI (preview 1) for the WebAssembly modules the office editors run in their worker (the
// spreadsheet editor's Rust xlsx engine), backed by the worker's in-memory files (fs.ts): the
// engine reads and writes the same files as the editor code around it. Only the calls those
// modules import are provided; the root folder is the one preopened directory (fd 3).
import path from "path-browserify";

const { posix } = path;
import { vfs } from "./fs.ts";

const ERRNO = { SUCCESS: 0, BADF: 8, EXIST: 20, INVAL: 28, ISDIR: 31, NOENT: 44, NOTDIR: 54, NOTEMPTY: 55 } as const;
const FILETYPE = { CHARACTER_DEVICE: 2, DIRECTORY: 3, REGULAR_FILE: 4 } as const;
const OFLAGS = { CREAT: 1, DIRECTORY: 2, EXCL: 4, TRUNC: 8 } as const;
const FDFLAGS_APPEND = 1;
const RIGHT_FD_WRITE = 1n << 6n;
const ALL_RIGHTS = 0xffff_ffff_ffff_ffffn;
const ROOT_FD = 3;

/** `owned`: `data` is this entry's own buffer (it starts as the stored file's bytes, copied on the first write). */
type FileEntry = { kind: "file"; path: string; data: Uint8Array; size: number; pos: number; append: boolean; writable: boolean; dirty: boolean; owned: boolean };
type DirEntry = { kind: "dir"; path: string };
type Entry = FileEntry | DirEntry;

class WasiExit extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

export function createWasi(log: (stream: "stdout" | "stderr", text: string) => void = () => {}) {
  let memory: WebAssembly.Memory | null = null;
  const fds = new Map<number, Entry>([[ROOT_FD, { kind: "dir", path: "/" }]]);
  let nextFd = ROOT_FD + 1;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const view = () => new DataView(memory!.buffer);
  const bytes = () => new Uint8Array(memory!.buffer);
  const text = (ptr: number, len: number) => decoder.decode(bytes().subarray(ptr, ptr + len));
  const resolve = (fd: number, ptr: number, len: number) => {
    const base = fds.get(fd);
    if (!base || base.kind !== "dir") return null;
    return posix.resolve(base.path, text(ptr, len));
  };

  /** A file's unsaved writes go into the worker's files. */
  function commit(entry: FileEntry) {
    if (!entry.dirty) return;
    vfs.write(entry.path, entry.data.slice(0, entry.size));
    entry.dirty = false;
  }

  function grow(entry: FileEntry, size: number) {
    if (entry.owned && size <= entry.data.length) return;
    const next = new Uint8Array(Math.max(size, entry.data.length * 2, 4096));
    next.set(entry.data.subarray(0, entry.size));
    entry.data = next;
    entry.owned = true;
  }

  function writeFilestat(ptr: number, filetype: number, size: number, mtimeMs: number) {
    const dv = view();
    const time = BigInt(Math.round(mtimeMs)) * 1_000_000n;
    dv.setBigUint64(ptr, 0n, true);
    dv.setBigUint64(ptr + 8, 0n, true);
    dv.setUint8(ptr + 16, filetype);
    dv.setBigUint64(ptr + 24, 1n, true);
    dv.setBigUint64(ptr + 32, BigInt(size), true);
    dv.setBigUint64(ptr + 40, time, true);
    dv.setBigUint64(ptr + 48, time, true);
    dv.setBigUint64(ptr + 56, time, true);
  }

  const iovecs = (ptr: number, count: number) => {
    const dv = view();
    return Array.from({ length: count }, (_, index) => ({ buf: dv.getUint32(ptr + 8 * index, true), len: dv.getUint32(ptr + 8 * index + 4, true) }));
  };

  const imports = {
    wasi_snapshot_preview1: {
      environ_sizes_get(countPtr: number, sizePtr: number) {
        view().setUint32(countPtr, 0, true);
        view().setUint32(sizePtr, 0, true);
        return ERRNO.SUCCESS;
      },
      environ_get() {
        return ERRNO.SUCCESS;
      },
      clock_time_get(_id: number, _precision: bigint, timePtr: number) {
        view().setBigUint64(timePtr, BigInt(Math.round((performance.timeOrigin + performance.now()) * 1_000_000)), true);
        return ERRNO.SUCCESS;
      },
      random_get(ptr: number, len: number) {
        for (let at = 0; at < len; at += 65_536) crypto.getRandomValues(bytes().subarray(ptr + at, ptr + Math.min(len, at + 65_536)));
        return ERRNO.SUCCESS;
      },
      fd_close(fd: number) {
        const entry = fds.get(fd);
        if (!entry || fd === ROOT_FD) return ERRNO.BADF;
        if (entry.kind === "file") commit(entry);
        fds.delete(fd);
        return ERRNO.SUCCESS;
      },
      fd_sync(fd: number) {
        const entry = fds.get(fd);
        if (!entry) return ERRNO.BADF;
        if (entry.kind === "file") commit(entry);
        return ERRNO.SUCCESS;
      },
      fd_fdstat_get(fd: number, ptr: number) {
        const dv = view();
        const entry = fds.get(fd);
        if (fd > 2 && !entry) return ERRNO.BADF;
        dv.setUint8(ptr, fd <= 2 ? FILETYPE.CHARACTER_DEVICE : entry!.kind === "dir" ? FILETYPE.DIRECTORY : FILETYPE.REGULAR_FILE);
        dv.setUint16(ptr + 2, entry?.kind === "file" && entry.append ? FDFLAGS_APPEND : 0, true);
        dv.setBigUint64(ptr + 8, ALL_RIGHTS, true);
        dv.setBigUint64(ptr + 16, ALL_RIGHTS, true);
        return ERRNO.SUCCESS;
      },
      fd_filestat_get(fd: number, ptr: number) {
        const entry = fds.get(fd);
        if (fd <= 2) {
          writeFilestat(ptr, FILETYPE.CHARACTER_DEVICE, 0, 0);
          return ERRNO.SUCCESS;
        }
        if (!entry) return ERRNO.BADF;
        if (entry.kind === "dir") writeFilestat(ptr, FILETYPE.DIRECTORY, 0, 0);
        else writeFilestat(ptr, FILETYPE.REGULAR_FILE, entry.size, vfs.stat(entry.path)?.mtimeMs ?? Date.now());
        return ERRNO.SUCCESS;
      },
      fd_prestat_get(fd: number, ptr: number) {
        if (fd !== ROOT_FD) return ERRNO.BADF;
        view().setUint8(ptr, 0);
        view().setUint32(ptr + 4, 1, true);
        return ERRNO.SUCCESS;
      },
      fd_prestat_dir_name(fd: number, ptr: number, len: number) {
        if (fd !== ROOT_FD) return ERRNO.BADF;
        bytes().set(encoder.encode("/").subarray(0, len), ptr);
        return ERRNO.SUCCESS;
      },
      fd_read(fd: number, iovs: number, count: number, nreadPtr: number) {
        const entry = fds.get(fd);
        let total = 0;
        if (fd === 0) {
          view().setUint32(nreadPtr, 0, true);
          return ERRNO.SUCCESS;
        }
        if (!entry) return ERRNO.BADF;
        if (entry.kind !== "file") return ERRNO.ISDIR;
        for (const { buf, len } of iovecs(iovs, count)) {
          const chunk = entry.data.subarray(entry.pos, Math.min(entry.size, entry.pos + len));
          bytes().set(chunk, buf);
          entry.pos += chunk.length;
          total += chunk.length;
          if (chunk.length < len) break;
        }
        view().setUint32(nreadPtr, total, true);
        return ERRNO.SUCCESS;
      },
      fd_write(fd: number, iovs: number, count: number, nwrittenPtr: number) {
        let total = 0;
        const parts = iovecs(iovs, count);
        if (fd === 1 || fd === 2) {
          for (const { buf, len } of parts) {
            log(fd === 1 ? "stdout" : "stderr", text(buf, len));
            total += len;
          }
          view().setUint32(nwrittenPtr, total, true);
          return ERRNO.SUCCESS;
        }
        const entry = fds.get(fd);
        if (!entry) return ERRNO.BADF;
        if (entry.kind !== "file") return ERRNO.ISDIR;
        if (!entry.writable) return ERRNO.BADF;
        for (const { buf, len } of parts) {
          const at = entry.append ? entry.size : entry.pos;
          grow(entry, at + len);
          entry.data.set(bytes().subarray(buf, buf + len), at);
          entry.pos = at + len;
          entry.size = Math.max(entry.size, entry.pos);
          total += len;
        }
        entry.dirty = true;
        view().setUint32(nwrittenPtr, total, true);
        return ERRNO.SUCCESS;
      },
      fd_seek(fd: number, offset: bigint, whence: number, newOffsetPtr: number) {
        const entry = fds.get(fd);
        if (!entry || entry.kind !== "file") return ERRNO.BADF;
        const base = whence === 0 ? 0 : whence === 1 ? entry.pos : entry.size;
        const next = base + Number(offset);
        if (next < 0) return ERRNO.INVAL;
        entry.pos = next;
        view().setBigUint64(newOffsetPtr, BigInt(next), true);
        return ERRNO.SUCCESS;
      },
      fd_readdir(fd: number, buf: number, bufLen: number, cookie: bigint, bufusedPtr: number) {
        const entry = fds.get(fd);
        if (!entry || entry.kind !== "dir") return ERRNO.BADF;
        const names = [{ name: ".", directory: true }, { name: "..", directory: true }, ...vfs.list(entry.path)];
        let used = 0;
        for (let index = Number(cookie); index < names.length && used < bufLen; index += 1) {
          const name = encoder.encode(names[index]!.name);
          const record = new Uint8Array(24 + name.length);
          const dv = new DataView(record.buffer);
          dv.setBigUint64(0, BigInt(index + 1), true);
          dv.setBigUint64(8, BigInt(index + 1), true);
          dv.setUint32(16, name.length, true);
          dv.setUint8(20, names[index]!.directory ? FILETYPE.DIRECTORY : FILETYPE.REGULAR_FILE);
          record.set(name, 24);
          const room = Math.min(record.length, bufLen - used);
          bytes().set(record.subarray(0, room), buf + used);
          used += room;
        }
        view().setUint32(bufusedPtr, used, true);
        return ERRNO.SUCCESS;
      },
      path_filestat_get(fd: number, _flags: number, pathPtr: number, pathLen: number, ptr: number) {
        const path = resolve(fd, pathPtr, pathLen);
        if (!path) return ERRNO.BADF;
        // An open, written file reports its current size before it is closed.
        const open = [...fds.values()].find((entry): entry is FileEntry => entry.kind === "file" && entry.path === path && entry.dirty);
        if (open) {
          writeFilestat(ptr, FILETYPE.REGULAR_FILE, open.size, Date.now());
          return ERRNO.SUCCESS;
        }
        const stat = vfs.stat(path);
        if (!stat) return ERRNO.NOENT;
        writeFilestat(ptr, stat.directory ? FILETYPE.DIRECTORY : FILETYPE.REGULAR_FILE, stat.size, stat.mtimeMs);
        return ERRNO.SUCCESS;
      },
      path_open(dirfd: number, _dirflags: number, pathPtr: number, pathLen: number, oflags: number, rightsBase: bigint, _rightsInheriting: bigint, fdflags: number, fdPtr: number) {
        const path = resolve(dirfd, pathPtr, pathLen);
        if (!path) return ERRNO.BADF;
        let stat = vfs.stat(path);
        if (stat && oflags & OFLAGS.EXCL && oflags & OFLAGS.CREAT) return ERRNO.EXIST;
        if (!stat && !(oflags & OFLAGS.CREAT)) return ERRNO.NOENT;
        if (stat?.directory || oflags & OFLAGS.DIRECTORY) {
          if (!stat?.directory) return ERRNO.NOTDIR;
          const fd = nextFd++;
          fds.set(fd, { kind: "dir", path });
          view().setUint32(fdPtr, fd, true);
          return ERRNO.SUCCESS;
        }
        if (!stat || oflags & OFLAGS.TRUNC) {
          vfs.write(path, new Uint8Array());
          stat = vfs.stat(path);
        }
        const data = vfs.read(path) ?? new Uint8Array();
        const fd = nextFd++;
        fds.set(fd, {
          kind: "file",
          path,
          data,
          size: data.length,
          pos: 0,
          append: Boolean(fdflags & FDFLAGS_APPEND),
          writable: (rightsBase & RIGHT_FD_WRITE) !== 0n,
          dirty: false,
          owned: false,
        });
        view().setUint32(fdPtr, fd, true);
        return ERRNO.SUCCESS;
      },
      path_create_directory(fd: number, pathPtr: number, pathLen: number) {
        const path = resolve(fd, pathPtr, pathLen);
        if (!path) return ERRNO.BADF;
        if (vfs.stat(path)) return ERRNO.EXIST;
        if (!vfs.stat(posix.dirname(path))?.directory) return ERRNO.NOENT;
        vfs.mkdir(path);
        return ERRNO.SUCCESS;
      },
      path_readlink() {
        return ERRNO.INVAL;
      },
      path_unlink_file(fd: number, pathPtr: number, pathLen: number) {
        const path = resolve(fd, pathPtr, pathLen);
        if (!path) return ERRNO.BADF;
        if (vfs.stat(path)?.directory) return ERRNO.ISDIR;
        return vfs.remove(path) ? ERRNO.SUCCESS : ERRNO.NOENT;
      },
      path_remove_directory(fd: number, pathPtr: number, pathLen: number) {
        const path = resolve(fd, pathPtr, pathLen);
        if (!path) return ERRNO.BADF;
        const stat = vfs.stat(path);
        if (!stat) return ERRNO.NOENT;
        if (!stat.directory) return ERRNO.NOTDIR;
        return vfs.removeDir(path) ? ERRNO.SUCCESS : ERRNO.NOTEMPTY;
      },
      // Sleeps and waits return at once: there is nothing to wait for here.
      poll_oneoff(inPtr: number, outPtr: number, count: number, neventsPtr: number) {
        const dv = view();
        for (let index = 0; index < count; index += 1) {
          const event = outPtr + 32 * index;
          dv.setBigUint64(event, dv.getBigUint64(inPtr + 48 * index, true), true);
          dv.setUint16(event + 8, 0, true);
          dv.setUint8(event + 10, dv.getUint8(inPtr + 48 * index + 8));
        }
        dv.setUint32(neventsPtr, count, true);
        return ERRNO.SUCCESS;
      },
      proc_exit(code: number) {
        throw new WasiExit(code);
      },
    },
  };

  return {
    imports,
    attach(next: WebAssembly.Memory) {
      memory = next;
    },
    /** Write every open file's pending bytes to the worker's files (after each engine call). */
    flush() {
      for (const entry of fds.values()) if (entry.kind === "file") commit(entry);
    },
  };
}
