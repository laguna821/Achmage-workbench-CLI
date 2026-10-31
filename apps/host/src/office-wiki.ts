import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SessionManager } from "./sessions.ts";
import type { EditorGrants } from "./editors.ts";
import { isWorkbenchPath, PROJECT_NOTE_IN_GIT, WORKBENCH_DIR } from "./artifacts.ts";
import { HttpError } from "./errors.ts";
import type { WikiFs } from "./office-wiki-engine.mjs";

const inside = (root: string, path: string) => { const rel = relative(root, path); return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
const invalid = (message = "위키 문서 요청을 확인해 주세요.") => new HttpError(400, "office_wiki", message);
const denied = () => new HttpError(403, "office_wiki_scope", "현재 문서의 작업공간에서만 위키 문서를 열 수 있습니다.");

/** Existing workspaces and editor grants own the scope; the original wiki owns all link rules. */
export class OfficeWiki {
  private readonly manager: SessionManager;
  constructor(manager: SessionManager) { this.manager = manager; }

  private async scope(artifactId: string, token: string, grants: EditorGrants) {
    const documents = this.manager.documents;
    if (!grants.allows(token, artifactId)) throw denied();
    const access = grants.access(token), sessionId = grants.session(token);
    const view = documents.registry.forArtifact(artifactId).find(item => item.viewId === access?.viewId);
    if (!view || view.sessionId !== sessionId) throw denied();
    const artifact = documents.get(artifactId);
    if (artifact.format !== "markdown") throw invalid("Markdown 문서에서 위키를 사용할 수 있습니다.");
    const work = this.manager.view.works.get(artifact.workId);
    if (!work) throw denied();
    const workspace = artifact.workspaceId ? this.manager.workspaces.requireActive(artifact.workspaceId, artifact.workId) : null;
    const cwd = await realpath(workspace?.cwd ?? work.cwd), path = await realpath(artifact.path);
    const root = inside(cwd, path) ? cwd : dirname(path);
    const key = (target: string) => JSON.stringify([artifact.workId, artifact.workspaceId ?? null, sessionId, target]);
    const check = () => {
      const current = documents.registry.forArtifact(artifactId).find(item => item.viewId === access?.viewId);
      if (!grants.allows(token, artifactId) || !current || current.sessionId !== sessionId) throw denied();
    };
    return { artifact, path, root, sessionId, key, check };
  }

  async action(artifactId: string, token: string, grants: EditorGrants, action: unknown, input: Record<string, unknown>) {
    const scope = await this.scope(artifactId, token, grants);
    const engine = await import("./office-wiki-engine.mjs");
    const allowed = async (raw: string, container = false) => {
      const path = resolve(raw);
      if (!inside(scope.root, path) || relative(scope.root, path).split(sep).some(part => engine.SKIP_DIRS.has(part))) throw denied();
      if (isWorkbenchPath(path) && !(container && basename(path) === WORKBENCH_DIR)) throw denied();
      const physical = await realpath(path);
      if (!inside(scope.root, physical) || relative(scope.root, physical).split(sep).some(part => engine.SKIP_DIRS.has(part)) || isWorkbenchPath(physical) && !(container && basename(physical) === WORKBENCH_DIR)) throw denied();
      return physical;
    };
    const fs: WikiFs = {
      isFile: async path => { try { return (await stat(await allowed(path))).isFile(); } catch { return false; } },
      list: async dir => {
        const physical = await allowed(dir, true), files: string[] = [], dirs: string[] = [];
        for (const item of await readdir(physical, { withFileTypes: true })) {
          if (engine.SKIP_DIRS.has(item.name)) continue;
          if (basename(physical) === WORKBENCH_DIR && item.name !== PROJECT_NOTE_IN_GIT) continue;
          // Match the original walker: directory and file links are not indexed.
          if (item.isDirectory()) dirs.push(item.name);
          else if (item.isFile() && await fs.isFile(join(dir, item.name))) files.push(item.name);
        }
        return { files, dirs };
      },
      read: async path => readFile(await allowed(path), "utf8"),
      mtimeMs: async path => { try { return (await stat(await allowed(path))).mtimeMs; } catch { return 0; } },
    };
    let result: unknown;
    if (action === "resolve") {
      if (!Array.isArray(input.targets) || input.targets.length > 500 || input.targets.some(value => typeof value !== "string" || value.length > 4096)) throw invalid();
      result = Object.fromEntries(await engine.resolveWikiLinks(input.targets, { fromPath: scope.path, root: scope.root }, fs));
    } else if (action === "backlinks") result = await engine.wikiBacklinks(scope.root, scope.path, fs);
    else if (action === "graph") result = await engine.wikiGraph(scope.root, fs);
    else if (action === "take-fragment") result = engine.takeWikiFragment(scope.key(scope.path));
    else if (action === "open") {
      if (typeof input.path !== "string" || input.path.length > 4096 || !isAbsolute(input.path) || typeof input.fragment !== "string" || input.fragment.length > 4096) throw invalid();
      const path = await allowed(input.path);
      if (!(await stat(path)).isFile()) throw invalid();
      scope.check();
      const target = this.manager.openFile(scope.artifact.workId, path, scope.artifact.workspaceId, scope.sessionId ?? undefined);
      engine.rememberWikiFragment(scope.key(path), input.fragment);
      result = { artifactId: target.id };
    } else throw invalid();
    scope.check();
    return result;
  }
}
