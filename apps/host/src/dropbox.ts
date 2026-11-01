import { accessSync, constants, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { formatOf } from "@workbench/contracts";
import type { DropboxFolder, DropboxListing, DropboxOpened, DropboxState } from "../../../packages/contracts/src/dropbox.ts";
import { liveWorkAt } from "./entry.ts";
import { HttpError } from "./errors.ts";
import type { SessionManager } from "./sessions.ts";

type MetaStore = { getMeta(key: string): string | null; setMeta(key: string, value: string): void };
type Environment = { home?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv };
const KEY = "dropbox.folder";
const inside = (root: string, target: string) => { const part = relative(root, target); return part === "" || (part !== ".." && !part.startsWith("../") && !part.startsWith("..\\") && !isAbsolute(part)); };
const available = (path: string) => { try { return statSync(path).isDirectory(); } catch { return false; } };
const canonical = (path: string) => { try { return realpathSync.native(path); } catch { return resolve(path); } };

/** Official metadata only: never read account tokens or enumerate the user's documents here. */
export function discoverDropbox({ home = homedir(), platform = process.platform, env = process.env }: Environment = {}): DropboxFolder[] {
  const files = platform === "win32"
    ? [env.APPDATA, env.LOCALAPPDATA].filter((path): path is string => Boolean(path)).map(path => join(path, "Dropbox", "info.json"))
    : [join(home, ".dropbox", "info.json")];
  const found = new Map<string, DropboxFolder>();
  const add = (path: string, label: string, source: DropboxFolder["source"]) => {
    if (!isAbsolute(path)) return;
    const normalized = canonical(path);
    if (!found.has(normalized)) found.set(normalized, { path: normalized, label, source, available: available(normalized) });
  };
  for (const file of files) {
    try {
      if (statSync(file).size > 64 * 1024) continue;
      const info = JSON.parse(readFileSync(file, "utf8"));
      for (const [key, label] of [["personal", "개인 Dropbox"], ["business", "업무 Dropbox"]]) {
        if (typeof info?.[key!]?.path === "string") add(info[key!].path, label!, "registered");
      }
    } catch { /* Missing or damaged metadata still permits an explicit folder choice. */ }
  }
  if (!found.size) {
    const conventional = join(home, "Dropbox");
    if (available(conventional)) add(conventional, "Dropbox 폴더 후보", "suggested");
    if (platform === "darwin") {
      try { for (const name of readdirSync(join(home, "Library", "CloudStorage"))) if (/^Dropbox(?:-|$)/.test(name)) add(join(home, "Library", "CloudStorage", name), "Dropbox 폴더 후보", "suggested"); } catch { /* No File Provider folder. */ }
    }
  }
  return [...found.values()];
}

/** The desktop sync client owns transport. Workbench uses the same files and its existing revisions. */
export class DropboxFolders {
  private readonly store: MetaStore;
  private readonly manager: SessionManager;
  private readonly dataDir: string;
  private readonly environment: Environment;
  private timer?: NodeJS.Timeout;
  private readonly observed = new Map<string, { signature: string; settled: boolean; revision: number; dirty: boolean }>();
  constructor(store: MetaStore, manager: SessionManager, dataDir: string, environment: Environment = {}) { this.store = store; this.manager = manager; this.dataDir = dataDir; this.environment = environment; }
  private get root() { return this.store.getMeta(KEY) || null; }
  state(): DropboxState {
    const candidates = discoverDropbox(this.environment), path = this.root;
    const match = path ? candidates.find(folder => inside(folder.path, path)) : undefined;
    return { candidates, selected: path ? { path, label: match?.label ?? "선택한 Dropbox 폴더", source: match?.source ?? "manual", available: available(path) } : null, syncStatus: "managed-by-dropbox" };
  }
  connect(raw: string): DropboxState {
    if (typeof raw !== "string" || !isAbsolute(raw) || raw.length > 4096) throw new HttpError(400, "dropbox_path", "Dropbox 폴더의 전체 경로를 선택해 주세요.");
    let path: string;
    try { path = realpathSync.native(raw); if (!statSync(path).isDirectory()) throw new Error(); accessSync(path, constants.R_OK); }
    catch { throw new HttpError(400, "dropbox_unavailable", "폴더를 열 수 없습니다. Dropbox 앱의 폴더 위치와 오프라인 사용 설정을 확인해 주세요."); }
    if (inside(path, canonical(this.dataDir)) || inside(canonical(this.dataDir), path)) throw new HttpError(400, "dropbox_local_data", "앱 데이터 폴더는 동기화하지 않습니다. 문서가 있는 Dropbox 폴더를 선택해 주세요.");
    this.store.setMeta(KEY, path); this.observed.clear(); return this.state();
  }
  disconnect(): DropboxState { this.store.setMeta(KEY, ""); this.observed.clear(); return this.state(); }
  private scoped(raw = ""): string {
    const root = this.root;
    if (!root) throw new HttpError(409, "dropbox_disconnected", "먼저 Dropbox 폴더를 연결해 주세요.");
    const target = resolve(root, raw);
    if (!inside(root, target)) throw new HttpError(403, "dropbox_outside", "연결한 Dropbox 폴더 안에서 선택해 주세요.");
    let path: string;
    try { path = realpathSync.native(target); } catch { throw new HttpError(404, "dropbox_unavailable", "파일이나 폴더를 찾을 수 없습니다. Dropbox 동기화·오프라인 사용 상태를 확인해 주세요."); }
    if (!inside(root, path)) throw new HttpError(403, "dropbox_outside", "Dropbox 밖으로 연결된 경로는 열지 않습니다.");
    return path;
  }
  list(raw = ""): DropboxListing {
    const path = this.scoped(raw);
    if (!statSync(path).isDirectory()) throw new HttpError(400, "dropbox_not_folder", "폴더를 선택해 주세요.");
    const entries = readdirSync(path, { withFileTypes: true }).filter(entry => !entry.name.startsWith(".") && !entry.isSymbolicLink() && (entry.isDirectory() || (entry.isFile() && formatOf(entry.name))))
      .map(entry => ({ name: entry.name, path: join(path, entry.name), kind: entry.isDirectory() ? "folder" as const : "document" as const, conflictedCopy: /conflicted copy|충돌.*사본/i.test(entry.name) }))
      .sort((a, b) => Number(b.kind === "folder") - Number(a.kind === "folder") || a.name.localeCompare(b.name));
    return { path, parent: path === this.root ? null : dirname(path), entries: entries.slice(0, 500), truncated: entries.length > 500 };
  }
  open(raw: string, kind: "folder" | "document"): DropboxOpened {
    const path = this.scoped(raw), directory = statSync(path).isDirectory();
    if (directory !== (kind === "folder") || (!directory && !formatOf(path))) throw new HttpError(400, "dropbox_type", "열려는 폴더나 문서를 다시 선택해 주세요.");
    const cwd = directory ? path : dirname(path);
    const work = liveWorkAt(this.manager.view, cwd) ?? this.manager.createWork({ title: basename(cwd), titleSource: "user", cwd });
    return { work, ...(!directory ? { artifact: this.manager.openFile(work.id, path) } : {}) };
  }
  /** Poll registered documents only, and wait for two matching observations after atomic replacement. */
  refresh() {
    const root = this.root;
    if (!root) return;
    const ids = new Set<string>();
    for (const artifact of this.manager.documents.list()) {
      if (!inside(root, artifact.path)) continue;
      ids.add(artifact.id);
      let signature: string;
      try {
        if (!inside(root, realpathSync.native(artifact.path))) continue;
        const stat = statSync(artifact.path); signature = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      } catch { signature = "missing"; }
      const dirty = this.manager.documents.registry.forArtifact(artifact.id).some(view => view.dirty);
      const seen = this.observed.get(artifact.id);
      if (!seen || seen.signature !== signature) { this.observed.set(artifact.id, { signature, settled: false, revision: artifact.revision, dirty }); continue; }
      if (seen.settled && seen.revision === artifact.revision && seen.dirty === dirty) continue;
      try {
        const current = this.manager.documents.check(artifact.id);
        const next = current.diskState === "changed" && !dirty ? this.manager.documents.adoptDisk(artifact.id, "Dropbox 폴더에서 바뀐 내용") : current;
        this.observed.set(artifact.id, { signature, settled: true, revision: next.revision, dirty });
      } catch { /* Keep revisions and retry after transient file locks. Never overwrite or delete. */ }
    }
    for (const id of this.observed.keys()) if (!ids.has(id)) this.observed.delete(id);
  }
  start() { if (!this.timer) { this.refresh(); this.timer = setInterval(() => this.refresh(), 2000); this.timer.unref(); } }
  close() { clearInterval(this.timer); this.timer = undefined; this.observed.clear(); }
}
