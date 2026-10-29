import { randomBytes } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Folder, Work, WorkAtFolder, WorksDirView } from "@workbench/contracts";
import { HttpError } from "./errors.ts";
import { readBody, sendJson } from "./http.ts";

// ① 들어가는 길 (design §3, §13): which live work a folder already belongs to ("같은 폴더 = 같은
// 프로젝트"), and where works started without a folder get their own folder. The location is the
// user's choice; it applies to new works only, because an engine continues a conversation only in
// the folder it began in.

/** Folders and works as the session manager has them (read only). */
export type WorksView = { folders: ReadonlyMap<string, Folder>; works: ReadonlyMap<string, Work> };

/** `~` expanded and made absolute; null for an empty or relative path. */
function absolute(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const expanded = trimmed === "~" ? homedir() : trimmed.startsWith("~/") ? join(homedir(), trimmed.slice(2)) : trimmed;
  return isAbsolute(expanded) ? resolve(expanded) : null;
}

/** The real path of a folder (links followed), or the normalised path when it does not exist. */
function realFolder(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** Archived, or under an archived folder. */
function hidden(view: WorksView, work: Work) {
  if (work.archivedAt) return true;
  for (let at = work.folderId; at; at = view.folders.get(at)?.parentId ?? null) if (view.folders.get(at)?.archivedAt) return true;
  return false;
}

/**
 * The live work whose folder is `path` (compared as real paths: links, `~`, trailing slashes and
 * `..` do not matter). Several works may share a folder from before: the most recently used one.
 */
export function liveWorkAt(view: WorksView, path: string): Work | null {
  const wanted = absolute(path);
  if (!wanted) return null;
  const target = realFolder(wanted);
  let found: Work | null = null;
  for (const work of view.works.values()) {
    if (hidden(view, work) || realFolder(work.cwd) !== target) continue;
    if (!found || work.updatedAt > found.updatedAt) found = work;
  }
  return found;
}

/** Why new work folders cannot go under `path` now, or null. */
function folderProblem(path: string): string | null {
  if (!existsSync(path)) return "폴더가 없습니다";
  if (!statSync(path).isDirectory()) return "폴더가 아닙니다";
  try {
    accessSync(path, constants.W_OK);
  } catch {
    return "쓸 수 없는 폴더입니다";
  }
  return null;
}

/** Write and remove a small file: the folder really takes new files (permissions, read-only mounts). */
function probeWritable(path: string) {
  const probe = join(path, `.workbench-write-check-${randomBytes(4).toString("hex")}`);
  try {
    writeFileSync(probe, "");
  } catch {
    return false;
  } finally {
    rmSync(probe, { force: true });
  }
  return true;
}

const KEY = "works.dir";

type MetaStore = { getMeta(key: string): string | null; setMeta(key: string, value: string): void };

/** "새 프로젝트 폴더 위치": kept in the gateway's meta table, checked before it is taken. */
export class WorksDir {
  private readonly store: MetaStore;
  readonly defaultPath: string;
  private readonly vault: () => string | null;

  constructor(store: MetaStore, defaultPath: string, vault: () => string | null = () => null) {
    this.store = store;
    this.defaultPath = defaultPath;
    this.vault = vault;
  }

  /** The folder the user chose, or null for the default. */
  private get chosen(): string | null {
    return this.store.getMeta(KEY) || null;
  }

  view(): WorksDirView {
    const chosen = this.chosen;
    return { path: chosen ?? this.defaultPath, defaultPath: this.defaultPath, custom: Boolean(chosen), problem: chosen ? folderProblem(chosen) : null };
  }

  /**
   * Where the next work started without a folder gets its folder. The default is made when missing;
   * a chosen folder that went away (an unplugged disk) is reported, not silently replaced.
   */
  root(): string {
    const chosen = this.chosen;
    if (!chosen) {
      mkdirSync(this.defaultPath, { recursive: true });
      return this.defaultPath;
    }
    const problem = folderProblem(chosen);
    if (problem) throw new HttpError(409, "works_dir_unusable", `새 프로젝트 폴더 위치(${chosen})를 쓸 수 없습니다: ${problem}. 설정에서 바꾸거나 기본으로 되돌리세요.`);
    return chosen;
  }

  /** Take a new location: an absolute folder (made when only its last part is missing) that takes files. */
  set(raw: string): WorksDirView {
    const path = absolute(raw);
    if (!path) throw new HttpError(400, "invalid_path", "폴더의 전체 경로를 적어 주세요(예: ~/문서/프로젝트).");
    if (realFolder(path) === realFolder(this.defaultPath)) return this.reset();
    const vault = this.vault();
    if (vault && inside(realFolder(vault), realFolder(path))) throw new HttpError(400, "inside_vault", "옵시디언 볼트 안에는 둘 수 없습니다. 볼트는 읽기 전용입니다.");
    if (!existsSync(path)) {
      if (!existsSync(dirname(path)) || !statSync(dirname(path)).isDirectory()) throw new HttpError(400, "missing_folder", `폴더가 없습니다: ${path}`);
      try {
        mkdirSync(path);
      } catch {
        throw new HttpError(400, "not_writable", `폴더를 만들 수 없습니다: ${path}`);
      }
    }
    if (!statSync(path).isDirectory()) throw new HttpError(400, "not_folder", `폴더가 아닙니다: ${path}`);
    if (!probeWritable(path)) throw new HttpError(400, "not_writable", `쓸 수 없는 폴더입니다: ${path}`);
    this.store.setMeta(KEY, path);
    return this.view();
  }

  /** Back to the gateway's own folder. */
  reset(): WorksDirView {
    this.store.setMeta(KEY, "");
    return this.view();
  }
}

async function readPath(req: IncomingMessage): Promise<string> {
  const body = await readBody(req, 20_000);
  try {
    const parsed = body.length ? (JSON.parse(body.toString("utf8")) as { path?: unknown }) : {};
    return typeof parsed.path === "string" ? parsed.path : "";
  } catch {
    throw new HttpError(400, "invalid_json", "JSON 형식이 아닙니다.");
  }
}

/** `/api/entry/*`; false when the path is not one of these routes. */
export async function handleEntry(deps: { view: () => WorksView; worksDir: WorksDir }, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const method = req.method ?? "GET";
  if (url.pathname === "/api/entry/work" && method === "GET") {
    const answer: WorkAtFolder = { work: liveWorkAt(deps.view(), url.searchParams.get("path") ?? "") };
    sendJson(res, 200, answer);
    return true;
  }
  if (url.pathname === "/api/entry/works-dir") {
    const answer = method === "GET" ? deps.worksDir.view() : method === "PUT" ? deps.worksDir.set(await readPath(req)) : method === "DELETE" ? deps.worksDir.reset() : null;
    if (!answer) return false;
    sendJson(res, 200, answer);
    return true;
  }
  return false;
}
