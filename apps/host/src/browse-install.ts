import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentBrowserInstall } from "@workbench/contracts";

const run = promisify(execFile);

// Installing the agent browser for the current user, into the app data folder only: Microsoft's
// Playwright CLI (https://github.com/microsoft/playwright-cli, Apache-2.0) at a pinned version
// with the two packages it declares, checked against the npm registry's SHA-512, then the
// Chromium build that CLI version names (Chrome for Testing), downloaded by the CLI itself and
// checked against a pinned SHA-256 of its executable. Nothing is installed system-wide.

export const PLAYWRIGHT_CLI = {
  version: "0.1.22",
  packages: [
    {
      name: "@playwright/cli",
      version: "0.1.22",
      tarball: "https://registry.npmjs.org/@playwright/cli/-/cli-0.1.22.tgz",
      integrity: "sha512-6WMkQNM4VEzqMkdr/l60X9Cr7i+tI/arK87IWz2K7pB6j8I2ZJ8KN+1JfhJDLnK+SXnab6Op8xGt4adcGLsyfA==",
    },
    {
      name: "playwright",
      version: "1.64.0-alpha-1790635538000",
      tarball: "https://registry.npmjs.org/playwright/-/playwright-1.64.0-alpha-1790635538000.tgz",
      integrity: "sha512-/5XDUMxpOd/9AojJtWDFIRV3EJZNQ0AwvK69wgt3CPzy8wTgiBG9pX45VfxtqtvIRGwfWzMhrvawNKreG69Snw==",
    },
    {
      name: "playwright-core",
      version: "1.64.0-alpha-1790635538000",
      tarball: "https://registry.npmjs.org/playwright-core/-/playwright-core-1.64.0-alpha-1790635538000.tgz",
      integrity: "sha512-pNwaXirhXMRLaRQs4NQ18EpTdtDoFwyPH9FOaaDC7YXG4hpwE2xmwCic/1srbuExVQC7zT9LJSJpDBAru+Vo9A==",
    },
  ],
  /**
   * The Chromium of playwright-core's browsers.json for this version: Chrome for Testing, whose
   * executable for each platform is checked against its SHA-256 (taken from the same builds on
   * cdn.playwright.dev, builds/cft/155.0.8059.12/<platform>/chrome-<platform>.zip).
   */
  browser: {
    version: "155.0.8059.12",
    folder: "chromium-1247",
    executables: {
      "linux-x64": { path: "chrome-linux64/chrome", sha256: "adf078f8f80eb9e980a07b4418af23b0f4008a83bc5756d5588055bc4d76c5a0" },
      "win32-x64": { path: "chrome-win64/chrome.exe", sha256: "74222067d9e6a3ab417a6b1ba00688baded1c7807bb6ef8d1fdf8b6e74d725b8" },
      "darwin-arm64": {
        path: "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        sha256: "48620458518eae4e6a4dc19dd7ca38285d7fe822bf2589efcbcced4a40d6fc71",
      },
      "darwin-x64": {
        path: "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        sha256: "417d0692fe65c13602258d78f6c819595e02b18554db240556268f95c8b06775",
      },
    } as Record<string, { path: string; sha256: string }>,
  },
} as const;

/** This computer's Chromium executable and its pinned hash, or null where Playwright has none. */
export function browserBuild(platform: NodeJS.Platform = process.platform, arch: string = process.arch) {
  return PLAYWRIGHT_CLI.browser.executables[`${platform}-${arch}`] ?? null;
}

/** Where everything of the agent browser lives (all under the gateway's data folder). */
export function browserPaths(dataDir: string) {
  const root = join(dataDir, "agent-browser");
  return {
    root,
    cli: join(root, "cli"),
    cliJs: join(root, "cli/node_modules/@playwright/cli/playwright-cli.js"),
    browsers: join(root, "browsers"),
    chrome: join(root, "browsers", PLAYWRIGHT_CLI.browser.folder, ...(browserBuild()?.path ?? "chrome-unsupported/chrome").split("/")),
    profile: join(root, "profile"),
    bin: join(root, "bin"),
    spool: join(root, "spool"),
    output: join(root, "output"),
    config: join(root, "cli.config.json"),
    record: join(root, "install.json"),
    threads: join(root, "threads.json"),
    told: join(root, "told.json"),
  };
}

export type BrowserPaths = ReturnType<typeof browserPaths>;

/** One step of the install; `report` updates the message and percent on screen. */
export type InstallStep = { stage: NonNullable<AgentBrowserInstall["stage"]>; message: string; run: (report: (message: string, percent?: number | null) => void) => Promise<void> };

/** Whether the pinned CLI and its verified Chromium are on disk (as the last install recorded them). */
export function installedOnDisk(paths: BrowserPaths): boolean {
  try {
    const record = JSON.parse(readFileSync(paths.record, "utf8")) as { cli?: string; browser?: string };
    return record.cli === PLAYWRIGHT_CLI.version && record.browser === PLAYWRIGHT_CLI.browser.version && existsSync(paths.cliJs) && existsSync(paths.chrome);
  } catch {
    return false;
  }
}

/**
 * The install as a small state machine: missing → installing (cli → browser → verify) → ready,
 * or error with the reason; never two installs at once. `steps` is replaceable for tests.
 */
export class BrowserInstaller {
  private current: AgentBrowserInstall;
  private running: Promise<void> | null = null;
  private readonly onChange: (state: AgentBrowserInstall) => void;
  private readonly steps: () => InstallStep[];
  private readonly ready: () => boolean;

  constructor(options: { ready: () => boolean; steps: () => InstallStep[]; onChange: (state: AgentBrowserInstall) => void }) {
    this.ready = options.ready;
    this.steps = options.steps;
    this.onChange = options.onChange;
    this.current = this.resting();
  }

  private resting(): AgentBrowserInstall {
    const ready = this.ready();
    return {
      state: ready ? "ready" : "missing",
      stage: null,
      message: null,
      percent: null,
      cliVersion: ready ? PLAYWRIGHT_CLI.version : null,
      browserVersion: ready ? PLAYWRIGHT_CLI.browser.version : null,
    };
  }

  get state() {
    return this.current;
  }

  private set(next: AgentBrowserInstall) {
    this.current = next;
    this.onChange(next);
  }

  /** Look at the disk again (an install by another gateway, or files removed). */
  refresh() {
    if (!this.running) this.set(this.resting());
    return this.current;
  }

  /** Start installing unless it is running; resolves when this install ends (ready or error). */
  install(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        for (const step of this.steps()) {
          this.set({ ...this.current, state: "installing", stage: step.stage, message: step.message, percent: null });
          await step.run((message, percent = null) => this.set({ ...this.current, message, percent }));
        }
        if (!this.ready()) throw new Error("설치를 마쳤지만 실행 파일을 찾지 못했습니다.");
        this.set({ ...this.resting(), message: "에이전트 브라우저를 설치했습니다." });
      } catch (error) {
        this.set({ ...this.current, state: "error", stage: null, percent: null, message: `설치하지 못했습니다: ${error instanceof Error ? error.message : String(error)}` });
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }
}

/** `tar`: Windows 10 and later ship bsdtar as System32\tar.exe (found even with a short PATH). */
function tarCommand() {
  if (process.platform !== "win32") return "tar";
  const system = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  return existsSync(system) ? system : "tar";
}

/** Download a file, checking its bytes against an npm `sha512-…` integrity string on the way. */
async function download(url: string, file: string, integrity: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`내려받기 실패(${response.status}): ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (actual !== integrity) throw new Error(`체크섬이 맞지 않아 쓰지 않았습니다: ${url}`);
  writeFileSync(file, bytes);
}

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

/** The real steps: the CLI packages, the browser through the CLI, then the checks and the record. */
export function installSteps(paths: BrowserPaths, finish: () => void): InstallStep[] {
  return [
    {
      stage: "cli",
      message: `Playwright CLI ${PLAYWRIGHT_CLI.version} 내려받는 중…`,
      run: async () => {
        mkdirSync(paths.root, { recursive: true });
        // Staged next to the install so the final move is a rename on the same file system.
        const staging = mkdtempSync(join(paths.root, ".cli-staging-"));
        try {
          for (const pkg of PLAYWRIGHT_CLI.packages) {
            const archive = join(staging, `${pkg.name.replace(/[@/]/g, "_")}.tgz`);
            await download(pkg.tarball, archive, pkg.integrity);
            const target = join(staging, "node_modules", pkg.name);
            mkdirSync(target, { recursive: true });
            // npm tarballs keep everything under package/; no install scripts run.
            await run(tarCommand(), ["-xzf", archive, "-C", target, "--strip-components=1", "--no-same-owner"], { timeout: 120_000, windowsHide: true });
            rmSync(archive, { force: true });
          }
          writeFileSync(join(staging, "package.json"), JSON.stringify({ private: true, dependencies: Object.fromEntries(PLAYWRIGHT_CLI.packages.map((pkg) => [pkg.name, pkg.version])) }, null, 2));
          rmSync(paths.cli, { recursive: true, force: true });
          renameSync(staging, paths.cli);
        } finally {
          rmSync(staging, { recursive: true, force: true });
        }
      },
    },
    {
      stage: "browser",
      message: `Chromium ${PLAYWRIGHT_CLI.browser.version} 내려받는 중…`,
      run: (report) =>
        new Promise<void>((resolve, reject) => {
          // Only the full browser (the window is visible); no headless shell.
          const child = spawn(process.execPath, [paths.cliJs, "install-browser", "chromium", "--no-shell"], {
            cwd: paths.root,
            env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: paths.browsers, NO_UPDATE_NOTIFIER: "1" },
            stdio: ["ignore", "pipe", "pipe"],
          });
          let tail = "";
          const onData = (chunk: Buffer) => {
            const text = chunk.toString("utf8");
            tail = (tail + text).slice(-2000);
            const percent = [...text.matchAll(/(\d+)% of ([\d.]+ ?MiB)/g)].at(-1);
            if (percent) report(`Chromium ${PLAYWRIGHT_CLI.browser.version} 내려받는 중… (${percent[2]!.replace(" ", "")})`, Number(percent[1]));
          };
          child.stdout.on("data", onData);
          child.stderr.on("data", onData);
          child.on("error", reject);
          child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`브라우저를 받지 못했습니다: ${tail.trim().split("\n").at(-1) ?? code}`))));
        }),
    },
    {
      stage: "verify",
      message: "내려받은 브라우저 확인 중…",
      run: async () => {
        const build = browserBuild();
        if (!build) throw new Error(`이 컴퓨터(${process.platform} ${process.arch})용 Chromium은 Playwright가 배포하지 않습니다.`);
        if (!existsSync(paths.chrome)) throw new Error("브라우저 실행 파일이 없습니다.");
        if ((await sha256(paths.chrome)) !== build.sha256) {
          rmSync(join(paths.browsers, PLAYWRIGHT_CLI.browser.folder), { recursive: true, force: true });
          throw new Error("브라우저 실행 파일의 체크섬이 고정값과 달라 지웠습니다.");
        }
        writeFileSync(paths.record, JSON.stringify({ cli: PLAYWRIGHT_CLI.version, browser: PLAYWRIGHT_CLI.browser.version, at: new Date().toISOString() }, null, 2));
        finish();
      },
    },
  ];
}
