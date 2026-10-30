#!/usr/bin/env node
// A stand-in for npm's command line (WORKBENCH_NPM_CLI) for setup checks: `install <package>@latest
// --prefix <dir>` lays out the npm package of Codex or Claude Code as npm would, with the stand-in
// engines inside, over about two seconds (so progress shows); `prefix -g` names a folder.
// FAKE_NPM_FAIL=<code> fails like npm does (e.g. ENOTFOUND when offline).

import { copyFileSync, mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (process.env.FAKE_NPM_LOG) appendFileSync(process.env.FAKE_NPM_LOG, `${JSON.stringify(args)}\n`);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

if (args[0] === "prefix") {
  console.log(join(here, ".fake-npm-prefix"));
  process.exit(0);
}
if (args[0] !== "install") {
  console.error(`npm error unknown command ${args[0]}`);
  process.exit(1);
}
const spec = args[1] ?? "";
const prefix = option("--prefix");
if (!prefix) {
  console.error("npm error --prefix is required here");
  process.exit(1);
}
const failure = process.env.FAKE_NPM_FAIL || (process.env.FAKE_NPM_FAIL_FILE && existsSync(process.env.FAKE_NPM_FAIL_FILE) ? readFileSync(process.env.FAKE_NPM_FAIL_FILE, "utf8").trim() : "");
if (failure) {
  await sleep(500);
  console.error(`npm error code ${failure}\nnpm error network request to https://registry.npmjs.org/ failed`);
  process.exit(1);
}
const name = spec.replace(/@[^@/]*$/, "");
const root = join(prefix, "node_modules", ...name.split("/"));
mkdirSync(root, { recursive: true });
// The download arriving: 4 MB in steps.
for (let step = 0; step < 8; step += 1) {
  appendFileSync(join(root, "payload.bin"), Buffer.alloc(512 * 1024, step));
  await sleep(250);
}
// The modules the stand-in engines import, copied next to them.
const HELPERS = ["png.mjs", "sample-reply.mjs"];
if (name === "@openai/codex") {
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name, version: "0.0.0-fake", type: "module", bin: { codex: "bin/codex.js" } }));
  copyFileSync(join(here, "fake-codex.mjs"), join(root, "bin", "codex.js"));
  for (const helper of HELPERS) copyFileSync(join(here, helper), join(root, "bin", helper));
} else if (name === "@anthropic-ai/claude-code") {
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name, version: "2.1.999", type: "module", bin: { claude: "bin/claude.exe" } }));
  // The placeholder npm leaves when the install script did not run, and the package's fallback launcher.
  writeFileSync(join(root, "bin", "claude.exe"), 'echo "Error: claude native binary not installed." >&2\nexit 1\n');
  writeFileSync(join(root, "cli-wrapper.cjs"), '#!/usr/bin/env node\nimport(require("node:url").pathToFileURL(require("node:path").join(__dirname, "fake-claude.mjs")).href);\n');
  copyFileSync(join(here, "fake-claude.mjs"), join(root, "fake-claude.mjs"));
  for (const helper of HELPERS) copyFileSync(join(here, helper), join(root, helper));
} else {
  console.error(`npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/${name}`);
  process.exit(1);
}
console.log(`added 1 package in 2s`);
