// 설정 › 정보 › 업데이트 in the gateway (app-update brief): check, download and verification happen here;
// the install step is handed to the detached helper. Only the PC's own window drives this (the route
// needs the window's token and is not in a remote device's route list); a request names an ACTION only —
// the address, the file and the version come from the verified manifest.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, constants } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppUpdateAction, AppUpdateStatus, HostUpdateBlocker } from "@workbench/contracts";
import { downloadAsset, fetchSmall, updateSource, type Fetch, type UpdateSource } from "./download.ts";
import { assetKindFor, isNewer, MANIFEST_MAX_BYTES, parseManifest, releaseUrl, SIGNATURE_MAX_BYTES, trustedKeys, UpdateRefused, verifyManifestSignature, type UpdateManifest } from "./manifest.ts";
import { resultFile, sha256File, type InstallPlan, type InstallResult } from "./install.ts";
import type { InstallInfo } from "./kind.ts";

declare const __WORKBENCH_VERSION__: string | undefined;
/** The installed version: fixed when the gateway bundle is built (the release version), else the repository's. */
export function installedVersion(): string {
  if (typeof __WORKBENCH_VERSION__ === "string" && __WORKBENCH_VERSION__) return __WORKBENCH_VERSION__;
  return (JSON.parse(readFileSync(fileURLToPath(new URL("../../../../package.json", import.meta.url)), "utf8")) as { version: string }).version;
}

export type DrainPolicy = { prepare(): { blockers: HostUpdateBlocker[] }; cancel(): unknown; status(): { blockers: HostUpdateBlocker[] } };
export type AppUpdateOptions = {
  dataDir: string;
  installed: string;
  install: InstallInfo;
  policy: DrainPolicy;
  /** Stops this gateway for the install (the existing drain stop), after the answer has gone out. */
  stopForInstall(): void;
  /** Starts the helper with the plan file; it must outlive this process. */
  startHelper?(planFile: string, plan: InstallPlan): void;
  fetch?: Fetch;
  keys?: readonly string[];
  source?: UpdateSource;
  /** The systemctl by absolute path for the user-folder login unit restart. */
  systemctl?: string | null;
  /** The login unit to restart after a user-folder install (Linux), when it is enabled. */
  loginUnit?(): Promise<string | null>;
  downloadsDir?: string;
  now?(): number;
  pollMs?: number;
};

const SIGNATURE = "업데이트 정보의 서명이 맞지 않습니다. 설치하지 않았습니다. 잠시 뒤 다시 확인해 주세요.";
const NO_ASSET = "이 컴퓨터에 맞는 설치 파일이 아직 게시되지 않았습니다. ‘바뀐 점 보기’에서 직접 받아 주세요.";
const INSTRUCTION: Record<string, string> = {
  nsis: "내려받은 설치 파일을 두 번 눌러 설치해 주세요. 대화와 문서는 그대로 남습니다.",
  msi: "받은 설치 파일을 실행하세요. 대화와 문서는 그대로 남습니다.",
  dmg: "내려받은 파일을 열고 Achmage Workbench를 지금 앱이 있는 폴더로 끌어다 놓아 주세요. 대화와 문서는 그대로 남습니다.",
  appimage: "앱을 닫고 지금 쓰는 AppImage 파일을 내려받은 파일로 바꿔 주세요. 대화와 문서는 그대로 남습니다.",
  deb: "받은 .deb 파일을 열어 설치하세요. 대화와 문서는 그대로 남습니다.",
  pacman: "터미널에서 sudo pacman -U <받은 파일>로 설치하세요. 대화와 문서는 그대로 남습니다.",
  "user-folder": "앱을 닫고 내려받은 꾸러미의 usr/lib/achmage-workbench 안 파일로 앱 폴더를 바꿔 주세요. 대화와 문서는 그대로 남습니다.",
};

export class AppUpdates {
  private state: AppUpdateStatus["state"] = "idle";
  private manifest: UpdateManifest | null = null;
  private progress: number | null = null;
  private message: string | null = null;
  private blockers: HostUpdateBlocker[] = [];
  private saved: AppUpdateStatus["saved"] = null;
  private lastResult: AppUpdateStatus["lastResult"] = null;
  private settings: { autoCheck: boolean; lastCheckedAt: number | null };
  private downloaded: string | null = null;
  private waitTimer: NodeJS.Timeout | null = null;
  private dailyTimer: NodeJS.Timeout | null = null;
  private busy: Promise<unknown> | null = null;
  /** Called after each change (the window refreshes 설정's mark). */
  onChange: (status: AppUpdateStatus) => void = () => undefined;
  private readonly options: AppUpdateOptions;
  constructor(options: AppUpdateOptions) {
    this.options = options;
    this.settings = this.readSettings();
    this.lastResult = this.readResult();
    this.tidy();
  }
  /** After an install (or a failed one): the plan, the helper's copy and downloads that are not newer go. */
  private tidy() {
    try {
      if (!existsSync(this.dir)) return;
      for (const entry of readdirSync(this.dir)) {
        const old = /^\d+\.\d+\.\d+/.test(entry) && (() => { try { return !isNewer(entry, this.options.installed); } catch { return true; } })();
        if (old || entry === "helper" || entry === "plan.json") rmSync(join(this.dir, entry), { recursive: true, force: true });
      }
    } catch { /* a later start tries again */ }
  }
  private get dir() { return join(this.options.dataDir, "updates"); }
  private now() { return this.options.now?.() ?? Date.now(); }
  private readSettings() {
    try { const raw = JSON.parse(readFileSync(join(this.dir, "settings.json"), "utf8")) as { autoCheck?: unknown; lastCheckedAt?: unknown };
      return { autoCheck: raw.autoCheck !== false, lastCheckedAt: typeof raw.lastCheckedAt === "number" ? raw.lastCheckedAt : null };
    } catch { return { autoCheck: true, lastCheckedAt: null }; }
  }
  private writeSettings() {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(this.dir, "settings.json.tmp"), JSON.stringify(this.settings), { mode: 0o600 });
    renameSync(join(this.dir, "settings.json.tmp"), join(this.dir, "settings.json"));
  }
  /** The helper's line from the last install: shown once, after the restart. */
  private readResult(): AppUpdateStatus["lastResult"] {
    try {
      const result = JSON.parse(readFileSync(resultFile(this.options.dataDir), "utf8")) as InstallResult;
      if (typeof result.message !== "string" || typeof result.ok !== "boolean") return null;
      // A success that did not take (this is still the old version) is not said as a success.
      if (result.ok && result.version !== this.options.installed) return { ok: false, message: "업데이트가 끝나지 않았습니다. 지금 있던 앱은 그대로 쓸 수 있습니다. 다시 눌러 주세요.", at: result.at };
      return { ok: result.ok, message: result.message, at: result.at };
    } catch { return null; }
  }

  status(): AppUpdateStatus {
    const available = this.manifest && isNewer(this.manifest.version, this.options.installed)
      ? { version: this.manifest.version, published: this.manifest.published, notes: this.manifest.notes, releaseUrl: releaseUrl(this.manifest.version) } : null;
    return { state: this.state, installed: this.options.installed, kind: this.options.install.kind, installable: this.options.install.installable, available,
      progress: this.progress, blockers: this.blockers, saved: this.saved, message: this.message, autoCheck: this.settings.autoCheck,
      lastCheckedAt: this.settings.lastCheckedAt, lastResult: this.lastResult };
  }
  private set(patch: Partial<{ state: AppUpdateStatus["state"]; progress: number | null; message: string | null; blockers: HostUpdateBlocker[] }>) {
    if (patch.state !== undefined) this.state = patch.state;
    if (patch.progress !== undefined) this.progress = patch.progress;
    if (patch.message !== undefined) this.message = patch.message;
    if (patch.blockers !== undefined) this.blockers = patch.blockers;
    this.onChange(this.status());
  }
  private fail(error: unknown, fallbackState: AppUpdateStatus["state"] = "failed") {
    const message = error instanceof UpdateRefused ? error.message : "업데이트를 마치지 못했습니다. 지금 있던 앱은 그대로 쓸 수 있습니다. 잠시 뒤 다시 눌러 주세요.";
    if (!(error instanceof UpdateRefused)) console.error("App update:", error instanceof Error ? error.message : String(error));
    this.progress = null;
    this.set({ state: fallbackState, message });
  }

  /** One action from the window. */
  async act(action: AppUpdateAction): Promise<AppUpdateStatus> {
    switch (action) {
      case "check": if (!this.working()) await this.check(); break;
      case "install": if (!this.working()) { this.busy = this.install().finally(() => { this.busy = null; }); await this.waitForPhase(); } break;
      case "wait": if (this.state === "blocked") this.waitThenInstall(); break;
      case "cancel": this.cancel(); break;
      case "dismiss": this.dismiss(); break;
      case "auto-on": case "auto-off": this.settings.autoCheck = action === "auto-on"; this.writeSettings(); this.onChange(this.status()); break;
      default: throw new UpdateRefused("manifest", "알 수 없는 요청입니다.");
    }
    return this.status();
  }
  private working() { return ["checking", "downloading", "verifying", "installing", "waiting"].includes(this.state); }
  /** The install answers as soon as the download has started (progress is polled), or at its end when quicker. */
  private async waitForPhase() { await Promise.race([this.busy, new Promise(resolve => setTimeout(resolve, 200))]); }

  async check(quiet = false): Promise<void> {
    // The line from the last install is said until the person checks again.
    if (!quiet && this.lastResult) this.dismiss();
    this.set({ state: "checking", message: null });
    try {
      const source = this.options.source ?? updateSource();
      const [manifestBytes, signature] = await Promise.all([
        fetchSmall(source, "update.json", MANIFEST_MAX_BYTES, this.options.fetch),
        fetchSmall(source, "update.json.sig", SIGNATURE_MAX_BYTES, this.options.fetch),
      ]);
      if (!verifyManifestSignature(manifestBytes, signature, this.options.keys ?? trustedKeys())) throw new UpdateRefused("signature", SIGNATURE);
      const manifest = parseManifest(manifestBytes);
      this.settings.lastCheckedAt = this.now(); this.writeSettings();
      this.manifest = manifest;
      this.saved = null;
      this.set({ state: isNewer(manifest.version, this.options.installed) ? "available" : "latest", message: null });
    } catch (error) {
      // A quiet check at start says nothing when it fails; 설정 shows the last state.
      if (quiet) { this.set({ state: this.manifest ? "available" : "idle", message: null }); return; }
      this.fail(error);
    }
  }

  /** The quiet check: at start and then at most once a day, only while the switch is on. */
  startDailyCheck(intervalMs = 6 * 3_600_000) {
    const due = () => this.settings.autoCheck && !this.working() && (this.settings.lastCheckedAt === null || this.now() - this.settings.lastCheckedAt >= 24 * 3_600_000);
    const tick = () => { if (due()) void this.check(true); };
    setTimeout(tick, 15_000).unref();
    this.dailyTimer = setInterval(tick, intervalMs); this.dailyTimer.unref();
  }
  close() { if (this.dailyTimer) clearInterval(this.dailyTimer); if (this.waitTimer) clearInterval(this.waitTimer); }

  private async install() {
    const manifest = this.manifest;
    if (!manifest || !isNewer(manifest.version, this.options.installed)) { this.set({ state: "failed", message: "먼저 ‘업데이트 확인’을 눌러 주세요." }); return; }
    const kind = assetKindFor(this.options.install.kind), asset = kind ? manifest.assets[kind] : undefined;
    if (!asset) { this.set({ state: "failed", message: NO_ASSET }); return; }
    const target = join(this.dir, manifest.version, asset.name);
    try {
      if (!existsSync(target)) {
        // Older downloads are not kept: only this version's folder stays.
        for (const entry of existsSync(this.dir) ? readdirSync(this.dir) : []) if (/^\d+\.\d+\.\d+/.test(entry) && entry !== manifest.version) rmSync(join(this.dir, entry), { recursive: true, force: true });
        this.set({ state: "downloading", progress: 0, message: null });
        await downloadAsset(this.options.source ?? updateSource(), asset, target, { fetch: this.options.fetch, onProgress: fraction => { const percent = Math.floor(fraction * 100); if (percent !== this.progress) this.set({ progress: percent }); }, roomFactor: this.options.install.kind === "user-folder" ? 6 : 2 });
      }
      this.set({ state: "verifying", progress: null });
      if (await sha256File(target) !== asset.sha256) { rmSync(target, { force: true }); throw new UpdateRefused("checksum", "내려받은 파일이 게시된 것과 다릅니다. 설치하지 않았습니다."); }
      this.downloaded = target;
    } catch (error) { this.fail(error); return; }
    if (!this.options.install.installable) { this.saveForPerson(target, this.options.install.kind); return; }
    // Something running or unsaved: say what, and change nothing yet (new work is still admitted).
    const current = this.options.policy.status();
    if (current.blockers.length) { this.set({ state: "blocked", blockers: current.blockers }); return; }
    const drain = this.options.policy.prepare();
    if (drain.blockers.length) { this.options.policy.cancel(); this.set({ state: "blocked", blockers: drain.blockers }); return; }
    await this.handOver();
  }

  /** The fallback: the checked installer goes to the downloads folder, with one sentence. */
  private saveForPerson(file: string, kind: string) {
    try {
      const folder = this.options.downloadsDir ?? downloadsFolder();
      mkdirSync(folder, { recursive: true });
      const name = basename(file), ext = name.endsWith(".pkg.tar.zst") ? ".pkg.tar.zst" : extname(name), stem = name.slice(0, name.length - ext.length);
      let path = join(folder, name);
      for (let n = 1; existsSync(path); n++) path = join(folder, `${stem} (${n})${ext}`);
      copyFileSync(file, path, constants.COPYFILE_EXCL);
      this.saved = { path, instruction: `${this.options.install.reason ?? ""} ${INSTRUCTION[kind] ?? INSTRUCTION.nsis!}`.trim() };
      this.set({ state: "saved", message: null });
    } catch (error) { this.fail(new UpdateRefused("space", "내려받기 폴더에 저장하지 못했습니다. 공간과 폴더 권한을 확인한 뒤 다시 눌러 주세요.")); void error; }
  }

  /** "작업이 끝나면 업데이트": waits for the blockers to clear, then goes on. Never stops a running turn. */
  private waitThenInstall() {
    // The existing drain: running work finishes, new work waits until the update (or 취소).
    this.options.policy.prepare();
    this.set({ state: "waiting" });
    this.waitTimer = setInterval(() => {
      const current = this.options.policy.status();
      if (current.blockers.length) { if (JSON.stringify(current.blockers) !== JSON.stringify(this.blockers)) this.set({ blockers: current.blockers }); return; }
      if (this.waitTimer) clearInterval(this.waitTimer); this.waitTimer = null;
      void this.handOver();
    }, this.options.pollMs ?? 2000);
    this.waitTimer.unref?.();
  }
  private cancel() {
    if (this.waitTimer) { clearInterval(this.waitTimer); this.waitTimer = null; }
    if (this.state === "waiting") { try { this.options.policy.cancel(); } catch { /* already stopping */ } }
    if (this.state === "installing") return;
    this.set({ state: this.manifest && isNewer(this.manifest.version, this.options.installed) ? "available" : "idle", blockers: [], message: null });
  }
  private dismiss() {
    const file = resultFile(this.options.dataDir);
    if (existsSync(file)) renameSync(file, join(dirname(file), "result.seen.json"));
    this.lastResult = null;
    if (this.state === "failed" || this.state === "saved") { this.saved = null; this.set({ state: this.manifest && isNewer(this.manifest.version, this.options.installed) ? "available" : "idle", message: null }); }
    else this.onChange(this.status());
  }

  private async handOver() {
    const manifest = this.manifest!, info = this.options.install, file = this.downloaded!;
    const kind = assetKindFor(info.kind)!, asset = manifest.assets[kind]!;
    const plan: InstallPlan = { kind: info.kind as InstallPlan["kind"], version: manifest.version, from: this.options.installed, installer: file, sha256: asset.sha256, size: asset.size,
      target: info.target, appBin: info.appBin, relaunch: info.relaunch, gatewayPid: process.pid, dataDir: this.options.dataDir,
      restartUnit: info.kind === "user-folder" && this.options.systemctl ? await this.options.loginUnit?.().catch(() => null) ?? null : null, systemctl: this.options.systemctl ?? null };
    const planFile = join(this.dir, "plan.json");
    try {
      writeFileSync(planFile, JSON.stringify(plan), { mode: 0o600 });
      (this.options.startHelper ?? startHelper)(planFile, plan);
    } catch (error) { try { this.options.policy.cancel(); } catch { /* stopping */ } this.fail(error); return; }
    this.set({ state: "installing", blockers: [], message: null });
    // After the answer has reached the window: the gateway stops through the existing drain path.
    setTimeout(() => this.options.stopForInstall(), 500).unref?.();
  }
}

/** The person's downloads folder (XDG on Linux), else ~/Downloads. */
export function downloadsFolder(home = homedir()): string {
  if (process.platform === "linux") {
    try {
      const line = readFileSync(join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "user-dirs.dirs"), "utf8").split("\n").find(l => l.startsWith("XDG_DOWNLOAD_DIR="));
      const value = line?.slice("XDG_DOWNLOAD_DIR=".length).replace(/^"|"$/g, "").replace(/^\$HOME/, home);
      if (value && value.startsWith("/")) return value;
    } catch { /* no user-dirs file */ }
  }
  return join(home, "Downloads");
}

/**
 * The helper runs from a copy in the updates folder with the app's own Node (on Windows the Node binary is
 * copied too, so the installer can replace the one in the install folder). Detached: it outlives the app.
 */
export function startHelper(planFile: string, plan: InstallPlan) {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const script = join(here, "update-helper.mjs");
  if (!existsSync(script)) throw new UpdateRefused("installer", "이 설치본에는 업데이트 도우미가 없습니다. ‘바뀐 점 보기’에서 직접 받아 주세요.");
  const dir = join(dirname(planFile), "helper");
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true, mode: 0o700 });
  copyFileSync(script, join(dir, "update-helper.mjs"));
  let node = process.execPath;
  if (process.platform === "win32") { copyFileSync(node, join(dir, "node.exe")); node = join(dir, "node.exe"); }
  const child = spawn(node, [join(dir, "update-helper.mjs"), planFile], { detached: true, stdio: "ignore", windowsHide: true, cwd: dir, env: { ...process.env, WORKBENCH_UPDATE_HELPER: "1" } });
  child.on("error", () => undefined);
  child.unref();
  void plan;
}
