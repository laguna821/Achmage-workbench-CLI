import { createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { acceptAssetName, compareVersions, isNewer, MANIFEST_MAX_BYTES, parseManifest, trustedKeys, UPDATE_PUBLIC_KEYS, verifyManifestSignature } from "./manifest.ts";

// Throwaway keys made for this run only; nothing is committed.
export function testKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return { privateKey, spki, sign: (bytes: Uint8Array) => Buffer.from(sign(null, bytes, privateKey).toString("base64") + "\n") };
}
const manifestBytes = (version = "0.5.3", assets: Record<string, unknown> = { pacman: { name: `achmage-workbench-${version}-1-x86_64.pkg.tar.zst`, size: 10, sha256: "a".repeat(64) } }) =>
  Buffer.from(JSON.stringify({ version, published: "2026-11-20T00:00:00Z", notes: "고친 점", assets }));

describe("manifest signature", () => {
  const key = testKeyPair();
  it("the shipped key is an ed25519 public key and the only one in a release build", () => {
    expect(createPublicKey({ key: Buffer.from(UPDATE_PUBLIC_KEYS[0]!, "base64"), format: "der", type: "spki" }).asymmetricKeyType).toBe("ed25519");
    expect(trustedKeys()).toEqual([...UPDATE_PUBLIC_KEYS]);
  });
  it("accepts a good signature from a listed key (any position in the list)", () => {
    const bytes = manifestBytes();
    expect(verifyManifestSignature(bytes, key.sign(bytes), [key.spki])).toBe(true);
    expect(verifyManifestSignature(bytes, key.sign(bytes), [...UPDATE_PUBLIC_KEYS, key.spki])).toBe(true);
  });
  it("refuses one changed byte, a wrong key, an empty or oversized file", () => {
    const bytes = manifestBytes(), signature = key.sign(bytes);
    const tampered = Buffer.from(bytes); tampered[tampered.length - 3] ^= 1;
    expect(verifyManifestSignature(tampered, signature, [key.spki])).toBe(false);
    expect(verifyManifestSignature(bytes, signature, [testKeyPair().spki])).toBe(false);
    expect(verifyManifestSignature(bytes, signature, UPDATE_PUBLIC_KEYS)).toBe(false);
    expect(verifyManifestSignature(bytes, Buffer.alloc(0), [key.spki])).toBe(false);
    expect(verifyManifestSignature(Buffer.alloc(0), signature, [key.spki])).toBe(false);
    const big = Buffer.alloc(MANIFEST_MAX_BYTES + 1, 32);
    expect(verifyManifestSignature(big, key.sign(big), [key.spki])).toBe(false);
    expect(verifyManifestSignature(bytes, Buffer.concat([signature, Buffer.alloc(2000, 65)]), [key.spki])).toBe(false);
    // A signature in another encoding, or a key that is not ed25519, is not accepted.
    expect(verifyManifestSignature(bytes, Buffer.from(signature.toString().trim(), "base64"), [key.spki])).toBe(false);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ format: "der", type: "spki" }).toString("base64");
    expect(verifyManifestSignature(bytes, signature, [rsa, "not a key"])).toBe(false);
  });
});

describe("version order", () => {
  it("only a strictly higher version is newer", () => {
    expect(isNewer("0.5.3", "0.5.2")).toBe(true);
    expect(isNewer("0.5.2", "0.5.2")).toBe(false);
    expect(isNewer("0.5.1", "0.5.2")).toBe(false);
    expect(isNewer("0.10.0", "0.9.9")).toBe(true);
    expect(isNewer("1.0.0", "0.99.99")).toBe(true);
  });
  it("pre-release strings follow semantic-version precedence", () => {
    expect(isNewer("0.5.3-beta.1", "0.5.2")).toBe(true);
    expect(isNewer("0.5.3-beta.1", "0.5.3")).toBe(false);
    expect(isNewer("0.5.3", "0.5.3-beta.1")).toBe(true);
    expect(isNewer("0.5.3-beta.2", "0.5.3-beta.1")).toBe(true);
    expect(isNewer("0.5.3-beta.10", "0.5.3-beta.9")).toBe(true);
    expect(isNewer("0.5.3-beta", "0.5.3-alpha")).toBe(true);
    expect(isNewer("0.5.3-alpha.1", "0.5.3-alpha")).toBe(true);
    expect(compareVersions("0.5.3-1", "0.5.3-alpha")).toBeLessThan(0);
  });
  it("a malformed version is refused, never guessed", () => {
    for (const bad of ["v0.5.3", "0.5", "0.5.3.1", "05.1.1", "0.5.3+build", "", "0.5.3-", "0.5.3-a..b"]) expect(() => compareVersions(bad, "0.5.2")).toThrow();
  });
});

describe("the version in a sentence", () => {
  it("takes the particle its last digit is read with", async () => {
    const { versionWith } = await import("@workbench/contracts");
    expect(versionWith("0.5.3", "으로")).toBe("0.5.3으로");
    expect(versionWith("0.5.2", "으로")).toBe("0.5.2로");
    expect(versionWith("0.5.1", "으로")).toBe("0.5.1로");
    expect(versionWith("0.5.10", "으로")).toBe("0.5.10으로");
    expect(versionWith("0.5.2", "이")).toBe("0.5.2가");
    expect(versionWith("0.5.3", "이")).toBe("0.5.3이");
    expect(versionWith("0.5.7", "이")).toBe("0.5.7이");
    expect(versionWith("0.6.0-beta.2", "이")).toBe("0.6.0-beta.2가");
  });
});

describe("asset name", () => {
  it("accepts the published names of each kind for the manifest's version", () => {
    expect(acceptAssetName("nsis", "0.5.3", "Achmage.Workbench_0.5.3_x64-setup.exe")).toBe(true);
    expect(acceptAssetName("msi", "0.5.3", "Achmage.Workbench_0.5.3_x64_ko-KR.msi")).toBe(true);
    expect(acceptAssetName("dmg", "0.5.3", "Achmage.Workbench_0.5.3_aarch64.dmg")).toBe(true);
    expect(acceptAssetName("appimage", "0.5.3", "Achmage.Workbench_0.5.3_amd64.AppImage")).toBe(true);
    expect(acceptAssetName("deb", "0.5.3", "Achmage.Workbench_0.5.3_amd64.deb")).toBe(true);
    expect(acceptAssetName("pacman", "0.5.3", "achmage-workbench-0.5.3-1-x86_64.pkg.tar.zst")).toBe(true);
  });
  it("refuses path separators, other hosts, other versions and other kinds", () => {
    for (const name of ["../Achmage.Workbench_0.5.3_x64-setup.exe", "dir/Achmage.Workbench_0.5.3_x64-setup.exe", "dir\\Achmage.Workbench_0.5.3_x64-setup.exe",
      "https://evil.example/Achmage.Workbench_0.5.3_x64-setup.exe", "//evil.example/Achmage.Workbench_0.5.3_x64-setup.exe", "Achmage.Workbench_0.5.2_x64-setup.exe",
      "Achmage.Workbench_0.5.3_x64-setup.exe?x=1", "Achmage.Workbench_0.5.3_x64-setup.exe%2f", "Achmage.Workbench_0.5.3_x64_ko-KR.msi", "Achmage.Workbench_0.5.3_x64-setup.exe\n"])
      expect(acceptAssetName("nsis", "0.5.3", name)).toBe(false);
    // The version's dots are literal.
    expect(acceptAssetName("deb", "0.5.3", "Achmage.Workbench_0x5x3_amd64.deb")).toBe(false);
  });
  it("parseManifest refuses a manifest whose asset name is not the kind's pattern", () => {
    expect(() => parseManifest(manifestBytes("0.5.3", { pacman: { name: "../x.pkg.tar.zst", size: 1, sha256: "a".repeat(64) } }))).toThrow(/파일 이름/);
    expect(() => parseManifest(manifestBytes("0.5.3", { pacman: { name: "achmage-workbench-0.5.3-1-x86_64.pkg.tar.zst", size: -1, sha256: "a".repeat(64) } }))).toThrow(/크기/);
    expect(() => parseManifest(manifestBytes("0.5.3", { pacman: { name: "achmage-workbench-0.5.3-1-x86_64.pkg.tar.zst", size: 1, sha256: "XYZ" } }))).toThrow(/확인값/);
    expect(() => parseManifest(Buffer.from("{"))).toThrow();
    expect(() => parseManifest(manifestBytes("latest"))).toThrow(/판 번호/);
    expect(parseManifest(manifestBytes()).assets.pacman?.size).toBe(10);
  });
});
