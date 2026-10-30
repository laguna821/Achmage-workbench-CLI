import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import manifest from '../third_party/ieumoffice/pdf-runtime.json' with { type: 'json' };
const root = fileURLToPath(new URL('../', import.meta.url)), ieum = join(root, 'vendor/ieumoffice');
if (execFileSync('git', ['-C', ieum, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== manifest.ieumCommit) throw new Error('Review the PDF adapter for the new Ieum source');
const output = join(root, 'apps/office/public/pdf-runtime');
mkdirSync(output, { recursive: true });
for (const [name, entry] of Object.entries(manifest.files)) {
  const source = join(ieum, entry.source), data = readFileSync(source);
  const pkg = JSON.parse(readFileSync(join(ieum, entry.packageJson), 'utf8'));
  if (pkg.version !== entry.version || createHash('sha256').update(data).digest('hex') !== entry.sha256) throw new Error(`Review changed PDF resource: ${name}`);
  writeFileSync(join(output, name), data);
}
writeFileSync(join(output, 'build.json'), JSON.stringify(manifest, null, 2) + '\n');
// Backend/WASM dependencies are outside Vite's browser module graph; retain their
// notices explicitly as shipped resources as well as the original Ieum attribution.
const licenses = [
  ['IeumOffice-LICENSE', join(ieum, 'LICENSE')], ['IeumOffice-NOTICE', join(ieum, 'NOTICE')],
  ['PDFium-LICENSE', join(ieum, 'node_modules/@embedpdf/pdfium/LICENSE.pdfium')],
  ['EmbedPDF-LICENSE', join(ieum, 'node_modules/@embedpdf/pdfium/LICENSE')],
  ['HarfBuzz-LICENSE', join(ieum, 'apps/pdf/node_modules/harfbuzzjs/LICENSE')],
  ['pdf-lib-LICENSE', join(ieum, 'node_modules/pdf-lib/LICENSE.md')],
  ['node-forge-LICENSE', join(ieum, 'node_modules/node-forge/LICENSE')],
  ['opentype-LICENSE', join(ieum, 'node_modules/opentype.js/LICENSE')],
  ['pngjs-LICENSE', join(root, 'node_modules/pngjs/LICENSE')],
  ['jpeg-js-LICENSE', join(root, 'node_modules/jpeg-js/LICENSE')],
];
mkdirSync(join(output, 'licenses'), { recursive: true });
for (const [name, source] of licenses) cpSync(source, join(output, 'licenses', name));
// PDF.js resolves all of these relative to the original renderer's document.baseURI.
const browser = join(root, 'apps/office/public/pdfjs');
mkdirSync(browser, { recursive: true });
for (const folder of ['cmaps', 'standard_fonts', 'wasm']) {
  rmSync(join(browser, folder), { recursive: true, force: true });
  cpSync(join(ieum, 'node_modules/pdfjs-dist', folder), join(browser, folder), { recursive: true });
}
console.log('PDF: verified PDFium/HarfBuzz and copied PDF.js browser resources');
