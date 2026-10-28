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
