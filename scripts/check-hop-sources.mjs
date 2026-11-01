import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const folder = resolve(root, 'third_party/hop');
const manifest = JSON.parse(readFileSync(resolve(folder, 'manifest.json'), 'utf8'));
for (const file of manifest.files) {
  const path = resolve(folder, file.output);
  const rel = relative(root, path);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new Error('HOP source path outside the repository');
  const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (actual !== file.outputSha256) throw new Error(`HOP source differs from reviewed adaptation: ${file.output}`);
}
console.log(`HOP: ${manifest.files.length} pinned source adaptations checked`);
