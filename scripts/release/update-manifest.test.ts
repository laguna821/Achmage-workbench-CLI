import { generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseManifest, verifyManifestSignature } from "../../apps/host/src/app-update/manifest.ts";
import { hashFile } from "./collect-candidate.ts";
import { preparePromotion } from "./promote.ts";
import { manifestBytes, signManifest, verifySignedRelease } from "./update-manifest.ts";

// A throwaway pair made for this run; the real key is the repository secret and is never here.
const pair = () => { const { privateKey, publicKey } = generateKeyPairSync("ed25519"); return { pem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(), spki: publicKey.export({ format: "der", type: "spki" }).toString("base64") }; };
const NAMES = (v: string) => [`Achmage.Workbench_${v}_x64-setup.exe`, `Achmage.Workbench_${v}_x64_ko-KR.msi`, `Achmage.Workbench_${v}_aarch64.dmg`, `Achmage.Workbench_${v}_amd64.AppImage`, `Achmage.Workbench_${v}_amd64.deb`, `achmage-workbench-${v}-1-x86_64.pkg.tar.zst`];

it("update.json lists every published kind from the real files and is signed over its exact bytes", () => {
  const key = pair();
  const assets = NAMES("0.5.2").map((name, i) => ({ name, bytes: 100 + i, sha256: String(i).repeat(64) }));
  const bytes = manifestBytes("0.5.2", assets, { published: "2026-11-20T00:00:00Z", notes: "n" });
  const parsed = parseManifest(bytes);
  expect(Object.keys(parsed.assets).sort()).toEqual(["appimage", "deb", "dmg", "msi", "nsis", "pacman"]);
  expect(parsed.assets.pacman).toEqual({ name: "achmage-workbench-0.5.2-1-x86_64.pkg.tar.zst", size: 105, sha256: "5".repeat(64) });
  const signature = signManifest(bytes, key.pem, [key.spki]);
  expect(verifyManifestSignature(bytes, signature, [key.spki])).toBe(true);
  // A missing kind, a missing secret, or a key the app does not carry fails loudly.
  expect(() => manifestBytes("0.5.2", assets.slice(1))).toThrow(/nsis/);
  expect(() => manifestBytes("0.5.3", assets)).toThrow();
  expect(() => signManifest(bytes, undefined, [key.spki])).toThrow(/WORKBENCH_UPDATE_SIGNING_KEY is missing/);
  expect(() => signManifest(bytes, "", [key.spki])).toThrow(/missing/);
  expect(() => signManifest(bytes, key.pem)).toThrow(/does not verify with any public key the app carries/);
});

it("the publish writes update.json with no key; the signature is checked against the app's keys and the files before upload", async () => {
  const key = pair(), root = mkdtempSync(join(tmpdir(), "wb-promote-update-"));
  const artifacts = join(root, "artifacts"), receipts = join(root, "candidate");
  mkdirSync(artifacts); mkdirSync(receipts);
  const assets = [];
  for (const name of NAMES("0.5.2")) {
    const artifactName = name.replace("Achmage.Workbench", "Achmage Workbench"), path = join(artifacts, artifactName);
    writeFileSync(path, `installer ${name}`);
    assets.push({ artifactName, name, ...await hashFile(path) });
  }
  const input = { root: artifacts, receipt: join(receipts, "installer-provenance.json"), sourceRun: "1", sourceSha: "a".repeat(40) };
  writeFileSync(input.receipt, JSON.stringify({ schemaVersion: 1, sourceRun: "1", sourceSha: "a".repeat(40), acceptanceShas: ["b".repeat(40)], scope: { applicationVersion: "0.5.2" }, assets,
    acceptance: { "firstRun:windows": { state: "PASS", checks: 20 }, "firstRun:macos": { state: "PASS", checks: 20 }, "upgrade:windows": { state: "PASS", checks: 17 } } }));
  writeFileSync(join(receipts, "SHA256SUMS.txt"), assets.map(a => `${a.sha256}  ${a.name}\n`).join(""));
  writeFileSync(join(receipts, "preview-notes.md"), "notes");
  const out = join(root, "release");
  const promoted = await preparePromotion({ ...input, tag: "v0.5.2", output: out, update: true });
  expect(promoted.files).toHaveLength(10);
  expect(existsSync(join(out, "update.json.sig"))).toBe(false);
  const manifest = readFileSync(join(out, "update.json"));
  const sums = readFileSync(join(out, "SHA256SUMS.txt"), "utf8");
  for (const asset of Object.values(parseManifest(manifest).assets)) expect(sums).toContain(`${asset!.sha256}  ${asset!.name}\n`);
  // Without the signing job's file, or with a signature from a key the app does not carry: nothing is uploaded.
  expect(() => verifySignedRelease(out, "0.5.2", [key.spki])).toThrow(/both required/);
  writeFileSync(join(out, "update.json.sig"), signManifest(manifest, key.pem, [key.spki]));
  expect(() => verifySignedRelease(out, "0.5.2")).toThrow(/does not verify/);
  expect(verifySignedRelease(out, "0.5.2", [key.spki]).version).toBe("0.5.2");
  expect(() => verifySignedRelease(out, "0.5.3", [key.spki])).toThrow(/another version/);
  writeFileSync(join(out, NAMES("0.5.2")[3]!), "swapped installer");
  expect(() => verifySignedRelease(out, "0.5.2", [key.spki])).toThrow(/does not match/);
});

it("the workflow signs in its own inline step: no checkout or repository code where the key is, and the inline signer is right", () => {
  const workflow = YAML.parse(readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8")) as { jobs: Record<string, { steps: { uses?: string; run?: string; env?: Record<string, string> }[]; if?: string; needs?: string[] }> };
  const holders = Object.entries(workflow.jobs).flatMap(([job, spec]) => spec.steps.filter(step => JSON.stringify(step).includes("secrets.WORKBENCH_UPDATE_SIGNING_KEY")).map(step => ({ job, step })));
  expect(holders.map(h => h.job)).toEqual(["sign-update"]);
  const sign = workflow.jobs["sign-update"]!;
  expect(sign.steps.map(step => step.uses).filter(Boolean)).toEqual(["actions/download-artifact@v4", "actions/upload-artifact@v4"]);
  for (const step of sign.steps) expect(step.run ?? "").not.toMatch(/scripts\/|npm|npx|\.ts\b|\.mjs\b/);
  const signer = sign.steps.find(step => step.env?.WORKBENCH_UPDATE_SIGNING_KEY)!.run!;
  expect(signer).toMatch(/^set \+x/);
  expect(signer).toMatch(/WORKBENCH_UPDATE_SIGNING_KEY is missing/);
  // The guard comes first, in a step without the key.
  expect(sign.steps[0]!.run).toMatch(/refs\/heads\/release\/v\*/);
  expect(sign.steps[0]!.env).toBeUndefined();
  // The inline node program, run with a throwaway key, writes a signature the app accepts.
  const code = /node -e '([^']+)'/.exec(signer)![1]!;
  const key = pair(), dir = mkdtempSync(join(tmpdir(), "wb-sign-"));
  mkdirSync(join(dir, "update"));
  const bytes = manifestBytes("0.5.2", NAMES("0.5.2").map((name, i) => ({ name, bytes: 1 + i, sha256: String(i).repeat(64) })));
  writeFileSync(join(dir, "update/update.json"), bytes);
  execFileSync(process.execPath, ["-e", code], { cwd: dir, env: { PATH: process.env.PATH, WORKBENCH_UPDATE_SIGNING_KEY: key.pem, PREVIEW_TAG: "v0.5.2" }, stdio: "pipe" });
  expect(verifyManifestSignature(bytes, readFileSync(join(dir, "update/update.json.sig")), [key.spki])).toBe(true);
  // update.json for another version is not signed.
  rmSync(join(dir, "update/update.json.sig"));
  expect(() => execFileSync(process.execPath, ["-e", code], { cwd: dir, env: { PATH: process.env.PATH, WORKBENCH_UPDATE_SIGNING_KEY: key.pem, PREVIEW_TAG: "v0.5.3" }, stdio: "pipe" })).toThrow();
  expect(existsSync(join(dir, "update/update.json.sig"))).toBe(false);
  // Promotion needs the in-app update proofs; deb is not proven in place any more.
  expect(workflow.jobs.candidate!.if).toContain("needs.update-proof.result == 'success'");
  expect(JSON.stringify(workflow.jobs["publish-tested"])).toContain("In-app update ({kind})");
});
