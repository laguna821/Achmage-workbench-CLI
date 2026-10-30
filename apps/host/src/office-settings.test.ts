import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OfficeSettings, OFFICE_SECRET_PLACEHOLDER } from "./office-settings.mjs";
import { OfficeVault, OFFICE_SEALED_PREFIX, nativeOfficeVault } from "./office-vault.ts";
import { createOfficeAiEngine } from "./office-ai-engine.mjs";

function fixture(raw?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "wb-office-settings-"));
  const key = randomBytes(32), id = randomBytes(16).toString("hex");
  const vault = () => new OfficeVault(dir, async () => ({ id, key: Buffer.from(key) }));
  const store = new OfficeSettings(dir, vault());
  if (raw !== undefined) { mkdirSync(join(dir, "office")); writeFileSync(store.path, JSON.stringify(raw)); }
  return { dir, key, id, vault, store, close: () => { store.close(); key.fill(0); rmSync(dir, { recursive: true, force: true }); } };
}
const configure = (settings: Record<string, any>, key = "fixture-chat-key"): Record<string, any> => ({ ...settings, provider: "openai", providers: { ...settings.providers, openai: { ...settings.providers.openai, apiKey: key } } });

describe("Office native secret vault", () => {
  it("uses randomized authenticated envelopes that survive a host restart and refuse tampering", async () => {
    const f = fixture();
    const one = f.vault(), two = f.vault();
    try {
      const a = await one.seal("한글-key"), b = await one.seal("한글-key");
      expect(a).toMatch(/^sealed:v1:workbench:/); expect(a).not.toBe(b); expect(a).not.toContain("한글-key");
      expect(await two.open(a)).toBe("한글-key");
      const parts = a.split("."); parts[1] = Buffer.from("altered").toString("base64url");
      await expect(two.open(parts.join("."))).rejects.toMatchObject({ code: "office_secret_invalid" });
      const wrong = new OfficeVault(f.dir, async () => ({ id: f.id, key: randomBytes(32) }));
      await expect(wrong.open(a)).rejects.toMatchObject({ code: "office_secret_invalid" }); wrong.close();
      one.close(); await expect(one.seal("another")).rejects.toMatchObject({ code: "office_vault_unavailable" });
    } finally { one.close(); two.close(); f.close(); }
  });
  it("does not replace Electron envelopes or fall back to plaintext without the native helper", async () => {
    const f = fixture(), unavailable = new OfficeVault(f.dir, nativeOfficeVault(f.dir, "/missing-workbench-fixture"));
    try {
      expect(await unavailable.seal("sealed:v1:legacy-fixture")).toBe("sealed:v1:legacy-fixture");
      await expect(unavailable.open("sealed:v1:legacy-fixture")).rejects.toMatchObject({ code: "office_legacy_secret" });
      await expect(unavailable.seal("do-not-store-me")).rejects.toMatchObject({ code: "office_vault_unavailable" });
      expect(readdirSync(f.dir)).toEqual([]);
    } finally { unavailable.close(); f.close(); }
  });
});

describe("Office settings persistence", () => {
  it("tests an unsaved provider without opening an unrelated legacy Electron key", async () => {
    const f = fixture({ providers: { gemini: { apiKey: "sealed:v1:legacy-fixture" } } });
    try {
      const before = readFileSync(f.store.path), initial = f.store.snapshot();
      const draft = await f.store.draftSettings(configure(initial.settings, "unsaved-key"));
      expect(draft.providers.openai.apiKey).toBe("unsaved-key"); expect(draft.providers.gemini.apiKey).toBe("");
      expect(readFileSync(f.store.path)).toEqual(before);
    } finally { f.close(); }
  });
  it("does not persist a cancelled browser connection after waiting for the native vault", async () => {
    const f = fixture(), abort = new AbortController();
    const store = new OfficeSettings(f.dir, new OfficeVault(f.dir, async () => { abort.abort(); return { id: f.id, key: Buffer.from(f.key) }; }));
    try {
      const initial = store.snapshot();
      await expect(store.write(configure(initial.settings), initial.revision, { signal: abort.signal })).rejects.toMatchObject({ code: "office_settings_cancelled" });
      expect(existsSync(store.path)).toBe(false);
    } finally { store.close(); f.close(); }
  });
  it("seals all original secret fields, preserves non-secret settings and reopens after restart", async () => {
    const f = fixture(); let restarted: OfficeSettings | undefined;
    try {
      const initial = f.store.snapshot(), draft = configure(initial.settings);
      draft.customEndpoints = [{ id: "local-fixture", name: "Local", kind: "local", baseUrl: "http://127.0.0.1:1234/v1", apiKey: "fixture-custom-key", model: "model" }];
      draft.customEndpoint = "local-fixture";
      draft.media.providers.openai.apiKey = "fixture-image-key";
      draft.search.providers.tavily.apiKey = "fixture-search-key";
      draft.readUrl = { githubToken: "fixture-github-key" };
      draft.maxOutputTokens = 12_345;
      const saved = await f.store.write(draft, initial.revision), bytes = readFileSync(f.store.path, "utf8");
      for (const value of ["fixture-chat-key", "fixture-custom-key", "fixture-image-key", "fixture-search-key", "fixture-github-key"]) {
        expect(bytes).not.toContain(value); expect(JSON.stringify(saved)).not.toContain(value); expect(JSON.stringify(f.store.publicSettings())).not.toContain(value);
      }
      expect(bytes).toContain(OFFICE_SEALED_PREFIX);
      expect(saved.settings.maxOutputTokens).toBe(12_345);
      if (process.platform !== "win32") expect(statSync(f.store.path).mode & 0o777).toBe(0o600);
      expect(readdirSync(join(f.dir, "office"))).toEqual(["ai-settings.json"]);
      f.store.close(); restarted = new OfficeSettings(f.dir, f.vault());
      const actual = await restarted.executionSettings();
      expect(actual.providers.openai.apiKey).toBe("fixture-chat-key");
      expect(actual.customEndpoints[0].apiKey).toBe("fixture-custom-key");
      expect(actual.media.providers.openai.apiKey).toBe("fixture-image-key");
      expect(actual.search.providers.tavily.apiKey).toBe("fixture-search-key");
      expect(actual.readUrl.githubToken).toBe("fixture-github-key");
      expect(readFileSync(f.store.path, "utf8")).toBe(bytes);
    } finally { restarted?.close(); f.close(); }
  });
  it("keeps unopened Electron bytes through a settings edit and never sends them as an API key", async () => {
    const f = fixture({ provider: "openai", providers: { openai: { apiKey: "sealed:v1:original-electron-fixture", model: "fixture-model" } } });
    try {
      const before = readFileSync(f.store.path), snapshot = f.store.snapshot();
      expect(snapshot.legacySecrets).toBe(1); expect(readFileSync(f.store.path)).toEqual(before);
      expect((await f.store.executionSettings()).providers.openai.apiKey).toBe("");
      await f.store.write({ ...snapshot.settings, maxOutputTokens: 5000 }, snapshot.revision);
      expect(JSON.parse(readFileSync(f.store.path, "utf8")).providers.openai.apiKey).toBe("sealed:v1:original-electron-fixture");
      const next = f.store.snapshot();
      await f.store.write(configure(next.settings, "replacement-key"), next.revision);
      expect((await f.store.executionSettings()).providers.openai.apiKey).toBe("replacement-key");
    } finally { f.close(); }
  });
  it("rejects stale concurrent writes, forged references and flag-only metered consent", async () => {
    const f = fixture();
    try {
      const start = f.store.snapshot();
      const both = await Promise.allSettled([f.store.write(configure(start.settings, "first"), start.revision), f.store.write(configure(start.settings, "second"), start.revision)]);
      expect(both.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
      expect((both[1] as PromiseRejectedResult).reason.code).toBe("office_settings_changed");
      const next = f.store.snapshot(), before = readFileSync(f.store.path);
      await expect(f.store.write(configure(next.settings, "__workbench_secret_ref_not-yours__"), next.revision)).rejects.toMatchObject({ code: "office_settings_secret_changed" });
      await expect(f.store.write(configure(next.settings, OFFICE_SECRET_PLACEHOLDER), next.revision)).rejects.toMatchObject({ code: "office_settings_secret_invalid" });
      expect(readFileSync(f.store.path)).toEqual(before);
      const saved = await f.store.write({ ...next.settings, meteredAccepted: { codex: true, "claude-code": true } }, next.revision);
      expect(saved.settings.meteredAccepted).toEqual({ codex: false, "claude-code": false });
    } finally { f.close(); }
  });
  it("rechecks exact disk bytes after an asynchronous vault unlock and preserves external edits", async () => {
    const f = fixture();
    let resume!: () => void, entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const wait = new Promise<void>((resolve) => { resume = resolve; });
    const store = new OfficeSettings(f.dir, new OfficeVault(f.dir, async () => { entered(); await wait; return { id: f.id, key: Buffer.from(f.key) }; }));
    try {
      const initial = store.snapshot(), writing = store.write(configure(initial.settings), initial.revision);
      await started;
      mkdirSync(join(f.dir, "office")); writeFileSync(store.path, '{"provider":"auto","providers":{}}\n');
      const external = readFileSync(store.path); resume();
      await expect(writing).rejects.toMatchObject({ code: "office_settings_changed" });
      expect(readFileSync(store.path)).toEqual(external);
    } finally { resume(); store.close(); f.close(); }
  });
  it("leaves broken JSON and old plaintext untouched on reads or a failed save", async () => {
    const f = fixture({ apiKey: "old-plaintext-fixture", model: "old-model", baseUrl: "http://localhost:1234/v1" });
    const bad = new OfficeSettings(f.dir, new OfficeVault(f.dir, async () => { throw new Error("locked fixture"); }));
    try {
      const before = readFileSync(f.store.path), one = bad.snapshot(), two = bad.snapshot();
      expect(one).toEqual(two); expect(JSON.stringify(one)).not.toContain("old-plaintext-fixture");
      expect((await bad.executionSettings()).providers.custom.apiKey).toBe("old-plaintext-fixture");
      await expect(bad.write(one.settings, one.revision)).rejects.toThrow();
      expect(readFileSync(f.store.path)).toEqual(before);
      writeFileSync(f.store.path, "{ broken source");
      expect(() => bad.snapshot()).toThrow(); expect(readFileSync(f.store.path, "utf8")).toBe("{ broken source");
      expect(existsSync(join(f.dir, "office", "vault-id"))).toBe(false);
    } finally { bad.close(); f.close(); }
  });
  it("uses decrypted saved keys with the original provider while returning only masked keys", async () => {
    const f = fixture(); let seen = "";
    const engine = createOfficeAiEngine(f.dir, { settingsStore: f.store, chat: async (_provider, config) => { seen = (config as Record<string, string>).apiKey!; return { ok: true, content: "fixture answer" }; } });
    try {
      const initial = f.store.snapshot(); await f.store.write(configure(initial.settings), initial.revision);
      expect((engine.settings().providers as Record<string, { apiKey: string }>).openai!.apiKey).toBe(OFFICE_SECRET_PLACEHOLDER);
      const result = await engine.chat({ settings: engine.settings(), system: "test", user: "hello" }, new AbortController().signal);
      expect(result).toEqual({ ok: true, content: "fixture answer" }); expect(seen).toBe("fixture-chat-key");
    } finally { engine.close?.(); f.close(); }
  });
  it("requires detected metered login and original fingerprint consent, which survives restart and clears on login-kind change", async () => {
    const f = fixture(); let loginKind = "api-key";
    const dependencies = {
      settingsStore: f.store,
      detect: async (provider: string) => ({ provider, state: "metered", loginMethod: "metered", loginKind, account: "fixture-account@example.invalid" }),
      listModels: async () => [],
    };
    const engine = createOfficeAiEngine(f.dir, dependencies);
    let restarted: ReturnType<typeof createOfficeAiEngine> | undefined;
    try {
      expect(await engine.setMeteredAccepted!("codex", true)).toMatchObject({ ok: false });
      expect(existsSync(f.store.path)).toBe(false);
      const publicStatus = await engine.statuses(true), trusted = await engine.statuses(false, true);
      expect(publicStatus.codex?.meteredAccepted).toBe(false);
      expect(JSON.stringify(publicStatus)).not.toContain("fixture-account");
      expect(trusted.codex?.account).toBe("fixture-account@example.invalid");
      expect(await engine.setMeteredAccepted!("codex", true)).toMatchObject({ ok: true });
      expect(f.store.snapshot().settings.meteredAccepted.codex).toBe(true);
      const consent = readFileSync(join(f.dir, "office/subscription-metered.json"), "utf8");
      expect(JSON.parse(consent).codex).toBe("metered:api-key"); expect(consent).not.toContain("fixture-account");
      restarted = createOfficeAiEngine(f.dir, { ...dependencies, settingsStore: new OfficeSettings(f.dir, f.vault()) });
      expect((await restarted.statuses(true)).codex?.meteredAccepted).toBe(true);
      loginKind = "unknown";
      expect((await restarted.statuses(true)).codex?.meteredAccepted).toBe(false);
      expect(restarted.configuration!.snapshot().settings.meteredAccepted.codex).toBe(false);
      expect(JSON.parse(readFileSync(join(f.dir, "office/subscription-metered.json"), "utf8")).codex).toBeUndefined();
    } finally { restarted?.close?.(); engine.close?.(); f.close(); }
  });
});
