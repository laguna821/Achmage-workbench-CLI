import { createHash, randomUUID } from "node:crypto";
import { constants, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { formatOf, type Artifact, type DocumentAccess } from "@workbench/contracts";
import type { OfficeOutputFormat } from "../../../packages/contracts/src/office-output.ts";
import type { Documents } from "./artifacts.ts";
import { isWorkbenchPath } from "./artifacts.ts";
import { HttpError } from "./errors.ts";
import { decodeHwpSave, hwpFormat, prepareHwpSave } from "./hwp-codec.ts";
import { checkOfficeCopy } from "./office-copy-codec.ts";

export type OutputPlan = { id: string; path: string; format: OfficeOutputFormat; exists: boolean; size: number };
type Result = { path: string; artifact: Artifact; backupPath?: string };
type Ticket = OutputPlan & { artifactId: string; revision: number; sourcePath: string; viewId: string | null; sessionId: string | null; sha256: string | null; expires: number; inputHash?: string; outputHash?: string; backupPath?: string; result?: Result };
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function disk(path: string) {
  if (!existsSync(path)) return null;
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new HttpError(400, "output_not_file", "일반 파일 경로를 선택해 주세요.");
  if (info.size > 200_000_000) throw new HttpError(413, "output_too_large", "저장할 대상 파일이 너무 큽니다.");
  return readFileSync(path);
}

/** Parent UI selects a destination; an editor never gains arbitrary filesystem access. */
export class OfficeOutputs {
  private readonly tickets = new Map<string, Ticket>();
  private readonly busy = new Set<string>();
  private readonly documents: Documents;
  private readonly register: (source: Artifact, path: string, revision: number, sessionId: string | null) => Artifact;
  constructor(documents: Documents, register: OfficeOutputs["register"]) { this.documents = documents; this.register = register; }
  private file(id: string) { return join(this.documents.dataDir, "office-outputs", `${id}.json`); }
  private remember(ticket: Ticket) {
    const path = this.file(ticket.id), temp = `${path}.${randomUUID()}.tmp`;
    mkdirSync(dirname(path), { recursive: true });
    try { writeFileSync(temp, JSON.stringify(ticket), { flag: "wx", mode: 0o600 }); renameSync(temp, path); }
    finally { rmSync(temp, { force: true }); }
    this.tickets.set(ticket.id, ticket);
  }
  private scope(artifactId: string, access?: DocumentAccess) {
    if (!access) {
      this.documents.registry.assertWrite(artifactId);
      return { viewId: null, sessionId: null };
    }
    const view = this.documents.registry.list().find((entry) => entry.viewId === access.viewId && entry.artifactId === artifactId);
    if (!view) throw new HttpError(409, "output_view_changed", "문서 창을 다시 확인해 주세요.");
    // Reading/copying a revision is allowed in a read-only view; source bytes are never written.
    return { viewId: view.viewId, sessionId: view.sessionId };
  }
  prepare(artifactId: string, revision: number, rawPath: string, access?: DocumentAccess): OutputPlan {
    const source = this.documents.get(artifactId);
    const scope = this.scope(artifactId, access);
    if (!Number.isSafeInteger(revision) || revision < 1 || revision > source.revision) throw new HttpError(400, "output_revision", "저장할 문서 판이 올바르지 않습니다.");
    if (!rawPath.trim() || rawPath.length > 4096 || rawPath.includes("\0")) throw new HttpError(400, "output_path", "저장할 파일 이름을 입력하세요.");
    const requested = isAbsolute(rawPath) ? resolve(rawPath) : resolve(dirname(source.path), rawPath);
    // Pin the parent directory too: replacing it with a symlink later must not redirect this job.
    const path = join(realpathSync(dirname(requested)), basename(requested));
    const format = extname(path).slice(1).toLowerCase() as OfficeOutputFormat;
    const family = formatOf(path);
    const hangul = ["hwp", "hwpx"].includes(source.format) && ["hwp", "hwpx"].includes(format);
    const same = family === source.format && ["docx", "pptx", "xlsx", "markdown", "html", "xmind", "epub", "pdf"].includes(source.format);
    if (!hangul && !same && format !== "pdf") throw new HttpError(415, "output_format", "현재 문서와 같은 파일 형식으로 저장해 주세요.");
    // Until the text asset copier handles a destination, do not publish a document with
    // silently broken relative images/styles/scripts. Binary formats embed their resources.
    if (["markdown", "html"].includes(source.format) && same && dirname(path) !== realpathSync(dirname(source.path))) throw new HttpError(415, "output_assets_pending", "이 문서의 다른 폴더 저장은 첨부 자산 복사 연결 후 사용할 수 있습니다. 지금은 원본과 같은 폴더를 선택해 주세요.");
    if (isWorkbenchPath(path) || path === resolve(source.path) || (existsSync(source.path) && path === realpathSync(source.path))) throw new HttpError(400, "output_source", "원본과 다른 파일 이름을 선택해 주세요. 원본 저장은 저장 메뉴를 사용하세요.");
    this.documents.registry.assertPath(path);
    const bytes = disk(path);
    for (const [id, ticket] of this.tickets) if ((ticket.result || ticket.expires < Date.now()) && !this.busy.has(id)) this.tickets.delete(id);
    if (this.tickets.size >= 100) throw new HttpError(429, "output_busy", "저장 요청이 너무 많습니다.");
    const ticket: Ticket = { id: randomUUID(), path, format, exists: bytes !== null, size: bytes?.length ?? 0, sha256: bytes ? hash(bytes) : null, artifactId, revision, sourcePath: source.path, ...scope, expires: Date.now() + 15 * 60_000 };
    this.remember(ticket);
    return { id: ticket.id, path, format, exists: ticket.exists, size: ticket.size };
  }
  async commit(artifactId: string, id: string, body: Buffer, replace: boolean, access?: DocumentAccess): Promise<Result> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new HttpError(404, "output_expired", "저장 위치를 다시 선택해 주세요.");
    const ticket = this.tickets.get(id) ?? (existsSync(this.file(id)) ? JSON.parse(readFileSync(this.file(id), "utf8")) as Ticket : undefined);
    if (!ticket || ticket.artifactId !== artifactId || (!ticket.outputHash && ticket.expires < Date.now())) throw new HttpError(404, "output_expired", "저장 위치를 다시 선택해 주세요.");
    const scope = this.scope(artifactId, access);
    if (scope.sessionId !== ticket.sessionId || (!ticket.outputHash && scope.viewId !== ticket.viewId)) throw new HttpError(409, "output_view_changed", "저장 위치를 고른 문서 창이나 대화가 바뀌었습니다.");
    const inputHash = hash(body);
    if (ticket.inputHash && inputHash !== ticket.inputHash) throw new HttpError(409, "output_payload_changed", "이미 처리한 저장 요청의 내용이 바뀌었습니다. 새 저장 위치를 선택해 주세요.");
    if (ticket.result) return ticket.result;
    if (this.busy.has(id)) throw new HttpError(409, "output_busy", "이미 저장하고 있습니다.");
    if (ticket.exists && !replace) throw new HttpError(409, "output_exists", "같은 이름의 파일이 있습니다. 바꾸려면 확인란을 선택하세요.");
    this.busy.add(id);
    try {
      const source = this.documents.get(artifactId);
      if (source.path !== ticket.sourcePath) throw new HttpError(409, "output_source_moved", "원본의 위치가 바뀌었습니다. 위치를 다시 선택해 주세요.");
      if (realpathSync(dirname(ticket.path)) !== dirname(ticket.path)) throw new HttpError(409, "output_moved", "저장 폴더가 바뀌었습니다. 위치를 다시 선택하세요.");
      const finish = () => {
        const artifact = this.register(source, ticket.path, ticket.revision, ticket.sessionId);
        ticket.result = { path: ticket.path, artifact, ...(ticket.backupPath ? { backupPath: ticket.backupPath } : {}) };
        this.remember(ticket); return ticket.result;
      };
      // A host restart after publication must not overwrite the file or create another copy.
      if (ticket.outputHash) {
        const published = disk(ticket.path);
        if (published && hash(published) === ticket.outputHash) return finish();
        throw new HttpError(409, "output_uncertain", "중단된 저장 기록이 있습니다. 대상 파일과 백업을 먼저 확인해 주세요. 다시 덮어쓰지 않았습니다.");
      }
      let bytes = body;
      if (ticket.format === "hwp" || ticket.format === "hwpx") {
        const decoded = decodeHwpSave(body);
        bytes = await prepareHwpSave(readFileSync(this.documents.revisionPath(artifactId, ticket.revision)), decoded.bytes, ticket.format, decoded.metadata, "save", hwpFormat(source.format));
      } else await checkOfficeCopy(bytes, ticket.format);
      const currentScope = this.scope(artifactId, access);
      if (currentScope.viewId !== ticket.viewId || currentScope.sessionId !== ticket.sessionId) throw new HttpError(409, "output_view_changed", "저장 중 문서 창이나 대화가 바뀌었습니다.");
      this.documents.registry.assertPath(ticket.path);
      if (realpathSync(dirname(ticket.path)) !== dirname(ticket.path)) throw new HttpError(409, "output_moved", "저장 폴더가 바뀌었습니다. 위치를 다시 선택하세요.");
      const before = disk(ticket.path);
      if ((before ? hash(before) : null) !== ticket.sha256) throw new HttpError(409, "output_changed", "위치를 고른 뒤 대상 파일이 바뀌었습니다. 덮어쓰지 않았습니다.");
      ticket.inputHash = inputHash; ticket.outputHash = hash(bytes);
      if (before) ticket.backupPath = `${ticket.path}.${randomUUID()}.bak`;
      this.remember(ticket);
      const temporary = `${ticket.path}.workbench-${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, bytes, { flag: "wx" });
        if (before) {
          copyFileSync(ticket.path, ticket.backupPath!, constants.COPYFILE_EXCL);
          if (hash(readFileSync(ticket.backupPath!)) !== ticket.sha256 || hash(disk(ticket.path)!) !== ticket.sha256) throw new HttpError(409, "output_changed", "백업하는 동안 대상 파일이 바뀌었습니다. 덮어쓰지 않았습니다.");
          renameSync(temporary, ticket.path);
        } else linkSync(temporary, ticket.path); // exclusive publication: never replaces a newly appeared file
      } finally { rmSync(temporary, { force: true }); }
      // The file is durable before it is advertised as a document; all prior destination
      // revisions and the pre-overwrite backup remain available.
      return finish();
    } finally { this.busy.delete(id); }
  }
}
