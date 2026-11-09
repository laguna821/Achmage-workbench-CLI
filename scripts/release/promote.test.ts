import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "vitest";
import { hashFile } from "./collect-candidate.ts";
import { preparePromotion } from "./promote.ts";
import { verifyProvenance } from "./verify-provenance.ts";

test("promotion reuses six accepted installer bytes and rejects swapped bytes or source", async () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-promotion-"));
  try {
    const artifacts = join(root, "artifacts"), receipts = join(root, "candidate");
    mkdirSync(artifacts); mkdirSync(receipts);
    const assets = [];
    for (const suffix of [".exe", ".msi", ".dmg", ".deb", ".AppImage", ".pkg.tar.zst"]) {
      const artifactName = `Workbench 0.4.0${suffix}`, path = join(artifacts, artifactName);
      writeFileSync(path, `accepted installer ${suffix}`);
      assets.push({ artifactName, name: artifactName.replaceAll(" ", "."), ...await hashFile(path) });
    }
    const input = { root: artifacts, receipt: join(receipts, "installer-provenance.json"), sourceRun: "123", sourceSha: "a".repeat(40) };
    writeFileSync(input.receipt, JSON.stringify({ schemaVersion: 1, sourceRun: input.sourceRun, sourceSha: input.sourceSha,
      acceptanceShas: ["b".repeat(40)], scope: { applicationVersion: "0.4.0" }, assets,
      acceptance: { "firstRun:windows": { state: "PASS", checks: 20 }, "firstRun:macos": { state: "PASS", checks: 20 }, "upgrade:windows": { state: "PASS", checks: 17 } } }));
    writeFileSync(join(receipts, "SHA256SUMS.txt"), assets.map(a => `${a.sha256}  ${a.name}\n`).join(""));
    writeFileSync(join(receipts, "preview-notes.md"), "Actual installation scope");
    const promoted = await preparePromotion({ ...input, tag: "v0.4.0", output: join(root, "release") });
    expect(promoted.channel.prerelease).toBe(false);
    expect(promoted.files).toHaveLength(9);
    for (const asset of assets) expect(await hashFile(join(root, "release", asset.name))).toEqual({ bytes: asset.bytes, sha256: asset.sha256 });
    expect(readFileSync(join(root, "release", "installer-provenance.json"), "utf8")).toBe(readFileSync(input.receipt, "utf8"));
    await expect(verifyProvenance({ ...input, sourceSha: "c".repeat(40) })).rejects.toThrow("source identity");
    await expect(preparePromotion({ ...input, tag: "v0.5.0", output: join(root, "wrong") })).rejects.toThrow("version differ");
    writeFileSync(join(artifacts, assets[0]!.artifactName), "different installer");
    await expect(verifyProvenance(input)).rejects.toThrow("bytes changed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
