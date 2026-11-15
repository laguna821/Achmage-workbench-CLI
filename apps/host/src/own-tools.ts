import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/**
 * Programs the GATEWAY ITSELF runs by name (git, gh), resolved once to an absolute path, preferring
 * folders the person cannot write (the system's: /usr/bin, Program Files) over their own (~/.local/bin,
 * ~/.cargo/bin): any program of the person can plant a file only in the latter (sec-vault round 2,
 * C1 c). The gateway's own PATH no longer holds `<data>/bin` at all (tool-bin.ts). Found only in the
 * person's folders (their own git install) it is used from there: the vault helper answers such a
 * child nothing anyway (it lacks the gateway's ticket). Not found: the bare name, as before.
 */
const resolved = new Map<string, string>();
export function ownTool(name: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const cached = resolved.get(name);
  if (cached) return cached;
  const key = Object.keys(env).find((entry) => entry.toLowerCase() === "path") ?? "PATH";
  const exts = platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean).map((ext) => ext.toLowerCase()) : [""];
  const found: { file: string; system: boolean }[] = [];
  for (const dir of (env[key] ?? "").split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    for (const ext of exts) {
      const file = join(dir, `${name}${ext}`);
      try { if (!statSync(file).isFile()) continue; } catch { continue; }
      let system = false;
      try { accessSync(dir, constants.W_OK); } catch { system = true; }
      found.push({ file, system });
      break;
    }
  }
  const pick = (found.find((entry) => entry.system) ?? found[0])?.file ?? name;
  resolved.set(name, pick);
  return pick;
}
/** Tests: forget what was resolved. */
export function forgetOwnTools() { resolved.clear(); }
