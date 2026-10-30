import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, extname } from "node:path";
import type { DocRef, DocumentAccess } from "@workbench/contracts";
import type { OfficeAttachment, OfficeDocumentChoice, OfficeReferenceSnapshot } from "../../../packages/contracts/src/office-references.ts";
import type { Documents } from "./artifacts.ts";
import type { EditorGrants } from "./editors.ts";
import { physicalPath } from "./directory-operations.ts";
import { HttpError } from "./errors.ts";

const MAX_BYTES = 50 * 1024 * 1024, MAX_FILES = 20;
type Context = { documents: Documents; grants: EditorGrants; artifactId: string; token: string; access?: DocumentAccess };
type Snapshot = { id: string; owner: string; sessionId: string; refs: DocRef[]; files: Map<string, { ref: DocRef; meta: OfficeAttachment }>; touched: number };
const fail = (message: string): never => { throw new HttpError(409, "office_reference", message); };
function pathsOf(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_FILES || !value.every((p) => typeof p === "string" && p.length > 0 && p.length <= 8192)) return fail("참조 문서는 한 번에 20개까지 선택해 주세요.");
  return [...new Set(value)];
}

/** The trusted Workbench window chooses references. An editor never gains arbitrary file access.
 * Snapshots contain immutable document revisions, not copies of a second conversation store. */
export class OfficeReferences {
  private readonly selections = new Map<string, Map<string, string>>();
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly parse: (path: string) => Promise<{ ok: boolean; kind: string; text?: string; error?: string }>;
  constructor(parse = async (path: string) => (await import("./office-file-parse.mjs")).parseFileToText(path)) { this.parse = parse; }
  private scope(context: Context) {
    const { documents, grants, artifactId, token, access } = context;
    if (!grants.allows(token, artifactId)) return fail("이 문서 창의 참조 권한을 확인하지 못했습니다.");
    const bound = grants.access(token), view = documents.registry.forArtifact(artifactId).find((v) => v.viewId === bound?.viewId);
    if (!view || access && access.viewId !== bound?.viewId || view.sessionId !== grants.session(token)) return fail("문서 창이나 선택한 세션이 바뀌었습니다.");
    documents.registry.assertWrite(artifactId, bound);
    return { owner: `${artifactId}:${grants.previewInfo(token).baseUrl}`, sessionId: grants.session(token), artifact: documents.get(artifactId) };
  }
  private candidates(context: Context) {
    const { artifact } = this.scope(context), own = physicalPath(artifact.path), seen = new Set([own]);
    return context.documents.list().filter((item) => {
      if (item.workId !== artifact.workId) return false;
      const key = physicalPath(item.path);
      if (seen.has(key)) return false;
      try { if (!statSync(item.path).isFile()) return false; } catch { return false; }
      seen.add(key); return true;
    });
  }
  list(context: Context): { ok: true; items: OfficeDocumentChoice[] } {
    const items = this.candidates(context).map((item): OfficeDocumentChoice => {
      const views = context.documents.registry.forArtifact(item.id);
      return { path: item.path, name: item.name, dir: dirname(item.path), group: views.length ? "open" : "recent", state: views.some((view) => view.dirty) ? "modified" : "ok" };
    });
    items.sort((a, b) => Number(a.group === "recent") - Number(b.group === "recent"));
    return { ok: true, items };
  }
  private selected(context: Context) {
    const { owner } = this.scope(context);
    let selected = this.selections.get(owner);
    if (!selected) {
      while (this.selections.size >= 500) this.selections.delete(this.selections.keys().next().value!);
      selected = new Map(); this.selections.set(owner, selected);
    }
    return selected;
  }
  add(context: Context, paths: unknown) {
    const candidates = this.candidates(context), selected = this.selected(context);
    const accepted: OfficeAttachment[] = [], rejected: string[] = [];
    for (const path of pathsOf(paths)) {
      const item = candidates.find((doc) => doc.path === path);
      if (!item) { rejected.push("이 프로젝트의 문서 목록에서 참조를 선택해 주세요."); continue; }
      if (context.documents.registry.forArtifact(item.id).some((view) => view.dirty)) { rejected.push(`${item.name}: 먼저 문서를 저장해 주세요.`); continue; }
      const sizeBytes = statSync(item.path).size;
      if (sizeBytes > MAX_BYTES) { rejected.push(`${item.name}: 50MB 이하의 문서만 첨부할 수 있습니다.`); continue; }
      if (!selected.has(path) && selected.size >= 100) { rejected.push("첨부 선택 기록이 많습니다. 문서 탭을 다시 열어 주세요."); continue; }
      selected.set(path, item.id);
      accepted.push({ path, name: item.name, ext: extname(path).slice(1).toLowerCase(), sizeBytes });
    }
    return { accepted, rejected };
  }
  describe(context: Context, paths: unknown) {
    const selected = this.selected(context), allowed = new Set(this.candidates(context).map((item) => item.id));
    return pathsOf(paths).map((path) => {
      const artifactId = selected.get(path);
      if (!artifactId || !allowed.has(artifactId)) return fail("선택한 참조 문서가 이동했거나 이 문서 창에서 선택한 파일이 아닙니다.");
      return { path, artifactId };
    });
  }
  freeze(context: Context, paths: unknown, revisions: unknown): OfficeReferenceSnapshot {
    const scope = this.scope(context);
    if (!scope.sessionId) return fail("참조할 Workbench 세션을 먼저 연결해 주세요.");
    const selected = this.describe(context, paths);
    if (!Array.isArray(revisions) || revisions.length !== selected.length || revisions.some((value) => value !== null && (!Number.isSafeInteger(value) || value < 1))) return fail("참조 문서의 저장된 판을 확인하지 못했습니다.");
    const refs = context.documents.resolveReferences(selected.map((item, i) => ({ artifactId: item.artifactId, mode: "review", ...(revisions[i] === null ? {} : { revision: revisions[i] }) })));
    const files = new Map<string, { ref: DocRef; meta: OfficeAttachment }>();
    for (const [i, item] of selected.entries()) {
      const ref = refs[i]!, artifact = context.documents.get(item.artifactId), source = context.documents.revisionPath(item.artifactId, ref.revision);
      const sizeBytes = statSync(source).size;
      if (sizeBytes > MAX_BYTES) return fail(`${artifact.name}: 50MB 이하의 문서만 참조할 수 있습니다.`);
      if (createHash("sha256").update(readFileSync(source)).digest("hex") !== ref.sha256) return fail("참조 문서 판의 내용과 해시가 다릅니다.");
      files.set(item.path, { ref, meta: { path: item.path, name: artifact.name, ext: extname(item.path).slice(1).toLowerCase(), sizeBytes } });
    }
    const id = randomUUID(), now = Date.now();
    for (const [key, value] of this.snapshots) if (now - value.touched > 6 * 60 * 60 * 1000) this.snapshots.delete(key);
    if (this.snapshots.size >= 500) return fail("진행 중인 문서 참조가 많습니다. 기존 요청을 마친 뒤 다시 보내 주세요.");
    this.snapshots.set(id, { id, owner: scope.owner, sessionId: scope.sessionId, refs, files, touched: now });
    return { id, refs };
  }
  private snapshot(context: Context, id: unknown) {
    const scope = this.scope(context), found = typeof id === "string" ? this.snapshots.get(id) : undefined;
    if (!found || found.owner !== scope.owner || found.sessionId !== scope.sessionId) return fail("현재 문서·세션의 참조 판이 아닙니다. 요청을 다시 보내 주세요.");
    found.touched = Date.now(); return found;
  }
  references(context: Context, id: unknown) { return this.snapshot(context, id).refs; }
  async read(context: Context, id: unknown, path: unknown, offset = 0, length = 24_000) {
    const snapshot = this.snapshot(context, id), file = typeof path === "string" ? snapshot.files.get(path) : undefined;
    if (!file) return fail("이번 요청에 첨부한 문서만 읽을 수 있습니다.");
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 48_000) return fail("첨부 읽기 범위가 올바르지 않습니다.");
    const source = context.documents.revisionPath(file.ref.artifactId, file.ref.revision), bytes = readFileSync(source);
    if (bytes.length > MAX_BYTES || createHash("sha256").update(bytes).digest("hex") !== file.ref.sha256) return fail("참조 문서 판의 내용과 해시가 다릅니다.");
    const parsed = await this.parse(source);
    this.snapshot(context, id);
    if (!parsed.ok || parsed.kind !== "text" || typeof parsed.text !== "string") return { ok: false, error: parsed.error ?? "첨부 문서를 읽지 못했습니다." };
    return { ok: true, name: file.meta.name, text: parsed.text.slice(offset, offset + length), totalChars: parsed.text.length, offset };
  }
}
