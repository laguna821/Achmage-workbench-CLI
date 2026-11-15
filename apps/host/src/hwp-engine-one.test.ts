// The gateway and the studio run ONE Hangul engine (H4b). The engine is chosen in one file,
// third_party/hop/engine.ts; everything that opens a Hangul document in the gateway imports it from
// there, and the studio build is built around the folder it names. This test fails when a source
// reaches an engine folder directly, when engine.ts names two folders, when the studio build would
// pick another folder, when the built studio carries another WASM, and when the gateway would accept
// a shipped studio whose WASM is not its own.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENGINE_DIR, enginePackage } from "../../../third_party/hop/engine.ts";
import { hwpWasmPath } from "./hwp-resource.ts";
// @ts-expect-error -- plain ES module without types
import { hwpEngineResolve } from "../../../scripts/hwp-engine-platform.mjs";

const root = resolve(import.meta.dirname, "../../..");
const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const engineFolder = /third_party\/hop\/rhwp-core(?:-[\d.]+)?\b|['"]\.\/rhwp-core(?:-[\d.]+)?\//;
/** Files allowed to name an engine folder: the selector itself, the engine's own build/check tools, and data. */
const allowed = new Set([
  "third_party/hop/engine.ts",
  "scripts/rebuild-hwp-engine.mjs",
  "scripts/rebuild-hwp-engine-090.mjs",
  "scripts/check-hop-sources.mjs",
  "scripts/hwp-engine-first-look.ts",
  "scripts/hwp-corpus/compare.test.ts",
  "apps/host/src/hwp-engine-one.test.ts",
]);
function sources(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === "dist" || name === "public") return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx|mts|mjs|js|cjs)$/.test(name) ? [path] : [];
  });
}

describe("one Hangul engine for the gateway and the studio", () => {
  it("is chosen in one file that names one folder", () => {
    const text = readFileSync(join(root, "third_party/hop/engine.ts"), "utf8");
    // the comment names the way back ("rhwp-core"); the code lines all name the engine's folder
    const code = text.split("\n").filter((line) => !line.trimStart().startsWith("//"));
    const lines = code.filter((line) => /rhwp-core/.test(line));
    const folders = new Set(lines.flatMap((line) => [...line.matchAll(/rhwp-core(?:-[\d.]+)?(?=\/|")/g)].map((match) => match[0])));
    expect(lines.length).toBe(4);
    expect([...folders]).toEqual([ENGINE_DIR.split("/").pop()]);
    expect(existsSync(join(root, ENGINE_DIR, "rhwp_bg.wasm"))).toBe(true);
    expect(sha256(readFileSync(join(root, ENGINE_DIR, "rhwp_bg.wasm")))).toBe(enginePackage.rhwp.wasmSha256);
  });

  it("is reached through that file by every gateway, studio-build and check source", () => {
    const files = ["apps", "packages", "scripts", "third_party/ieumoffice", "third_party/hop"].flatMap((dir) => sources(join(root, dir)))
      .map((path) => relative(root, path).split("\\").join("/"))
      .filter((path) => !allowed.has(path) && !path.startsWith("third_party/hop/rhwp-core"));
    const direct = files.filter((path) => engineFolder.test(readFileSync(join(root, path), "utf8")));
    expect(direct).toEqual([]);
    // the studio build takes its folder from the selector
    expect(readFileSync(join(root, "scripts/build-hwp-studio.mjs"), "utf8")).toMatch(/third_party\/hop\/engine\.ts[\s\S]*const core = join\(root, ENGINE_DIR\)/);
  });

  it("is also what Ieum's vendored code gets for '@rhwp/core' (the document AI, its file parser and memo reader)", () => {
    const engine = join(root, "third_party/hop/engine.ts");
    expect(hwpEngineResolve("@rhwp/core", join(root, "vendor/ieumoffice/packages/cli/src/formats/hwp-edit.ts"))).toBe(engine);
    expect(hwpEngineResolve("@rhwp/core", join(root, "vendor/ieumoffice/packages/file-parse/src/hwp.ts"))).toBe(engine);
    expect(hwpEngineResolve("@rhwp/core", join(root, "apps/host/src/x.ts"))).toBeNull();
    expect(readFileSync(join(root, "scripts/build-host.mjs"), "utf8")).toMatch(/plugins: \[[^\]]*hwpEnginePlugin\(\)/);
    expect(readFileSync(join(root, "vitest.config.ts"), "utf8")).toContain("resolveId: hwpEngineResolve");
  });

  // Every gateway bundle that carries the engine's glue (hangul-picture-job.mjs too: review M2).
  for (const name of ["hwp-cli.mjs", "host.mjs", "hangul-picture-job.mjs"]) {
    const bundle = join(root, "apps/host/dist", name);
    it.skipIf(!existsSync(bundle))(`is the only engine in the built gateway (${name})`, () => {
      const text = readFileSync(bundle, "utf8");
      expect(text).not.toContain("// vendor/ieumoffice/vendor/rhwp-core/rhwp.js");
      expect(text).toContain(`// ${ENGINE_DIR}/rhwp.js`);
    });
  }

  // The built studio, and its copy in the web build that the gateway serves in development, the
  // captures and the e2e runs (WORKBENCH_WEB_DIR=apps/web/dist; review M2: after a way back the copy
  // there still held the other engine's studio and nothing said so).
  for (const folder of ["apps/office/public/studio", "apps/web/dist/office/studio"]) {
    const studio = join(root, folder, "build.json");
    it.skipIf(!existsSync(studio))(`is the engine inside the built studio (${folder})`, () => {
      const build = JSON.parse(readFileSync(studio, "utf8")) as { wasm: string; wasmSha256: string; rhwpCommit: string; engineVersion: string };
      expect(build.wasmSha256).toBe(enginePackage.rhwp.wasmSha256);
      expect(build.rhwpCommit).toBe(enginePackage.rhwp.commit);
      expect(build.engineVersion).toBe(enginePackage.version);
      expect(sha256(readFileSync(join(root, folder, build.wasm)))).toBe(enginePackage.rhwp.wasmSha256);
    });
  }

  const saved = process.env.WORKBENCH_RESOURCES_DIR;
  let scratch: string | undefined;
  afterEach(() => {
    if (saved === undefined) delete process.env.WORKBENCH_RESOURCES_DIR; else process.env.WORKBENCH_RESOURCES_DIR = saved;
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  });
  function shippedStudio(wasm: Uint8Array, recorded: string) {
    scratch = mkdtempSync(join(tmpdir(), "wb-engine-one-"));
    const dir = join(scratch, "web/office/studio");
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "assets/rhwp_bg-test.wasm"), wasm);
    writeFileSync(join(dir, "build.json"), JSON.stringify({ schemaVersion: 1, wasm: "assets/rhwp_bg-test.wasm", wasmSha256: recorded }));
    process.env.WORKBENCH_RESOURCES_DIR = scratch;
  }
  it("is refused by the gateway when a shipped studio carries another WASM", () => {
    const other = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
    shippedStudio(other, sha256(other));
    expect(() => hwpWasmPath()).toThrow("한글 편집기 빌드 정보가 맞지 않습니다.");
    shippedStudio(other, enginePackage.rhwp.wasmSha256);
    expect(() => hwpWasmPath()).toThrow("한글 편집기 엔진의 해시가 맞지 않습니다.");
    shippedStudio(readFileSync(join(root, ENGINE_DIR, "rhwp_bg.wasm")), enginePackage.rhwp.wasmSha256);
    expect(hwpWasmPath()).toBe(join(scratch!, "web/office/studio/assets/rhwp_bg-test.wasm"));
  });
});
