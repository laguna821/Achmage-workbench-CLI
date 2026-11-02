import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { EngineLaunch } from "./engine-locate.ts";
import { resolveCodex } from "./binaries.ts";

const fixture = vi.hoisted(() => ({ candidates: [] as EngineLaunch[] }));
vi.mock("./engine-locate.ts", async original => ({ ...await original<typeof import("./engine-locate.ts")>(), engineCandidates: () => fixture.candidates }));
const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); fixture.candidates = []; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it("uses a newer Workbench engine even when an older Codex already exists on PATH", async () => {
  vi.stubEnv("WORKBENCH_CODEX_BIN", "");
  const dir = mkdtempSync(join(tmpdir(), "wb-codex-candidates-")); dirs.push(dir);
  const candidate = (name: string, version: string, origin: EngineLaunch["origin"]): EngineLaunch => {
    const path = join(dir, `${name}.mjs`); writeFileSync(path, `console.log('codex-cli ${version}');`);
    return { path, command: process.execPath, args: [path], env: {}, paths: [], kind: "node", origin };
  };
  const old = candidate("old", "0.150.0", "path"), latest = candidate("latest", "0.160.0", "managed");
  fixture.candidates = [old, latest];
  expect(await resolveCodex()).toMatchObject({ path: latest.path, version: "0.160.0", source: "managed" });
  const app = candidate("app", "0.170.0", "app"); fixture.candidates.push(app);
  expect(await resolveCodex()).toMatchObject({ path: app.path, version: "0.170.0", source: "installed" });
  vi.stubEnv("WORKBENCH_CODEX_BIN", old.path);
  expect(await resolveCodex()).toMatchObject({ path: old.path, version: "0.150.0", source: "override" });
});
