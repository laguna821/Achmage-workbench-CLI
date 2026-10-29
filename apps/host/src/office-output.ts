import { createHash, randomUUID } from "node:crypto";
import { constants, copyFileSync, existsSync, linkSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import type { Artifact } from "@workbench/contracts";
import type { Documents } from "./artifacts.ts";
import { isWorkbenchPath } from "./artifacts.ts";
import { HttpError } from "./errors.ts";
import { decodeHwpSave, hwpFormat, prepareHwpSave } from "./hwp-codec.ts";

export type OutputPlan = { id: string; path: string; format: "hwp" | "hwpx" | "pdf"; exists: boolean; size: number };
type Result = { path: string; artifact: Artifact; backupPath?: string };
type Ticket = OutputPlan & { artifactId: string; revision: number; sha256: string | null; expires: number; busy?: boolean; result?: Result };
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
  private readonly documents: Documents;
  private readonly register: (source: Artifact, path: string) => Artifact;
  constructor(documents: Documents, register: (source: Artifact, path: string) => Artifact) { this.documents = documents; this.register = register; }
  prepare(artifactId: string, revision: number, rawPath: string): OutputPlan {
    const source = this.documents.get(artifactId);
    if (!Number.isSafeInteger(revision) || revision < 1 || revision > source.revision) throw new HttpError(400, "output_revision", "저장할 문서 판이 올바르지 않습니다.");
    if (!rawPath.trim() || rawPath.length > 4096 || rawPath.includes("\0")) throw new HttpError(400, "output_path", "저장할 파일 이름을 입력하세요.");
    const requested = isAbsolute(rawPath) ? resolve(rawPath) : resolve(dirname(source.path), rawPath);
    // Pin the parent directory too: replacing it with a symlink later must not redirect this job.
    const path = join(realpathSync(dirname(requested)), basename(requested));
    const format = extname(path).slice(1).toLowerCase();
    if (format !== "pdf" && format !== "hwp" && format !== "hwpx") throw new HttpError(415, "output_format", "HWP·HWPX·PDF 파일 이름을 선택해 주세요.");
    if (format !== "pdf" && source.format !== "hwp" && source.format !== "hwpx") throw new HttpError(415, "output_format", "한글 문서만 이 형식으로 저장할 수 있습니다.");
    if (isWorkbenchPath(path) || path === resolve(source.path) || (existsSync(source.path) && path === realpathSync(source.path))) throw new HttpError(400, "output_source", "원본과 다른 파일 이름을 선택해 주세요. 원본 저장은 저장 메뉴를 사용하세요.");
    this.documents.registry.assertPath(path);
    const bytes = disk(path);
    for (const [id, ticket] of this.tickets) if (ticket.expires < Date.now() && !ticket.busy) this.tickets.delete(id);
    if (this.tickets.size >= 100) throw new HttpError(429, "output_busy", "저장 요청이 너무 많습니다.");
    const ticket: Ticket = { id: randomUUID(), path, format, exists: bytes !== null, size: bytes?.length ?? 0, sha256: bytes ? hash(bytes) : null, artifactId, revision, expires: Date.now() + 15 * 60_000 };
    this.tickets.set(ticket.id, ticket);
    return { id: ticket.id, path, format, exists: ticket.exists, size: ticket.size };
  }
  async commit(artifactId: string, id: string, body: Buffer, replace: boolean): Promise<Result> {
    const ticket = this.tickets.get(id);
    if (!ticket || ticket.artifactId !== artifactId || ticket.expires < Date.now()) throw new HttpError(404, "output_expired", "저장 위치를 다시 선택해 주세요.");
    if (ticket.result) return ticket.result;
    if (ticket.busy) throw new HttpError(409, "output_busy", "이미 저장하고 있습니다.");
    if (ticket.exists && !replace) throw new HttpError(409, "output_exists", "같은 이름의 파일이 있습니다. 바꾸려면 확인란을 선택하세요.");
    ticket.busy = true;
    try {
      const source = this.documents.get(artifactId);
      let bytes = body;
      if (ticket.format === "pdf") {
        if (!bytes.length || bytes.length > 200_000_000 || !bytes.subarray(0, 8).toString().startsWith("%PDF-")) throw new HttpError(422, "invalid_pdf", "PDF 출력 데이터가 올바르지 않습니다.");
      } else {
        const decoded = decodeHwpSave(body);
        bytes = await prepareHwpSave(readFileSync(this.documents.revisionPath(artifactId, ticket.revision)), decoded.bytes, ticket.format, decoded.metadata, "save", hwpFormat(source.format));
      }
      this.documents.registry.assertPath(ticket.path);
      if (realpathSync(dirname(ticket.path)) !== dirname(ticket.path)) throw new HttpError(409, "output_moved", "저장 폴더가 바뀌었습니다. 위치를 다시 선택하세요.");
      const before = disk(ticket.path);
      if ((before ? hash(before) : null) !== ticket.sha256) throw new HttpError(409, "output_changed", "위치를 고른 뒤 대상 파일이 바뀌었습니다. 덮어쓰지 않았습니다.");
      let backupPath: string | undefined;
      const temporary = `${ticket.path}.workbench-${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, bytes, { flag: "wx" });
        if (before) {
          backupPath = `${ticket.path}.${randomUUID()}.bak`;
          copyFileSync(ticket.path, backupPath, constants.COPYFILE_EXCL);
          renameSync(temporary, ticket.path);
        } else linkSync(temporary, ticket.path); // exclusive publication: never replaces a newly appeared file
      } finally { rmSync(temporary, { force: true }); }
      // The file is durable before it is advertised as a document; all prior destination
      // revisions and the pre-overwrite backup remain available.
      const artifact = this.register(source, ticket.path);
      ticket.result = { path: ticket.path, artifact, ...(backupPath ? { backupPath } : {}) };
      return ticket.result;
    } finally { ticket.busy = false; }
  }
}
