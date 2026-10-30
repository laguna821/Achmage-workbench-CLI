import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { formatOf, type DocRef, type DocumentAccess, type TranscriptItem } from "@workbench/contracts";
import type { OfficeAttachment, OfficeDocumentChoice, OfficeReferenceSnapshot, OfficeStoredAttachment } from "../../../packages/contracts/src/office-references.ts";
import type { Documents } from "./artifacts.ts";
import type { EditorGrants } from "./editors.ts";
import { physicalPath } from "./directory-operations.ts";
import { HttpError } from "./errors.ts";
import { keepOfficeFile, officeFileBytes, officeFileMeta, officeImageBytes, readOfficeFile, selectedOfficeBytes } from "./office-files.ts";

const MAX_BYTES = 50 * 1024 * 1024, MAX_FILES = 20;
type Context = { documents: Documents; grants: EditorGrants; artifactId: string; token: string; access?: DocumentAccess };
type Selected = { artifactId: string } | { meta: OfficeAttachment; fileId?: string };
type Frozen = { ref?: DocRef; meta: OfficeStoredAttachment };
type Snapshot = { id: string; owner: string; sessionId: string; refs: DocRef[]; files: Map<string, Frozen>; touched: number };
const fail = (message: string): never => { throw new HttpError(409, "office_reference", message); };
function pathsOf(value: unknown, max = MAX_FILES): string[] {
  if (!Array.isArray(value) || value.length > max || !value.every((p) => typeof p === "string" && p.length > 0 && p.length <= 8192)) return fail(`첨부 경로를 확인해 주세요. 한 번에 ${max}개까지 처리할 수 있습니다.`);
  return [...new Set(value)];
}

/** The trusted Workbench window chooses references. An editor never gains arbitrary file access.
 * Snapshots contain immutable document revisions, not copies of a second conversation store. */
export class OfficeReferences {
  private readonly selections = new Map<string, { sessionId: string | null; files: Map<string, Selected> }>();
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
    const { owner, sessionId } = this.scope(context);
    let entry = this.selections.get(owner);
    // Keep the first request's selection when it creates its session. A switch
    // between real conversations never carries the old composer authority.
    if (!entry || entry.sessionId !== null && entry.sessionId !== sessionId) {
      while (this.selections.size >= 500) this.selections.delete(this.selections.keys().next().value!);
      entry = { sessionId, files: new Map() }; this.selections.set(owner, entry);
    }
    entry.sessionId = sessionId;
    return entry.files;
  }
  private enroll(context: Context, meta: OfficeAttachment, item: Selected) {
    const selected = this.selected(context);
    if (!selected.has(meta.path) && selected.size >= 100) return fail("첨부 선택 기록이 많습니다. 문서 탭을 다시 열어 주세요.");
    selected.set(meta.path, item); return meta;
  }
  private documentMeta(context: Context, artifactId: string) {
    const item = context.documents.get(artifactId);
    if (item.workId !== this.scope(context).artifact.workId || item.id === context.artifactId) return fail("이 프로젝트의 다른 문서를 선택해 주세요.");
    if (context.documents.registry.forArtifact(item.id).some((view) => view.dirty)) return fail(`${item.name}: 먼저 문서를 저장해 주세요.`);
    return officeFileMeta(item.path, item.name);
  }
  add(context: Context, paths: unknown) {
    const candidates = this.candidates(context), selected = this.selected(context);
    const accepted: OfficeAttachment[] = [], rejected: string[] = [];
    for (const path of pathsOf(paths)) {
      try {
        const doc = candidates.find((item) => item.path === path), previous = selected.get(path);
        if (doc) accepted.push(this.enroll(context, this.documentMeta(context, doc.id), { artifactId: doc.id }));
        else if (previous && "meta" in previous) accepted.push(this.enroll(context, selectedOfficeBytes(context.documents.dataDir, previous).meta, previous));
        else rejected.push("이 프로젝트의 문서 목록에서 참조를 선택해 주세요.");
      } catch (error) { rejected.push(error instanceof Error ? error.message : String(error)); }
    }
    return { accepted, rejected };
  }
  /** Only the root-authenticated parent calls this after the native chooser returns. */
  importPaths(context: Context, paths: unknown) {
    const { artifact } = this.scope(context), accepted: OfficeAttachment[] = [], rejected: string[] = [];
    for (const path of pathsOf(paths)) {
      try {
        const actual = physicalPath(path);
        if (actual === physicalPath(artifact.path)) return fail("현재 문서 자신은 첨부할 수 없습니다.");
        const aliases = context.documents.list().filter((doc) => physicalPath(doc.path) === actual);
        if (aliases.some((doc) => context.documents.registry.forArtifact(doc.id).some((view) => view.dirty))) return fail("선택한 파일에 미저장 편집이 있습니다. 먼저 저장해 주세요.");
        const { meta } = officeFileBytes(path);
        if (formatOf(path)) {
          const found = aliases.find((doc) => doc.workId === artifact.workId);
          const doc = found ?? context.documents.track(artifact.workId, dirname(path), path, "user", null, "Office 참조 첨부")?.artifact;
          if (!doc) return fail("첨부 문서를 등록하지 못했습니다.");
          accepted.push(this.enroll(context, this.documentMeta(context, doc.id), { artifactId: doc.id }));
        } else accepted.push(this.enroll(context, meta, { meta }));
      } catch (error) { rejected.push(error instanceof Error ? error.message : String(error)); }
    }
    return { accepted, rejected };
  }
  upload(context: Context, bytes: Buffer, name: string) {
    this.scope(context);
    const saved = keepOfficeFile(context.documents.dataDir, bytes, name);
    return { accepted: [this.enroll(context, saved.meta, saved)], rejected: [] };
  }
  /** Only persisted host transcript entries, never a client-provided list, enroll a reopened chat. */
  restore(context: Context, items: TranscriptItem[]) {
    const selected = this.selected(context), { artifact } = this.scope(context), restored = new Map<string, OfficeAttachment>();
    for (const item of items) {
      if (item.kind !== "user" || item.office?.artifactId !== artifact.id) continue;
      const stored: OfficeStoredAttachment[] = item.office.attachments ?? item.refs?.filter((ref) => ref.mode === "review").flatMap((ref) => {
        try { const doc = context.documents.get(ref.artifactId); return [{ path: doc.path, name: doc.name, ext: doc.path.split(".").at(-1)!.toLowerCase(), sizeBytes: doc.size, artifactId: doc.id }]; } catch { return []; }
      }) ?? [];
      for (const meta of stored) {
        if (selected.size >= 100 && !selected.has(meta.path)) continue;
        restored.set(meta.path, meta);
        if (meta.artifactId) {
          try { const doc = context.documents.get(meta.artifactId); if (doc.workId === artifact.workId && doc.id !== artifact.id) selected.set(doc.path, { artifactId: doc.id }); } catch { /* Missing document remains visible in history, without read authority. */ }
        } else if (meta.fileId) selected.set(meta.path, { meta, fileId: meta.fileId });
      }
    }
    return [...restored.values()];
  }
  describe(context: Context, paths: unknown) {
    const selected = this.selected(context), allowed = new Set(this.candidates(context).map((item) => item.id));
    return pathsOf(paths, 100).map((path) => {
      const item = selected.get(path);
      if (!item || "artifactId" in item && !allowed.has(item.artifactId)) return fail("선택한 참조 문서가 이동했거나 이 문서 창에서 선택한 파일이 아닙니다.");
      return { path, artifactId: "artifactId" in item ? item.artifactId : null };
    });
  }
  freeze(context: Context, paths: unknown, revisions: unknown): OfficeReferenceSnapshot {
    const scope = this.scope(context);
    if (!scope.sessionId) return fail("참조할 Workbench 세션을 먼저 연결해 주세요.");
    const selected = this.describe(context, paths);
    if (!Array.isArray(revisions) || revisions.length !== selected.length || revisions.some((value) => value !== null && (!Number.isSafeInteger(value) || value < 1))) return fail("참조 문서의 저장된 판을 확인하지 못했습니다.");
    const refs: DocRef[] = [], files = new Map<string, Frozen>();
    for (const [i, item] of selected.entries()) {
      if (item.artifactId) {
        const [ref] = context.documents.resolveReferences([{ artifactId: item.artifactId, mode: "review", ...(revisions[i] === null ? {} : { revision: revisions[i] }) }]);
        const artifact = context.documents.get(item.artifactId), source = context.documents.revisionPath(item.artifactId, ref!.revision);
        const meta = officeFileMeta(item.path, artifact.name, statSync(source).size);
        if (createHash("sha256").update(readFileSync(source)).digest("hex") !== ref!.sha256) return fail("참조 문서 판의 내용과 해시가 다릅니다.");
        refs.push(ref!); files.set(item.path, { ref, meta: { ...meta, artifactId: artifact.id } });
      } else {
        if (revisions[i] !== null) return fail("첨부 파일의 판 정보가 올바르지 않습니다.");
        const entry = this.selected(context).get(item.path)!;
        if (!("meta" in entry)) return fail("첨부 파일 선택이 바뀌었습니다.");
        const { bytes, meta } = selectedOfficeBytes(context.documents.dataDir, entry);
        const kept = keepOfficeFile(context.documents.dataDir, bytes, meta.name);
        files.set(item.path, { meta: { ...meta, fileId: kept.fileId } });
      }
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
  attachments(context: Context, id: unknown) { return [...this.snapshot(context, id).files.values()].map((file) => file.meta); }
  private frozenFile(context: Context, id: unknown, path: unknown) {
    const snapshot = this.snapshot(context, id), file = typeof path === "string" ? snapshot.files.get(path) : undefined;
    if (!file) return fail("이번 요청에 첨부한 문서만 읽을 수 있습니다.");
    if (!file.ref) return { ...readOfficeFile(context.documents.dataDir, file.meta.fileId!), meta: file.meta };
    const source = context.documents.revisionPath(file.ref.artifactId, file.ref.revision), bytes = readFileSync(source);
    if (bytes.length > MAX_BYTES || createHash("sha256").update(bytes).digest("hex") !== file.ref.sha256) return fail("참조 문서 판의 내용과 해시가 다릅니다.");
    return { path: source, bytes, meta: file.meta };
  }
  readImage(context: Context, id: unknown, path: unknown) {
    if (id != null) { const file = this.frozenFile(context, id, path); return officeImageBytes(file.meta, file.bytes); }
    const entry = typeof path === "string" ? this.selected(context).get(path) : null;
    if (!entry || !("meta" in entry)) return fail("이 문서 창에서 선택한 이미지만 읽을 수 있습니다.");
    const file = selectedOfficeBytes(context.documents.dataDir, entry);
    return officeImageBytes(file.meta, file.bytes);
  }
  async read(context: Context, id: unknown, path: unknown, offset = 0, length = 24_000) {
    const file = this.frozenFile(context, id, path);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 48_000) return fail("첨부 읽기 범위가 올바르지 않습니다.");
    const parsed = await this.parse(file.path);
    this.snapshot(context, id);
    if (!parsed.ok || parsed.kind !== "text" || typeof parsed.text !== "string") return { ok: false, error: parsed.error ?? "첨부 문서를 읽지 못했습니다." };
    return { ok: true, name: file.meta.name, text: parsed.text.slice(offset, offset + length), totalChars: parsed.text.length, offset };
  }
}
