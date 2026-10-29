// Copy the reviewed, Node-only Ieum skill core with Node-compatible relative imports.
// --check verifies source/output hashes; --write intentionally refreshes these generated files.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'vendor/ieumoffice');
const destination = join(root, 'third_party/ieumoffice');
const mode = process.argv[2] ?? '--check';
if (!['--write', '--check'].includes(mode)) throw new Error('Use --write or --check');
const commit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const pinned = readFileSync(join(root, 'vendor/ieumoffice.PINNED'), 'utf8').match(/^commit: (.+)$/m)?.[1];
if (commit !== pinned) throw new Error('The source checkout does not match vendor/ieumoffice.PINNED');
const groups = [
  ['packages/ai-provider/src/user-skills', 'user-skills'],
  ['packages/zip-gate/src', 'zip-gate'],
];
const files = groups.flatMap(([input, output]) => readdirSync(join(source, input)).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts')).sort().map((name) => [join(input, name), join(output, name)]));
files.push(['packages/agent-core/src/user-skill-names.ts', 'agent-core/user-skill-names.ts']);
const sha = (data) => createHash('sha256').update(data).digest('hex');
const manifest = { source: 'https://github.com/pblsketch/openoffice', commit, changes: 'Apache-2.0 source headers, explicit .ts relative imports, local paths for zip-gate and user-skill-names', files: [] };
for (const [input, output] of files) {
  const original = readFileSync(join(source, input), 'utf8');
  const text = `// Adapted from IeumOffice ${input} @ ${commit}.\n// Apache-2.0; see ../LICENSE and ../NOTICE. Changes: explicit Node .ts and local package imports.\n` + original
    .replace(/\bfrom (['"])(\.[^'"]+)\1/g, (_, quote, path) => `from ${quote}${path.endsWith('.ts') ? path : path + '.ts'}${quote}`)
    .replaceAll("'@genoffice/zip-gate'", "'../zip-gate/index.ts'")
    .replaceAll("'@genoffice/agent-core/user-skill-names'", "'../agent-core/user-skill-names.ts'");
  const path = join(destination, output);
  if (mode === '--write') { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
  else if (readFileSync(path, 'utf8') !== text) throw new Error(`Vendored source differs: ${output}`);
  manifest.files.push({ source: input, output, sourceSha256: sha(original), outputSha256: sha(text) });
}
const path = join(destination, 'user-skills.manifest.json');
const json = JSON.stringify(manifest, null, 2) + '\n';
if (mode === '--write') writeFileSync(path, json);
else if (readFileSync(path, 'utf8') !== json) throw new Error('The user-skills manifest differs');
console.log(`${mode.slice(2)}: ${files.length} Ieum skill/zip source files @ ${commit.slice(0, 12)}`);
