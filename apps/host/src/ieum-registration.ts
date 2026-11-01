import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { sandboxWrapper } from "./ieumoffice.ts";

const run = promisify(execFile);
export type DesktopRegistration = { platform: NodeJS.Platform; entry: string; executable: string };
export type RegistrationOptions = { platform?: NodeJS.Platform; home?: string; env?: NodeJS.ProcessEnv };

/** Desktop Entry applies string escaping before Exec quoting. No shell is involved.
 * https://specifications.freedesktop.org/desktop-entry/latest/exec-variables.html */
export function desktopExecArgument(value: string) {
  if (/[\r\n\0=]/.test(value)) throw new Error("앱 실행 경로에 지원하지 않는 문자가 있습니다.");
  return `"${value.replace(/%/g, "%%").replace(/["`$\\]/g, "\\$&").replace(/\\/g, "\\\\")}"`;
}
const desktopValue = (value: string) => value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r");

/** Register the real Ieum app outside the CLI install. Workbench/its Node need not be running. */
export async function registerIeumDesktop(app: string, options: RegistrationOptions = {}): Promise<DesktopRegistration> {
  const platform = options.platform ?? process.platform, home = options.home ?? homedir(), env = options.env ?? process.env;
  if (!existsSync(app)) throw new Error("등록할 이음오피스 앱을 찾지 못했습니다.");
  if (platform === "darwin") {
    const entry = resolve(dirname(app), "../..");
    await run("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-f", entry], { timeout: 30_000, maxBuffer: 64_000 });
    return { platform, entry, executable: app };
  }
  if (platform === "win32") {
    const programs = join(env.APPDATA ?? join(home, "AppData/Roaming"), "Microsoft/Windows/Start Menu/Programs");
    const entry = join(programs, "IeumOffice.lnk");
    mkdirSync(programs, { recursive: true });
    // Official NSIS usually creates this. Verify/repair that single entry for existing installs.
    // Paths are data in environment variables, not interpolated PowerShell source.
    const script = `$ErrorActionPreference='Stop'; $shell=New-Object -ComObject WScript.Shell; $link=$shell.CreateShortcut($env:IEUM_REG_SHORTCUT); if ((Test-Path -LiteralPath $env:IEUM_REG_SHORTCUT) -and $link.TargetPath -and ([IO.Path]::GetFileName($link.TargetPath) -ine 'IeumOffice.exe')) { throw 'An unrelated Start Menu shortcut already uses the IeumOffice name' }; $link.TargetPath=$env:IEUM_REG_APP; $link.WorkingDirectory=[IO.Path]::GetDirectoryName($env:IEUM_REG_APP); $link.IconLocation=$env:IEUM_REG_APP+',0'; $link.Description='IeumOffice'; $link.Save(); if (!(Test-Path -LiteralPath $env:IEUM_REG_SHORTCUT)) { throw 'IeumOffice shortcut was not registered' }`;
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { env: { ...env, IEUM_REG_APP: app, IEUM_REG_SHORTCUT: entry }, timeout: 30_000, windowsHide: true, maxBuffer: 64_000 });
    return { platform, entry, executable: app };
  }
  if (platform !== "linux") throw new Error("이 OS의 이음오피스 앱 등록을 지원하지 않습니다.");
  const data = env.XDG_DATA_HOME || join(home, ".local/share");
  const applications = join(data, "applications"), entry = join(applications, "ieumoffice.desktop");
  const launcher = sandboxWrapper(app, join(data, "ieumoffice", "launcher"));
  if (!launcher) throw new Error("이음오피스 독립 실행기를 만들지 못했습니다.");
  if (existsSync(entry)) {
    const previous = readFileSync(entry, "utf8");
    if (!previous.includes("X-Achmage-Managed=true")) {
      if (previous.includes(app) || /^Exec=(?:"?\/usr\/bin\/)?ieumoffice(?:[ "\n]|$)/m.test(previous)) return { platform, entry, executable: app };
      throw new Error("기존 이음오피스 앱 메뉴가 다른 실행 경로를 사용합니다. 기존 앱을 연결해 주세요.");
    }
  }
  const icon = [join(dirname(app), "ieumoffice.png"), join(dirname(app), ".DirIcon"), join(dirname(app), "usr/share/icons/hicolor/256x256/apps/ieumoffice.png")].find(existsSync);
  // GLib validates the first executable before expanding %% field codes. A fixed env
  // executable also supports percent signs in the real path, without invoking a shell.
  const content = ["[Desktop Entry]", "Type=Application", "Name=IeumOffice", "Name[ko]=이음오피스", "Comment=문서 편집과 AI 작업", `Exec=/usr/bin/env ${desktopExecArgument(launcher)} %U`, `TryExec=${desktopValue(launcher)}`, `Icon=${icon ? desktopValue(icon) : "applications-office"}`, "Terminal=false", "Categories=Office;", "StartupWMClass=ieumoffice", "StartupNotify=true", "X-Achmage-Managed=true", ""].join("\n");
  mkdirSync(applications, { recursive: true });
  if (!existsSync(entry) || readFileSync(entry, "utf8") !== content) writeFileSync(entry, content, { mode: 0o644 });
  return { platform, entry, executable: app };
}
