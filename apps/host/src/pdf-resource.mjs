import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import manifest from '../../../third_party/ieumoffice/pdf-runtime.json' with { type: 'json' };
import { repoRoot, shipped } from './resources.ts';

const verified = new Map();
function resource(name) {
  const entry = manifest.files[name], root = repoRoot();
  const path = shipped(`web/office/pdf-runtime/${name}`) ?? (root ? join(root, 'vendor/ieumoffice', entry.source) : null);
  if (!path) throw new Error(`PDF engine resource missing: ${name}`);
  if (verified.get(name) !== path) {
    if (createHash('sha256').update(readFileSync(path)).digest('hex') !== entry.sha256) throw new Error(`PDF engine resource differs from reviewed version: ${name}`);
    verified.set(name, path);
  }
  return path;
}
export const pdfiumWasmPath = () => resource('pdfium.wasm');
export const hbSubsetWasmPath = () => resource('hb-subset.wasm');
