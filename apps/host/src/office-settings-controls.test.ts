import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { OfficeSettings } from "./office-settings.mjs";
import { OfficeVault } from "./office-vault.ts";
import { createOfficeSettingsControls, type OfficeAiHostActions, type OfficeSettingsControlOverrides } from "./office-settings-controls.mjs";

function fixture(overrides: OfficeSettingsControlOverrides = {}, actions?: OfficeAiHostActions) {
  const dir = mkdtempSync(join(tmpdir(), "wb-office-controls-")), key = randomBytes(32), id = randomBytes(16).toString("hex");
  const store = new OfficeSettings(dir, new OfficeVault(dir, async () => ({ id, key: Buffer.from(key) })));
  const controls = createOfficeSettingsControls(dir, store, {
    detect: async (provider: string) => ({ provider, state: "signed-out" }), listModels: async () => [], ...overrides,
  }, actions);
  const call = (channel: string, input?: unknown, owner = "settings-a", signal = new AbortController().signal) => controls.invoke(channel, input === undefined ? [] : [input], owner, signal);
  return { store, call, close: () => { controls.close(); store.close(); key.fill(0); rmSync(dir, { recursive: true, force: true }); } };
}
async function saveKeys(f: ReturnType<typeof fixture>) {
  const s = f.store.snapshot();
  s.settings.provider = "openai"; s.settings.providers.openai.apiKey = "fixture-secret";
  s.settings.media.providers.openai.apiKey = "fixture-media-secret";
  s.settings.search.providers.tavily.apiKey = "fixture-search-secret";
  return f.store.write(s.settings, s.revision);
}

describe("original Office settings controls", () => {
  it("waits for the shared installation, reports failure, and rechecks the actual CLI afterward", async () => {
    let finish!: (value: { ok: boolean; reason?: "failed"; error?: string }) => void;
    let state = "not-installed";
    const install = vi.fn(() => new Promise<{ ok: boolean; reason?: "failed"; error?: string }>((resolve) => { finish = resolve; }));
    const f = fixture({ detect: async (provider) => ({ provider, state }) }, { install });
    try {
      let settled = false;
      const pending = f.call("ai:subscription-install", { provider: "codex" }).then((result) => { settled = true; return result; });
      await vi.waitFor(() => expect(install).toHaveBeenCalledOnce()); expect(settled).toBe(false);
      state = "ready"; finish({ ok: true }); expect(await pending).toEqual({ ok: true });
      expect((await f.call("ai:subscription-statuses")).codex.state).toBe("ready");
      const failed = f.call("ai:subscription-update", { provider: "codex" });
      await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(2));
      state = "not-installed"; finish({ ok: false, reason: "failed", error: "fixture network failure" });
      expect(await failed).toEqual({ ok: false, reason: "failed", error: "fixture network failure" });
      expect((await f.call("ai:subscription-statuses")).codex.state).toBe("not-installed");
      const snap = f.store.snapshot(); snap.settings.providers.codex.cliPath = "user-selected-cli";
      await f.store.write(snap.settings, snap.revision);
      expect(await f.call("ai:subscription-update", { provider: "codex" })).toMatchObject({ ok: false, reason: "unsupported" });
      expect(install).toHaveBeenCalledTimes(2);
    } finally { f.close(); }
  });
  it("does not transfer saved metered consent to a different unsaved CLI, or persist the draft", async () => {
    const chat = vi.fn(async () => ({ ok: true, content: "OK" }));
    let draftState = "metered";
    const f = fixture({ chat, detect: async (provider, options) => ({ provider, state: options?.configuredPath === "draft-cli" ? draftState : "metered", loginMethod: "metered", loginKind: "api-key" }) });
    try {
      const initial = f.store.snapshot(); initial.settings.provider = "codex"; initial.settings.providers.codex.cliPath = "saved-cli";
      await f.store.write(initial.settings, initial.revision);
      await f.call("ai:subscription-recheck", { providers: ["codex"] });
      expect(await f.call("ai:subscription-metered", { provider: "codex", accepted: true })).toMatchObject({ ok: true });
      const draft = f.store.snapshot().settings, before = readFileSync(f.store.path);
      draft.providers.codex.cliPath = "draft-cli";
      expect(await f.call("ai:chat", { settings: draft })).toMatchObject({ ok: false, errorCode: "metered-not-accepted" });
      expect(chat).not.toHaveBeenCalled(); expect(readFileSync(f.store.path)).toEqual(before);
      draftState = "ready";
      expect(await f.call("ai:chat", { settings: draft })).toMatchObject({ ok: true });
      expect(chat.mock.calls[0]).toMatchObject(["codex", { cliPath: "draft-cli" }, expect.any(String), "ping", expect.any(AbortSignal)]);
      expect(readFileSync(f.store.path)).toEqual(before);
      expect((await f.call("ai:subscription-statuses")).codex.meteredAccepted).toBe(true);
    } finally { f.close(); }
  });
  it("rechecks a saved login before a connection test and refuses a now signed-out CLI", async () => {
    let state = "ready";
    const chat = vi.fn(async () => ({ ok: true, content: "OK" }));
    const f = fixture({ chat, detect: async (provider) => ({ provider, state }) });
    try {
      const initial = f.store.snapshot(); initial.settings.provider = "codex";
      const saved = await f.store.write(initial.settings, initial.revision);
      await f.call("ai:subscription-recheck", { providers: ["codex"] });
      state = "signed-out";
      expect(await f.call("ai:chat", { settings: saved.settings })).toMatchObject({ ok: false, errorCode: "signed-out" });
      expect(chat).not.toHaveBeenCalled();
    } finally { f.close(); }
  });
  it("clears metered consent when a different CLI path is saved even if its login kind matches", async () => {
    const f = fixture({ detect: async (provider) => ({ provider, state: "metered", loginMethod: "metered", loginKind: "api-key" }) });
    try {
      const initial = f.store.snapshot(); initial.settings.provider = "codex"; initial.settings.providers.codex.cliPath = "first-cli";
      await f.store.write(initial.settings, initial.revision);
      await f.call("ai:subscription-recheck", { providers: ["codex"] });
      expect(await f.call("ai:subscription-metered", { provider: "codex", accepted: true })).toMatchObject({ ok: true });
      const draft = f.store.snapshot(); draft.settings.providers.codex.cliPath = "second-cli";
      const saved = await f.store.write(draft.settings, draft.revision);
      expect(saved.settings.meteredAccepted.codex).toBe(false);
      expect(await f.call("ai:chat", { settings: saved.settings })).toMatchObject({ ok: false, errorCode: "metered-not-accepted" });
    } finally { f.close(); }
  });
  it("refuses consent when the saved path changes during its fresh login check", async () => {
    let release!: () => void, entered!: () => void, hold = false;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const f = fixture({ detect: async (provider) => { if (hold) { entered(); await waiting; } return { provider, state: "metered", loginMethod: "metered", loginKind: "api-key" }; } });
    try {
      await f.call("ai:subscription-recheck", { providers: ["codex"] }); hold = true;
      const accepting = f.call("ai:subscription-metered", { provider: "codex", accepted: true });
      const refused = expect(accepting).rejects.toMatchObject({ status: 409 });
      await started;
      const draft = f.store.snapshot(); draft.settings.providers.codex.cliPath = "new-cli";
      await f.store.write(draft.settings, draft.revision);
      release(); await refused; expect(f.store.snapshot().settings.meteredAccepted.codex).toBe(false);
    } finally { release(); f.close(); }
  });
  it("opens opaque keys only on the host and never changes settings during connection tests", async () => {
    const seen = { chat: vi.fn(async () => ({ ok: true, content: "OK" })), customModels: vi.fn(async () => ({ models: ["fixture-model"], defaultModel: "fixture-model" })), mediaTest: vi.fn(async () => ({ ok: true })), searchTest: vi.fn(async () => ({ ok: true })) };
    const f = fixture(seen);
    try {
      const saved = await saveKeys(f), before = readFileSync(f.store.path);
      await f.call("ai:custom-models", { baseUrl: "http://127.0.0.1:1234/v1", apiKey: saved.settings.providers.openai.apiKey });
      expect(seen.customModels.mock.calls[0]).toEqual([{ baseUrl: "http://127.0.0.1:1234/v1", apiKey: "fixture-secret" }]);
      await f.call("ai:media-test", { provider: "openai", config: saved.settings.media.providers.openai });
      expect(seen.mediaTest.mock.calls[0]).toMatchObject(["openai", { apiKey: "fixture-media-secret" }]);
      await f.call("ai:search-test", { provider: "tavily", apiKey: saved.settings.search.providers.tavily.apiKey });
      expect(seen.searchTest.mock.calls[0]).toEqual(["tavily", "fixture-search-secret"]);
      await f.call("ai:chat", { settings: saved.settings, system: "untrusted requested prompt", user: "arbitrary work" });
      expect(seen.chat.mock.calls[0]).toMatchObject(["openai", { apiKey: "fixture-secret" }, "You are a connectivity test. Reply with the single word OK.", "ping", expect.any(AbortSignal)]);
      expect(readFileSync(f.store.path)).toEqual(before);
      await expect(f.call("ai:search-test", { provider: "tavily", apiKey: "__workbench_secret_ref_stale__" })).rejects.toMatchObject({ code: "office_settings_secret_changed" });
    } finally { f.close(); }
  });
  it("keeps local test ownership and cancellation separate from another settings frame", async () => {
    let running!: { owner: string; signal: AbortSignal };
    const f = fixture({ localTest: async (_input, options) => { running = options; return { ok: true }; } });
    const abort = new AbortController();
    try {
      await f.call("ai:local-test", { baseUrl: "http://localhost:1234", model: "fixture" }, "frame-a", abort.signal);
      expect(running.owner).toBe("frame-a"); expect(running.signal).toBe(abort.signal);
      abort.abort(); expect(running.signal.aborted).toBe(true);
      await expect(f.call("document:write", {})).rejects.toMatchObject({ status: 400 });
      await expect(f.call("ai:media-test", { provider: "unknown", config: {} })).rejects.toMatchObject({ status: 400 });
    } finally { f.close(); }
  });
  it("saves a free connection encrypted and returns no plaintext key", async () => {
    const f = fixture({ geminiConnect: async () => ({ ok: true, apiKey: "new-fixture-free-key", model: "fixture-free-model" }) });
    try {
      const result = await f.call("ai:free-connect", { provider: "gemini", apiKey: "new-fixture-free-key" });
      expect(result).toEqual({ ok: true, provider: "gemini", model: "fixture-free-model" });
      expect(readFileSync(f.store.path, "utf8")).not.toContain("new-fixture-free-key");
      expect((await f.store.executionSettings()).providers.gemini.apiKey).toBe("new-fixture-free-key");
      await f.call("ai:free-disconnect", { provider: "gemini" });
      expect((await f.store.executionSettings()).providers.gemini.apiKey).toBe("");
    } finally { f.close(); }
  });
  it("does not save a cancelled connection, including when another frame tries to cancel it", async () => {
    let finish!: (value: unknown) => void, started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const f = fixture({ openRouterConnect: async () => { started(); return new Promise((resolve) => { finish = resolve; }); } });
    try {
      const pending = f.call("ai:free-connect", { provider: "openrouter" }, "owner"); await entered;
      await f.call("ai:free-connect-cancel", undefined, "different-owner");
      await f.call("ai:free-connect-cancel", undefined, "owner");
      finish({ ok: true, apiKey: "never-persist-me", model: "fixture:free" });
      expect(await pending).toEqual({ ok: false, reason: "cancelled" }); expect(existsSync(f.store.path)).toBe(false);
    } finally { f.close(); }
  });
  it("preserves settings changed while a browser connection was pending", async () => {
    let finish!: (value: unknown) => void, started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const f = fixture({ openRouterConnect: async () => { started(); return new Promise((resolve) => { finish = resolve; }); } });
    try {
      const pending = f.call("ai:free-connect", { provider: "openrouter" }); await entered;
      await saveKeys(f); const before = readFileSync(f.store.path);
      finish({ ok: true, apiKey: "superseded-key", model: "fixture:free" });
      await expect(pending).rejects.toMatchObject({ code: "office_settings_changed" });
      expect(readFileSync(f.store.path)).toEqual(before);
    } finally { f.close(); }
  });
  it("retains the original subscription validation and does not launch unknown providers", async () => {
    const login = vi.fn(async () => ({ ok: true })), cancel = vi.fn(async () => ({ ok: true }));
    const f = fixture({ subscriptionActions: { launchLogin: login, cancelLogin: cancel } });
    try {
      expect(await f.call("ai:subscription-login", { provider: "unknown" })).toEqual({ ok: false, reason: "invalid" }); expect(login).not.toHaveBeenCalled();
      expect(await f.call("ai:subscription-login", { provider: "codex", mode: "window" })).toEqual({ ok: true }); expect(login).toHaveBeenCalledWith("codex", "window");
      expect(await f.call("ai:subscription-metered", { provider: "codex", accepted: "yes" })).toMatchObject({ ok: false });
    } finally { f.close(); }
    expect(cancel).toHaveBeenCalledWith("codex"); expect(cancel).toHaveBeenCalledWith("claude-code");
  });
});
