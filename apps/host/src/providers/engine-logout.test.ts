import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderStatus } from "@workbench/contracts";
import type { AdapterSink } from "./types.ts";
import { ClaudeAdapter } from "./claude.ts";
import { CodexAdapter } from "./codex.ts";

// 0.5.6 round 2 (the owner: "GPT의 경우 수동으로 OAuth 로그인 기능이 설정에 없었어"): 설정 › AI 엔진 offers
// the same keys for both engines; signed in, 로그아웃 goes through the engine's own logout (Claude Code:
// `claude auth logout`; Codex: the app-server's `account/logout`). Stand-in engines only: their login is a
// file in a temporary folder (FAKE_ENGINE_AUTH_DIR), never the owner's ~/.claude or ~/.codex.

const dirs: string[] = [];
const adapters: { shutdown(): Promise<void> }[] = [];
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.shutdown();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wb-engine-logout-"));
  dirs.push(dir);
  const auth = join(dir, "auth");
  vi.stubEnv("WORKBENCH_CLAUDE_BIN", resolve("scripts/fixtures/fake-claude.mjs"));
  vi.stubEnv("WORKBENCH_CODEX_BIN", resolve("scripts/fixtures/fake-codex.mjs"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(dir, "claude-config"));
  vi.stubEnv("CODEX_HOME", join(dir, "codex-home"));
  vi.stubEnv("FAKE_ENGINE_AUTH_DIR", auth);
  // Both stand-ins signed in.
  rmSync(auth, { recursive: true, force: true });
  mkdirSync(auth, { recursive: true });
  writeFileSync(join(auth, "claude"), "signed in");
  writeFileSync(join(auth, "codex"), "signed in");
  const statuses: ProviderStatus[] = [];
  const sink: AdapterSink = {
    upsertItem: () => undefined, delta: () => undefined, updateSession: () => undefined,
    providerStatus: (status) => statuses.push(status), steerDropped: () => undefined, toolImages: () => undefined,
  };
  return { auth, sink, statuses };
}

describe("로그아웃 through the engine's own logout", () => {
  it("Claude Code: signed in, then `claude auth logout` signs it out and the status says so", async () => {
    const { auth, sink } = setup();
    const adapter = new ClaudeAdapter(sink, {});
    adapters.push(adapter);
    await adapter.init();
    expect((await adapter.refreshStatus()).loggedIn).toBe(true);
    await adapter.logout!();
    expect(existsSync(join(auth, "claude"))).toBe(false);
    expect(adapter.status()).toMatchObject({ loggedIn: false, account: null, plan: null, loginMethod: null });
    // Signed out it stays out when looked at again.
    expect((await adapter.refreshStatus()).loggedIn).toBe(false);
  }, 30_000);

  it("Codex: signed in, then the app-server's account/logout signs it out and the status says so", async () => {
    const { auth, sink } = setup();
    const adapter = new CodexAdapter(sink, {});
    adapters.push(adapter);
    await adapter.init();
    expect((await adapter.refreshStatus()).loggedIn).toBe(true);
    await adapter.logout!();
    expect(existsSync(join(auth, "codex"))).toBe(false);
    expect(adapter.status()).toMatchObject({ loggedIn: false, account: null, plan: null, loginMethod: null });
    expect((await adapter.refreshStatus()).loggedIn).toBe(false);
  }, 30_000);
});
