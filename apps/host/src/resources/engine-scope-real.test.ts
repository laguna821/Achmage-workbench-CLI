import { afterEach, describe, expect, it, vi } from "vitest";
import { launchEnv, resolveClaude, resolveCodex, sdkBundledBinary } from "../binaries.ts";
import { engineCgroup, engineScope, probeScope, spawnEngine } from "./engine-scope.ts";

// The real engines through the real wrapper, without accounts and without the network: `--version` only, started the
// way the providers start them (the engine they resolve, its launch environment, the wrapper of a conversation).
// Opt-in (WB_REAL_ENGINE_SMOKE=1): it needs `claude` / `codex` on this computer. Run under ux/run-isolated.sh (its HOME,
// CLAUDE_CONFIG_DIR and CODEX_HOME are empty temp folders).

afterEach(() => { engineScope.enabled = false; engineScope.owner = null; engineScope.binary = "systemd-run"; engineScope.onDisable = null; });

describe.runIf(process.platform === "linux" && process.env.WB_REAL_ENGINE_SMOKE === "1")("real engines through the wrapper (--version)", () => {
  for (const name of ["claude", "codex"] as const) {
    it(`${name}: its output arrives, exit 0, started inside its own scope, no fall-back`, async () => {
      const saved = process.env.WORKBENCH_ENGINE_SCOPE;
      delete process.env.WORKBENCH_ENGINE_SCOPE;
      const probe = await probeScope("linux").finally(() => { process.env.WORKBENCH_ENGINE_SCOPE = saved; });
      expect(probe?.systemdRun).toBe(true);
      const binary = name === "claude" ? await resolveClaude(sdkBundledBinary()) : await resolveCodex();
      if (!binary) { console.log(`${name}: not found on this computer`); return; }
      const log = vi.spyOn(console, "error");
      engineScope.enabled = true;
      const child = spawnEngine(binary.command, [...binary.args, "--version"], { env: launchEnv(binary) }, `smoke-${name}`, name === "claude");
      let out = "", err = "", scope: string | null = null;
      child.stdout.on("data", (data: Buffer) => { out += data; });
      child.stderr.on("data", (data: Buffer) => { err += data; });
      child.once("spawn", () => { void engineCgroup(child.pid!).then((found) => { scope = found; }); });
      const code = await new Promise<number | null>((done) => child.on("close", (exit: number | null) => done(exit)));
      console.log(`${name} (${binary.source}, ${binary.command}): exit ${code}, "${out.trim()}"${err.trim() ? `, stderr "${err.trim().slice(0, 200)}"` : ""}, scope ${scope ?? "(ended before it was read)"}`);
      expect(code).toBe(0);
      expect(out).toMatch(/\d+\.\d+/);
      expect(log.mock.calls.filter(([line]) => String(line).startsWith("WB_ENGINE_SCOPE_OFF"))).toHaveLength(0);
      expect(engineScope.enabled).toBe(true);
    }, 60_000);
  }
});
