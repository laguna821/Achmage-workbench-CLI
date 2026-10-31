import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, rmdirSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type LegacyResource = { path: string; bytes: number; sha256: string };
const retainedIeum = new Set(["cli", "wasm", "native", "ocr", "builtin-skills", "LICENSE.txt", "NOTICE.txt", "LICENSE-UNICODE.txt", "THIRD-PARTY-NOTICES.txt"]);

/** Only the obsolete, shipped application resources; never a user data directory. */
export function obsoleteResourcePath(path: string) {
  const parts = path.split("/");
  if (parts.length < 2 || parts.some(p => !p || p === "." || p === "..") || /[\\:*?"<>|\x00-\x1f]/.test(path)) return false;
  if (["hop", "pdfcraft", "kordoc"].includes(parts[0]!)) return true;
  return parts[0] === "ieumoffice" && path !== "ieumoffice/WORKBENCH-BUNDLE.json"
    && !(parts[1] === "resources" && retainedIeum.has(parts[2]!));
}

function regularPath(root: string, path: string, directory = false) {
  const parts = path.split("/");
  for (let i = 0; i < parts.length; i++) {
    const stat = lstatSync(join(root, ...parts.slice(0, i + 1)));
    if (stat.isSymbolicLink() || (i < parts.length - 1 || directory ? !stat.isDirectory() : !stat.isFile())) return false;
  }
  return true;
}

/** File-by-file, hash-checked cleanup. Modified/unlisted files and links stay in place. */
export function cleanupLegacyResources(installDirectory: string, files: LegacyResource[]) {
  const root = resolve(installDirectory);
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()
    || !regularPath(root, "achmage-workbench.exe")) throw new Error("Not a Workbench installation");
  // Validate the entire manifest before deleting the first file.
  const seen = new Set<string>();
  for (const file of files) {
    if (!obsoleteResourcePath(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0
      || !/^[a-f0-9]{64}$/.test(file.sha256) || seen.has(file.path.toLowerCase())) throw new Error("Invalid legacy resource manifest");
    seen.add(file.path.toLowerCase());
  }
  const report = { removed: [] as string[], removedBytes: 0, preserved: [] as string[], failed: [] as { path: string; code: string }[] };
  const folders = new Set<string>();
  for (const file of files) {
    const path = join(root, file.path);
    let folder = dirname(file.path);
    while (folder !== ".") { folders.add(folder); folder = dirname(folder); }
    try {
      if (!regularPath(root, file.path)) { report.preserved.push(file.path); continue; }
      const before = lstatSync(path);
      if (before.size !== file.bytes) { report.preserved.push(file.path); continue; }
      const fd = openSync(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
      let hash: string;
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("Resource changed during cleanup");
        const digest = createHash("sha256"), buffer = Buffer.allocUnsafe(64 * 1024);
        let length: number;
        while ((length = readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, length));
        hash = digest.digest("hex");
      } finally { closeSync(fd); }
      const after = lstatSync(path);
      if (hash !== file.sha256 || after.dev !== before.dev || after.ino !== before.ino
        || after.mtimeMs !== before.mtimeMs || after.size !== before.size || !regularPath(root, file.path)) {
        report.preserved.push(file.path); continue;
      }
      unlinkSync(path);
      report.removed.push(file.path);
      report.removedBytes += file.bytes;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "CHANGED";
      if (code !== "ENOENT") report.failed.push({ path: file.path, code });
    }
  }
  // Remove only now-empty directories. Never recursively remove an application/user folder.
  for (const folder of [...folders].sort((a, b) => b.split(/[\\/]/).length - a.split(/[\\/]/).length)) {
    try { if (regularPath(root, folder.replaceAll("\\", "/"), true)) rmdirSync(join(root, folder)); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") report.failed.push({ path: folder, code: code ?? "UNKNOWN" });
    }
  }
  return report;
}
