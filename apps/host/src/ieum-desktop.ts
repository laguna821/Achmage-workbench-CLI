import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import type { ToolStatus } from "@workbench/contracts";
import { HttpError } from "./errors.ts";
import { findIeum, ieumFromCliDir, installIeumOffice, sandboxWrapper, type IeumInstall } from "./ieumoffice.ts";

const run = promisify(execFile);
const REPO = "https://github.com/pblsketch/openoffice/releases/download/";
export type DesktopRelease = { tag_name: string; assets: { name: string; browser_download_url: string; digest: string | null; size: number }[] };

/** Select a verified official installer, with no executable URL supplied by the caller. */
export function desktopAsset(release: DesktopRelease, platform: NodeJS.Platform, arch: string) {
  const version = release.tag_name?.replace(/^v/, "");
  if (!version || !/^\d+\.\d+\.\d+(?:[-.][\w.-]+)?$/.test(version) || !Array.isArray(release.assets)) throw new HttpError(502, "ieum_release", "공식 이음오피스 배포 정보를 확인하지 못했습니다.");
  const name = platform === "win32" && (arch === "x64" || arch === "arm64") ? `IeumOffice-Setup-${version}.exe`
    : platform === "darwin" && (arch === "x64" || arch === "arm64") ? `IeumOffice-${version}${arch === "arm64" ? "-arm64" : ""}-mac.zip` : null;
  const asset = release.assets.find((entry) => entry.name === name);
  if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? "") || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > 1_500_000_000 || asset.browser_download_url !== `${REPO}${release.tag_name}/${name}`) throw new HttpError(502, "ieum_release", "이 OS의 공식 설치 파일과 체크섬을 확인하지 못했습니다.");
  return { ...asset, version, sha256: asset.digest!.slice(7) };
}

export function desktopFromPath(input: string, platform: NodeJS.Platform = process.platform): IeumInstall {
  let path = resolve(input.trim());
  if (platform === "darwin" && path.endsWith(".app")) path = join(path, "Contents", "MacOS", "IeumOffice");
  if (!existsSync(path)) throw new HttpError(404, "ieum_app_missing", "이음오피스 앱을 찾지 못했습니다. 설치 위치를 확인해 주세요.");
  path = realpathSync(path);
  const cli = platform === "darwin" ? join(dirname(path), "..", "Resources", "cli") : join(dirname(path), "resources", "cli");
  const install = ieumFromCliDir(cli, false, platform);
  if (!install?.app || realpathSync(install.app) !== path) throw new HttpError(400, "ieum_app_invalid", "이음오피스 앱과 함께 설치된 문서 도구를 찾지 못했습니다.");
  return install;
}

/** Optional standalone application. It never replaces Workbench's bundled document engine. */
export class IeumDesktop {
  private selected: { path: string; version: string | null } | null = null;
  private busy = false;
  private message: string | null = null;
  private readonly config: string;
  private readonly dataDir: string;
  private readonly changed: () => void;
  constructor(dataDir: string, changed: () => void) {
    this.dataDir = dataDir; this.changed = changed;
    this.config = join(dataDir, "ieum-desktop.json");
    try { const value = JSON.parse(readFileSync(this.config, "utf8")); if (typeof value.path === "string") this.selected = { path: value.path, version: typeof value.version === "string" ? value.version : null }; } catch { /* First use. */ }
  }
  find(): IeumInstall | null {
    if (this.selected) { try { return desktopFromPath(this.selected.path); } catch { /* An app can move or update. */ } }
    return findIeum(process.env, process.platform, true);
  }
  status(): ToolStatus {
    const app = this.find()?.app ?? null;
    return { available: Boolean(app), bundled: false, path: app, version: app === this.selected?.path ? this.selected.version : null, busy: this.busy, message: this.message };
  }
  link(path: string, version: string | null = null) {
    const install = desktopFromPath(path);
    this.selected = { path: install.app!, version };
    mkdirSync(this.dataDir, { recursive: true });
    const temporary = `${this.config}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.selected), { mode: 0o600 }); renameSync(temporary, this.config);
    this.message = "이음오피스 앱을 연결했습니다. 같은 파일을 열고 저장 내용을 이어받습니다.";
    this.changed(); return this.status();
  }
  install() {
    if (this.busy) return this.status();
    this.busy = true; this.message = "최신 공식 이음오피스 확인 중…"; this.changed();
    void this.performInstall().catch((error) => { this.message = error instanceof Error ? error.message : String(error); })
      .finally(() => { this.busy = false; this.changed(); });
    return this.status();
  }
  private async performInstall() {
    if (process.platform === "linux") {
      const cli = await installIeumOffice((step) => { this.message = step.message; this.changed(); });
      const app = ieumFromCliDir(dirname(cli))?.app;
      if (!app) throw new Error("설치한 이음오피스 앱을 찾지 못했습니다.");
      this.link(app); return;
    }
    const response = await fetch("https://api.github.com/repos/pblsketch/openoffice/releases/latest", { headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`공식 배포 정보를 받지 못했습니다 (${response.status}).`);
    const asset = desktopAsset(await response.json() as DesktopRelease, process.platform, process.arch);
    const downloads = join(this.dataDir, "installers"); mkdirSync(downloads, { recursive: true });
    const staging = mkdtempSync(join(downloads, "ieum-"));
    try {
      this.message = `이음오피스 ${asset.version} 다운로드 중 (${Math.ceil(asset.size / 1_000_000)} MB)…`; this.changed();
      const download = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(600_000) });
      if (!download.ok || !download.body) throw new Error("이음오피스 설치 파일 다운로드에 실패했습니다.");
      const file = join(staging, asset.name), digest = createHash("sha256"); let bytes = 0;
      await pipeline(Readable.fromWeb(download.body as import("node:stream/web").ReadableStream), new Transform({ transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.length;
        if (bytes > asset.size) { done(new Error("배포 파일 크기가 공식 정보와 다릅니다.")); return; }
        digest.update(chunk); done(null, chunk);
      } }), createWriteStream(file, { flags: "wx" }));
      if (bytes !== asset.size || digest.digest("hex") !== asset.sha256) throw new Error("설치 파일의 공식 체크섬이 맞지 않아 실행하지 않았습니다.");
      this.message = `이음오피스 ${asset.version} 설치 중…`; this.changed();
      if (process.platform === "win32") {
        await run(file, ["/S"], { timeout: 600_000, windowsHide: false, maxBuffer: 64_000 });
        const app = findIeum(process.env, process.platform, true)?.app;
        if (!app) throw new Error("설치가 끝났습니다. 앱 위치를 자동으로 찾지 못해 설치된 IeumOffice.exe를 선택해 주세요.");
        this.link(app, asset.version);
      } else {
        const applications = join(homedir(), "Applications"); mkdirSync(applications, { recursive: true });
        const unpack = mkdtempSync(join(applications, ".ieum-install-")), target = join(applications, "IeumOffice.app");
        try {
          await run("/usr/bin/ditto", ["-x", "-k", file, unpack], { timeout: 300_000, maxBuffer: 64_000 });
          desktopFromPath(join(unpack, "IeumOffice.app"));
          if (existsSync(target)) renameSync(target, join(applications, `IeumOffice.previous-${Date.now()}.app`));
          renameSync(join(unpack, "IeumOffice.app"), target);
          this.link(target, asset.version);
        } finally { rmSync(unpack, { recursive: true, force: true }); }
      }
    } finally { rmSync(staging, { recursive: true, force: true }); }
  }
  async open(path: string) {
    const app = this.find()?.app;
    if (!app) throw new HttpError(409, "ieum_app_missing", "이음오피스 앱을 먼저 설치하거나 연결해 주세요.");
    const file = process.platform === "darwin" ? "/usr/bin/open" : process.platform === "linux" ? sandboxWrapper(app, this.dataDir) ?? app : app;
    const args = process.platform === "darwin" ? ["-a", join(dirname(app), "..", ".."), "--", path] : [path];
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.GENOFFICE_USER_DATA; delete env.GENOFFICE_AI_SETTINGS;
    if (process.platform === "darwin") {
      await run(file, args, { env, timeout: 30_000, maxBuffer: 64_000 });
      return { app: "이음오피스", path };
    }
    await new Promise<void>((resolve, reject) => {
      const child = spawn(file, args, { detached: true, stdio: "ignore", env });
      child.once("error", reject); child.once("spawn", () => { child.unref(); resolve(); });
    });
    return { app: "이음오피스", path };
  }
}
