/**
 * A minimal PDF whose text uses a non-embedded CID font with the predefined
 * KSCms-UHC-H CMap (code -> CID) and the Adobe-Korea1 ordering. PDF.js can only
 * recover its text when the KSCms-UHC-H and Adobe-Korea1-UCS2 CMaps are available.
 */
export function makeKoreanCMapPdf(): ArrayBuffer {
  // "한글 PDF" in CP949 (UHC): 한 C7D1, 글 B1DB, space 20, P 50, D 44, F 46.
  const stream = "BT /F1 18 Tf 72 720 Td <C7D1B1DB20504446> Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type0 /BaseFont /HYSMyeongJo-Medium /Encoding /KSCms-UHC-H /DescendantFonts [6 0 R] >>",
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HYSMyeongJo-Medium /CIDSystemInfo << /Registry (Adobe) /Ordering (Korea1) /Supplement 2 >> /FontDescriptor 7 0 R /DW 1000 >>",
    "<< /Type /FontDescriptor /FontName /HYSMyeongJo-Medium /Flags 6 /FontBBox [0 -148 1001 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 60 >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = Buffer.from(pdf, "latin1");
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
