import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentBrowserInstall } from "@workbench/contracts";
import { BrowserInstaller, PLAYWRIGHT_CLI, browserBuild, browserPaths, installedOnDisk, type InstallStep } from "./browse-install.ts";

// Installing the agent browser as a state machine, with a stand-in installer (no download).

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeInstall(fail?: "cli" | "browser" | "verify") {
  let done = false;
  const seen: AgentBrowserInstall[] = [];
  const step = (stage: InstallStep["stage"]): InstallStep => ({
    stage,
    message: `${stage}…`,
    run: async (report) => {
      report(`${stage} 50%`, 50);
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (fail === stage) throw new Error(`${stage} 실패`);
      if (stage === "verify") done = true;
    },
  });
  const installer = new BrowserInstaller({ ready: () => done, steps: () => [step("cli"), step("browser"), step("verify")], onChange: (state) => seen.push(state) });
  return { installer, seen };
}

describe("agent browser install", () => {
  it("goes missing → cli → browser → verify → ready, with progress on the way", async () => {
    const { installer, seen } = fakeInstall();
    expect(installer.state.state).toBe("missing");
    await installer.install();
    expect(installer.state).toMatchObject({ state: "ready", stage: null, cliVersion: PLAYWRIGHT_CLI.version, browserVersion: PLAYWRIGHT_CLI.browser.version });
    const stages = seen.filter((state) => state.state === "installing").map((state) => state.stage);
    expect([...new Set(stages)]).toEqual(["cli", "browser", "verify"]);
    expect(seen.some((state) => state.percent === 50 && state.message === "browser 50%")).toBe(true);
  });

  it("stops at the failing step with its reason, and can be tried again", async () => {
    const { installer } = fakeInstall("browser");
    await installer.install();
    expect(installer.state.state).toBe("error");
    expect(installer.state.message).toContain("browser 실패");
    expect(installer.state.cliVersion).toBeNull();
  });

  it("never runs twice at once", async () => {
    const { installer, seen } = fakeInstall();
    const first = installer.install();
    const second = installer.install();
    expect(second).toBe(first);
    await first;
    expect(seen.filter((state) => state.state === "installing" && state.stage === "cli" && state.percent === null)).toHaveLength(1);
  });

  it("counts as installed only with the pinned versions recorded and both files present", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "wb-browse-install-"));
    dirs.push(dataDir);
    const paths = browserPaths(dataDir);
    expect(installedOnDisk(paths)).toBe(false);
    mkdirSync(join(paths.cliJs, ".."), { recursive: true });
    writeFileSync(paths.cliJs, "");
    mkdirSync(join(paths.chrome, ".."), { recursive: true });
    writeFileSync(paths.chrome, "");
    writeFileSync(paths.record, JSON.stringify({ cli: "0.0.1", browser: PLAYWRIGHT_CLI.browser.version }));
    expect(installedOnDisk(paths)).toBe(false);
    writeFileSync(paths.record, JSON.stringify({ cli: PLAYWRIGHT_CLI.version, browser: PLAYWRIGHT_CLI.browser.version }));
    expect(installedOnDisk(paths)).toBe(true);
    // Everything lives under the gateway's data folder.
    for (const path of [paths.cli, paths.browsers, paths.profile, paths.bin, paths.spool]) expect(path.startsWith(join(dataDir, "agent-browser"))).toBe(true);
  });
});

describe("the agent browser on every OS", () => {
  it("knows the Chromium executable and its pinned hash for Linux, Windows and both Macs", () => {
    expect(browserBuild("linux", "x64")?.path).toBe("chrome-linux64/chrome");
    expect(browserBuild("win32", "x64")?.path).toBe("chrome-win64/chrome.exe");
    expect(browserBuild("darwin", "arm64")?.path).toContain("Google Chrome for Testing.app/Contents/MacOS/");
    expect(browserBuild("darwin", "x64")?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(browserBuild("linux", "arm64")).toBeNull();
  });
});
