// Upload an accepted candidate to a prepared preview or stable draft without rebuilding it.
import { execFileSync } from "node:child_process";
import { constants, copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyProvenance } from "./verify-provenance.ts";
import { verifySignedRelease, writeUnsignedManifest } from "./update-manifest.ts";

export function releaseTag(tag: string) {
  if (/^preview-[A-Za-z0-9._-]+$/.test(tag)) return { prerelease: true, version: null };
  const version = /^v(\d+\.\d+\.\d+)$/.exec(tag)?.[1];
  if (version) return { prerelease: false, version };
  throw Error("Expected a preview-* or vMAJOR.MINOR.PATCH tag");
}

export async function preparePromotion(input: { root: string; receipt: string; sourceRun: string; sourceSha: string; tag: string; output: string;
  /**
   * The in-app update's manifest (app-update): update.json is WRITTEN here, from the real files, with no key in
   * reach. It is signed by the workflow's own inline step in a separate job (release.yml › sign-update; review H1).
   */
  update?: boolean }) {
  const channel = releaseTag(input.tag);
  const candidate = await verifyProvenance(input);
  if (channel.version && candidate.receipt.scope?.applicationVersion !== channel.version) throw Error("Stable tag and installed application version differ");
  mkdirSync(input.output, { recursive: true });
  const files = [];
  for (const asset of candidate.assets) {
    const target = join(input.output, asset.name);
    copyFileSync(asset.path, target, constants.COPYFILE_EXCL);
    files.push(target);
  }
  for (const name of ["SHA256SUMS.txt", "installer-provenance.json", "preview-notes.md"]) {
    const target = join(input.output, name);
    copyFileSync(join(dirname(input.receipt), name), target, constants.COPYFILE_EXCL);
    files.push(target);
  }
  if (input.update) {
    const version = candidate.receipt.scope?.applicationVersion;
    if (!version) throw Error("update.json needs the candidate's application version");
    files.push(writeUnsignedManifest(input.output, version, candidate.assets.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 }))));
  }
  return { files, channel };
}

// `promote.ts prepare <out> <receipt> <release-files>`: verify the candidate, copy its files and write update.json
// (stable tags only). `promote.ts upload <release-files>`: check update.json.sig (made by the workflow's signing
// job) against the app's key list and the files, then upload. Neither ever holds the signing key.
async function main() {
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const sourceRun = process.env.SOURCE_RUN ?? "", sourceSha = process.env.SOURCE_SHA ?? "", tag = process.env.PREVIEW_TAG ?? "";
  const channel = releaseTag(tag);
  if (process.env.WORKBENCH_UPDATE_SIGNING_KEY) throw Error("The signing key must never reach repository code");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw Error("Expected an explicit GitHub repository");
  const gh = (args: string[]) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  // Resolve annotated tags too; the immutable source is always the commit, not its tag object.
  let ref = JSON.parse(gh(["api", `repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`])).object as { type: string; sha: string };
  for (let depth = 0; ref.type === "tag" && depth < 5; depth++) ref = JSON.parse(gh(["api", `repos/${repository}/git/tags/${ref.sha}`])).object;
  if (ref.type !== "commit" || ref.sha !== sourceSha) throw Error("Release tag does not point to the accepted source");
  const draft = JSON.parse(gh(["release", "view", tag, "--repo", repository, "--json", "isDraft,isPrerelease,assets"]));
  if (!draft.isDraft || draft.isPrerelease !== channel.prerelease || draft.assets.length) throw Error("Expected an empty, unpublished draft for this channel");
  const mode = process.argv[2];
  if (mode === "prepare") {
    const result = await preparePromotion({ root: resolve(process.argv[3] ?? "out"), receipt: resolve(process.argv[4] ?? "out/candidate-provenance/installer-provenance.json"),
      sourceRun, sourceSha, tag, output: resolve(process.argv[5] ?? "release-files"), update: channel.version !== null });
    console.log(JSON.stringify({ tag, sourceRun, sourceSha, prepared: result.files.length }));
  } else if (mode === "upload") {
    const dir = resolve(process.argv[3] ?? "release-files");
    if (channel.version) verifySignedRelease(dir, channel.version);
    else if (existsSync(join(dir, "update.json")) || existsSync(join(dir, "update.json.sig"))) throw Error("A preview release carries no update manifest");
    const files = readdirSync(dir).sort().map(name => join(dir, name));
    gh(["release", "upload", tag, "--repo", repository, ...files]);
    console.log(JSON.stringify({ tag, sourceRun, sourceSha, uploaded: files.length, published: false }));
  } else throw Error("usage: promote.ts prepare <out> <receipt> <release-files> | upload <release-files>");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
