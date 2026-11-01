import { PDFDocument } from '../../../vendor/ieumoffice/node_modules/pdf-lib/cjs/index.js';

/** Only wraps the renderer's bitmap; OpenDataLoader performs all recognition. */
export async function ocrPdfImage(loader, png) {
  if (!loader.status().ocrReady) return null;
  if (typeof png !== 'string' || png.length > 24_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(png)) throw new Error('OCR 그림이 올바르지 않습니다.');
  const bytes = Buffer.from(png, 'base64');
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('PNG 그림이 필요합니다.');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width > 8192 || height > 8192 || width * height > 24_000_000) throw new Error('OCR 그림 크기가 너무 큽니다.');
  const pdf = await PDFDocument.create(), image = await pdf.embedPng(bytes);
  pdf.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
  const result = await loader.extract(await pdf.save(), { ocr: true });
  return result.blocks.filter(block => block.box).map(block => ({ text: block.text, confidence: 1,
    box: block.box.map((n, index) => Math.max(0, Math.min(1, n / (index % 2 === 0 ? width : height)))) }));
}
