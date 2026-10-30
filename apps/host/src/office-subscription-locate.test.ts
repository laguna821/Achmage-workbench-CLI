import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { locateSubscriptionProgram, resolveSubscriptionProgram } from "./office-subscription-locate.mjs";
import { createOfficeAiEngine, shutdownOfficeAiProviders } from "./office-ai-engine.mjs";
import { resolveCodex, resolveClaude, type ResolvedBinary } from "./binaries.ts";

vi.mock("./binaries.ts", async (original) => ({ ...await original<typeof import("./binaries.ts")>(), resolveCodex: vi.fn(), resolveClaude: vi.fn() }));
afterEach(() => { shutdownOfficeAiProviders(); vi.unstubAllEnvs(); vi.resetAllMocks(); });
const fixtures = fileURLToPath(new URL("../../../scripts/fixtures/", import.meta.url));
for (const name of ["codex", "claude"]) if (!statSync(join(fixtures, `fake-${name}.mjs`)).isFile()) throw new Error("CLI fixture missing");
const binary = (name: string): ResolvedBinary => ({ path: join(fixtures, `fake-${name}.mjs`), command: process.execPath,
  args: [join(fixtures, `fake-${name}.mjs`)], env: { CODEX_MANAGED_BY_NPM: "1" }, paths: ["/fixture/tools"], kind: "node", origin: "managed", version: "0.135.0", source: "managed" });

describe("Office CLI platform adapter", () => {
  it("uses the complete Workbench launch and lets the original layer sanitize billing variables", async () => {
    const selected = binary("codex"); vi.mocked(resolveCodex).mockResolvedValue(selected);
    vi.stubEnv("ANTHROPIC_API_KEY", "never-copy-this-secret");
    const program = await locateSubscriptionProgram("codex");
    expect(program).toMatchObject({ command: process.execPath, prefixArgs: selected.args, entry: selected.args[0], source: "managed", env: selected.env });
    expect(Object.entries(program!.env).find(([key]) => key.toLowerCase() === "path")?.[1]).toContain("/fixture/tools");
    expect(JSON.stringify(program)).not.toContain("never-copy-this-secret");
    vi.mocked(resolveCodex).mockResolvedValue(null);
    await expect(resolveSubscriptionProgram("codex")).rejects.toMatchObject({ kind: "not-installed" });
  });
  it("preserves a configured CLI without consulting the automatic Workbench resolver", async () => {
    const cli = join(fixtures, "fake-codex.mjs");
    expect(await locateSubscriptionProgram("codex", { configuredPath: cli })).toMatchObject({ entry: cli, source: "configured" });
    expect(resolveCodex).not.toHaveBeenCalled();
  });
  it("routes original status, model catalogue and requests through the same automatic CLI", async () => {
    vi.stubEnv("FAKE_CODEX_VERSION", "0.135.0");
    vi.mocked(resolveCodex).mockResolvedValue(binary("codex")); vi.mocked(resolveClaude).mockResolvedValue(binary("claude"));
    const dir = mkdtempSync(join(tmpdir(), "wb-office-cli-")), engine = createOfficeAiEngine(dir);
    try {
      const settings = engine.configuration!.snapshot(); settings.settings.provider = "codex";
      await engine.configuration!.write(settings.settings, settings.revision);
      const before = readFileSync(engine.configuration!.path);
      expect(await engine.statuses(true)).toMatchObject({ codex: { state: "ready", version: "0.135.0" }, "claude-code": { state: "ready" } });
      const models = await engine.settingsInvoke!("ai:codex-models", [], "fixture", new AbortController().signal);
      expect(models).toMatchObject({ models: ["fake-model"] });
      const reply = await engine.chat({ settings: engine.settings(), system: "Fixture", user: "ping" }, new AbortController().signal);
      expect(reply, JSON.stringify(reply)).toMatchObject({ ok: true, content: "OK" });
      expect(readFileSync(engine.configuration!.path)).toEqual(before);
    } finally { engine.close?.(); rmSync(dir, { recursive: true, force: true }); }
  }, 20000);
});
