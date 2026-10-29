import { existsSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Files that ship with the app (the bundled kordoc, IeumOffice, npm): the desktop shell names its
// resource folders in WORKBENCH_RESOURCES_DIR; the gateway bundle sits in <resources>/host/, and a
// source checkout keeps them under third_party/ and apps/desktop/src-tauri/.

/** Folders to look in for shipped files, most specific first. */
export function resourceDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const dirs = [
    ...(env.WORKBENCH_RESOURCES_DIR ?? "").split(delimiter).filter(Boolean),
    // host.mjs in <resources>/host/
    resolve(here, ".."),
  ];
  return [...new Set(dirs.map((dir) => resolve(dir)))];
}

/** A source checkout's root (apps/host/src → ../../..), when running from sources. */
export function repoRoot(): string | null {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  return existsSync(join(root, "apps/host/src")) ? root : null;
}

/** The first of `relative` paths that exists in a resource folder. */
export function shipped(...relative: string[]): string | null {
  for (const dir of resourceDirs()) {
    for (const path of relative) {
      const candidate = join(dir, path);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}
