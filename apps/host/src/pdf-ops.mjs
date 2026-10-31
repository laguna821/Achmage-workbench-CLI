import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PDFDocument } from '../../../vendor/ieumoffice/node_modules/pdf-lib/cjs/index.js';
import { savePdfBytesToPath, readStaticFormFills, insertBlankPageBytes, setPageSizeBytes, cropPagesBytes } from '../../../vendor/ieumoffice/apps/pdf/src/main/save-pdf.ts';
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
export async function inspectPdf(bytes, editable = true) {
  if (bytes.length < 8 || bytes.length > 200_000_000 || !Buffer.from(bytes.subarray(0, 1024)).includes(Buffer.from('%PDF-'))) bad('PDF 파일 형식이 아닙니다.');
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  if (editable && doc.isEncrypted) throw new HttpError(422, 'encrypted_pdf', '암호화된 PDF는 편집하거나 복구본으로 보관하지 않습니다.');
  if (doc.getPageCount() < 1 || doc.getPageCount() > 20_000) bad('PDF 페이지 수 한도를 넘었습니다.');
  return { pages: doc.getPageCount(), encrypted: doc.isEncrypted };
}
function boundedJson(value, depth = 0) {
  if (depth > 12) bad('PDF 편집 정보가 너무 깊습니다.');
  if (typeof value === 'number' && !Number.isFinite(value)) bad('PDF 편집 숫자가 올바르지 않습니다.');
  if (Array.isArray(value)) { if (value.length > 100000) bad('PDF 편집 항목이 너무 많습니다.'); for (const item of value) boundedJson(item, depth + 1); }
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { if (['__proto__', 'constructor', 'prototype'].includes(key)) bad('PDF 편집 정보가 올바르지 않습니다.'); boundedJson(item, depth + 1); }
}
const lists = ['markups', 'annotDeletes', 'drawings', 'noteEdits', 'formValues', 'stamps', 'textEdits', 'textInserts', 'imageEdits', 'staticFormFills', 'formWidgetEdits', 'formFields', 'blankPages', 'rotations', 'deletedPages', 'pageOrder'];
function saveRequest(input, pages) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) bad('PDF 편집 요청이 없습니다.');
  if (input.targetPath !== undefined || input.copyOnly === true || (input.annotations !== undefined && input.annotations !== 'keep')) bad('이 저장은 현재 PDF의 편집만 반영합니다. 복사·주석 제거는 별도 저장이 필요합니다.');
  if (input.redactions?.length) bad('영구 가림은 별도 사본 저장 경로가 필요합니다. 원본에 적용하지 않았습니다.');
  const allowed = new Set([...lists, 'path', 'metadata', 'annotations', 'auto', 'redactions', 'copyOnly']);
  if (Object.keys(input).some((key) => !allowed.has(key))) bad('알 수 없는 PDF 저장 항목입니다.');
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
export async function editPdf(bytes, input) {
  const { pages } = await inspectPdf(bytes), request = saveRequest(input, pages);
  return renderPdf(bytes, request);
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
  const { pages } = await inspectPdf(bytes, !clean);
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
  if (annotations === 'flatten') {
    const { bytes: editedBytes, ...skips } = await renderPdf(bytes, { ...request, annotations: 'keep' });
    if (Object.values(skips).some((items) => items.length)) return { bytes: editedBytes, ...skips };
    const flattened = Buffer.from(await flattenPdfCopy(editedBytes)); await inspectPdf(flattened);
    return { bytes: flattened, ...skips };
  }
  return renderPdf(bytes, request);
}
async function renderPdf(bytes, request) {
  const dir = await mkdtemp(join(tmpdir(), 'wb-pdf-'));
  try {
    const output = join(dir, 'edited.pdf');
    const skipped = await savePdfBytesToPath(bytes, output, request);
    const data = await readFile(output); await inspectPdf(data);
    return { bytes: data, ...skipped };
  } finally { await rm(dir, { recursive: true, force: true }); }
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
