import { mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventBus } from "./bus.ts";
import { EnginePrefs } from "./engine-prefs.ts";
import { createHttpServer } from "./http.ts";
import { agyEnv, strippedAgyVars } from "./providers/gemini-locate.ts";
import { effectiveAccess, permissionOption } from "./providers/gemini-map.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";
import { tempDir } from "./test-temp.ts";

// The owner, 2026-11-21: "Gemini 는 구독 로그인만으로 하기로 한거 아닌가?" — Gemini in Workbench is subscription login only,
// through agy's own sign-in (a personal or a company Google account; agy decides). No API-key kind, no Cloud / ADC
// route, no 전체 접근, never "always allow"; the opt-in and warning apply to every Gemini sign-in.

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

describe("Gemini: subscription login only", () => {
  it("the settings keep only the opt-in; a stored API-key / Enterprise choice from before is dropped", () => {
    const dir = tempDir("wb-gemini-sub-");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "engine-prefs.json"), JSON.stringify({ personalTools: {}, gemini: { loginKind: "apiKey", googleOptIn: true, apiKeyEntry: "old-key" } }));
    const prefs = new EnginePrefs(dir);
    expect(prefs.gemini()).toEqual({ googleOptIn: true });
    expect(prefs.setGemini({ loginKind: "enterprise", apiKeyEntry: "x", googleOptIn: false })).toEqual({ googleOptIn: false });
  });

  it("the settings route takes the opt-in and nothing else", async () => {
    const dir = tempDir("wb-gemini-sub-route-");
    const manager = new SessionManager(new Store(join(dir, "state.sqlite")), new EventBus(), { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works") });
    const enginePrefs = new EnginePrefs(dir);
    const token = "test-gateway-token-for-gemini-settings";
    const server = createHttpServer(manager, new EventBus(), { token, webDir: null, enginePrefs });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    cleanup.push(() => server.close());
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/providers/gemini/settings`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ loginKind: "apiKey", apiKeyEntry: "x", googleOptIn: true }),
    });
    expect(response.status).toBe(200);
    expect(enginePrefs.gemini()).toEqual({ googleOptIn: true });
  });

  it("agy never gets a key, a Cloud project or ADC: every such variable is scrubbed", () => {
    const base = { PATH: "/bin", GEMINI_API_KEY: "k", GOOGLE_API_KEY: "k", GOOGLE_CLOUD_PROJECT: "p", GOOGLE_APPLICATION_CREDENTIALS: "/c", AGY_ADC_AUTH: "true", CLOUDSDK_CONFIG: "/g" };
    const env = agyEnv({ base, os: "linux" });
    for (const name of Object.keys(base).filter((name) => name !== "PATH")) expect(env[name], name).toBeUndefined();
    expect(strippedAgyVars(base, "linux").sort()).toEqual(["AGY_ADC_AUTH", "CLOUDSDK_CONFIG", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT"]);
  });

  it("no 전체 접근 and never 'always allow'", () => {
    expect(effectiveAccess("full")).toBe("auto");
    const onlyAlways = [{ optionId: "aa", name: "Always allow", kind: "allow_always" }, { optionId: "r1", name: "Reject", kind: "reject_once" }];
    expect(permissionOption(onlyAlways, "accept")).toBeNull();
    expect(permissionOption(onlyAlways, "decline")).toBe("r1");
  });
});
