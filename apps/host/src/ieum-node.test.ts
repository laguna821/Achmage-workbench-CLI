import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IeumOffice, ieumAppEnvironment, type IeumInstall } from "./ieumoffice.ts";
import { installToolWrappers } from "./tool-bin.ts";

afterEach(() => vi.unstubAllEnvs());

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wb-ieum-node-"));
  const script = join(root, "original CLI.cjs"), app = join(root, "legacy app");
  writeFileSync(app, "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  writeFileSync(script, `if (process.argv.includes('--version')) console.log('IeumOffice 0.12.7'); else console.log(JSON.stringify({status:'ok',detail:{runtime:process.execPath,electron:process.versions.electron??null,runAsNode:process.env.ELECTRON_RUN_AS_NODE??null,exportApp:process.env.GENOFFICE_APP_BIN??null,roots:process.env.GENOFFICE_ALLOWED_ROOTS??null,args:process.argv.slice(2)}}));`);
  const install: IeumInstall = { script, app, launcher: script, bundled: true };
  return { root, install };
}

describe("Ieum CLI shared Node execution", () => {
  it("binds native app, settings and control to the same profile", async () => {
    const { root, install } = fixture(), app = join(root, "Workbench native");
    vi.stubEnv("WORKBENCH_APP_BIN", app);
    const office = new IeumOffice(install, { dataDir: root });
    expect(office.appWrapper).toBe(app);
    expect(ieumAppEnvironment(root, office.appWrapper)).toEqual({ GENOFFICE_APP_BIN: app, WORKBENCH_DATA_DIR: root, GENOFFICE_USER_DATA: join(root, "office"), GENOFFICE_AI_SETTINGS: join(root, "office/ai-settings.json") });
    expect((await office.run(["info", "synthetic.docx"], [root])).detail).toMatchObject({ exportApp: app, runtime: process.execPath, electron: null });
    vi.stubEnv("PATH", process.env.PATH ?? "");
    installToolWrappers(root, { kordoc: null, ieum: install, ieumAppWrapper: office.appWrapper });
    const wrapper = readFileSync(join(root, "bin/ieumoffice"), "utf8");
    expect(wrapper).toContain("GENOFFICE_AI_SETTINGS="); expect(wrapper).toContain("WORKBENCH_DATA_DIR=");
  });
  it("runs gateway version and commands on Node while keeping legacy export separate", async () => {
    const { root, install } = fixture();
    vi.stubEnv("ELECTRON_RUN_AS_NODE", "1");
    const office = new IeumOffice(install);
    expect(await office.version()).toBe("0.12.7");
    const result = await office.run(["info", "synthetic.docx"], [root]);
    expect(result.detail).toMatchObject({ runtime: process.execPath, electron: null, runAsNode: null, exportApp: install.app, roots: root, args: ["info", "synthetic.docx", "--json"] });
  });

  it.skipIf(process.platform === "win32")("launches engine wrapper on Node and unsets inherited Electron mode", () => {
    const { root, install } = fixture();
    vi.stubEnv("PATH", process.env.PATH ?? "");
    vi.stubEnv("ELECTRON_RUN_AS_NODE", "1");
    const exportApp = join(root, "explicit render service");
    installToolWrappers(root, { kordoc: null, ieum: install, ieumAppWrapper: exportApp });
    const wrapper = join(root, "bin", "ieumoffice");
    expect(readFileSync(wrapper, "utf8")).toContain("unset ELECTRON_RUN_AS_NODE");
    const result = JSON.parse(execFileSync(wrapper, ["info", "한글 file.docx"], { encoding: "utf8" }));
    expect(result.detail).toMatchObject({ runtime: process.execPath, electron: null, runAsNode: null, exportApp, args: ["info", "한글 file.docx"] });
  });
});
