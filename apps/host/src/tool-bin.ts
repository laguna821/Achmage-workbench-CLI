import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { ieumAppEnvironment, type IeumInstall } from "./ieumoffice.ts";
import { repoRoot, shipped } from "./resources.ts";

// The document tools engines run by name: `kordoc` and `ieumoffice`, small wrappers in the gateway's
// data folder, on the PATH of everything the gateway starts. A path inside the app would need
// quoting that differs between bash, PowerShell and cmd ("C:\Program Files\…", "Achmage
// Workbench.app"); a bare name works in all of them. Rewritten at each start (the app may move).

const posixQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** The wrapper files for one tool: an sh script (also for Git Bash on Windows) and, on Windows, a .cmd. */
export function wrapperFiles(
  name: string,
  command: { file: string; args: string[]; env?: Record<string, string>; unsetEnv?: string[] },
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const shPath = (value: string) => (platform === "win32" ? value.replace(/\\/g, "/") : value);
  const exports = Object.entries(command.env ?? {})
    .map(([key, value]) => `export ${key}=${posixQuote(shPath(value))}\n`)
    .join("");
  const unsets = (command.unsetEnv ?? []).map((key) => `unset ${key}\n`).join("");
  const sh = `#!/bin/sh\n# Written by Achmage Workbench (tool-bin.ts).\n${unsets}${exports}exec ${[command.file, ...command.args].map((part) => posixQuote(shPath(part))).join(" ")} "$@"\n`;
  const files: Record<string, string> = { [name]: sh };
  if (platform === "win32") {
    const sets = (command.unsetEnv ?? []).map((key) => `set "${key}="\r\n`).join("") + Object.entries(command.env ?? {}).map(([key, value]) => `set "${key}=${value}"\r\n`).join("");
    files[`${name}.cmd`] = `@echo off\r\nrem Written by Achmage Workbench (tool-bin.ts).\r\nsetlocal\r\n${sets}${[command.file, ...command.args].map((part) => `"${part}"`).join(" ")} %*\r\n`;
  }
  return files;
}

/**
 * Write the wrappers into `<dataDir>/bin` and put that folder first on this process's PATH (engines
 * inherit it). Returns the names written.
 */
export function installToolWrappers(dataDir: string, tools: { kordoc: string | null; ieum: IeumInstall | null; ieumAppWrapper?: string | null }) {
  const dir = join(dataDir, "bin");
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  const write = (name: string, command: { file: string; args: string[]; env?: Record<string, string>; unsetEnv?: string[] } | null) => {
    for (const file of [name, `${name}.cmd`]) rmSync(join(dir, file), { force: true });
    if (!command) return;
    for (const [file, text] of Object.entries(wrapperFiles(name, command))) {
      const path = join(dir, file);
      let same = false;
      try {
        same = readFileSync(path, "utf8") === text;
      } catch {
        // Not written yet.
      }
      if (!same) writeFileSync(path, text, { mode: 0o755 });
      chmodSync(path, 0o755);
    }
    written.push(name);
  };
  write("kordoc", tools.kordoc ? { file: process.execPath, args: [tools.kordoc] } : null);
  const hwp = shipped("host/hwp-cli.mjs") ?? (repoRoot() ? join(repoRoot()!, "apps/host/dist/hwp-cli.mjs") : null);
  write("workbench-hwp", hwp ? { file: process.execPath, args: [hwp] } : null);
  const ieum = tools.ieum;
  write(
    "ieumoffice",
    ieum
      ? { file: process.execPath, args: [ieum.script], unsetEnv: ["ELECTRON_RUN_AS_NODE"], env: ieumAppEnvironment(dataDir, tools.ieumAppWrapper ?? ieum.app) }
      : null,
  );
  const key = Object.keys(process.env).find((entry) => entry.toLowerCase() === "path") ?? "PATH";
  const parts = (process.env[key] ?? "").split(delimiter).filter((entry) => entry && entry !== dir);
  process.env[key] = [dir, ...parts].join(delimiter);
  return written;
}
