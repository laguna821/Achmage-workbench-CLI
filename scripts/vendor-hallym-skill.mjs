// Only the reviewed public manifest is distributable; never copy a user's skill tree or library.
import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = join(root, 'third_party/skills/hallym-kordoc');
const source = process.argv[2] === '--copy' ? resolve(process.argv[3]) : destination;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = readFileSync(join(source, 'PACKAGE-MANIFEST.json'));
if (sha(manifest) !== '86c62334f93ea7d893ccd134433a83bd5fe1547ea4e2451340865249ee09daad') throw new Error('Unreviewed hallym-kordoc public manifest');
const files = JSON.parse(manifest).files;
for (const file of files) {
  if (file.path.split(/[\\/]/).some(part => !part || part === '..') || file.path.startsWith('/')) throw new Error('Invalid manifest path');
  const path = join(source, file.path), bytes = readFileSync(path);
  if (!lstatSync(path).isFile() || bytes.length !== file.bytes || sha(bytes) !== file.sha256) throw new Error(`Skill differs: ${file.path}`);
}
if (source !== destination) {
  for (const file of [...files, { path: 'PACKAGE-MANIFEST.json' }]) {
    const target = join(destination, file.path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(source, file.path), target);
  }
}
console.log(`hallym-kordoc: ${files.length} public files verified`);
