import { randomBytes } from "node:crypto";
import { accessSync, closeSync, constants, existsSync, fchmodSync, fsyncSync, lstatSync, openSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { resolvedPath } from "./directory-operations.ts";
import { HttpError } from "./errors.ts";

/** The system would not let the file be written (permissions, a read-only disk). */
const DENIED = new Set(["EACCES", "EPERM", "EROFS"]);

/**
 * A failed write as the person is told it: a refusal that names the file and says nothing changed,
 * when the system denied it; any other error as it is.
 */
export function asUnwritable(path: string, error: unknown): unknown {
  if (error instanceof HttpError || !DENIED.has((error as NodeJS.ErrnoException | null)?.code ?? "")) return error;
  return new HttpError(409, "file_unwritable", `「${basename(path)}」 파일을 쓸 수 없습니다. 파일이 읽기 전용이거나 폴더에 쓸 권한이 없습니다. 아무것도 바꾸지 않았습니다.`);
}

/**
 * Replace a file whole: the bytes go to a hidden temporary file beside the target, which is then
 * renamed over it, so a crash never leaves half a file and a reader (Obsidian, a sync client) sees
 * the old file or the new one, never a truncated one. A link is followed — the link stays, the file
 * it names is replaced, under that file's own name and letter case — and the file keeps its mode.
 * What writing in place would not do is refused here too: a file that is read-only stays as it is,
 * and a link to nothing is not turned into a file. When the write fails the target is as it was and
 * the temporary file is removed; a denial by the system is said as a refusal (`asUnwritable`).
 */
export function writeAtomic(path: string, data: Buffer | string) {
  let dangling = false;
  try {
    dangling = lstatSync(path).isSymbolicLink() && !existsSync(path);
  } catch {
    // Not there yet: a new file.
  }
  if (dangling) throw new HttpError(409, "file_dangling_link", `「${basename(path)}」은(는) 가리키는 파일이 없는 링크입니다. 아무것도 바꾸지 않았습니다. 링크를 고치거나 지운 뒤 다시 해 주세요.`);
  // A file opened through a symlink still writes the physical file, not a replacement regular
  // file at the link's directory entry.
  const target = resolvedPath(path);
  // A short name of its own (a note's name may already fill the 255 bytes a name can have).
  const temporary = join(dirname(target), `.workbench-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  let file: number | null = null;
  try {
    let mode: number | null = null;
    if (existsSync(target)) {
      mode = statSync(target).mode & 0o7777;
      // The rename needs only the folder's permission; the file's own read-only flag is kept to.
      accessSync(target, constants.W_OK);
    }
    file = openSync(temporary, "wx", mode ?? 0o666);
    writeFileSync(file, data);
    // The umask may have narrowed the mode asked for when the file was made.
    if (mode !== null) fchmodSync(file, mode);
    fsyncSync(file);
    closeSync(file);
    file = null;
    renameSync(temporary, target);
  } catch (error) {
    if (file !== null) {
      try {
        closeSync(file);
      } catch {
        // Already closed.
      }
    }
    try {
      unlinkSync(temporary);
    } catch {
      // Never made, or already renamed.
    }
    throw asUnwritable(path, error);
  }
}
