// sec-vault round 2, check F2: the resolve guard ("only files under the install load") belongs to the
// bundle that holds the vault's ticket (host.mjs). The job bundles never hold it, and the on-device
// voice worker must load its runtime from <data>/voice/runtime-*/node_modules — outside the install.
import { execFileSync, fork } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getLocalSpeechModelDir } from "../../../vendor/paseo/voice-server/src/server/speech/providers/local/models.ts";
import { engineFiles, getLocalSttEngine } from "../../../vendor/paseo/voice-server/src/server/speech/providers/local/sherpa/model-catalog.ts";
const { RESOLVE_GUARD_BANNER, TICKET_HOLDERS } = await import(new URL("../../../scripts/host-resolve-guard.mjs", import.meta.url).href) as { RESOLVE_GUARD_BANNER: string; TICKET_HOLDERS: string[] };

const root = resolve(import.meta.dirname, "../../..");
const work = mkdtempSync(join(tmpdir(), "wb-resolve-guard-"));
const install = join(work, "install"), hostDir = join(install, "host");
const runtimeNodeModules = join(work, "data", "voice", "runtime-x", "node_modules");
const platformPackage = `sherpa-onnx-${process.platform === "win32" ? "win" : process.platform}-${process.arch}`;
const marker = "registerHooks as __rh";

function plantPackage(nodeModules: string, name: string, body: string) {
  mkdirSync(join(nodeModules, name), { recursive: true });
  writeFileSync(join(nodeModules, name, "package.json"), JSON.stringify({ name, version: "0.0.0", main: "index.js" }));
  writeFileSync(join(nodeModules, name, "index.js"), body);
}

beforeAll(() => {
  // A clean output folder, exactly as the release builds it.
  execFileSync(process.execPath, [join(root, "scripts/build-host.mjs")], { cwd: root, env: { ...process.env, WORKBENCH_HOST_BUILD_DIR: hostDir }, stdio: "ignore" });
  // The person's downloaded voice runtime, as voice-models.ts lays it out (fake: it only leaves a mark).
  plantPackage(runtimeNodeModules, "sherpa-onnx-node", `require("node:fs").writeFileSync(${JSON.stringify(join(work, "voice-loaded"))}, "yes");\nmodule.exports = { OfflineRecognizer: class { constructor() { throw new Error("fake recognizer reached"); } } };\n`);
  plantPackage(runtimeNodeModules, platformPackage, "module.exports = {};\n");
  // A package planted ABOVE the install (where Node's parent-folder walk would find it).
  plantPackage(join(work, "node_modules"), "planted-above", `require("node:fs").writeFileSync(${JSON.stringify(join(work, "planted-loaded"))}, "yes");\n`);
}, 240_000);
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("the resolve guard is only where the ticket is", () => {
  it("host.mjs carries it; every job bundle (voice worker, document jobs, clients, service) is built without it", () => {
    const bundles = readdirSync(hostDir).filter((name) => name.endsWith(".mjs")).sort();
    expect(bundles).toContain("voice-worker.mjs");
    expect(TICKET_HOLDERS).toEqual(["host"]);
    for (const name of bundles) expect([name, readFileSync(join(hostDir, name), "utf8").includes(marker)]).toEqual([name, name === "host.mjs"]);
  });

  it("the voice worker loads its runtime from <data>/voice/runtime-x/node_modules", async () => {
    const modelsDir = join(work, "data", "voice", "models");
    const modelDir = getLocalSpeechModelDir(modelsDir, "whisper-base");
    for (const file of engineFiles(getLocalSttEngine("whisper-base"))) { mkdirSync(join(modelDir, file, ".."), { recursive: true }); writeFileSync(join(modelDir, file), ""); }
    const child = fork(join(hostDir, "voice-worker.mjs"), [], { env: { ...process.env, NODE_PATH: runtimeNodeModules }, execArgv: [], serialization: "advanced", stdio: ["ignore", "ignore", "ignore", "ipc"] });
    try {
      const answer = await new Promise<{ ok: boolean; error?: string }>((done, failed) => {
        const timer = setTimeout(() => failed(new Error("the voice worker did not answer")), 20_000);
        child.on("message", (message: { type: string; ok: boolean; error?: string }) => { if (message.type === "response") { clearTimeout(timer); done(message); } });
        child.send({ type: "stt.transcribe", requestId: "r1", model: "dictation", format: "audio/wav", audio: new Uint8Array(0),
          config: { modelsDir, dictationSttModel: "whisper-base", voiceSttModel: "whisper-base", voiceTtsModel: "kokoro-en-v0_19" } });
      });
      expect(answer.error ?? "").toContain("fake recognizer reached");
      expect(existsSync(join(work, "voice-loaded"))).toBe(true);
    } finally { child.kill(); }
  }, 30_000);

  it("under the guard: a package above the install is refused, and the voice library folder is still found", async () => {
    // A stand-in for host.mjs: the same banner, in the same place, calling what host.mjs calls.
    const probe = join(hostDir, "guard-probe.mjs");
    await build({ absWorkingDir: root, stdin: { resolveDir: root, sourcefile: "probe.ts", loader: "ts", contents: `
      import { resolveSherpaLoaderEnv } from "./vendor/paseo/voice-server/dist/server/speech/providers/local/sherpa/sherpa-runtime-env.js";
      let planted = "loaded";
      try { require("planted-above"); } catch (error) { planted = (error as { code?: string }).code ?? "error"; }
      console.log(JSON.stringify({ planted, libDir: resolveSherpaLoaderEnv(process.platform, process.arch, process.argv[2])?.libDir ?? null }));` },
      outfile: probe, bundle: true, platform: "node", format: "esm", target: "node24", logLevel: "silent", banner: { js: RESOLVE_GUARD_BANNER } });
    const out = JSON.parse(execFileSync(process.execPath, [probe, runtimeNodeModules], { encoding: "utf8" }).trim()) as { planted: string; libDir: string | null };
    expect(out.planted).toBe("MODULE_NOT_FOUND");
    expect(existsSync(join(work, "planted-loaded"))).toBe(false);
    expect(out.libDir).toBe(join(runtimeNodeModules, platformPackage));
  });
});
