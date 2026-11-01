import { randomUUID } from "node:crypto";
import { constants, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { KbRunScopes, createKnowledgeDocument, parseKbCreateRequest } from "../../../vendor/ieumoffice/apps/shell/src/main/knowledge-base.ts";
import { createFileViaCli } from "../../../vendor/ieumoffice/apps/shell/src/main/mcp/headless-cli.ts";
import { listKnowledgeFiles } from "../../../vendor/ieumoffice/apps/shell/src/main/knowledge-base.ts";
import { HttpError } from "./errors.ts";

const invalid = () => new HttpError(400, "knowledge_home_request", "지식베이스 요청을 확인해 주세요.");
const record = value => value && typeof value === "object" && !Array.isArray(value);
const stemOf = title => {
  let stem = title.trim().replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/\.(md|docx)$/i, "").slice(0, 80).replace(/[. ]+$/, "") || "새 문서";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)) stem = "_" + stem;
  return stem;
};

/** The original home has no document or CLI conversation. Its own owners hold
 * group scopes and newly created citation targets for the lifetime of that home. */
export class OfficeKnowledgeHome {
  constructor(manager, library) {
    this.manager = manager; this.library = library;
    this.owners = new Map(); this.scopes = new KbRunScopes(); this.nextOwner = 0;
  }
  open() {
    this.library.check();
    if (this.owners.size >= 32) throw new HttpError(429, "knowledge_home_busy", "열린 지식베이스 창을 닫은 뒤 다시 열어 주세요.");
    const owner = randomUUID();
    this.owners.set(owner, { id: ++this.nextOwner, scopes: new Set(), created: new Map(), controller: new AbortController(), calls: new AbortController(), creating: false });
    return owner;
  }
  require(owner) {
    this.library.check();
    const held = this.owners.get(owner);
    if (!held) throw new HttpError(410, "knowledge_home_closed", "지식베이스 창을 다시 열어 주세요.");
    return held;
  }
  close(owner) {
    const held = this.owners.get(owner); if (!held) return;
    held.controller.abort();
    for (const scope of held.scopes) this.scopes.close(held.id, scope);
    this.owners.delete(owner);
  }
  cancel(owner) { const held = this.require(owner); held.calls.abort(); held.calls = new AbortController(); }
  shutdown() { for (const owner of this.owners.keys()) this.close(owner); }
  groups() { return new Map(this.library.items().map(item => [item.path, item.group ?? ""])); }
  paths(owner, raw) {
    return this.scopes.narrow(this.require(owner).id, raw, this.library.paths(), () => this.groups());
  }
  destination(input) {
    if (!record(input) || typeof input.workId !== "string" || (input.workspaceId !== undefined && typeof input.workspaceId !== "string")) {
      throw new HttpError(400, "knowledge_destination", "새 문서와 인용 파일을 열 프로젝트를 선택해 주세요.");
    }
    return this.manager.documentDestination(input.workId, input.workspaceId);
  }
  async invoke(owner, channel, args, destination, signal) {
    const held = this.require(owner);
    signal = AbortSignal.any([signal ?? new AbortController().signal, held.controller.signal, held.calls.signal]);
    this.library.check(signal);
    if (!Array.isArray(args) || args.length > 1) throw invalid();
    const raw = args[0];
    if (channel === "kb:open-scope" && args.length === 1) {
      const files = new Set(this.library.paths());
      const scope = this.scopes.open(held.id, raw, new Map([...this.groups()].filter(([path]) => files.has(path))));
      held.scopes.add(scope);
      while (held.scopes.size > 16) held.scopes.delete(held.scopes.values().next().value);
      return scope;
    }
    if (channel === "kb:close-scope" && args.length === 1) {
      this.scopes.close(held.id, raw); held.scopes.delete(raw); return null;
    }
    if (channel === "kb:list" && args.length <= 1 && (raw === undefined || record(raw))) return listKnowledgeFiles(this.paths(owner, raw));
    if (channel === "kb:search" && record(raw)) {
      return this.library.search(raw.q, raw.limit ?? 8, undefined, signal, () => this.paths(owner, raw));
    }
    if (channel === "kb:read" && record(raw)) {
      return this.library.read(raw.path, raw.offset ?? 0, signal, () => this.paths(owner, raw).includes(raw.path));
    }
    if (channel === "home:starred-groups" && !args.length) return this.library.library().groups;
    // The original panel requests limit:0 solely to show its chosen group's count.
    if (channel === "home:starred" && record(raw) && raw.limit === 0 && typeof raw.group === "string") {
      const count = this.library.paths(raw.group).length;
      return { entries: [], total: count, totalAll: count };
    }
    if (channel === "kb:create-document" && args.length === 1) return this.create(owner, raw, destination, signal);
    if (channel === "home:open-path" && args.length === 1 && typeof raw === "string") return this.openPath(owner, raw, destination);
    throw invalid();
  }
  openPath(owner, path, destination) {
    const held = this.require(owner), created = held.created.get(path);
    if (created) return this.manager.documents.get(created);
    if (!this.library.selected(path)) throw new HttpError(403, "office_knowledge_scope", "별표 자료나 이 창에서 만든 문서만 열 수 있습니다.");
    const work = this.destination(destination);
    return this.manager.openFile(work.id, path, destination.workspaceId);
  }
  async create(owner, raw, destination, signal) {
    const held = this.require(owner), request = parseKbCreateRequest(raw), work = this.destination(destination);
    if (held.creating) throw new HttpError(409, "knowledge_creating", "앞서 요청한 문서를 만들고 있습니다.");
    if (held.created.size >= 128) throw new HttpError(429, "knowledge_created_limit", "이 창에서 만든 문서가 많습니다. 지식베이스를 새로 열어 주세요.");
    const folder = realpathSync(work.cwd);
    const root = join(this.manager.documents.dataDir, "office", "knowledge", "generated"); mkdirSync(root, { recursive: true });
    const staging = mkdtempSync(join(root, "answer-"));
    held.creating = true;
    try {
      const check = () => {
        this.library.check(signal); this.require(owner);
        const current = this.destination(destination);
        if (current.cwd !== work.cwd || realpathSync(current.cwd) !== folder) throw new HttpError(409, "knowledge_destination_changed", "저장할 작업공간이 바뀌었습니다. 위치를 다시 선택해 주세요.");
      };
      check();
      const result = await createKnowledgeDocument({
        dir: () => staging, uniquePath: (dir, fileName) => join(dir, fileName), sanitizeBase: stemOf,
        writeText: async (path, text) => { writeFileSync(path, text, { flag: "wx", mode: 0o600 }); },
        markdownToDocx: async (markdown, out) => {
          const ieum = this.manager.documents.ieum;
          if (!ieum?.available) throw new HttpError(503, "ieumoffice_missing", "내장 문서 도구를 찾지 못했습니다.");
          await createFileViaCli({ run: async args => {
            check();
            const input = args[args.indexOf("--from") + 1];
            const json = await ieum.run(args, [dirname(input), staging], 180_000, signal);
            check();
            return { ok: json.status === "ok", code: json.status === "ok" ? 0 : 1, json, stdout: "", stderr: "" };
          } }, { type: "docx", input: { name: "content.md", content: markdown }, out });
        },
        recordRecent() {},
      }, request);
      check();
      if (statSync(result.path).size > 200_000_000) throw new HttpError(413, "knowledge_output_size", "생성된 문서가 너무 큽니다.");
      const stem = stemOf(request.title); let path;
      for (let index = 1; index <= 999; index++) {
        path = join(folder, stem + (index === 1 ? "" : " " + index) + "." + request.format);
        this.manager.documents.registry.assertPath(path);
        try { copyFileSync(result.path, path, constants.COPYFILE_EXCL); break; }
        catch (error) { if (error.code !== "EEXIST") throw error; path = undefined; }
      }
      if (!path) throw new HttpError(409, "knowledge_name_taken", "같은 이름의 문서가 너무 많습니다.");
      const tracked = this.manager.documents.track(work.id, work.cwd, path, "user", null, "지식베이스 답변에서 생성");
      if (!tracked) throw new HttpError(500, "knowledge_not_tracked", "문서는 저장했지만 목록에 등록하지 못했습니다: " + path);
      held.created.set(path, tracked.artifact.id);
      return { path, artifactId: tracked.artifact.id };
    } finally { held.creating = false; rmSync(staging, { recursive: true, force: true }); }
  }
}
