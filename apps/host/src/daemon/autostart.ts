import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unit = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$")}"`;
const ps = (s: string) => `'${s.replace(/'/g, "''")}'`;
const powershell = (script: string) => run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 15_000 });
export type AutostartStatus = { enabled: boolean; supported: boolean; label: string };

/** Per-user login start only. Disabling never terminates the currently running service. */
export class HostAutostart {
  private readonly dir: string;
  private readonly id: string;
  private readonly launcher: string;
  private readonly cli: string;
  private readonly runner: string | undefined;
  constructor(dataDir: string, main = process.argv[1] ?? "") {
    this.dir = resolve(dataDir);
    this.id = `kr.achmage.workbench.${createHash("sha256").update(this.dir).digest("hex").slice(0, 12)}`;
    this.launcher = join(this.dir, "login-start.mjs");
    this.cli = main.endsWith(".ts") ? join(dirname(main), "daemon/cli.ts") : join(dirname(main), "workbench-service.mjs");
    this.runner = process.platform === "linux" ? process.env.WORKBENCH_HOST_RUNNER : undefined;
  }
  private file() {
    return process.platform === "darwin" ? join(homedir(), "Library/LaunchAgents", `${this.id}.plist`) : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd/user", `${this.id}.service`);
  }
  async status(): Promise<AutostartStatus> {
    const supported = (!process.env.APPIMAGE || !!this.runner && existsSync(this.runner)) && ["linux", "darwin", "win32"].includes(process.platform) && existsSync(this.cli);
    let enabled = false;
    if (supported) try {
      if (process.platform === "linux") { const result = await run("systemctl", ["--user", "is-enabled", `${this.id}.service`], { timeout: 5000 }); enabled = result.stdout.trim() === "enabled"; }
      else if (process.platform === "darwin") enabled = existsSync(this.file());
      else { const result = await powershell(`$t=Get-ScheduledTask -TaskName ${ps(this.id)} -ErrorAction SilentlyContinue; if($t -and $t.Settings.Enabled){'enabled'}`); enabled = result.stdout.trim() === "enabled"; }
    } catch { /* Not registered or this login has no service manager. */ }
    return { enabled, supported, label: "이 기기 로그인 시 백그라운드 작업 시작" };
  }
  /** Preserve an existing opt-in across an install/runtime path change; never enable by default. */
  async refreshEnabled() { if ((await this.status()).enabled) await this.setEnabled(true); }
  async setEnabled(enabled: boolean): Promise<AutostartStatus> {
    if (enabled && process.env.APPIMAGE && (!this.runner || !existsSync(this.runner))) throw Error("AppImage의 백그라운드 실행 파일을 찾지 못했습니다. 앱을 다시 실행해 주세요.");
    if (!existsSync(this.cli)) throw Error("설치본의 백그라운드 실행기를 찾지 못했습니다.");
    const file = this.file();
    if (enabled) {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const environment: Record<string, string> = { WORKBENCH_DATA_DIR: this.dir, WORKBENCH_IEUM_BOOTSTRAP: "0" };
      for (const key of (this.runner ? ["PATH", "WORKBENCH_HOST_RUNNER", "WORKBENCH_HOST_ID", "WORKBENCH_HOST_LABEL"] : ["PATH", "WORKBENCH_WEB_DIR", "WORKBENCH_RESOURCES_DIR", "WORKBENCH_PTY_BIN", "WORKBENCH_SECRET_BIN", "WORKBENCH_APP_BIN", "WORKBENCH_HOST_ID", "WORKBENCH_HOST_LABEL"]))
        if (process.env[key]) environment[key] = process.env[key]!;
      // Only paths and host identity are captured; no credentials or provider auth are copied.
      if (!this.runner) writeFileSync(this.launcher, `Object.assign(process.env, ${JSON.stringify(environment)});\nprocess.argv[2] = "start";\nawait import(${JSON.stringify(pathToFileURL(resolve(this.cli)).href)});\n`, { mode: 0o600 });
      if (process.platform === "linux") {
        mkdirSync(dirname(file), { recursive: true });
        const environmentLines = this.runner ? Object.entries(environment).map(([key, value]) => `Environment=${JSON.stringify(`${key}=${value}`).replace(/%/g, "%%")}\n`).join("") : "";
        const start = this.runner ? `${unit(this.runner)} --host-service start` : `${unit(process.execPath)} ${unit(this.launcher)}`;
        writeFileSync(file, `[Unit]\nDescription=Achmage Workbench background tasks\n[Service]\nType=oneshot\nRemainAfterExit=yes\n${environmentLines}ExecStart=${start}\n[Install]\nWantedBy=default.target\n`, { mode: 0o600 });
        await run("systemctl", ["--user", "daemon-reload"], { timeout: 5000 });
        await run("systemctl", ["--user", "enable", `${this.id}.service`], { timeout: 5000 });
      } else if (process.platform === "darwin") {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${xml(this.id)}</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(this.launcher)}</string></array><key>RunAtLoad</key><true/><key>AbandonProcessGroup</key><true/></dict></plist>`, { mode: 0o600 });
        // Loaded by launchd on the next login. The current host is already running.
      } else if (process.platform === "win32") {
        const argument = `"${this.launcher}"`;
        await powershell(`$ErrorActionPreference='Stop'; $who=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name; $action=New-ScheduledTaskAction -Execute ${ps(process.execPath)} -Argument ${ps(argument)}; $trigger=New-ScheduledTaskTrigger -AtLogOn -User $who; $principal=New-ScheduledTaskPrincipal -UserId $who -LogonType Interactive -RunLevel Limited; $settings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries; Register-ScheduledTask -TaskName ${ps(this.id)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null`);
      } else throw Error("이 OS는 로그인 자동 시작을 지원하지 않습니다.");
    } else {
      if (process.platform === "linux") {
        if (existsSync(file)) await run("systemctl", ["--user", "disable", `${this.id}.service`], { timeout: 5000 });
        rmSync(file, { force: true }); await run("systemctl", ["--user", "daemon-reload"], { timeout: 5000 });
      } else if (process.platform === "darwin") rmSync(file, { force: true });
      else if (process.platform === "win32") await powershell(`Get-ScheduledTask -TaskName ${ps(this.id)} -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false`);
      rmSync(this.launcher, { force: true });
    }
    return this.status();
  }
}
