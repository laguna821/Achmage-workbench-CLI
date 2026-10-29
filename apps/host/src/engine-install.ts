import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { arch, homedir, platform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { EngineInstallState, Provider, ProviderStatus } from "@workbench/contracts";
import { setManagedEnginesDir } from "./binaries.ts";
import { launchFor, realFs, type EngineName } from "./engine-locate.ts";
import { npmCli } from "./npm.ts";

const run = promisify(execFile);

// "설치": a missing engine installed with one click, for this user only, into the app's data folder.
// The app's own Node runs the npm shipped beside it (the Arch package uses the system's), so no
// admin rights, no system Node and no terminal are needed. npm checks every package against the
// registry's integrity hash; install scripts do not run (the native engine is taken from its
// platform package, where Claude Code's own install script would copy it from). A finished install
// is moved into place in one step, so a running engine is never half replaced.

export const ENGINE_PACKAGES: Record<EngineName, string> = { codex: "@openai/codex", claude: "@anthropic-ai/claude-code" };

/** The file an installed package is started from (resolved to its native engine by engine-locate). */
const ENTRY: Record<EngineName, string[]> = {
  codex: ["node_modules", "@openai", "codex", "bin", "codex.js"],
  claude: ["node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"],
};

/** What npm said went wrong, in plain Korean (the engine's own words are not needed to act on it). */
export function installError(output: string, folder: string): string {
  const code = /npm (?:error|ERR!) code (\S+)/.exec(output)?.[1] ?? /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOSPC|EACCES|EPERM|EINTEGRITY)\b/.exec(output)?.[1] ?? "";
  if (["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "ERR_SOCKET_TIMEOUT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "SELF_SIGNED_CERT_IN_CHAIN"].includes(code)) {
    return "인터넷에 연결하지 못했습니다. 연결을 확인한 뒤 다시 눌러 주세요.";
  }
  if (code === "ENOSPC") return "디스크 공간이 부족합니다. 1GB 정도 비운 뒤 다시 눌러 주세요.";
  if (code === "EACCES" || code === "EPERM" || code === "EBUSY") return `설치 폴더에 쓰지 못했습니다(${folder}). 백신 프로그램이 막았는지 확인한 뒤 다시 눌러 주세요.`;
  if (code === "EINTEGRITY") return "내려받은 파일이 배포본과 달라 설치하지 않았습니다. 다시 눌러 주세요.";
  if (code === "E404" || code === "ETARGET") return "배포 저장소에서 엔진을 찾지 못했습니다. 잠시 뒤 다시 눌러 주세요.";
  const line = output
    .split(/\r?\n/)
    .map((entry) => entry.replace(/^npm (error|ERR!)\s*/, "").trim())
    .filter((entry) => entry && !/^(A complete log|code |errno |syscall )/.test(entry))
    .at(-1);
  return `설치하지 못했습니다${line ? `: ${line.slice(0, 200)}` : "."}`;
}

/** Bytes under a folder (to show how far the download is). */
function folderBytes(dir: string, limit = 20_000): number {
  let total = 0;
  let seen = 0;
  const walk = (path: string) => {
    let names: string[];
    try {
      names = readdirSync(path);
    } catch {
      return;
    }
    for (const name of names) {
      if (++seen > limit) return;
      const child = join(path, name);
      try {
        const stat = statSync(child);
        if (stat.isDirectory()) walk(child);
        else total += stat.size;
      } catch {
        // Being written.
      }
    }
  };
  walk(dir);
  return total;
}

/** The size the packages unpack to, from the registry (best effort, for the progress bar). */
async function expectedBytes(engine: EngineName): Promise<{ version: string | null; bytes: number | null }> {
  const registry = (process.env.npm_config_registry || "https://registry.npmjs.org/").replace(/\/?$/, "/");
  const meta = async (name: string, version: string) => {
    const response = await fetch(`${registry}${name.replace("/", "%2f")}/${version}`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(String(response.status));
    return (await response.json()) as { version?: string; dist?: { unpackedSize?: number }; optionalDependencies?: Record<string, string> };
  };
  try {
    const main = await meta(ENGINE_PACKAGES[engine], "latest");
    const version = main.version ?? null;
    let bytes = main.dist?.unpackedSize ?? 0;
    const suffix = `${platform()}-${arch()}`;
    const name = Object.keys(main.optionalDependencies ?? {}).find((entry) => entry.endsWith(`-${suffix}`));
    const spec = name ? main.optionalDependencies![name]! : null;
    if (spec) {
      // Codex names its platform builds as versions of itself ("npm:@openai/codex@0.165.0-linux-x64").
      const alias = /^npm:(.+)@([^@]+)$/.exec(spec);
      const platformMeta = await meta(alias ? alias[1]! : name!, alias ? alias[2]! : spec);
      bytes += platformMeta.dist?.unpackedSize ?? 0;
    }
    return { version, bytes: bytes || null };
  } catch {
    return { version: null, bytes: null };
  }
}

type StateListener = (engine: EngineName, state: EngineInstallState | null) => void;

export class EngineInstaller {
  readonly dir: string;
  private readonly states = new Map<EngineName, EngineInstallState | null>();
  private readonly running = new Map<EngineName, Promise<void>>();
  private readonly onChange: StateListener;

  constructor(options: { dataDir: string; onChange: StateListener }) {
    this.dir = join(options.dataDir, "engines");
    this.onChange = options.onChange;
    setManagedEnginesDir(this.dir);
  }

  /** npm's script, looked up once (every status the screen gets says whether "설치" can work). */
  private npm: string | null | undefined;

  /** Whether one click can install engines here (an npm to run). */
  canInstall() {
    if (this.npm === undefined) this.npm = npmCli();
    return Boolean(this.npm);
  }

  state(engine: EngineName) {
    return this.states.get(engine) ?? null;
  }

  /** What the status of an engine says about installing it. */
  decorate(status: ProviderStatus): ProviderStatus {
    const engine = status.provider as EngineName;
    return { ...status, canInstall: this.canInstall(), install: this.state(engine) };
  }

  private set(engine: EngineName, patch: Partial<EngineInstallState> | null) {
    const state = patch === null ? null : ({ state: "installing", stage: null, percent: null, message: null, version: null, ...this.state(engine), ...patch, at: Date.now() } as EngineInstallState);
    this.states.set(engine, state);
    this.onChange(engine, state);
  }

  /** Install the latest release of an engine for this user (never twice at once); resolves when done. */
  install(engine: Provider): Promise<void> {
    const name = engine as EngineName;
    const current = this.running.get(name);
    if (current) return current;
    const job = this.run(name).finally(() => this.running.delete(name));
    this.running.set(name, job);
    return job;
  }

  private async run(engine: EngineName) {
    const label = engine === "codex" ? "Codex" : "Claude Code";
    this.set(engine, { state: "installing", stage: "prepare", percent: null, message: `${label} 설치를 준비하는 중…`, version: null });
    const cli = (this.npm = npmCli());
    if (!cli) {
      this.set(engine, { state: "failed", stage: null, message: "앱에 들어 있는 npm을 찾지 못했습니다. 앱을 다시 설치해 주세요." });
      return;
    }
    const root = join(this.dir, engine);
    let stage: string | null = null;
    try {
      mkdirSync(root, { recursive: true });
      // Staged next to the install so the final move is a rename on the same disk.
      stage = mkdtempSync(join(root, ".staging-"));
      writeFileSync(join(stage, "package.json"), JSON.stringify({ name: "workbench-engine", private: true }));
      const expected = await expectedBytes(engine);
      const size = expected.bytes ? ` (약 ${Math.round(expected.bytes / 1_048_576)}MB)` : "";
      this.set(engine, { stage: "download", percent: expected.bytes ? 0 : null, message: `${label}${expected.version ? ` ${expected.version}` : ""} 내려받는 중${size}…`, version: expected.version });
      const output = await this.npmInstall(engine, cli, stage, expected.bytes, label, expected.version);
      if (output.code !== 0) throw new Error(installError(output.text, root));

      this.set(engine, { stage: "verify", percent: null, message: "설치한 엔진을 확인하는 중…" });
      const entry = join(stage, ...ENTRY[engine]);
      const ctx = { platform: platform(), arch: arch(), env: process.env, home: homedir(), fs: realFs, node: process.execPath };
      // npm packages start their native engine; one that only has a launcher fails the check below.
      const launch = existsSync(entry) ? launchFor(entry, "managed", ctx) : null;
      if (!launch) throw new Error(`이 컴퓨터(${platform()} ${arch()})용 ${label} 실행 파일을 받지 못했습니다. 다시 눌러 주세요.`);
      let version: string | null = null;
      try {
        const { stdout } = await run(launch.command, [...launch.args, "--version"], { timeout: 30_000, windowsHide: true, env: { ...process.env, ...launch.env } });
        version = stdout.trim().split(/\s+/).find((token) => /^\d+\.\d+/.test(token)) ?? null;
      } catch (error) {
        throw new Error(`설치한 엔진이 실행되지 않습니다: ${error instanceof Error ? error.message.split("\n")[0]!.slice(0, 160) : String(error)}`);
      }
      if (!version) throw new Error("설치한 엔진이 버전을 알려 주지 않습니다.");

      // Into place: <engines>/<engine>/<version>, then the record that names it.
      let final = join(root, version);
      if (existsSync(final)) {
        try {
          rmSync(final, { recursive: true, force: true });
        } catch {
          // In use (Windows keeps a running program's files): keep it, use a fresh folder.
          final = join(root, `${version}-${Date.now()}`);
        }
      }
      renameSync(stage, final);
      stage = null;
      const record = join(root, "current.json");
      writeFileSync(`${record}.tmp`, JSON.stringify({ version, entry: join(final, ...ENTRY[engine]), installedAt: new Date().toISOString() }, null, 2));
      renameSync(`${record}.tmp`, record);
      // Older installs go when nothing holds them any more.
      for (const name of readdirSync(root)) {
        const path = join(root, name);
        if (path === final || name === "current.json" || name.startsWith(".")) continue;
        try {
          rmSync(path, { recursive: true, force: true });
        } catch {
          // Still running: removed after a later install.
        }
      }
      this.set(engine, { state: "done", stage: null, percent: 100, message: `${label} ${version} 설치를 마쳤습니다.`, version });
    } catch (error) {
      this.set(engine, { state: "failed", stage: null, percent: null, message: error instanceof Error ? error.message : String(error) });
    } finally {
      if (stage) rmSync(stage, { recursive: true, force: true });
      rmSync(join(this.dir, ".npm-cache"), { recursive: true, force: true });
    }
  }

  /** npm into the staging folder, reporting how much has arrived. */
  private npmInstall(engine: EngineName, cli: string, stage: string, expected: number | null, label: string, version: string | null): Promise<{ code: number; text: string }> {
    return new Promise((resolve) => {
      const args = [
        cli,
        "install",
        `${ENGINE_PACKAGES[engine]}@latest`,
        "--prefix",
        stage,
        "--no-audit",
        "--no-fund",
        "--no-package-lock",
        "--ignore-scripts",
        "--no-update-notifier",
        "--loglevel=error",
        // Its own cache, removed afterwards: the user's npm cache stays as it was.
        "--cache",
        join(this.dir, ".npm-cache"),
      ];
      const child = spawn(process.execPath, args, {
        cwd: stage,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, NO_UPDATE_NOTIFIER: "1", npm_config_update_notifier: "false", npm_config_fund: "false" },
      });
      let text = "";
      const keep = (chunk: Buffer) => {
        text = (text + chunk.toString("utf8")).slice(-6000);
      };
      child.stdout.on("data", keep);
      child.stderr.on("data", keep);
      const started = Date.now();
      const tick = setInterval(() => {
        const bytes = folderBytes(join(stage, "node_modules"));
        const seconds = Math.round((Date.now() - started) / 1000);
        const percent = expected ? Math.min(99, Math.round((bytes / expected) * 100)) : null;
        this.set(engine, { percent, message: `${label}${version ? ` ${version}` : ""} 내려받는 중… ${Math.round(bytes / 1_048_576)}MB${expected ? ` / ${Math.round(expected / 1_048_576)}MB` : ""} · ${seconds}초` });
      }, 1000);
      // Twenty minutes even on a slow connection; then it stops with a reason.
      const limit = setTimeout(() => {
        text += "\nnpm error code ETIMEDOUT";
        child.kill();
      }, 20 * 60_000);
      let finished = false;
      const done = (code: number) => {
        if (finished) return;
        finished = true;
        clearInterval(tick);
        clearTimeout(limit);
        resolve({ code, text });
      };
      child.on("error", (error) => {
        text += `\n${error.message}`;
        done(1);
      });
      child.on("exit", (code) => done(code ?? 1));
    });
  }
}
