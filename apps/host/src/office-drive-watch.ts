import { lstatSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

/** DriveFiles has one folder per remote ID. Watch those directories, not the
 * replaced file inode: Workbench saves through atomic rename on every OS. */
export function watchDriveCopies(root: string, changed: (path: string) => void) {
  const watchers = new Map<string, FSWatcher>();
  let stopped = false;
  const directory = (path: string) => { try { return lstatSync(path).isDirectory(); } catch { return false; } };
  const watchFolder = (path: string, top = false) => {
    if (stopped || watchers.has(path) || !directory(path)) return;
    try {
      const watcher = watch(path, (_event, name) => {
        if (stopped) return;
        if (name) changed(join(path, String(name)));
        if (top) scan();
      });
      watchers.set(path, watcher);
      watcher.on("error", () => { watcher.close(); watchers.delete(path); });
      // A folder can appear with its first saved file before its watcher is ready.
      if (!top) for (const name of readdirSync(path)) changed(join(path, name));
    } catch { /* The root scan can attach a folder that was still being created. */ }
  };
  const scan = () => {
    if (stopped) return;
    for (const [path, watcher] of watchers) if (!directory(path)) { watcher.close(); watchers.delete(path); }
    try { for (const name of readdirSync(root)) watchFolder(join(root, name)); } catch { /* Closed/removed cache. */ }
  };
  watchFolder(root, true); scan();
  return () => { stopped = true; for (const watcher of watchers.values()) watcher.close(); watchers.clear(); };
}
