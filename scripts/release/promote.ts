// Upload an accepted candidate to a prepared preview or stable draft without rebuilding it.
import { execFileSync } from "node:child_process";
import { constants, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyProvenance } from "./verify-provenance.ts";

export function releaseTag(tag: string) {
  if (/^preview-[A-Za-z0-9._-]+$/.test(tag)) return { prerelease: true, version: null };
  const version = /^v(\d+\.\d+\.\d+)$/.exec(tag)?.[1];
  if (version) return { prerelease: false, version };
  throw Error("Expected a preview-* or vMAJOR.MINOR.PATCH tag");
}

export async function preparePromotion(input: { root: string; receipt: string; sourceRun: string; sourceSha: string; tag: string; output: string }) {
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
  return { files, channel };
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const sourceRun = process.env.SOURCE_RUN ?? "", sourceSha = process.env.SOURCE_SHA ?? "", tag = process.env.PREVIEW_TAG ?? "";
  const channel = releaseTag(tag);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw Error("Expected an explicit GitHub repository");
  const gh = (args: string[]) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  // Resolve annotated tags too; the immutable source is always the commit, not its tag object.
  let ref = JSON.parse(gh(["api", `repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`])).object as { type: string; sha: string };
  for (let depth = 0; ref.type === "tag" && depth < 5; depth++) ref = JSON.parse(gh(["api", `repos/${repository}/git/tags/${ref.sha}`])).object;
  if (ref.type !== "commit" || ref.sha !== sourceSha) throw Error("Release tag does not point to the accepted source");
  const draft = JSON.parse(gh(["release", "view", tag, "--repo", repository, "--json", "isDraft,isPrerelease,assets"]));
  if (!draft.isDraft || draft.isPrerelease !== channel.prerelease || draft.assets.length) throw Error("Expected an empty, unpublished draft for this channel");
  const result = await preparePromotion({ root: resolve(process.argv[2] ?? "out"), receipt: resolve(process.argv[3] ?? "out/candidate-provenance/installer-provenance.json"),
    sourceRun, sourceSha, tag, output: resolve(process.argv[4] ?? "release-files") });
  gh(["release", "upload", tag, "--repo", repository, ...result.files]);
  console.log(JSON.stringify({ tag, sourceRun, sourceSha, uploaded: result.files.length, published: false }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
