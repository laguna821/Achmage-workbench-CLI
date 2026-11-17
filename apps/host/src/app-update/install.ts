// The install step (app-update brief, decision 2): run by the detached helper (`host/update-helper.mjs`,
// started with the app's own Node) AFTER the gateway has stopped. It waits for the gateway and the window
// to exit, checks the installer's SHA-256 once more, installs by kind, starts the app again and leaves ONE
// result file the gateway reads at its next start. A step that fails before the swap changes nothing; a
// swap is done by rename, so a failed copy leaves the old app in place.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync, chmodSync, cpSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { versionWith, type AppInstallKind } from "@workbench/contracts";
import { extractPrefix } from "./tar.ts";
import { guiEnvironment } from "../gui-env.ts";

export type InstallPlan = {
  /** Only the kinds installed as the person themselves; deb, pacman and MSI take the saved-installer fallback (security review M1). */
  kind: Extract<AppInstallKind, "nsis" | "dmg" | "appimage" | "user-folder">;
  version: string;
  from: string;
  installer: string;
  sha256: string;
  size: number;
  /** user-folder: the folder; appimage: the original .AppImage file; dmg: the .app bundle; others: the install folder. */
  target: string;
  /** The binary the window runs (WORKBENCH_APP_BIN): waited for, then started again. */
  appBin: string;
  /** What to start again after the install (the app binary, the AppImage, or `open <bundle>` on macOS). */
  relaunch: string[];
  /** The gateway's pid: waited for before anything is touched. */
  gatewayPid: number;
  dataDir: string;
  /** user-folder on Linux: the login unit to restart (only when it is enabled), else null. */
  restartUnit: string | null;
  /** The systemctl the gateway chose by absolute path (/usr/bin/systemctl), never a PATH lookup in the helper. */
  systemctl?: string | null;
};
export type InstallResult = { ok: boolean; version: string; from: string; kind: string; message: string; at: number; detail?: string };

export type HelperDeps = {
  /** Runs a program and resolves with its exit code (never throws for a non-zero exit). */
  run(command: string, args: string[], options?: { timeoutMs?: number }): Promise<number>;
  /** Starts a program that outlives the helper. */
  launch(command: string, args: string[]): void;
  alive(pid: number): boolean;
  appRunning(appBin: string): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  platform: NodeJS.Platform;
  /** How long to wait for the gateway and the window to exit. */
  waitMs?: number;
  /** Tests only: runs between the two renames of a swap (an injected failure). */
  beforePlace?(): void;
};

export const resultFile = (dataDir: string) => join(dataDir, "updates", "result.json");
const NOTHING = "아무것도 바뀌지 않았습니다.";
export const WORDS = {
  done: (version: string) => `${versionWith(version, "으로")} 업데이트했습니다.`,
  stillOpen: `앱이 닫히지 않아 설치하지 않았습니다. ${NOTHING} 앱을 다시 열고 업데이트를 눌러 주세요.`,
  changed: `내려받은 파일이 게시된 것과 다릅니다. 설치하지 않았습니다.`,
  failed: "설치 프로그램이 끝까지 실행되지 않았습니다. 지금 있던 앱은 그대로 쓸 수 있습니다. 잠시 뒤 다시 눌러 주세요.",
  space: `저장 공간이 부족해 설치하지 않았습니다. ${NOTHING} 공간을 비운 뒤 다시 눌러 주세요.`,
  layout: `새 판의 파일이 온전하지 않아 설치하지 않았습니다. ${NOTHING}`,
};

class Stop extends Error { readonly detail: string; constructor(message: string, detail = "") { super(message); this.detail = detail; } }

export async function sha256File(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function waitGone(plan: InstallPlan, deps: HelperDeps) {
  const deadline = Date.now() + (deps.waitMs ?? 90_000);
  while (deps.alive(plan.gatewayPid)) { if (Date.now() > deadline) throw new Stop(WORDS.stillOpen, "gateway still running"); await deps.sleep(250); }
  while (await deps.appRunning(plan.appBin)) { if (Date.now() > deadline) throw new Stop(WORDS.stillOpen, "app still running"); await deps.sleep(250); }
}

/**
 * Swap `fresh` into `target` by rename; the old one becomes `backup` (an older backup is dropped only after).
 * If the new one cannot be put in place, the old one is renamed back before the failure is reported; a helper
 * killed between the two renames is repaired at the next helper start (recoverInterrupted).
 */
function swap(target: string, fresh: string, backup: string, deps: HelperDeps) {
  const older = `${backup}.older`;
  rmSync(older, { recursive: true, force: true });
  if (existsSync(backup)) renameSync(backup, older);
  renameSync(target, backup);
  try { deps.beforePlace?.(); renameSync(fresh, target); }
  catch (error) { renameSync(backup, target); if (existsSync(older)) renameSync(older, backup); throw error; }
  rmSync(older, { recursive: true, force: true });
}

/** Where a kind keeps the app it is replacing while the swap runs. */
export function backupOf(plan: Pick<InstallPlan, "kind" | "target">) {
  if (plan.kind === "dmg") return join(dirname(plan.target), `.${basename(plan.target)}.previous`);
  if (plan.kind === "user-folder" || plan.kind === "appimage") return `${plan.target}.previous`;
  return null;
}
/** An earlier helper stopped between the two renames: the app is missing and its backup is there — put it back. */
export function recoverInterrupted(plan: Pick<InstallPlan, "kind" | "target">, log: (line: string) => void) {
  const backup = backupOf(plan);
  if (!backup || existsSync(plan.target) || !existsSync(backup)) return false;
  renameSync(backup, plan.target);
  const older = `${backup}.older`;
  if (existsSync(older)) renameSync(older, backup);
  log(`recovered ${plan.target} from ${backup} (an earlier install stopped half-way)`);
  return true;
}
export const HDIUTIL = "/usr/bin/hdiutil", DITTO = "/usr/bin/ditto";

/** The top-level files of a user folder that are the person's, not the package's: kept across the swap. */
const KEEP_IN_FOLDER = ["node", "WORKBENCH-INSTALL.json", "LICENSE"];
export const PACMAN_PREFIX = "usr/lib/achmage-workbench/";

async function userFolder(plan: InstallPlan, deps: HelperDeps) {
  const root = plan.target, fresh = `${root}.update-new`, backup = `${root}.previous`;
  rmSync(fresh, { recursive: true, force: true });
  try {
    try { await extractPrefix(plan.installer, PACMAN_PREFIX, fresh); }
    catch (error) { throw new Stop((error as NodeJS.ErrnoException).code === "ENOSPC" ? WORDS.space : WORDS.layout, String((error as Error).message)); }
    for (const required of ["achmage-workbench", "host/host.mjs", "host/workbench-service.mjs", "web/index.html"]) if (!existsSync(join(fresh, required))) throw new Stop(WORDS.layout, `missing ${required}`);
    for (const name of KEEP_IN_FOLDER) if (existsSync(join(root, name)) && !existsSync(join(fresh, name))) cpSync(join(root, name), join(fresh, name), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    writeFileSync(join(fresh, "install-kind.json"), `${JSON.stringify({ kind: "user-folder" })}\n`);
    swap(root, fresh, backup, deps);
    deps.log(`swapped ${root}; previous kept at ${backup}`);
  } finally { rmSync(fresh, { recursive: true, force: true }); }
  if (plan.restartUnit) {
    const code = await deps.run(plan.systemctl || "/usr/bin/systemctl", ["--user", "restart", plan.restartUnit], { timeoutMs: 60_000 });
    deps.log(`systemctl --user restart ${plan.restartUnit}: ${code}`);
  }
}

async function appImage(plan: InstallPlan, deps: HelperDeps) {
  const fresh = `${plan.target}.update-new`, backup = `${plan.target}.previous`;
  try {
    copyFileSync(plan.installer, fresh);
    chmodSync(fresh, 0o755);
    if (await sha256File(fresh) !== plan.sha256) throw new Stop(WORDS.changed, "copy differs");
    swap(plan.target, fresh, backup, deps);
    rmSync(backup, { force: true });
  } catch (error) {
    rmSync(fresh, { force: true });
    if ((error as NodeJS.ErrnoException).code === "ENOSPC") throw new Stop(WORDS.space);
    throw error;
  }
  deps.log(`replaced ${plan.target}`);
}

async function dmg(plan: InstallPlan, deps: HelperDeps) {
  const mount = join(dirname(plan.installer), "mount");
  rmSync(mount, { recursive: true, force: true }); mkdirSync(mount, { recursive: true });
  const attached = await deps.run(HDIUTIL, ["attach", plan.installer, "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mount], { timeoutMs: 120_000 });
  if (attached !== 0) throw new Stop(WORDS.failed, `hdiutil attach ${attached}`);
  const name = basename(plan.target), parent = dirname(plan.target);
  const fresh = join(parent, `.${name}.update-new`), backup = join(parent, `.${name}.previous`);
  try {
    const source = join(mount, name);
    if (!existsSync(join(source, "Contents/MacOS"))) throw new Stop(WORDS.layout, "no app in the image");
    rmSync(fresh, { recursive: true, force: true });
    const copied = await deps.run(DITTO, [source, fresh], { timeoutMs: 600_000 });
    if (copied !== 0) throw new Stop(WORDS.failed, `ditto ${copied}`);
    swap(plan.target, fresh, backup, deps);
    rmSync(backup, { recursive: true, force: true });
  } finally {
    rmSync(fresh, { recursive: true, force: true });
    await deps.run(HDIUTIL, ["detach", mount, "-quiet"], { timeoutMs: 60_000 });
  }
}

/** Windows NSIS: the installer's own silent update path, as the person (its pre-install hook calls `prepare-update`). */
export const nsisArgs = () => ["/S", "/UPDATE"];

async function nsis(plan: InstallPlan, deps: HelperDeps) {
  const code = await deps.run(plan.installer, nsisArgs(), { timeoutMs: 30 * 60_000 });
  deps.log(`setup exit ${code}`);
  if (code !== 0) throw new Stop(WORDS.failed, `exit ${code}`);
}

export async function runInstall(plan: InstallPlan, deps: HelperDeps): Promise<InstallResult> {
  const at = () => Date.now();
  const result = (ok: boolean, message: string, detail?: string): InstallResult => ({ ok, version: plan.version, from: plan.from, kind: plan.kind, message, at: at(), ...(detail ? { detail } : {}) });
  let outcome: InstallResult;
  try {
    if (!["nsis", "dmg", "appimage", "user-folder"].includes(plan.kind)) throw new Stop(WORDS.failed, `not installed in place: ${plan.kind}`);
    recoverInterrupted(plan, deps.log);
    await waitGone(plan, deps);
    if (statSync(plan.installer).size !== plan.size || await sha256File(plan.installer) !== plan.sha256) throw new Stop(WORDS.changed, "installer changed after download");
    if (plan.kind === "user-folder") await userFolder(plan, deps);
    else if (plan.kind === "appimage") await appImage(plan, deps);
    else if (plan.kind === "dmg") await dmg(plan, deps);
    else await nsis(plan, deps);
    outcome = result(true, WORDS.done(plan.version));
  } catch (error) {
    const stop = error instanceof Stop ? error : null;
    outcome = result(false, stop?.message ?? WORDS.failed, stop?.detail || (error instanceof Error ? error.message : String(error)));
  }
  writeResult(plan.dataDir, outcome);
  deps.log(`result ${JSON.stringify(outcome)}`);
  // The app starts again either way: the new one, or the one that was there.
  const [command, ...args] = plan.relaunch;
  if (command) try { deps.launch(command, args); } catch (error) { deps.log(`relaunch failed: ${String(error)}`); }
  return outcome;
}

export function writeResult(dataDir: string, outcome: InstallResult) {
  const file = resultFile(dataDir);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.tmp`, JSON.stringify(outcome), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

/** The environment the app is started with again: none of the gateway's own launch variables. */
export function relaunchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("WORKBENCH_") && key !== "WORKBENCH_DATA_DIR" && key !== "WORKBENCH_UPDATE_SOURCE") continue;
    if ((key.startsWith("NODE_") && key !== "NODE_ENV") || key.startsWith("LD_") || key.startsWith("DYLD_") || ["APPDIR", "APPIMAGE", "ARGV0", "OWD"].includes(key)) continue;
    out[key] = value;
  }
  return out;
}

/** Real effects, for the helper process. */
export function systemDeps(log: (line: string) => void, platform: NodeJS.Platform = process.platform): HelperDeps {
  return {
    platform, log,
    run: (command, args, options) => new Promise(resolve => {
      const child = spawn(command, args, { stdio: "ignore", windowsHide: true, env: relaunchEnv(process.env) });
      const timer = options?.timeoutMs ? setTimeout(() => child.kill(), options.timeoutMs) : null;
      child.once("error", () => { if (timer) clearTimeout(timer); resolve(127); });
      child.once("exit", code => { if (timer) clearTimeout(timer); resolve(code ?? 1); });
    }),
    launch: (command, args) => { const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: false, env: relaunchEnv(guiEnvironment(process.env)) }); child.on("error", () => undefined); child.unref(); },
    alive: pid => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } },
    appRunning: appBin => appRunning(appBin, platform),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  };
}

/** Whether any process runs `appBin` (the window, a session window, its gateway launcher). */
export async function appRunning(appBin: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (platform === "linux") {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
      try { if (readlinkSync(`/proc/${entry}/exe`).replace(/ \(deleted\)$/, "") === appBin) return true; } catch { /* gone or not ours */ }
    }
    return false;
  }
  const output = await new Promise<string>(resolve => {
    const [command, args] = platform === "win32"
      ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-Process | Where-Object { $_.Path } | ForEach-Object { $_.Path }"]] as const
      : ["ps", ["-axo", "comm="]] as const;
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let text = ""; child.stdout.on("data", (chunk: Buffer) => { text += chunk.toString(); });
    child.once("error", () => resolve("")); child.once("close", () => resolve(text));
  });
  const wanted = platform === "win32" ? appBin.toLowerCase() : appBin;
  return output.split(/\r?\n/).some(line => (platform === "win32" ? line.trim().toLowerCase() : line.trim()) === wanted);
}

/** One helper at a time per data folder. */
export function takeLock(dataDir: string): (() => void) | null {
  const file = join(dataDir, "updates", "install.lock");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  try { closeSync(openSync(file, "wx", 0o600)); }
  catch {
    // A lock older than an hour is from a helper that did not finish.
    try { if (Date.now() - statSync(file).mtimeMs < 3_600_000) return null; rmSync(file, { force: true }); closeSync(openSync(file, "wx", 0o600)); } catch { return null; }
  }
  return () => rmSync(file, { force: true });
}

export function readPlan(file: string): InstallPlan { return JSON.parse(readFileSync(file, "utf8")) as InstallPlan; }
