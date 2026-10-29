import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { bundleVersion } from "./hop.ts";
import { shipped } from "./resources.ts";

// Achmage PDFCraft's command line (https://github.com/laguna821/pdfcraft, MIT OR Apache-2.0) for PDF
// page edits: the copy shipped with the app (packaging/bundled-apps.json), else one on PATH.

export type PdfcraftCli = { path: string; version: string | null; bundled: boolean };

export function findPdfcraft(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): PdfcraftCli | null {
  const name = platform === "win32" ? "pdfcraft-cli.exe" : "pdfcraft-cli";
  const bundled = shipped(join("pdfcraft", name));
  if (bundled) return { path: bundled, version: bundleVersion(dirname(bundled)), bundled: true };
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    const candidate = dir ? join(dir, name) : "";
    if (candidate && existsSync(candidate)) return { path: candidate, version: null, bundled: false };
  }
  return null;
}
