import { execFile } from "node:child_process";
import { cpSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { IntegrationsView, McpDefinition, SkillEntry } from "@workbench/contracts";
import { HttpError } from "./errors.ts";
import { engineEnv } from "./engine-env.ts";

// MCP servers and skills as the two engines themselves see them. Workbench keeps no store of its
// own: it reads the engines' configuration, and writes only on an explicit click, through each
// engine's official command (`claude mcp add-json`, `codex mcp add`) or by copying a skill folder
// into the other engine's skills folder. Nothing is written at start-up.

const run = promisify(execFile);

export type EngineBinaries = { claude: string | null; codex: string | null };

const home = () => homedir();
const claudeSkillDirs = () => [join(home(), ".claude/skills")];
const codexSkillDirs = () => [join(home(), ".codex/skills"), join(home(), ".agents/skills")];

/** Claude's user-scope servers from ~/.claude.json (read only; written through `claude mcp`). */
function claudeServers(): Record<string, McpDefinition> {
  try {
    const config = JSON.parse(readFileSync(join(home(), ".claude.json"), "utf8")) as { mcpServers?: Record<string, Record<string, unknown>> };
    const out: Record<string, McpDefinition> = {};
    for (const [name, entry] of Object.entries(config.mcpServers ?? {})) {
      const type = typeof entry.type === "string" ? entry.type : entry.url ? "http" : "stdio";
      out[name] =
        type === "stdio"
          ? { type: "stdio", command: String(entry.command ?? ""), args: Array.isArray(entry.args) ? entry.args.map(String) : [], env: envOf(entry.env), url: null, enabled: true }
          : { type: type === "sse" ? "sse" : "http", command: null, args: [], env: {}, url: String(entry.url ?? ""), enabled: true };
    }
    return out;
  } catch {
    return {};
  }
}

const envOf = (value: unknown): Record<string, string> =>
  value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, String(entry)])) : {};

/** Codex's servers through its own `codex mcp list --json`. */
async function codexServers(codex: string | null): Promise<Record<string, McpDefinition>> {
  if (!codex) return {};
  try {
    const { stdout } = await run(codex, ["mcp", "list", "--json"], { timeout: 20_000, env: engineEnv({ command: codex }), maxBuffer: 8 * 1024 * 1024 });
    const list = JSON.parse(stdout) as { name: string; enabled?: boolean; transport?: { type?: string; command?: string; args?: string[]; env?: Record<string, string> | null; url?: string } }[];
    const out: Record<string, McpDefinition> = {};
    for (const entry of list) {
      const transport = entry.transport ?? {};
      out[entry.name] =
        transport.type === "stdio"
          ? { type: "stdio", command: transport.command ?? "", args: transport.args ?? [], env: envOf(transport.env), url: null, enabled: entry.enabled !== false }
          : { type: "http", command: null, args: [], env: {}, url: transport.url ?? "", enabled: entry.enabled !== false };
    }
    return out;
  } catch {
    return {};
  }
}

function description(skillFile: string): string | null {
  try {
    const head = readFileSync(skillFile, "utf8").slice(0, 4000);
    const match = /^---\n([\s\S]*?)\n---/.exec(head);
    const line = match?.[1].split("\n").find((entry) => entry.startsWith("description:"));
    return line ? line.slice("description:".length).trim().replace(/^["']|["']$/g, "").slice(0, 240) : null;
  } catch {
    return null;
  }
}

function skillsIn(dirs: string[]): Record<string, { path: string; description: string | null }> {
  const out: Record<string, { path: string; description: string | null }> = {};
  for (const dir of dirs) {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(dir, name);
      const file = join(path, "SKILL.md");
      if (out[name] || !existsSync(file)) continue;
      out[name] = { path, description: description(file) };
    }
  }
  return out;
}

export async function integrations(binaries: EngineBinaries, ieumSkill: string | null): Promise<IntegrationsView> {
  const claude = claudeServers();
  const codex = await codexServers(binaries.codex);
  const names = [...new Set([...Object.keys(claude), ...Object.keys(codex)])].sort();
  const claudeSkills = skillsIn(claudeSkillDirs());
  const codexSkills = skillsIn(codexSkillDirs());
  const skillNames = [...new Set([...Object.keys(claudeSkills), ...Object.keys(codexSkills)])].sort();
  const skills: SkillEntry[] = skillNames.map((name) => ({
    name,
    description: claudeSkills[name]?.description ?? codexSkills[name]?.description ?? null,
    claude: claudeSkills[name]?.path ?? null,
    codex: codexSkills[name]?.path ?? null,
  }));
  return {
    mcp: names.map((name) => ({ name, claude: claude[name] ?? null, codex: codex[name] ?? null })),
    skills,
    paths: { claudeConfig: join(home(), ".claude.json"), codexConfig: join(home(), ".codex/config.toml"), claudeSkills: claudeSkillDirs()[0], codexSkills: codexSkillDirs()[0] },
    ieumSkill: ieumSkill ? { source: ieumSkill, claude: Boolean(claudeSkills.ieumoffice), codex: Boolean(codexSkills.ieumoffice) } : null,
  };
}

const NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/** Give the other engine the same MCP server, through that engine's own command (user scope). */
export async function copyMcp(binaries: EngineBinaries, name: string, to: "claude" | "codex") {
  if (!NAME.test(name)) throw new HttpError(400, "bad_name", "MCP 서버 이름이 올바르지 않습니다.");
  const view = await integrations(binaries, null);
  const entry = view.mcp.find((server) => server.name === name);
  const source = to === "claude" ? entry?.codex : entry?.claude;
  if (!entry || !source) throw new HttpError(404, "mcp_missing", "복사할 MCP 서버를 찾지 못했습니다.");
  if ((to === "claude" ? entry.claude : entry.codex) !== null) throw new HttpError(409, "mcp_exists", "이미 같은 이름의 서버가 있어 덮어쓰지 않습니다.");
  if (to === "claude") {
    if (!binaries.claude) throw new HttpError(501, "claude_missing", "Claude Code가 없습니다.");
    const json = source.type === "stdio" ? { type: "stdio", command: source.command, args: source.args, env: source.env } : { type: source.type, url: source.url };
    await run(binaries.claude, ["mcp", "add-json", "--scope", "user", name, JSON.stringify(json)], { timeout: 30_000, env: engineEnv({ command: binaries.claude }) });
  } else {
    if (!binaries.codex) throw new HttpError(501, "codex_missing", "Codex가 없습니다.");
    const args =
      source.type === "stdio"
        ? ["mcp", "add", name, ...Object.entries(source.env).flatMap(([key, value]) => ["--env", `${key}=${value}`]), "--", source.command ?? "", ...source.args]
        : ["mcp", "add", name, "--url", source.url ?? ""];
    await run(binaries.codex, args, { timeout: 30_000, env: engineEnv({ command: binaries.codex }) });
  }
  return integrations(binaries, null);
}

/** Copy a skill folder into the other engine's skills folder (never over an existing one). */
export function copySkill(name: string, from: string, to: "claude" | "codex") {
  if (!NAME.test(name)) throw new HttpError(400, "bad_name", "스킬 이름이 올바르지 않습니다.");
  if (!existsSync(join(from, "SKILL.md")) || !statSync(from).isDirectory()) throw new HttpError(404, "skill_missing", "스킬 폴더를 찾지 못했습니다.");
  const target = join(to === "claude" ? claudeSkillDirs()[0] : codexSkillDirs()[0], name);
  if (existsSync(target)) throw new HttpError(409, "skill_exists", `이미 ${target}이(가) 있어 덮어쓰지 않습니다.`);
  cpSync(from, target, { recursive: true, dereference: true, errorOnExist: true, force: false });
  return target;
}
