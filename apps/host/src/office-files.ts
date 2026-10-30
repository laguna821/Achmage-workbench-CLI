import { readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { createHash } from "node:crypto";
import type { OfficeAttachment } from "../../../packages/contracts/src/office-references.ts";
import { ATTACHABLE_EXTS, ATTACHABLE_IMAGE_EXTS, ATTACHABLE_MAX_BYTES, ATTACHABLE_IMAGE_MAX_BYTES } from "../../../vendor/ieumoffice/packages/file-parse/src/attachable.ts";
import { Attachments, attachmentsDir, sniff } from "./attachments.ts";
import { HttpError } from "./errors.ts";

export const OFFICE_FILE_LIMIT = ATTACHABLE_MAX_BYTES;
const error = (message: string): never => { throw new HttpError(400, "office_attachment", message); };
export const officeImage = (ext: string) => ATTACHABLE_IMAGE_EXTS.has(ext);
export function officeFileMeta(path: string, name = basename(path), sizeBytes = statSync(path).size): OfficeAttachment {
  const ext = extname(name).slice(1).toLowerCase();
  if (!ATTACHABLE_EXTS.has(ext)) return error(`${name}: 첨부할 수 없는 형식입니다.`);
  const limit = officeImage(ext) ? ATTACHABLE_IMAGE_MAX_BYTES : OFFICE_FILE_LIMIT;
  if (sizeBytes < 1 || sizeBytes > limit) return error(`${name}: 빈 파일은 첨부할 수 없으며 ${limit / 1024 / 1024}MB 이하여야 합니다.`);
  return { path, name, ext, sizeBytes };
}
export function officeFileBytes(path: string, name?: string) {
  const stat = statSync(path);
  if (!stat.isFile()) return error("일반 파일만 첨부할 수 있습니다.");
  officeFileMeta(path, name, stat.size);
  const bytes = readFileSync(path), meta = officeFileMeta(path, name, bytes.length);
  if (officeImage(meta.ext)) officeImageBytes(meta, bytes);
  return { meta, bytes };
}
export function officeImageBytes(meta: OfficeAttachment, bytes: Buffer) {
  const mime = sniff(bytes), expected = meta.ext === "jpg" || meta.ext === "jpeg" ? "image/jpeg" : `image/${meta.ext}`;
  if (!officeImage(meta.ext) || mime !== expected || bytes.length > ATTACHABLE_IMAGE_MAX_BYTES) return error(`${meta.name}: 올바른 이미지 파일이 아닙니다.`);
  return { ok: true as const, mime, base64: bytes.toString("base64") };
}
/** The regular Workbench attachment store owns bytes; Office owns only its scoped selection. */
export function keepOfficeFile(dataDir: string, bytes: Buffer, name: string) {
  const meta = officeFileMeta("", name, bytes.length);
  if (officeImage(meta.ext)) officeImageBytes(meta, bytes);
  const store = new Attachments(dataDir), saved = store.save(bytes, name, "application/octet-stream", OFFICE_FILE_LIMIT, true);
  const path = store.path(saved.id);
  // A damaged pre-existing content-addressed file must never replace the uploaded bytes.
  readOfficeFile(dataDir, saved.id);
  return { meta: { ...meta, path, name: saved.name }, fileId: saved.id };
}
export function readOfficeFile(dataDir: string, fileId: string) {
  const path = new Attachments(dataDir).path(fileId);
  if (statSync(path).size > OFFICE_FILE_LIMIT) return error("보관한 첨부가 50MB를 넘습니다.");
  const bytes = readFileSync(path);
  if (bytes.length > OFFICE_FILE_LIMIT || createHash("sha256").update(bytes).digest("hex") !== fileId.split(".")[0]) return error("보관한 첨부의 내용과 해시가 다릅니다.");
  return { path, bytes };
}
export function selectedOfficeBytes(dataDir: string, selected: { meta: OfficeAttachment; fileId?: string }) {
  // Uploaded bytes have an immutable identity. Native source files remain live
  // and are copied again on the next turn, just like registered documents.
  if (selected.fileId && selected.meta.path === join(attachmentsDir(dataDir), selected.fileId)) {
    const file = readOfficeFile(dataDir, selected.fileId);
    return { bytes: file.bytes, meta: officeFileMeta(file.path, selected.meta.name, file.bytes.length) };
  }
  return officeFileBytes(selected.meta.path, selected.meta.name);
}
