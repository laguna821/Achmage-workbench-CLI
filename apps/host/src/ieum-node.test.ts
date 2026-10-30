import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IeumOffice, type IeumInstall } from "./ieumoffice.ts";
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
