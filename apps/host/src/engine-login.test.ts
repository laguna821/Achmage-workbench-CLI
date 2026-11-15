import { describe, expect, it } from "vitest";
import { BILLING_ENV_VARS, billingVarsIn, claudeSdkEnv, engineEnv } from "./engine-env.ts";
import { accountOf, codexAccountInfo, parseClaudeAuthStatus } from "./engine-login.ts";

describe("engine environment", () => {
  it("starts engines without billing variables and keeps everything else", () => {
    const base = { PATH: "/usr/bin", HOME: "/home/a", ANTHROPIC_API_KEY: "sk-x", OPENAI_BASE_URL: "http://proxy", CLAUDE_CODE_OAUTH_TOKEN: "t" };
    const env = engineEnv({ base, command: "/opt/claude/bin/claude", platform: "linux" });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("t");
    expect(env.HOME).toBe("/home/a");
    expect(env.PATH).toBe("/opt/claude/bin:/usr/bin");
    expect(base.ANTHROPIC_API_KEY).toBe("sk-x");
    expect(billingVarsIn(base, "linux").sort()).toEqual(["ANTHROPIC_API_KEY", "OPENAI_BASE_URL"]);
  });

  it("matches names without case on Windows", () => {
    const env = engineEnv({ base: { anthropic_api_key: "sk", Path: "C:\\x" }, platform: "win32" });
    expect(env.anthropic_api_key).toBeUndefined();
    expect(BILLING_ENV_VARS).toContain("CODEX_API_KEY");
  });

  it("passes of the app's own variables only the allow-list: nothing that points at the vault helper or the gateway's door", () => {
    const base = {
      PATH: "/usr/bin", HOME: "/home/a", GITHUB_TOKEN: "the person's own",
      WORKBENCH_SECRET_BIN: "/opt/wb/app", WORKBENCH_PTY_BIN: "/opt/wb/app", WORKBENCH_APP_BIN: "/opt/wb/app",
      WORKBENCH_TOKEN: "gateway-door", WORKBENCH_PORT: "47820", WORKBENCH_HOST_RUNNER: "/x", WORKBENCH_CLI_INPUT: "/y",
      WORKBENCH_TELEGRAM_API: "http://127.0.0.1:1", WORKBENCH_CLAUDE_BIN: "/c", WORKBENCH_WEB_DIR: "/w",
      WORKBENCH_DATA_DIR: "/d", WORKBENCH_RESOURCES_DIR: "/r", GENOFFICE_AI_SETTINGS: "/d/office/ai-settings.json",
    };
    const env = engineEnv({ base, platform: "linux", extra: { WORKBENCH_FIND_SESSION: "s1" } });
    for (const name of ["WORKBENCH_SECRET_BIN", "WORKBENCH_PTY_BIN", "WORKBENCH_TOKEN", "WORKBENCH_PORT", "WORKBENCH_HOST_RUNNER", "WORKBENCH_CLI_INPUT", "WORKBENCH_TELEGRAM_API", "WORKBENCH_CLAUDE_BIN", "WORKBENCH_WEB_DIR", "GENOFFICE_AI_SETTINGS"])
      expect(env[name], name).toBeUndefined();
    expect(Object.keys(env).filter((name) => /^(WORKBENCH|GENOFFICE)_/.test(name)).sort()).toEqual(["WORKBENCH_APP_BIN", "WORKBENCH_DATA_DIR", "WORKBENCH_FIND_SESSION", "WORKBENCH_RESOURCES_DIR"]);
    // The person's own environment is theirs to give their engines (billing variables aside).
    expect(env.GITHUB_TOKEN).toBe("the person's own");
    const windows = engineEnv({ base: { Path: "C:\\x", workbench_secret_bin: "C:\\wb.exe", Workbench_Token: "t" }, platform: "win32" });
    expect(windows.workbench_secret_bin).toBeUndefined();
    expect(windows.Workbench_Token).toBeUndefined();
  });

  it("gives the Claude SDK the same environment, without the helper's path", () => {
    process.env.WORKBENCH_SECRET_BIN = "/opt/wb/app"; process.env.WORKBENCH_PTY_BIN = "/opt/wb/app";
    try {
      const env = claudeSdkEnv("/usr/bin/claude");
      expect(env.WORKBENCH_SECRET_BIN).toBeUndefined();
      expect(env.WORKBENCH_PTY_BIN).toBeUndefined();
    } finally { delete process.env.WORKBENCH_SECRET_BIN; delete process.env.WORKBENCH_PTY_BIN; }
  });

  it("gives the SDK plain strings with a client tag", () => {
    const env = claudeSdkEnv("/usr/bin/claude");
    expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toMatch(/^achmage-workbench\//);
    expect(Object.values(env).every((value) => typeof value === "string")).toBe(true);
  });
});

describe("engine login", () => {
  it("tells a Claude subscription from metered routes", () => {
    expect(parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max","email":"a@b.kr"}')).toEqual({
      signedIn: true,
      method: "subscription",
      plan: "max",
      account: "a@b.kr",
    });
    expect(parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty"}')).toMatchObject({ method: "metered" });
    expect(parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"bedrock","subscriptionType":"max"}')).toMatchObject({ method: "metered" });
    expect(parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}')).toMatchObject({ method: "unknown" });
    expect(parseClaudeAuthStatus('{"loggedIn":false}')).toEqual({ signedIn: false });
    expect(parseClaudeAuthStatus("warning\n{\"loggedIn\":false}\n")).toEqual({ signedIn: false });
    expect(parseClaudeAuthStatus("not json")).toBeNull();
  });

  it("reads Codex account/read", () => {
    expect(codexAccountInfo({ account: { type: "chatgpt", planType: "plus", email: "a@b.kr" }, requiresOpenaiAuth: true })).toEqual({
      signedIn: true,
      method: "subscription",
      plan: "plus",
      account: "a@b.kr",
    });
    expect(codexAccountInfo({ account: { type: "apiKey" }, requiresOpenaiAuth: true })).toMatchObject({ method: "metered" });
    expect(codexAccountInfo({ account: null, requiresOpenaiAuth: true })).toEqual({ signedIn: false });
    expect(codexAccountInfo({ account: null, requiresOpenaiAuth: false })).toMatchObject({ method: "unknown" });
  });

  it("keeps only an e-mail address as the account", () => {
    expect(accountOf("  a.b@c.co.kr ")).toBe("a.b@c.co.kr");
    expect(accountOf("Name <a@b.kr>")).toBeNull();
    expect(accountOf(42)).toBeNull();
  });
});
