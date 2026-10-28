import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

// Achmage HOP (the user's Hangul editor, a separate desktop app) for people editing HWPX/HWP:
// Workbench opens the file in HOP and takes what HOP saves as a new revision of the document.

export type HopInstall = { launcher: string; version: string | null };

/** The installed HOP launcher: an override, the user's launcher script, or `hop-desktop` on PATH. */
export function findHop(env: NodeJS.ProcessEnv = process.env): HopInstall | null {
  const candidates = [env.WORKBENCH_HOP_BIN, join(homedir(), ".local/bin/achmage-hop")].filter((path): path is string => Boolean(path));
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) candidates.push(join(dir, "achmage-hop"), join(dir, "hop-desktop"));
  const launcher = candidates.find((path) => existsSync(path));
  if (!launcher) return null;
  let version: string | null = null;
  try {
    // The user's launcher script names the installed version folder.
    version = /achmage-hop\/([^/"]+)\/usr\/bin\/hop-desktop/.exec(readFileSync(launcher, "utf8").slice(0, 4000))?.[1] ?? null;
  } catch {
    // A binary, not a script.
  }
  return { launcher, version };
}

/** Open a document in HOP, detached from the gateway (closing Workbench leaves HOP open). */
export function openInHop(hop: HopInstall, file: string) {
  const child = spawn(hop.launcher, [file], { detached: true, stdio: "ignore" });
  child.unref();
}

/** Open a file with the desktop's default application. */
export function openWithDesktop(file: string) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  const child = spawn(opener, [file], { detached: true, stdio: "ignore" });
  child.unref();
}
