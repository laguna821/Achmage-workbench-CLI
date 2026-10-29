import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { HttpError } from "./errors.ts";

/** Resolve existing ancestors too: a new file can still be inside a symlinked directory. */
export function physicalPath(path: string): string {
  let current = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try { current = join(realpathSync.native(current), ...tail); break; }
    catch {
      const parent = dirname(current);
      if (parent === current) { current = resolve(path); break; }
      tail.unshift(basename(current)); current = parent;
    }
  }
  return process.platform === "win32" ? current.toLowerCase() : current;
}

export function withinDirectory(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Blocks new application activity while an asynchronous destructive operation owns a folder. */
export class DirectoryOperations {
  private readonly roots = new Set<string>();
  assertAvailable(path: string) {
    const file = physicalPath(path);
    if ([...this.roots].some((root) => withinDirectory(root, file))) throw new HttpError(409, "workspace_removing", "이 폴더의 워크트리를 제거 중입니다. 작업이 끝난 뒤 다시 확인해 주세요.");
  }
  acquire(path: string) {
    const root = physicalPath(path);
    if ([...this.roots].some((entry) => withinDirectory(entry, root) || withinDirectory(root, entry))) throw new HttpError(409, "workspace_removing", "이 폴더의 워크트리를 이미 제거 중입니다.");
    this.roots.add(root);
    return () => { this.roots.delete(root); };
  }
}
