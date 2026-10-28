import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copySkill, integrations } from "./integrations.ts";

// The engines' own configuration in a temporary home folder.
let home = "";
let previous: string | undefined;

beforeEach(() => {
  previous = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "wb-integrations-"));
  process.env.HOME = home;
  mkdirSync(join(home, ".claude/skills/hallym-kordoc"), { recursive: true });
  writeFileSync(join(home, ".claude/skills/hallym-kordoc/SKILL.md"), "---\nname: hallym-kordoc\ndescription: 한글 문서를 만든다\n---\n# x\n");
  mkdirSync(join(home, ".codex/skills/achmage-presentation"), { recursive: true });
  writeFileSync(join(home, ".codex/skills/achmage-presentation/SKILL.md"), "---\nname: achmage-presentation\ndescription: \"발표 자료\"\n---\n");
  mkdirSync(join(home, ".claude/skills/not-a-skill"), { recursive: true });
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({ mcpServers: { achmage: { type: "stdio", command: "/usr/bin/python3", args: ["-u", "mcp"], env: { TOKEN: "x" } }, web: { type: "http", url: "https://example.org/mcp" } } }),
  );
});

afterEach(() => {
  process.env.HOME = previous;
});

describe("MCP servers and skills of both engines", () => {
  it("reads what each engine has, side by side", async () => {
    const view = await integrations({ claude: null, codex: null }, null);
    expect(view.mcp.map((entry) => entry.name)).toEqual(["achmage", "web"]);
    expect(view.mcp[0].claude).toMatchObject({ type: "stdio", command: "/usr/bin/python3", args: ["-u", "mcp"], env: { TOKEN: "x" } });
    expect(view.mcp[1].claude).toMatchObject({ type: "http", url: "https://example.org/mcp" });
    expect(view.skills).toEqual([
      { name: "achmage-presentation", description: "발표 자료", claude: null, codex: join(home, ".codex/skills/achmage-presentation") },
      { name: "hallym-kordoc", description: "한글 문서를 만든다", claude: join(home, ".claude/skills/hallym-kordoc"), codex: null },
    ]);
  });

  it("copies a skill folder to the other engine and never over an existing one", () => {
    const target = copySkill("hallym-kordoc", join(home, ".claude/skills/hallym-kordoc"), "codex");
    expect(target).toBe(join(home, ".codex/skills/hallym-kordoc"));
    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toContain("한글 문서를 만든다");
    expect(() => copySkill("hallym-kordoc", join(home, ".claude/skills/hallym-kordoc"), "codex")).toThrow(/덮어쓰지 않습니다/);
    expect(() => copySkill("../evil", join(home, ".claude/skills/hallym-kordoc"), "codex")).toThrow(/이름/);
    expect(() => copySkill("not-a-skill", join(home, ".claude/skills/not-a-skill"), "codex")).toThrow(/찾지 못했습니다/);
    expect(existsSync(join(home, ".codex/skills/not-a-skill"))).toBe(false);
  });
});
