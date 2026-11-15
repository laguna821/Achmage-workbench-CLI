import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openKit } from "../channels/test-kit.ts";
import { integrations } from "../integrations.ts";

// design §6.7: `GET /api/integrations` (SessionManager.integrations) gave the screen the values of
// MCP servers' environment variables. The screen shows names only; the values stay in the gateway,
// where copying a server to the other engine still reads them. Made-up values only.
const VALUE = "zz-secret-mcp-env-0005";
let home = "", previous: string | undefined;
const dirs: string[] = [];
beforeEach(() => {
  previous = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "wb-int-env-"));
  dirs.push(home);
  process.env.HOME = home;
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: {
    notion: { type: "stdio", command: "npx", args: ["-y", "notion-mcp"], env: { NOTION_TOKEN: VALUE, LOG: "1" } },
    other: { type: "stdio", command: "srv", args: [`--api-key=${VALUE}`, "--token", VALUE, "--name", "연구", `sk-${"a".repeat(24)}`], env: {} },
    web: { type: "http", url: `https://mcp.example.org/x?token=${VALUE}&mode=read` },
  } }));
});
afterEach(() => {
  process.env.HOME = previous;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("MCP environment variables over HTTP", () => {
  it("are named, never valued, in what the screen gets; the gateway's own copy path still has the values", async () => {
    const k = openKit(mkdtempSync(join(tmpdir(), "wb-int-kit-")), { now: Date.now() });
    dirs.push(join(k.dataDir, ".."));
    const view = await k.manager.integrations();
    expect(JSON.stringify(view)).not.toContain(VALUE);
    const notion = view.mcp.find((entry) => entry.name === "notion")!, other = view.mcp.find((entry) => entry.name === "other")!, web = view.mcp.find((entry) => entry.name === "web")!;
    expect(notion.claude).toMatchObject({ type: "stdio", command: "npx", env: { NOTION_TOKEN: "", LOG: "" } });
    expect(Object.keys(notion.claude!.env)).toEqual(["NOTION_TOKEN", "LOG"]);
    // Obvious key shapes in arguments and addresses are blanked too (round 1, Minor 13).
    expect(other.claude!.args).toEqual(["--api-key=", "--token", "", "--name", "연구", "[API 키]"]);
    expect(web.claude!.url).toBe("https://mcp.example.org/x?token=&mode=read");
    expect((await integrations({ claude: null, codex: null }, null)).mcp.find((entry) => entry.name === "notion")!.claude!.env.NOTION_TOKEN).toBe(VALUE);
    await k.manager.shutdown();
    k.store.close();
  });
});
