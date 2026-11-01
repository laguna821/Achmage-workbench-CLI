import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PdfLoader } from "../apps/host/src/pdf-loader.ts";

const output = resolve(process.argv[2] ?? ".pdf-loader-check"); mkdirSync(output, { recursive: true });
const loader = new PdfLoader(join(output, "data"));
const checks: { name: string; passed: boolean; detail?: unknown }[] = [];
const check = (name: string, passed: boolean, detail?: unknown) => { checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) }); if (!passed) throw new Error(name); };
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const timer = setInterval(() => console.log(JSON.stringify(loader.status())), 15000); timer.unref();
try {
  await loader.install("ocr"); check("official core and Korean/English OCR installed", loader.status().coreReady && loader.status().ocrReady, loader.status());
  const original = readFileSync(new URL("./fixtures/opendataloader/text.pdf", import.meta.url)), before = digest(original);
  const text = await loader.extract(original);
  check("original engine returns both pages and their source text", text.pages.length === 2 && text.pages.every(page => page.text.includes("Line 1:") && page.text.includes("Line 8:")));
  const page = await loader.extract(original, { pages: [2] }); check("selected page keeps its original page number", page.pages.length === 1 && page.pages[0]?.page === 2);
  check("source bytes unchanged", before === digest(original));
  const scan = readFileSync(new URL("./fixtures/opendataloader/scan-ko.pdf", import.meta.url)), scanHash = digest(scan);
  const pictures = await loader.extract(scan, { images: true });
  check("original picture extraction embeds bytes in portable Markdown", pictures.markdown.includes("data:image/"));
  const ocr = await loader.extract(scan, { ocr: true });
  writeFileSync(join(output, "ocr-result.json"), JSON.stringify(ocr, null, 2));
  // Integration gate, not an accuracy benchmark: upstream already has documented substitutions/omissions.
  const recognized = ocr.pages.map(page => page.text).join("\n");
  check("original local OCR returns Korean and English", recognized.includes("한글") && recognized.includes("OpenDataLoader"), { regions: ocr.blocks.length, sourceLines: 4, fullTranscriptionGuaranteed: false });
  check("OCR has usable original-page coordinates", ocr.blocks.length > 0 && ocr.blocks.every(block => block.page === 1 && block.box && block.box[0] < block.box[2] && block.box[1] < block.box[3]));
  check("scan bytes unchanged", scanHash === digest(scan));
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
finally {
  clearInterval(timer); await loader.close();
  writeFileSync(join(output, "verification.json"), JSON.stringify({ platform: process.platform, arch: process.arch, checks, passed: checks.every(check => check.passed) && process.exitCode !== 1, engine: loader.status().version }, null, 2));
}
