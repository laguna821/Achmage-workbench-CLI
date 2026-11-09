// Validate the candidate's existing receipt against the actual files. No rebuilt artifact is accepted.
import { basename, join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { assertAssets, filesUnder, hashFile, type Asset } from "./collect-candidate.ts";

export type CandidateReceipt = {
  schemaVersion: number; sourceRun: string; sourceSha: string; acceptanceShas: string[];
  acceptance: Record<string, { state: string; checks: number }>;
  assets: Asset[]; scope?: { applicationVersion?: string };
};
export async function verifyProvenance(input: { root: string; receipt: string; sourceRun: string; sourceSha: string }) {
  if (!/^\d+$/.test(input.sourceRun) || !/^[a-f0-9]{40}$/.test(input.sourceSha)) throw Error("Exact source run and commit required");
  const receipt = JSON.parse(readFileSync(input.receipt, "utf8")) as CandidateReceipt;
  if (receipt.schemaVersion !== 1 || receipt.sourceRun !== input.sourceRun || receipt.sourceSha !== input.sourceSha) throw Error("Candidate source identity does not match");
  assertAssets(receipt.assets);
  if (!receipt.acceptanceShas?.length || receipt.acceptanceShas.some(sha => !/^[a-f0-9]{40}$/.test(sha))) throw Error("Missing acceptance source identity");
  for (const [key, minimum] of [["firstRun:windows", 20], ["firstRun:macos", 20], ["upgrade:windows", 17]] as const) {
    const check = receipt.acceptance?.[key];
    if (check?.state !== "PASS" || !Number.isSafeInteger(check.checks) || check.checks < minimum) throw Error(`Candidate installation was not accepted: ${key}`);
  }
  const allFiles = filesUnder(input.root);
  const assets = [];
  for (const asset of receipt.assets) {
    if (basename(asset.name) !== asset.name || basename(asset.artifactName) !== asset.artifactName || /[\r\n\\]/.test(asset.name + asset.artifactName)) throw Error("Invalid installer name");
    const matches = allFiles.filter(file => basename(file) === asset.artifactName);
    if (matches.length !== 1) throw Error(`Missing or ambiguous installer: ${asset.artifactName}`);
    const path = matches[0]!;
    const actual = await hashFile(path);
    if (actual.bytes !== asset.bytes || actual.sha256 !== asset.sha256) throw Error(`Installer bytes changed: ${asset.name}`);
    assets.push({ ...asset, path });
  }
  const expectedSums = receipt.assets.map(asset => `${asset.sha256}  ${asset.name}\n`).join("");
  if (readFileSync(join(resolve(input.receipt, ".."), "SHA256SUMS.txt"), "utf8") !== expectedSums) throw Error("Candidate checksums do not match its receipt");
  return { receipt, assets };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await verifyProvenance({ root: resolve(process.argv[2] ?? "out"), receipt: resolve(process.argv[3] ?? "out/candidate-provenance/installer-provenance.json"),
    sourceRun: process.env.SOURCE_RUN ?? "", sourceSha: process.env.SOURCE_SHA ?? "" });
  console.log(JSON.stringify({ sourceRun: result.receipt.sourceRun, sourceSha: result.receipt.sourceSha, assets: result.assets.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })) }));
}
