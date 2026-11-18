import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PDFDocument } from '../../../vendor/ieumoffice/node_modules/pdf-lib/cjs/index.js';
import { savePdfBytesToPath, savePdfToPath, readStaticFormFills, insertBlankPageBytes, setPageSizeBytes, cropPagesBytes, insertPdfBytes } from '../../../vendor/ieumoffice/apps/pdf/src/main/save-pdf.ts';
import { copiedPagesOf } from '../../../vendor/ieumoffice/apps/pdf/src/main/page-clipboard.ts';
import { shrinkDocument } from '../../../vendor/ieumoffice/apps/pdf/src/main/pdf-shrink.ts';
import { decryptDocument, WrongPasswordError, CertificateEncryptionError } from '../../../vendor/ieumoffice/apps/pdf/src/main/pdf-crypt.ts';
import { listEditFonts, canDrawText, validateTextEdits } from '../../../vendor/ieumoffice/apps/pdf/src/main/text-edit.ts';
import { listPageImages, renderImagePng, renderPagePreviewPng } from '../../../vendor/ieumoffice/apps/pdf/src/main/image-edit.ts';
import { readAnnotSubjects } from '../../../vendor/ieumoffice/apps/pdf/src/main/annot-subjects.ts';
import { readPdfSignatures } from '../../../vendor/ieumoffice/apps/pdf/src/main/pdf-signatures.ts';
import { readPdfText } from '../../../vendor/ieumoffice/apps/pdf/src/main/read-text.ts';
import { validateRedactionRegions } from '../../../vendor/ieumoffice/apps/pdf/src/main/redaction.ts';
import { HttpError } from './errors.ts';
import { flattenPdfCopy } from './pdf-flatten.mjs';

export { listEditFonts, canDrawText };
const bad = (message) => { throw new HttpError(422, 'invalid_pdf_request', message); };
function finite(value, min, max) { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) bad('PDF 좌표·크기가 올바르지 않습니다.'); return value; }
function rect(value) { if (!Array.isArray(value) || value.length !== 4) bad('PDF 영역이 올바르지 않습니다.'); value.forEach((n) => finite(n, -100000, 100000)); return value; }
function page(value, total) { if (!Number.isSafeInteger(value) || value < 0 || value >= total) bad('PDF 페이지 범위가 올바르지 않습니다.'); return value; }
/** `password`: a session that opened the protected file with its password saves it (v0.13.0, 985b73c7a); the
 * file is checked under that password, the save decrypts with it and protects the result again (see editPdf).
 * Everything else stays refused for a protected file. */
export async function inspectPdf(bytes, editable = true, password = undefined) {
  if (bytes.length < 8 || bytes.length > 200_000_000 || !Buffer.from(bytes.subarray(0, 1024)).includes(Buffer.from('%PDF-'))) bad('PDF 파일 형식이 아닙니다.');
  let doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  if (doc.isEncrypted && typeof password === 'string') {
    let plain;
    try { plain = (await decryptDocument(bytes, password)).bytes; }
    catch { throw new HttpError(422, 'pdf_password', 'PDF 암호가 맞지 않아 저장하지 않았습니다.'); }
    doc = await PDFDocument.load(plain, { updateMetadata: false });
    if (doc.getPageCount() < 1 || doc.getPageCount() > 20_000) bad('PDF 페이지 수 한도를 넘었습니다.');
    return { pages: doc.getPageCount(), encrypted: true };
  }
  if (editable && doc.isEncrypted) throw new HttpError(422, 'encrypted_pdf', '암호화된 PDF는 암호를 넣어 연 편집 화면에서만 저장합니다. 복구본과 쪽 복사·붙여넣기·용량 줄이기에는 쓰지 않습니다.');
  if (doc.getPageCount() < 1 || doc.getPageCount() > 20_000) bad('PDF 페이지 수 한도를 넘었습니다.');
  return { pages: doc.getPageCount(), encrypted: doc.isEncrypted };
}
function boundedJson(value, depth = 0) {
  if (depth > 12) bad('PDF 편집 정보가 너무 깊습니다.');
  if (typeof value === 'number' && !Number.isFinite(value)) bad('PDF 편집 숫자가 올바르지 않습니다.');
  if (Array.isArray(value)) { if (value.length > 100000) bad('PDF 편집 항목이 너무 많습니다.'); for (const item of value) boundedJson(item, depth + 1); }
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { if (['__proto__', 'constructor', 'prototype'].includes(key)) bad('PDF 편집 정보가 올바르지 않습니다.'); boundedJson(item, depth + 1); }
}
const password = (value) => typeof value === 'string' && value.length <= 1024;
/** The password the source opens with, as upstream's save reads it (applySaveRequest). */
export const sourcePassword = (request) => request?.decryption?.userPassword ?? request?.encryption?.userPassword;
/** The password the saved output opens with (upstream's savedOutputPassword). */
const outputPassword = (request) => request.protectionDirty === false ? request.decryption?.userPassword : request.encryption?.userPassword;
/** The protection fields of a save. A password is set, changed or lifted only by the protection dialog's request
 * (protectionDirty: true); every other save of a protected file keeps the file's own protection. */
function protection(input) {
  const { decryption, encryption, protectionDirty } = input;
  if (protectionDirty !== undefined && typeof protectionDirty !== 'boolean') bad('PDF 보호 설정이 올바르지 않습니다.');
  if (decryption !== undefined && (!decryption || typeof decryption !== 'object' || Object.keys(decryption).some((key) => key !== 'userPassword') || !password(decryption.userPassword))) bad('PDF 암호 요청이 올바르지 않습니다.');
  if (encryption !== undefined) {
    const permissions = encryption?.permissions;
    if (!encryption || typeof encryption !== 'object' || !password(encryption.userPassword) || !password(encryption.ownerPassword) || !permissions || typeof permissions !== 'object'
      || ['printing', 'modifying', 'annotating', 'copying'].some((key) => typeof permissions[key] !== 'boolean')) bad('PDF 보호 설정이 올바르지 않습니다.');
    if (protectionDirty !== true && decryption === undefined) bad('PDF 암호는 보호 설정 창에서만 걸 수 있습니다.');
  }
  return { carries: decryption !== undefined || encryption !== undefined, changes: protectionDirty === true };
}
const lists = ['markups', 'annotDeletes', 'drawings', 'noteEdits', 'formValues', 'stamps', 'textEdits', 'textInserts', 'imageEdits', 'staticFormFills', 'formWidgetEdits', 'formFields', 'blankPages', 'rotations', 'deletedPages', 'pageOrder'];
function saveRequest(input, pages) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) bad('PDF 편집 요청이 없습니다.');
  if (input.targetPath !== undefined || input.copyOnly === true || (input.annotations !== undefined && input.annotations !== 'keep')) bad('이 저장은 현재 PDF의 편집만 반영합니다. 복사·주석 제거는 별도 저장이 필요합니다.');
  if (input.redactions?.length) bad('영구 가림은 별도 사본 저장 경로가 필요합니다. 원본에 적용하지 않았습니다.');
  // v0.13.0 sends protectionDirty (false: keep the file's own protection) and the markups' author with every
  // save, and edited bookmarks (outline) / embedded-file changes (attachments) when there are any. A protected
  // session also sends the password it opened the file with (decryption) and its protection (encryption).
  protection(input);
  const allowed = new Set([...lists, 'path', 'metadata', 'annotations', 'auto', 'redactions', 'copyOnly', 'protectionDirty', 'annotationAuthor', 'outline', 'attachments', 'decryption', 'encryption']);
  if (Object.keys(input).some((key) => !allowed.has(key))) bad('알 수 없는 PDF 저장 항목입니다.');
  if (input.annotationAuthor !== undefined && (typeof input.annotationAuthor !== 'string' || input.annotationAuthor.length > 200)) bad('PDF 메모 작성자가 올바르지 않습니다.');
  if (input.outline !== undefined && input.outline !== null && !Array.isArray(input.outline)) bad('PDF 책갈피가 올바르지 않습니다.');
  if (input.attachments !== undefined && (!input.attachments || typeof input.attachments !== 'object' || Array.isArray(input.attachments))) bad('PDF 첨부 파일 변경이 올바르지 않습니다.');
  boundedJson(input);
  const request = { ...input, path: '', markups: input.markups ?? [], drawings: input.drawings ?? [], formValues: input.formValues ?? [], stamps: input.stamps ?? [] };
  for (const name of lists) if (request[name] !== undefined && (!Array.isArray(request[name]) || request[name].length > 20000)) bad('PDF 편집 목록이 올바르지 않습니다.');
  const total = pages + (request.blankPages?.length ?? 0);
  for (const [i, blank] of (request.blankPages ?? []).entries()) { if (blank.pageIndex !== pages + i) bad('빈 페이지 순서가 올바르지 않습니다.'); finite(blank.width, 1, 14400); finite(blank.height, 1, 14400); }
  if (total > 20000) bad('PDF 페이지 수 한도를 넘었습니다.');
  for (const name of lists) for (const entry of request[name] ?? []) {
    if (name === 'deletedPages' || name === 'pageOrder') page(entry, total);
    else if (entry && typeof entry === 'object') { if ('pageIndex' in entry) page(entry.pageIndex, total); if ('rect' in entry) rect(entry.rect); }
    else bad('PDF 편집 항목이 올바르지 않습니다.');
  }
  const deleted = new Set(request.deletedPages ?? []);
  if (deleted.size !== (request.deletedPages?.length ?? 0) || deleted.size >= total) bad('삭제 페이지가 중복되었거나 남은 페이지가 없습니다.');
  if (request.pageOrder && (new Set(request.pageOrder).size !== request.pageOrder.length || request.pageOrder.length !== total - deleted.size || request.pageOrder.some((i) => deleted.has(i)))) bad('PDF 페이지 순서는 남은 페이지를 한 번씩 포함해야 합니다.');
  for (const rotation of request.rotations ?? []) if (![0, 90, 180, 270, -90, -180, -270].includes(rotation.delta)) bad('PDF 회전은 직각 단위여야 합니다.');
  return request;
}
/** The original save path, including its read-back verification and skip diagnostics. Its
 * atomic writer targets only a private temporary file; Documents owns the final CAS write. */
export async function editPdf(bytes, input, options = {}) {
  const { pages, encrypted } = await inspectPdf(bytes, true, options.unlocked === true ? sourcePassword(input) : undefined), request = saveRequest(input, pages);
  return guardedRender(bytes, request, encrypted);
}
/** A protected source is saved only by the session that knows its password, and stays protected unless the
 * protection dialog lifted it on purpose. */
async function guardedRender(bytes, request, encrypted) {
  const { carries, changes } = protection(request);
  if (encrypted && !carries) bad('암호를 넣어 연 화면에서만 이 PDF를 저장할 수 있습니다.');
  const { output, ...result } = await renderPdf(bytes, request, carries);
  if (encrypted && !changes && !output.encrypted) throw new HttpError(422, 'pdf_protection_lost', '저장한 결과에서 PDF 암호가 빠졌습니다. 원본을 바꾸지 않았습니다.');
  return result;
}

/** Legacy page-copy API: one-based pages, rotations then deletion then sequential
 * moves. Move destinations describe the resulting order, as PDFCraft did. The
 * original Ieum save engine retains page objects, text, metadata and annotations. */
export async function editPdfPages(bytes, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['rotate', 'delete', 'move'].includes(key))) bad('PDF 쪽 편집 요청이 올바르지 않습니다.');
  const { pages } = await inspectPdf(bytes, true);
  const list = key => { const value = input[key] ?? []; if (!Array.isArray(value) || value.length > 20000) bad('PDF 쪽 목록이 올바르지 않습니다.'); return value; };
  const rotations = new Map();
  const index = (value, count = pages) => { if (!Number.isInteger(value) || value < 1 || value > count) bad('PDF 쪽 번호를 확인해 주세요.'); return value - 1; };
  for (const rotation of list('rotate')) {
    if (!rotation || !Array.isArray(rotation.pages) || rotation.pages.length > 20000 || ![90, 180, 270].includes(rotation.degrees)) bad('PDF 회전은 90·180·270도만 가능합니다.');
    for (const value of new Set(rotation.pages)) { const pageIndex = index(value); rotations.set(pageIndex, ((rotations.get(pageIndex) ?? 0) + rotation.degrees) % 360); }
  }
  const deletedPages = [...new Set(list('delete').map(value => index(value)))];
  if (deletedPages.length >= pages) bad('PDF에는 한 쪽 이상 남아 있어야 합니다.');
  const deleted = new Set(deletedPages), order = Array.from({ length: pages }, (_, i) => i).filter(i => !deleted.has(i));
  const moves = list('move');
  for (const move of moves) {
    if (!move || !Number.isSafeInteger(move.to) || move.to < 1) bad('PDF 이동 위치를 확인해 주세요.');
    const from = index(move.from, order.length), [moved] = order.splice(from, 1);
    order.splice(Math.min(move.to - 1, order.length), 0, moved);
  }
  if (!rotations.size && !deletedPages.length && !moves.length) throw new HttpError(400, 'no_edit', '바꿀 내용이 없습니다.');
  return editPdf(bytes, { rotations: [...rotations].map(([pageIndex, delta]) => ({ pageIndex, delta })), deletedPages, pageOrder: order });
}
/** A copy renderer has no authority to write either the source or a chosen target.
 * The prepared-output service alone publishes these bytes. Redaction is a separate
 * operation so normal Save/Save As cannot accidentally apply pending regions. */
export async function copyPdf(bytes, input, redaction = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) bad('PDF 사본 요청이 없습니다.');
  if (input.targetPath !== undefined) bad('PDF 출력 경로는 준비된 사본 저장만 사용할 수 있습니다.');
  if (input.copyOnly !== undefined && typeof input.copyOnly !== 'boolean') bad('PDF 사본 옵션이 올바르지 않습니다.');
  const annotations = input.annotations ?? 'keep';
  if (!['keep', 'flatten', 'strip'].includes(annotations)) bad('PDF 주석 처리 방식이 올바르지 않습니다.');
  if (!redaction && input.redactions !== undefined) bad('영구 가림은 확인된 별도 사본으로만 처리합니다.');
  const clean = input.copyOnly === true && annotations === 'keep' && !redaction;
  const unlocked = protection(input).carries && !redaction && annotations === 'keep';
  const { pages, encrypted } = await inspectPdf(bytes, !clean, unlocked ? sourcePassword(input) : undefined);
  const request = saveRequest({ ...input, copyOnly: false, annotations: 'keep', redactions: undefined }, pages);
  const edited = lists.some((name) => name !== 'staticFormFills' && request[name]?.length) || request.metadata !== undefined;
  if (input.copyOnly && (!clean || edited)) bad('깨끗한 PDF 사본에 편집 작업을 섞을 수 없습니다.');
  if (redaction) {
    if (edited || input.copyOnly || annotations !== 'keep') bad('영구 가림 전에 다른 편집을 먼저 저장해 주세요.');
    try { request.redactions = validateRedactionRegions(input.redactions); }
    catch (error) { bad(error instanceof Error ? error.message : String(error)); }
    for (const region of request.redactions) page(region.pageIndex, pages);
  }
  request.annotations = annotations;
  if (clean) return { bytes: Buffer.from(bytes), skippedTextEdits: [], skippedTextInserts: [], skippedImageEdits: [] };
  if (encrypted) return guardedRender(bytes, request, encrypted);
  if (annotations === 'flatten') {
    const { bytes: editedBytes, ...skips } = await renderPdf(bytes, { ...request, annotations: 'keep' });
    if (Object.values(skips).some((items) => items.length)) return { bytes: editedBytes, ...skips };
    const flattened = Buffer.from(await flattenPdfCopy(editedBytes)); await inspectPdf(flattened);
    return { bytes: flattened, ...skips };
  }
  return renderPdf(bytes, request);
}
async function renderPdf(bytes, request, protectedOutput = false) {
  const dir = await mkdtemp(join(tmpdir(), 'wb-pdf-'));
  try {
    const output = join(dir, 'edited.pdf');
    // v0.13.0's bytes path skips a request whose only change is the bookmarks (outline) or the embedded files
    // (attachments): its "has edits" test predates them. Upstream's own save reads the file and always applies them.
    const structural = (request.outline !== undefined && request.outline !== null) || request.attachments !== undefined;
    let skipped;
    if (structural) { const source = join(dir, 'source.pdf'); await writeFile(source, bytes, { mode: 0o600 }); skipped = await savePdfToPath(source, output, request); }
    else skipped = await savePdfBytesToPath(bytes, output, request);
    const data = await readFile(output), inspected = await inspectPdf(data, true, protectedOutput ? outputPassword(request) : undefined);
    return { bytes: data, ...skipped, ...(protectedOutput ? { output: inspected } : {}) };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** v0.13.0's page clipboard (db612e638): the pages at the displayed positions of the document with the view's pending
 * edits applied, as a small PDF. Nothing is written; the gateway holds the result for the window. */
export async function copyPdfPages(bytes, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !input.source || typeof input.source !== 'object' || Array.isArray(input.source)
    || !Array.isArray(input.pages) || !input.pages.length || input.pages.length > 20000) bad('복사할 쪽을 확인해 주세요.');
  if (protection(input.source).carries) throw new HttpError(422, 'encrypted_pdf', '암호가 걸린 PDF의 쪽은 복사하지 않습니다.');
  const { pages } = await inspectPdf(bytes), request = saveRequest(input.source, pages);
  const copied = await copiedPagesOf(bytes, request, input.pages);
  if (!copied) bad('복사할 쪽을 확인해 주세요.');
  return { bytes: Buffer.from(copied.bytes), count: copied.count };
}
/** Insert the held pages after a page of the saved file (-1: in front), as upstream's paste does. */
export async function pastePdfPages(target, copied, afterPageIndex) {
  const { pages } = await inspectPdf(target);
  if (!Number.isSafeInteger(afterPageIndex) || afterPageIndex < -1 || afterPageIndex >= pages) bad('붙여 넣을 위치가 올바르지 않습니다.');
  const { merged, count } = await insertPdfBytes(target, copied, afterPageIndex);
  const bytes = Buffer.from(merged); await inspectPdf(bytes);
  return { bytes, count };
}
/** 용량 줄이기 (3b1f3f6af): upstream's shrink over a copy of the bytes. `bytes` is null when the result is not smaller
 * (upstream writes nothing then either). */
export async function reducePdf(source) {
  await inspectPdf(source);
  const doc = await PDFDocument.load(source, { updateMetadata: false });
  const { streamsRecompressed, imagesDownsampled } = shrinkDocument(doc);
  // Object streams stay on, as upstream keeps them: turning them off grows files whose producer used them.
  const after = Buffer.from(await doc.save({ useObjectStreams: true })), smaller = after.length < source.length;
  if (smaller) await inspectPdf(after);
  return { bytes: smaller ? after : null, bytesBefore: source.length, bytesAfter: after.length, streamsRecompressed, imagesDownsampled };
}
/** pdf:decrypt (985b73c7a): whether this password opens the file, and what it allows. The plain bytes stay here. */
export async function decryptPdf(bytes, value) {
  if (!password(value)) bad('PDF 암호 요청이 올바르지 않습니다.');
  try {
    const opened = await decryptDocument(bytes, value);
    return { ok: true, bytes: new Uint8Array(0), permissions: opened.permissions, neededPassword: opened.neededPassword, unlockedAs: opened.unlockedAs };
  } catch (error) {
    if (error instanceof WrongPasswordError) return { ok: false, reason: 'wrong-password' };
    if (error instanceof CertificateEncryptionError) return { ok: false, reason: 'certificate-encryption' };
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
export async function queryPdf(bytes, operation, input) {
  const { pages } = await inspectPdf(bytes, !['signatures', 'subjects'].includes(operation));
  boundedJson(input);
  switch (operation) {
    case 'text': return readPdfText(bytes, { charBudget: 200000 });
    case 'images': return listPageImages(bytes);
    case 'static-fills': return readStaticFormFills(bytes);
    case 'subjects': return readAnnotSubjects(bytes);
    case 'signatures': return readPdfSignatures(bytes);
    case 'validate-text': {
      if (!Array.isArray(input.edits) || input.edits.length > 20000) bad('글자 편집 목록이 올바르지 않습니다.');
      for (const edit of input.edits) { page(edit.pageIndex, pages); rect(edit.rect); }
      return validateTextEdits(bytes, input.edits);
    }
    case 'image-png': return renderImagePng(bytes, page(input.pageIndex, pages), rect(input.rect), finite(input.scale ?? 1, 0.1, 32));
    case 'preview-png': {
      page(input.pageIndex, pages);
      const clip = input.clip ?? {}; finite(clip.x, -100000, 100000); finite(clip.y, -100000, 100000); finite(clip.width, 0.01, 14400); finite(clip.height, 0.01, 14400);
      finite(input.pxWidth, 1, 4096);
      if (![0, 1, 2, 3].includes(input.rotate)) bad('PDF 미리보기 회전이 올바르지 않습니다.');
      if (Math.ceil(input.pxWidth) * Math.ceil(input.pxWidth * clip.height / clip.width) > 16_000_000) bad('PDF 미리보기 크기 한도를 넘었습니다.');
      if (!Array.isArray(input.excludeRects) || input.excludeRects.length > 20000) bad('그림 영역이 올바르지 않습니다.');
      input.excludeRects.forEach(rect);
      return renderPagePreviewPng(bytes, input);
    }
    default: throw new HttpError(404, 'pdf_operation', '지원하지 않는 PDF 조회입니다.');
  }
}
export async function transformPdf(bytes, operation, input) {
  const { pages } = await inspectPdf(bytes); boundedJson(input);
  if (operation === 'blank-page') {
    if (!Number.isSafeInteger(input.afterPageIndex) || input.afterPageIndex < -1 || input.afterPageIndex >= pages) bad('삽입 위치가 올바르지 않습니다.');
    return Buffer.from(await insertBlankPageBytes(bytes, input.afterPageIndex));
  }
  if (operation === 'page-size') return Buffer.from(await setPageSizeBytes(bytes, finite(input.width, 1, 14400), finite(input.height, 1, 14400)));
  if (operation === 'crop') {
    if (!Array.isArray(input.pages) || !input.pages.length || input.pages.length > pages) bad('자를 페이지가 올바르지 않습니다.');
    input.pages.forEach((n) => page(n, pages));
    for (const edge of ['l', 't', 'r', 'b']) finite(input.rect?.[edge], 0, 1);
    return Buffer.from(await cropPagesBytes(bytes, input.pages, input.rect));
  }
  throw new HttpError(404, 'pdf_operation', '지원하지 않는 PDF 편집입니다.');
}
