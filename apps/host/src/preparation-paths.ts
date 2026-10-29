import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readdir, readlink, realpath, stat, symlink } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { PreparationPath } from "@workbench/contracts";
import { physicalPath, withinDirectory } from "./directory-operations.ts";
import { digest } from "./preparation-config.ts";

export const COPY_BYTES = 2 * 1024 * 1024 * 1024, COPY_ENTRIES = 50_000;
type Budget = { bytes: number; entries: number };
type Item = { path: string; kind: "directory" | "file" | "link"; size: number; mode: number; stamp: string; link?: string };
const stamp = (s: Awaited<ReturnType<typeof lstat>>) => digest([s.dev, s.ino, s.size, s.mode, s.mtimeMs, s.ctimeMs]);
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
export async function present(path: string) { try { await lstat(path); return true; } catch (error) { if (missing(error)) return false; throw error; } }
async function ignored(root: string, paths: string[]) {
  if (!paths.length) return new Set<string>();
  return new Promise<Set<string>>((resolve, reject) => {
    const child = execFile("git", ["--no-optional-locks", "-C", root, "check-ignore", "--stdin", "-z"], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && error.code !== 1) reject(new Error(stderr || error.message));
      else resolve(new Set(stdout.split("\0").filter(Boolean)));
    });
    child.stdin?.end(paths.join("\0") + "\0");
  });
}
async function scan(source: string, budget: Budget, signal?: AbortSignal) {
  const items: Item[] = [];
  const visit = async (path: string) => {
    signal?.throwIfAborted();
    if (++budget.entries > COPY_ENTRIES) throw new Error("복사 항목 50,000개 한도를 넘었습니다.");
    const s = await lstat(join(source, path));
    if (s.isFile()) {
      budget.bytes += s.size; if (budget.bytes > COPY_BYTES) throw new Error("복사 파일 2 GiB 한도를 넘었습니다.");
      items.push({ path, kind: "file", size: s.size, mode: s.mode, stamp: stamp(s) });
    } else if (s.isSymbolicLink()) items.push({ path, kind: "link", size: 0, mode: s.mode, stamp: stamp(s), link: await readlink(join(source, path)) });
    else if (s.isDirectory()) {
      items.push({ path, kind: "directory", size: 0, mode: s.mode, stamp: stamp(s) });
      for (const child of (await readdir(join(source, path))).sort()) await visit(join(path, child));
    } else throw new Error("일반 파일·디렉터리·심볼릭 링크만 복사할 수 있습니다.");
  };
  await visit("");
  return { items, fingerprint: digest([source, items]), bytes: items.reduce((sum, item) => sum + item.size, 0), links: items.filter((item) => item.kind === "link").length };
}
/** Existing links are never followed to create children, including links created by earlier steps. */
async function destinationParents(root: string, target: string, create: boolean) {
  if (physicalPath(root) !== root) throw new Error("작업공간의 실제 경로가 바뀌었습니다.");
  if (!withinDirectory(physicalPath(root), physicalPath(dirname(target)))) throw new Error("목적지 상위 폴더가 작업공간 밖을 가리킵니다.");
  const parts = relative(root, dirname(target)).split(sep).filter(Boolean);
  let at = root;
  for (const part of parts) {
    at = join(at, part);
    try { const s = await lstat(at); if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("목적지 상위 경로가 일반 폴더가 아닙니다."); }
    catch (error) { if (!missing(error)) throw error; if (create) await mkdir(at); }
  }
}
export async function previewPaths(primary: string, target: string, candidates: Pick<PreparationPath, "path" | "mode" | "origin">[], signal?: AbortSignal) {
  const ignoredPaths = await ignored(primary, [...new Set(candidates.filter((entry) => entry.origin !== "local").map((entry) => entry.path))]);
  const result: PreparationPath[] = [], budget = { bytes: 0, entries: 0 };
  for (const candidate of candidates) {
    signal?.throwIfAborted();
    const entry: PreparationPath = { ...candidate, source: join(primary, candidate.path), target: join(target, candidate.path), action: "skip", reason: null, bytes: 0, entries: 0, fingerprint: "", links: 0 };
    try {
      if (await present(entry.target) || result.some((prior) => prior.action === "apply" && withinDirectory(prior.target, entry.target))) { entry.action = "preserve"; entry.reason = "이미 있거나 앞선 공유·복사에 포함된 목적지를 유지합니다."; }
      else if (candidate.origin !== "local" && !ignoredPaths.has(candidate.path)) entry.reason = "원본에서 Git이 무시하는 경로가 아닙니다.";
      else {
        await destinationParents(target, entry.target, false);
        entry.source = await realpath(entry.source);
        const s = await stat(entry.source);
        if (!s.isFile() && !s.isDirectory()) throw new Error("일반 파일이나 디렉터리가 아닙니다.");
        if (entry.origin === "orca.yaml" && !s.isDirectory()) throw new Error("공유 디렉터리는 폴더여야 합니다.");
        if (entry.mode === "share") { entry.fingerprint = digest([entry.source, stamp(s)]); entry.entries = 1; }
        else {
          const scanned = await scan(entry.source, budget, signal);
          entry.fingerprint = scanned.fingerprint; entry.entries = scanned.items.length; entry.bytes = scanned.bytes; entry.links = scanned.links;
        }
        entry.action = "apply";
      }
    } catch (error) { entry.reason = missing(error) ? "원본 경로가 없습니다." : error instanceof Error ? error.message : String(error); }
    result.push(entry);
  }
  return result;
}
export async function materializePath(root: string, entry: PreparationPath, signal: AbortSignal) {
  signal.throwIfAborted();
  if (entry.action !== "apply") return entry.action === "preserve" ? "preserved" as const : "skipped" as const;
  await destinationParents(root, entry.target, true);
  if (await present(entry.target)) throw new Error(`${entry.path}: 미리보기 뒤 목적지가 생겼습니다. 기존 파일을 보존했습니다.`);
  if (entry.mode === "share") {
    const s = await stat(entry.source);
    if (digest([entry.source, stamp(s)]) !== entry.fingerprint) throw new Error(`${entry.path}: 원본이 바뀌었습니다.`);
    await symlink(entry.source, entry.target, s.isDirectory() ? process.platform === "win32" ? "junction" : "dir" : "file");
    return "shared" as const;
  }
  const scanned = await scan(entry.source, { bytes: 0, entries: 0 }, signal);
  if (scanned.fingerprint !== entry.fingerprint) throw new Error(`${entry.path}: 복사할 원본이 바뀌었습니다.`);
  for (const item of scanned.items) {
    signal.throwIfAborted();
    const source = join(entry.source, item.path), target = join(entry.target, item.path);
    await destinationParents(root, target, true);
    if (stamp(await lstat(source)) !== item.stamp) throw new Error(`${entry.path}: 복사 중 원본이 바뀌었습니다.`);
    if (item.kind === "directory") await mkdir(target, { mode: 0o700 });
    else if (item.kind === "link") {
      const directory = await stat(source).then((s) => s.isDirectory()).catch(() => false);
      await symlink(item.link!, target, directory ? "dir" : "file");
    } else {
      await copyFile(source, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      if (stamp(await lstat(source)) !== item.stamp || (await stat(target)).size !== item.size) throw new Error(`${entry.path}: 복사 중 파일이 바뀌었습니다. 부분 결과는 남겼습니다.`);
      await chmod(target, item.mode & 0o777);
    }
  }
  for (const item of scanned.items.filter((item) => item.kind === "directory").reverse()) await chmod(join(entry.target, item.path), item.mode & 0o777);
  return "copied" as const;
}
