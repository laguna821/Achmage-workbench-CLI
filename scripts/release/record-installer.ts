// A receipt is written before installation, so acceptance identifies the exact input file.
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { filesUnder, hashFile } from "./collect-candidate.ts";

const [dir, output, suffix] = process.argv.slice(2);
if (!dir || !output || !suffix) throw Error("Usage: record-installer.ts <installer folder> <receipt path> <suffix>");
const files = filesUnder(resolve(dir)).filter(path => path.endsWith(suffix));
if (files.length !== 1) throw Error(`Expected exactly one ${suffix} installer`);
const { SOURCE_RUN, SOURCE_SHA, GITHUB_RUN_ID, GITHUB_SHA } = process.env;
const identity = { sourceRun: SOURCE_RUN || GITHUB_RUN_ID, sourceSha: SOURCE_SHA || GITHUB_SHA, acceptanceSha: GITHUB_SHA,
  artifactName: basename(files[0]!), ...await hashFile(files[0]!) };
if (!/^\d+$/.test(identity.sourceRun ?? "") || !/^[a-f0-9]{40}$/.test(identity.sourceSha ?? "") || !/^[a-f0-9]{40}$/.test(identity.acceptanceSha ?? "")) throw Error("Exact build and acceptance identities required");
mkdirSync(dirname(resolve(output)), { recursive: true });
writeFileSync(output, JSON.stringify(identity, null, 2) + "\n");
