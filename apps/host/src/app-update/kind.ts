// How THIS copy was installed (app-update brief, decision 3). A marker `install-kind.json` written at
// packaging time beside the app's resources comes first; it is then checked against where the files are,
// so a package's payload copied into a person's own folder is not taken for the package.
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { AppInstallKind } from "@workbench/contracts";

export type InstallInfo = {
  kind: AppInstallKind;
  /** The folder holding host/ and web/ (Resources on macOS). */
  root: string;
  /** What the install step replaces (the folder, the .AppImage file, the .app bundle). */
  target: string;
  appBin: string;
  relaunch: string[];
  /** False: the fallback — the checked installer of `kind` is saved to the downloads folder instead. */
  installable: boolean;
  /** Why it is the fallback, in one sentence. */
  reason: string | null;
};

const writable = (path: string) => { try { accessSync(path, constants.W_OK); return true; } catch { return false; } };
const marker = (root: string): string | null => {
  try { const kind = (JSON.parse(readFileSync(join(root, "install-kind.json"), "utf8")) as { kind?: unknown }).kind; return typeof kind === "string" ? kind : null; } catch { return null; }
};
const isFile = (path: string) => { try { return statSync(path).isFile(); } catch { return false; } };

/**
 * `hostEntry` is the running gateway bundle (…/host/host.mjs). `appBin` is the window's binary
 * (WORKBENCH_APP_BIN); `appImage` the ORIGINAL AppImage file (WORKBENCH_APPIMAGE_SOURCE).
 */
export function detectInstall(input: { hostEntry: string; platform: NodeJS.Platform; appBin?: string; appImage?: string }): InstallInfo {
  const root = resolve(dirname(dirname(input.hostEntry)));
  const none = (reason: string, kind: AppInstallKind = "none"): InstallInfo => ({ kind, root, target: root, appBin: input.appBin ?? "", relaunch: [], installable: false, reason });
  if (input.hostEntry.endsWith(".ts")) return none("소스에서 실행 중인 앱은 여기서 업데이트하지 않습니다.");
  const mark = marker(root);
  if (input.platform === "win32") {
    const exe = join(root, "achmage-workbench.exe");
    if (!isFile(exe)) return none("설치된 앱 파일을 찾지 못했습니다.");
    // NSIS and MSI share one build; the NSIS installer leaves its uninstaller beside the app.
    const kind: AppInstallKind = existsSync(join(root, "uninstall.exe")) ? "nsis" : mark === "windows" ? "msi" : "none";
    if (kind === "none") return none("이 설치 방식은 알 수 없습니다.");
    // MSI installs for the whole computer (elevated): not in place until an elevated-side check exists (review M1).
    if (kind === "msi") return none("", "msi");
    return { kind, root, target: root, appBin: input.appBin || exe, relaunch: [exe], installable: true, reason: null };
  }
  if (input.platform === "darwin") {
    if (mark !== "dmg" || !root.endsWith(`.app${sep}Contents${sep}Resources`)) return none("이 설치 방식은 알 수 없습니다.");
    const bundle = dirname(dirname(root));
    if (!writable(dirname(bundle)) || !writable(bundle)) return none("앱이 있는 폴더에 쓸 수 없습니다.", "dmg");
    return { kind: "dmg", root, target: bundle, appBin: input.appBin || join(bundle, "Contents/MacOS/achmage-workbench"), relaunch: ["open", bundle], installable: true, reason: null };
  }
  if (input.platform !== "linux") return none("이 OS는 앱 안에서 업데이트하지 않습니다.");
  if (mark === "appimage") {
    const image = input.appImage;
    if (!image || !isFile(image)) return none("AppImage 파일의 위치를 알지 못했습니다.", "appimage");
    if (!writable(dirname(image)) || !writable(image)) return none("AppImage가 있는 폴더에 쓸 수 없습니다.", "appimage");
    return { kind: "appimage", root, target: image, appBin: input.appBin ?? "", relaunch: [image], installable: true, reason: null };
  }
  // deb and pacman install as root: until a root-side verifier ships, the checked package is saved for the
  // person to install by hand (security review M1: a same-user program could swap the file under pkexec).
  if (mark === "deb" && root.startsWith("/usr/")) return none("", "deb");
  if (mark === "pacman" && root === "/usr/lib/achmage-workbench") return none("", "pacman");
  // A person's own folder: the package payload laid out where they own it (with or without a marker).
  const bin = join(root, "achmage-workbench");
  if ((mark === null || mark === "pacman" || mark === "deb" || mark === "user-folder") && !root.startsWith("/usr/") && !root.startsWith("/opt/")
    && isFile(bin) && existsSync(join(root, "host", "workbench-service.mjs")) && existsSync(join(root, "web", "index.html"))) {
    if (!writable(root) || !writable(dirname(root))) return none("앱이 있는 폴더에 쓸 수 없습니다.", "user-folder");
    return { kind: "user-folder", root, target: root, appBin: input.appBin || bin, relaunch: [bin], installable: true, reason: null };
  }
  return none("이 설치 방식은 알 수 없습니다.");
}
