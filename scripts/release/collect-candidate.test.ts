import { describe, expect, test } from "vitest";
import { assertAssets, bindInstaller, inspectChecks, type Asset } from "./collect-candidate.ts";

const sha = "a".repeat(40), hash = "b".repeat(64);
const assets: Asset[] = [".exe", ".msi", ".dmg", ".deb", ".AppImage", ".pkg.tar.zst"].map(s => ({ name: `Workbench${s}`, artifactName: `Workbench${s}`, bytes: 123, sha256: hash }));
describe("candidate installer provenance", () => {
  test("requires each real package exactly once", () => {
    expect(() => assertAssets(assets)).not.toThrow();
    expect(() => assertAssets(assets.slice(1))).toThrow();
    expect(() => assertAssets([...assets.slice(1), assets[1]!])).toThrow();
    expect(() => assertAssets(assets.map((a, i) => i ? a : { ...a, bytes: 0 }))).toThrow();
  });
  test("missing and partial acceptance never become a pass", () => {
    expect(inspectChecks(null, 20).state).toBe("NOT_RUN");
    expect(inspectChecks([], 20).state).toBe("FAIL");
    expect(inspectChecks([{ ok: true }, { ok: false }], 2).state).toBe("FAIL");
    expect(inspectChecks([{ ok: true }, { ok: true }], 2).state).toBe("PASS");
  });
  test("rejects acceptance of another build or bytes", () => {
    const check = inspectChecks([{ ok: true }], 1);
    const receipt = { sourceRun: "42", sourceSha: sha, acceptanceSha: "c".repeat(40), sha256: hash, artifactName: assets[0]!.name };
    expect(bindInstaller(check, receipt, assets[0], "42", sha).state).toBe("PASS");
    for (const wrong of [{ ...receipt, sourceRun: "41" }, { ...receipt, sha256: "d".repeat(64) }, { ...receipt, sourceSha: "d".repeat(40) }, { ...receipt, artifactName: "Other.exe" }]) {
      expect(bindInstaller(check, wrong, assets[0], "42", sha).state).toBe("FAIL");
    }
    expect(bindInstaller(check, null, assets[0], "42", sha).state).toBe("FAIL");
  });
});
