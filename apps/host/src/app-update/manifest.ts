// What the in-app update trusts (app-update brief, decision 1): a small manifest `update.json` signed with
// ed25519 over its exact bytes, a key from the LIST below, a version strictly higher than the installed
// one, and an asset name of the expected pattern for this copy's install kind. Pure functions only.
import { createPublicKey, verify, type KeyObject } from "node:crypto";
import type { AppInstallKind } from "@workbench/contracts";

/**
 * The public keys a manifest may be signed with (base64 of the SPKI DER). A LIST, so a later release can
 * ship the next key before the pipeline switches to it. The private key is the repository's Actions secret
 * WORKBENCH_UPDATE_SIGNING_KEY; it is never on a developer machine.
 */
export const UPDATE_PUBLIC_KEYS: readonly string[] = ["MCowBQYDK2VwAyEAo/100Y2c/EkzHNCRGrwDX9woI8Vt42mpXB2Trul28yk="];

declare const __WORKBENCH_UPDATE_TEST_KEYS__: string | undefined;
/**
 * The keys this build trusts. A TEST build (the per-OS update proof in release.yml, the rig) may add its own
 * throwaway key at BUILD time (`WORKBENCH_UPDATE_TEST_KEYS` → esbuild define); the release web job never sets
 * it, and nothing at run time (no environment variable, no file) can add a key to a built gateway.
 */
export function trustedKeys(): string[] {
  const extra = typeof __WORKBENCH_UPDATE_TEST_KEYS__ === "string" ? __WORKBENCH_UPDATE_TEST_KEYS__.split(",").map(key => key.trim()).filter(Boolean) : [];
  return [...UPDATE_PUBLIC_KEYS, ...extra];
}

export const REPOSITORY = "laguna821/Achmage-workbench-CLI";
export const UPDATE_SOURCE = `https://github.com/${REPOSITORY}/releases/latest/download/`;
export const MANIFEST_MAX_BYTES = 64 * 1024;
export const SIGNATURE_MAX_BYTES = 1024;
export const INSTALLER_MAX_BYTES = 1536 * 1024 * 1024;

export type UpdateAsset = { name: string; size: number; sha256: string };
export type UpdateManifest = { version: string; published: string | null; notes: string; assets: Partial<Record<AssetKind, UpdateAsset>> };
/** The published kinds. A user folder takes the pacman package's payload. */
export type AssetKind = "nsis" | "msi" | "dmg" | "appimage" | "deb" | "pacman";
export const ASSET_KINDS: readonly AssetKind[] = ["nsis", "msi", "dmg", "appimage", "deb", "pacman"];

export type RefusalCode = "signature" | "manifest" | "version" | "asset" | "checksum" | "size" | "network" | "source" | "space" | "system" | "installer" | "busy" | "kind";
export class UpdateRefused extends Error {
  readonly code: RefusalCode;
  constructor(code: RefusalCode, message: string) { super(message); this.code = code; }
}

// A strict semantic version: MAJOR.MINOR.PATCH with an optional pre-release; no build metadata, no "v".
const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(?:-([0-9A-Za-z-]{1,20}(?:\.[0-9A-Za-z-]{1,20}){0,4}))?$/;
export function parseVersion(text: string) {
  const match = VERSION.exec(text);
  if (!match) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])] as const, pre: match[4] ? match[4].split(".") : [] };
}
/** Semantic-version precedence: <0 when a is older, 0 when equal, >0 when a is newer. Throws on a malformed version. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) throw new UpdateRefused("version", "판 번호를 읽지 못했습니다.");
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i]! - y.core[i]!;
  // A pre-release is older than its release; then identifiers compare left to right.
  if (!x.pre.length || !y.pre.length) return (x.pre.length ? -1 : 0) - (y.pre.length ? -1 : 0);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}
/** Only a version strictly HIGHER than the installed one: no downgrade, no sidegrade. */
export function isNewer(candidate: string, installed: string) { return compareVersions(candidate, installed) > 0; }

/** ed25519 over the exact manifest bytes with one of `keys`. The signature file is base64 of the 64 bytes. */
export function verifyManifestSignature(manifest: Uint8Array, signatureFile: Uint8Array, keys: readonly string[] = trustedKeys()): boolean {
  if (!manifest.length || manifest.length > MANIFEST_MAX_BYTES || !signatureFile.length || signatureFile.length > SIGNATURE_MAX_BYTES) return false;
  const text = Buffer.from(signatureFile).toString("ascii").trim();
  if (!/^[A-Za-z0-9+/]{86}==$/.test(text)) return false;
  const signature = Buffer.from(text, "base64");
  if (signature.length !== 64) return false;
  for (const key of keys) {
    let object: KeyObject;
    try { object = createPublicKey({ key: Buffer.from(key, "base64"), format: "der", type: "spki" }); } catch { continue; }
    if (object.asymmetricKeyType !== "ed25519") continue;
    try { if (verify(null, manifest, object, signature)) return true; } catch { /* a malformed key or signature: next key */ }
  }
  return false;
}

const SHA256 = /^[a-f0-9]{64}$/;
/** The expected file name per kind; the version inside must be the manifest's own. */
export function assetNamePattern(kind: AssetKind, version: string): RegExp {
  const v = version.replace(/[.+]/g, "\\$&");
  switch (kind) {
    case "nsis": return new RegExp(`^Achmage\\.Workbench_${v}_x64-setup\\.exe$`);
    case "msi": return new RegExp(`^Achmage\\.Workbench_${v}_x64_ko-KR\\.msi$`);
    case "dmg": return new RegExp(`^Achmage\\.Workbench_${v}_aarch64\\.dmg$`);
    case "appimage": return new RegExp(`^Achmage\\.Workbench_${v}_amd64\\.AppImage$`);
    case "deb": return new RegExp(`^Achmage\\.Workbench_${v}_amd64\\.deb$`);
    case "pacman": return new RegExp(`^achmage-workbench-${v.replace(/-/g, "_")}-[1-9]\\d{0,2}-x86_64\\.pkg\\.tar\\.zst$`);
  }
}
/** A plain file name (no separator, no "..", no URL, no control character) of the kind's pattern. */
export function acceptAssetName(kind: AssetKind, version: string, name: string): boolean {
  if (typeof name !== "string" || !name || name.length > 120 || /[\\/:\0-\x1f\x7f?#%]/.test(name) || name.includes("..")) return false;
  return assetNamePattern(kind, version).test(name);
}

/** Parse the (already signature-checked) manifest bytes into the shape the app uses. */
export function parseManifest(bytes: Uint8Array): UpdateManifest {
  let raw: unknown;
  try { raw = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { throw new UpdateRefused("manifest", "업데이트 정보를 읽지 못했습니다."); }
  const object = raw as Record<string, unknown>;
  if (!object || typeof object !== "object" || Array.isArray(object)) throw new UpdateRefused("manifest", "업데이트 정보의 형식이 올바르지 않습니다.");
  const version = object.version;
  if (typeof version !== "string" || !parseVersion(version)) throw new UpdateRefused("manifest", "업데이트 정보의 판 번호가 올바르지 않습니다.");
  const published = typeof object.published === "string" && object.published.length <= 40 ? object.published : null;
  const notes = typeof object.notes === "string" ? object.notes.slice(0, 4000) : "";
  const assets: UpdateManifest["assets"] = {};
  const listed = object.assets;
  if (!listed || typeof listed !== "object" || Array.isArray(listed)) throw new UpdateRefused("manifest", "업데이트 정보에 설치 파일 목록이 없습니다.");
  for (const kind of ASSET_KINDS) {
    const entry = (listed as Record<string, unknown>)[kind] as Record<string, unknown> | undefined;
    if (!entry) continue;
    const { name, size, sha256 } = entry;
    if (typeof name !== "string" || !acceptAssetName(kind, version, name)) throw new UpdateRefused("asset", "업데이트 정보의 파일 이름이 올바르지 않습니다.");
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0 || size > INSTALLER_MAX_BYTES) throw new UpdateRefused("size", "업데이트 정보의 파일 크기가 올바르지 않습니다.");
    if (typeof sha256 !== "string" || !SHA256.test(sha256)) throw new UpdateRefused("checksum", "업데이트 정보의 확인값이 올바르지 않습니다.");
    assets[kind] = { name, size, sha256 };
  }
  return { version, published, notes, assets };
}

/** The asset a copy of this kind installs from. */
export function assetKindFor(kind: AppInstallKind): AssetKind | null {
  return kind === "user-folder" ? "pacman" : kind === "none" ? null : kind;
}
export function releaseUrl(version: string) {
  if (!parseVersion(version)) throw new UpdateRefused("version", "판 번호를 읽지 못했습니다.");
  return `https://github.com/${REPOSITORY}/releases/tag/v${version}`;
}
