import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { ieumAppEnvironment, type IeumInstall } from "./ieumoffice.ts";
import { repoRoot, shipped } from "./resources.ts";
import { bundledHallymSkill } from "./hallym-kordoc.ts";
import { setEngineToolDir } from "./engine-env.ts";

// The document tools engines run by name: `kordoc` and `ieumoffice`, small wrappers in the gateway's
// data folder, on the PATH of every engine the gateway starts (engine-env.ts) — never on the
// gateway's own PATH: any program of the person can write that folder, and a `git` planted there
// was run by the gateway itself (sec-vault review, Run 3). A path inside the app would need
// quoting that differs between bash, PowerShell and cmd ("C:\Program Files\…", "Achmage
// Workbench.app"); a bare name works in all of them. Rewritten at each start (the app may move).

const posixQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** The wrapper files for one tool: an sh script (also for Git Bash on Windows) and, on Windows, a .cmd. */
/**
 * IeumOffice's cloud commands (sec-vault review M2): a provider key the person saved in the app is
 * sealed, and since sec-vault the app opens it for no program an AI runs — the vendored command
 * line then reports the key as MISSING, which would send the person to enter again a key they have.
 * The wrapper adds what is true and what to do when one of these commands fails.
 */
export const IEUM_CLOUD_COMMANDS = ["search", "read-url", "image", "media", "pdf-ai-read", "pdf-translate", "epub-translate", "pdf-job"] as const;
export const IEUM_CLOUD_NOTE = "참고: 이음오피스에 저장한 AI·검색 키는 지워지지 않았습니다. Workbench는 보안을 위해 AI가 실행하는 명령에는 저장된 키를 열어 주지 않으므로, 이 명령은 키가 없다고 답합니다. 키를 다시 넣지 마시고, 이 작업은 Workbench 앱의 이음오피스 화면(문서 도구)에서 실행하거나 키 없이 되는 방법(무료 검색 등)을 쓰세요.";

export function wrapperFiles(
  name: string,
  command: { file: string; args: string[]; env?: Record<string, string>; unsetEnv?: string[]; onFailure?: { commands: readonly string[]; note: string } },
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const shPath = (value: string) => (platform === "win32" ? value.replace(/\\/g, "/") : value);
  const exports = Object.entries(command.env ?? {})
    .map(([key, value]) => `export ${key}=${posixQuote(shPath(value))}\n`)
    .join("");
  const unsets = (command.unsetEnv ?? []).map((key) => `unset ${key}\n`).join("");
  const line = [command.file, ...command.args].map((part) => posixQuote(shPath(part))).join(" ");
  const failure = command.onFailure;
  const sh = failure
    ? `#!/bin/sh\n# Written by Achmage Workbench (tool-bin.ts).\n${unsets}${exports}${line} "$@"\ncode=$?\nif [ "$code" -ne 0 ]; then for a in "$@"; do case "$a" in ${failure.commands.join("|")}) printf '%s\\n' ${posixQuote(failure.note)} >&2; break;; esac; done; fi\nexit "$code"\n`
    : `#!/bin/sh\n# Written by Achmage Workbench (tool-bin.ts).\n${unsets}${exports}exec ${line} "$@"\n`;
  const files: Record<string, string> = { [name]: sh };
  if (platform === "win32") {
    const sets = (command.unsetEnv ?? []).map((key) => `set "${key}="\r\n`).join("") + Object.entries(command.env ?? {}).map(([key, value]) => `set "${key}=${value}"\r\n`).join("");
    const call = `${[command.file, ...command.args].map((part) => `"${part}"`).join(" ")} %*`;
    const after = failure ? `set "code=%ERRORLEVEL%"\r\nif not "%code%"=="0" (\r\n${failure.commands.map((c) => `  if /I "%~1"=="${c}" echo ${failure.note.replace(/[()&|<>^]/g, (ch) => `^${ch}`)} 1>&2\r\n`).join("")})\r\nexit /b %code%\r\n` : "";
    files[`${name}.cmd`] = `@echo off\r\nrem Written by Achmage Workbench (tool-bin.ts).\r\nsetlocal\r\n${sets}${call}\r\n${after}`;
  }
  return files;
}

/** Remove `<dataDir>/bin` from this process's own PATH (an earlier build's login unit put it first). */
export function withoutToolDir(dataDir: string, env: NodeJS.ProcessEnv = process.env) {
  const dir = join(dataDir, "bin");
  const key = Object.keys(env).find((entry) => entry.toLowerCase() === "path") ?? "PATH";
  const parts = (env[key] ?? "").split(delimiter);
  const kept = parts.filter((entry) => entry && entry !== dir && entry !== `${dir}/` && entry !== `${dir}\\`);
  if (kept.length !== parts.filter(Boolean).length) env[key] = kept.join(delimiter);
}

/**
 * Write the wrappers into `<dataDir>/bin`, the folder engines get first on their PATH (engineEnv).
 * Returns the names written.
 */
export function installToolWrappers(dataDir: string, tools: { kordoc: string | null; ieum: IeumInstall | null; ieumAppWrapper?: string | null }) {
  const dir = join(dataDir, "bin");
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  const write = (name: string, command: Parameters<typeof wrapperFiles>[1] | null) => {
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
  // Remove our obsolete wrapper; the public skill is the supported creation interface.
  write("kordoc", null);
  const hangulSkill = bundledHallymSkill();
  write("hallym-kordoc", hangulSkill ? { file: process.execPath, args: [join(hangulSkill, "scripts/run.mjs")] } : null);
  const hwp = shipped("host/hwp-cli.mjs") ?? (repoRoot() ? join(repoRoot()!, "apps/host/dist/hwp-cli.mjs") : null);
  write("workbench-hwp", hwp ? { file: process.execPath, args: [hwp] } : null);
  const ieum = tools.ieum;
  write(
    "ieumoffice",
    ieum
      ? { file: process.execPath, args: [ieum.script], unsetEnv: ["ELECTRON_RUN_AS_NODE"], env: ieumAppEnvironment(dataDir, tools.ieumAppWrapper ?? ieum.app), onFailure: { commands: IEUM_CLOUD_COMMANDS, note: IEUM_CLOUD_NOTE } }
      : null,
  );
  setEngineToolDir(dir);
  return written;
}
