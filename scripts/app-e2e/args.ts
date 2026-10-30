import { accessSync, constants, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Engines } from "./launch.ts";

export const SCENARIOS = ["start", "panes", "pkm", "workspaces", "navigation", "tabs", "documents", "references", "templates", "template-office", "hwp", "worktrees", "terminals", "preparation", "scm", "scm-remote", "scm-conflict", "scm-hunks"] as const;

export function parseArgs(argv: string[], defaultBinary = join(homedir(), ".local/opt/achmage-workbench/achmage-workbench")) {
  const positional: string[] = [];
  let only: string[] = [...SCENARIOS];
  let engines: Engines = "stand-in";
  for (const arg of argv) {
    if (arg.startsWith("--only=")) only = arg.slice(7).split(",");
    else if (arg.startsWith("--engines=")) {
      const value = arg.slice(10);
      if (value !== "real" && value !== "stand-in") throw new Error(`Unknown engine mode: ${value}`);
      engines = value;
    } else if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 2) throw new Error("Expected binary and output directory only");
  for (const name of only) if (!(SCENARIOS as readonly string[]).includes(name)) throw new Error(`Scenario is not implemented: ${name || "(empty)"}`);
  const binary = resolve(positional[0]?.trim() || defaultBinary);
  if (!statSync(binary).isFile()) throw new Error(`Application binary must be a file: ${binary}`);
  accessSync(binary, constants.X_OK);
  const outDir = resolve(positional[1]?.trim() || join(tmpdir(), "wb-app-e2e"));
  return { binary, outDir, only: [...new Set(only)], engines };
}
