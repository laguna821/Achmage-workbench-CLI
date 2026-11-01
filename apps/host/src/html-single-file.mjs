import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { inlineImagesForSingleFile, singleFileExportBaseName } from "../../../vendor/ieumoffice/apps/html/src/main/single-file-html.ts";
import { extractDocumentImageSources, resolveSafeRelativeImagePath, scanCssUrls } from "../../../vendor/ieumoffice/apps/html/src/main/asset-lifecycle.ts";
import { readOfficeAsset } from "./office-assets.ts";
import { HttpError } from "./errors.ts";

/** The upstream engine reads only a private snapshot of this document's allowed images. */
export async function singleHtml(documents, artifact, html) {
  const root = join(documents.dataDir, "office-single-file"); await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, "export-"));
  try {
    const refs = new Set([...extractDocumentImageSources(html), ...scanCssUrls(html).map(value => value.source)]);
    if (refs.size > 2000) throw new HttpError(413, "html_export_size", "내보낼 그림 참조가 너무 많습니다.");
    let total = 0;
    for (const source of refs) {
      if (!await resolveSafeRelativeImagePath(artifact.path, source)) continue;
      const decoded = decodeURIComponent(source.trim()).replace(/[\\/]/g, sep), target = resolve(directory, decoded), rel = relative(directory, target);
      if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
      let asset;
      try { asset = await readOfficeAsset(artifact.path, decoded, extname(decoded).toLowerCase() !== ".svg", "image/*"); }
      catch (error) { if (error instanceof HttpError && [403, 404, 415].includes(error.status)) continue; throw error; }
      if (!asset.type.startsWith("image/")) continue;
      total += asset.data.length;
      if (total > 100_000_000) throw new HttpError(413, "html_export_size", "내보낼 그림 용량이 너무 큽니다.");
      await mkdir(dirname(target), { recursive: true }); await writeFile(target, asset.data, { mode: 0o600 });
    }
    const result = await inlineImagesForSingleFile(html, join(directory, "document.html"));
    return { ...result, defaultName: `${singleFileExportBaseName(basename(artifact.path).replace(/\.html?$/i, ""))}.html` };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
