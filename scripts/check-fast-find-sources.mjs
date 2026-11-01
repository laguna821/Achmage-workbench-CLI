import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve('third_party/fast-find');
const source = JSON.parse(readFileSync(resolve(root, 'upstream.json'), 'utf8'));
const adapted = JSON.parse(readFileSync(resolve(root, 'adaptations.json'), 'utf8'));
if (source.revision !== '714548efd3e361a7011a5123f4ae928630a01614' || adapted.upstream !== source.revision) throw Error('Fast Find source pin mismatch');
const changes = new Map(adapted.changes.map(row => [row.path, row]));
const sha = file => createHash('sha256').update(readFileSync(resolve(root, file))).digest('hex');
for (const [file, original] of Object.entries(source.files)) {
  const change = changes.get(file);
  if (change && (change.upstreamSha256 !== original || !change.reason)) throw Error(`Missing original hash/reason: ${file}`);
  if (sha(file) !== (change?.sha256 ?? original)) throw Error(`Unrecorded Fast Find change: ${file}`);
}
for (const [file, change] of changes) {
  if (!change.reason || sha(file) !== change.sha256 || (!source.files[file] && change.upstreamSha256 !== null)) throw Error(`Invalid Fast Find adaptation: ${file}`);
}
console.log(`Fast Find source: ${Object.keys(source.files).length} pinned files, ${changes.size} documented adaptations`);
