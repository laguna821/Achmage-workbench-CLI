import { readFile, writeFile } from 'node:fs/promises';
import { ensurePdfium } from '../../../vendor/ieumoffice/apps/shell/src/main/pdf2docx-local.ts';
import { convertPdfToDocx, convertPdfToPptx, convertPdfToXlsx } from '../../../vendor/ieumoffice/packages/pdf2docx/src/index.ts';
import { createVisionOcrEngine, createWindowsOcrEngine } from '../../../vendor/ieumoffice/packages/pdf2docx/src/ocr-vision.ts';

/** Original local converters, run under the existing per-document process owner. */
export async function convertOfficeJob({ job, setup }, progress) {
  const convert = { docx: convertPdfToDocx, pptx: convertPdfToPptx, xlsx: convertPdfToXlsx }[job.format];
  if (!convert) throw new Error('Unsupported PDF conversion');
  const pdfium = await ensurePdfium(), bytes = await readFile(job.source.pdfPath);
  let ocr = null;
  if (job.format === 'docx') {
    const create = process.platform === 'darwin' ? createVisionOcrEngine : createWindowsOcrEngine;
    for (const path of setup.ocrHelperPaths) { ocr = create(path); if (ocr) break; }
  }
  const result = await convert(bytes, { pdfium, ...(ocr ? { ocr } : {}), ...(job.source.password === undefined ? {} : { password: job.source.password }), onProgress: progress });
  await writeFile(job.outPath, result[job.format], { flag: 'wx', mode: 0o600 });
  return { pages: result.pages, pageResults: result.pageResults, warnings: result.warnings, scannedDocument: result.scannedDocument };
}
