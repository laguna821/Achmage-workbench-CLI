// The in-app update's signed manifest (app-update): `update.json` written from the REAL release files (names,
// sizes, SHA-256 — the same values as SHA256SUMS.txt) by repository code with no key in reach, and
// `update.json.sig`, ed25519 over its exact bytes, made ONLY by the workflow's own inline step in the separate
// sign-update job (release.yml; security review H1). `signManifest` here is for tests and local throwaway keys;
// the workflow never calls it with the real key. `verifySignedRelease` checks the result against the app's own
// key list and the files before anything is uploaded.
import { createPrivateKey, sign } from "node:crypto";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ASSET_KINDS, assetNamePattern, parseManifest, trustedKeys, verifyManifestSignature, type AssetKind, type UpdateManifest } from "../../apps/host/src/app-update/manifest.ts";

export type ReleaseAsset = { name: string; bytes: number; sha256: string };

/** The manifest bytes for `version` from the release's assets; every published kind must be there exactly once. */
export function manifestBytes(version: string, assets: ReleaseAsset[], options: { published?: string; notes?: string } = {}): Buffer {
  const entries: UpdateManifest["assets"] = {};
  for (const kind of ASSET_KINDS) {
    const found = assets.filter(asset => assetNamePattern(kind as AssetKind, version).test(asset.name));
    if (found.length !== 1) throw Error(`update.json: expected one ${kind} installer for ${version}, found ${found.length}`);
    entries[kind] = { name: found[0]!.name, size: found[0]!.bytes, sha256: found[0]!.sha256 };
  }
  const bytes = Buffer.from(`${JSON.stringify({ version, published: options.published ?? new Date().toISOString(), notes: options.notes ?? "", assets: entries }, null, 2)}\n`);
  parseManifest(bytes); // the app's own reader accepts it
  return bytes;
}

/** Sign with the PEM key; refuse unless the app's key list (or `keys`) verifies the result. */
export function signManifest(bytes: Buffer, pem: string | undefined, keys: readonly string[] = trustedKeys()): Buffer {
  if (!pem || !pem.includes("PRIVATE KEY")) throw Error("WORKBENCH_UPDATE_SIGNING_KEY is missing: a release is not published without a signed update.json");
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw Error("WORKBENCH_UPDATE_SIGNING_KEY is not an ed25519 key");
  const signature = Buffer.from(`${sign(null, bytes, key).toString("base64")}\n`);
  if (!verifyManifestSignature(bytes, signature, keys)) throw Error("update.json.sig does not verify with any public key the app carries (apps/host/src/app-update/manifest.ts): add the key there first");
  return signature;
}

/** Writes update.json and update.json.sig into `dir`; returns their paths. */
export function writeSignedManifest(dir: string, version: string, assets: ReleaseAsset[], pem: string | undefined, options: { keys?: readonly string[]; published?: string; notes?: string } = {}) {
  const bytes = manifestBytes(version, assets, options);
  const signature = signManifest(bytes, pem, options.keys);
  const manifest = join(dir, "update.json"), sig = join(dir, "update.json.sig");
  writeFileSync(manifest, bytes, { flag: "wx" });
  writeFileSync(sig, signature, { flag: "wx" });
  return [manifest, sig];
}

/** Writes update.json (unsigned) into `dir`; the signing job adds update.json.sig. */
export function writeUnsignedManifest(dir: string, version: string, assets: ReleaseAsset[], options: { published?: string; notes?: string } = {}) {
  const file = join(dir, "update.json");
  writeFileSync(file, manifestBytes(version, assets, options), { flag: "wx" });
  return file;
}

/**
 * Before upload: update.json.sig verifies with a key the app carries, update.json is for `version`, and every
 * asset it names is in `dir` with that exact size and SHA-256. Nothing is uploaded otherwise.
 */
export function verifySignedRelease(dir: string, version: string, keys: readonly string[] = trustedKeys()) {
  const names = readdirSync(dir);
  if (!names.includes("update.json") || !names.includes("update.json.sig")) throw Error("update.json and update.json.sig are both required for a stable release");
  const bytes = readFileSync(join(dir, "update.json")), signature = readFileSync(join(dir, "update.json.sig"));
  if (!verifyManifestSignature(bytes, signature, keys)) throw Error("update.json.sig does not verify with any public key the app carries");
  const manifest = parseManifest(bytes);
  if (manifest.version !== version) throw Error("update.json is for another version");
  for (const kind of ASSET_KINDS) {
    const asset = manifest.assets[kind];
    if (!asset) throw Error(`update.json lacks ${kind}`);
    const file = join(dir, asset.name);
    if (!names.includes(asset.name) || statSync(file).size !== asset.size || createHash("sha256").update(readFileSync(file)).digest("hex") !== asset.sha256) throw Error(`update.json does not match ${asset.name}`);
  }
  return manifest;
}
