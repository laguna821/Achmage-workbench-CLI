import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { shipped } from "./resources.ts";

// Achmage HOP (the user's Hangul editor, https://github.com/laguna821/Achmage-HOP-public, MIT) for
// people editing HWPX/HWP: Workbench opens the file in HOP and takes what HOP saves as a new
// revision of the document. Release builds ship HOP's official build for their OS
// (packaging/bundled-apps.json); a computer's own install is used when running without it.

/** How to open a file in HOP: `launcher` with `args` before the file. */
export type HopInstall = { launcher: string; args?: string[]; version: string | null; bundled?: boolean };

/** The version a bundled app was shipped as (scripts/fetch-bundled-apps.ts writes it). */
export function bundleVersion(dir: string): string | null {
  try {
    return (JSON.parse(readFileSync(join(dir, "WORKBENCH-BUNDLE.json"), "utf8")) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

/** The HOP shipped with the app: Linux usr/bin/hop-desktop, Windows hop-desktop.exe, macOS Achmage HOP.app. */
export function bundledHop(platform: NodeJS.Platform = process.platform): HopInstall | null {
  const app = platform === "darwin" ? shipped(join("hop", "Achmage HOP.app")) : null;
  if (app) return { launcher: "/usr/bin/open", args: ["-a", app], version: bundleVersion(dirname(app)), bundled: true };
  const binary = shipped(platform === "win32" ? join("hop", "hop-desktop.exe") : join("hop", "usr", "bin", "hop-desktop"));
  if (!binary) return null;
  return { launcher: binary, version: bundleVersion(platform === "win32" ? dirname(binary) : join(dirname(binary), "..", "..")), bundled: true };
}

/** HOP: an override, the copy shipped with the app, the user's launcher script, or `hop-desktop` on PATH. */
export function findHop(env: NodeJS.ProcessEnv = process.env): HopInstall | null {
  if (!env.WORKBENCH_HOP_BIN) {
    const bundled = bundledHop();
    if (bundled) return bundled;
  }
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
  const child = spawn(hop.launcher, [...(hop.args ?? []), file], { detached: true, stdio: "ignore", windowsHide: false });
  // A launcher that cannot start must not take the gateway down.
  child.on("error", () => undefined);
  child.unref();
}

/** Open a file with the desktop's default application. */
export function openWithDesktop(file: string) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  const child = spawn(opener, [file], { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}
