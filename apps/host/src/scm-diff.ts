import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import type { ScmArea, ScmDiff, ScmStatus } from "@workbench/contracts";
import { HttpError } from "./errors.ts";
import { scmGit, scmText } from "./scm-git.ts";
import { scmFileStamp, scmHash } from "./scm-status.ts";

const MAX_PATCH = 512 * 1024, MAX_IMAGE = 8 * 1024 * 1024;
const imageTypes: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
async function blob(root: string, ref: string) {
  const size = Number((await scmText(root, ["cat-file", "-s", ref]).catch(() => "-1")).trim());
  if (!Number.isFinite(size) || size < 0 || size > MAX_IMAGE) return null;
  return scmGit(root, ["cat-file", "blob", ref], { limit: MAX_IMAGE });
}
function workingBlob(root: string, path: string) {
  const absolute = join(root, path);
  try {
    // Existing parent links cannot steer an image preview outside the repository.
    if (realpathSync(dirname(absolute)) !== dirname(absolute)) return null;
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) return Buffer.from(readlinkSync(absolute));
    return stat.isFile() && stat.size <= MAX_IMAGE ? readFileSync(absolute) : null;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
function imageUrl(data: Buffer | null, mime: string) { return data ? `data:${mime};base64,${data.toString("base64")}` : null; }

export async function readScmDiff(status: ScmStatus, path: string, area: ScmArea): Promise<ScmDiff> {
  const file = status.files.find((entry) => entry.path === path);
  if (!file || !["staged", "working"].includes(area)) throw new HttpError(404, "scm_file", "현재 변경 목록에 없는 파일입니다.");
  const stamps = JSON.stringify(scmFileStamp(status.root, path));
  let patch: string;
  if (file.index === "?" && area === "working") {
    if (path.endsWith("/")) patch = "중첩 저장소입니다. 해당 저장소를 작업공간으로 열어 변경을 검토하세요.\n";
    else patch = await scmText(status.root, ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "--", "/dev/null", path], { accepted: [0, 1] });
  } else {
    patch = await scmText(status.root, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--full-index", "--unified=3", ...(area === "staged" ? ["--cached"] : []), "--", ...(file.oldPath ? [file.oldPath, path] : [path])]);
  }
  const mime = !file.submodule && !file.conflicted && imageTypes[extname(path).toLowerCase()];
  let images: ScmDiff["images"];
  if (mime) {
    const [before, after] = await Promise.all([
      area === "staged" ? status.head ? blob(status.root, `${status.head}:${file.oldPath ?? path}`) : null : file.index === "?" ? null : blob(status.root, `:${path}`),
      area === "staged" ? blob(status.root, `:${path}`) : workingBlob(status.root, path),
    ]);
    images = { before: imageUrl(before, mime), after: imageUrl(after, mime) };
  }
  if (stamps !== JSON.stringify(scmFileStamp(status.root, path))) throw new HttpError(409, "scm_changed", "차이를 읽는 동안 파일이 바뀌었습니다. 새로고침해 주세요.");
  const lines = patch.split("\n"), truncated = Buffer.byteLength(patch) > MAX_PATCH || lines.length > 6000;
  const displayed = truncated ? Buffer.from(lines.slice(0, 6000).join("\n")).subarray(0, MAX_PATCH).toString("utf8") : patch;
  return { path, area, revision: scmHash(JSON.stringify([status.revision, area, path, patch])), patch: displayed, truncated, binary: /^Binary files /m.test(patch), ...(images ? { images } : {}) };
}
