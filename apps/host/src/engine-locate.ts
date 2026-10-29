import { closeSync, lstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";

// Where Claude Code and Codex are on this computer, for every way people install them: PATH (with
// PATHEXT on Windows), npm's global folder, Claude Code's own installer, Codex's own installer,
// Homebrew, the ChatGPT/Codex desktop apps, editor extensions, and Workbench's own install. A GUI
// app often gets a shorter PATH than a terminal, so the usual folders are searched as well.
//
// What is found is turned into something that can be started without a shell: Windows `.cmd` and
// `.ps1` shims and npm's sh shims are read to find what they run; a JavaScript entry runs on the
// gateway's own Node (a GUI app may have no `node` on PATH); an npm install of Codex or Claude Code
// runs the native binary its platform package carries, as the package's own launcher would.
//
// Everything here is pure over a file system view (`FsView`), so layouts of every OS can be tested.

export type EngineName = "claude" | "codex";

/**
 * How an engine was found: `override` set by environment; `path` on PATH; `shell` on the login
 * shell's PATH only (macOS/Linux apps opened from the desktop); `npm` npm's global folder (or a Node
 * version manager's); `native` Claude Code's own installer; `standalone` Codex's own installer;
 * `homebrew`; `app` inside the ChatGPT/Codex desktop app; `editor` inside an editor extension;
 * `managed` installed by Workbench; `sdk` the copy shipped with the Claude Agent SDK.
 */
export type EngineOrigin = "override" | "path" | "shell" | "npm" | "native" | "standalone" | "homebrew" | "app" | "editor" | "managed" | "sdk";

/** How to start an engine: `command` with `args` before the engine's own arguments. */
export type EngineLaunch = {
  /** What was found (shown to the user): a shim, a link or the program itself. */
  path: string;
  command: string;
  args: string[];
  /** Variables the engine's own launcher would set (Codex installed with npm). */
  env: Record<string, string>;
  /** Folders the engine's own launcher would put in front of PATH. */
  paths: string[];
  /** A native program, or a JavaScript entry run on the gateway's Node. */
  kind: "native" | "node";
  origin: EngineOrigin;
};

export type FsView = {
  /** "file" or "dir", following links; a link that cannot be followed (a Windows app alias) counts as a file. */
  kind(path: string): "file" | "dir" | null;
  /** The start of a file (shims, package.json, magic bytes), or null. */
  head(path: string, bytes?: number): Buffer | null;
  /** Names in a folder, or none. */
  list(dir: string): string[];
  /** The path with links resolved (itself when it cannot be). */
  real(path: string): string;
};

export type LocateContext = {
  platform: NodeJS.Platform;
  arch: string;
  env: Record<string, string | undefined>;
  home: string;
  fs: FsView;
  /** The Node that runs the gateway: JavaScript entries run on it. */
  node: string;
  /** Folders only the login shell's PATH has (they are on PATH too, added at start). */
  shellDirs?: string[];
  /** npm's global prefix as npm reports it (asked only when nothing else was found). */
  npmPrefix?: string | null;
  /** Where Workbench installs engines (`<managedDir>/<engine>/current.json`). */
  managedDir?: string | null;
  /** The Agent SDK's own Claude Code binary. */
  sdkClaude?: string | null;
  /**
   * Also look in system-wide places (/usr/bin, /opt, /Applications, Program Files…). Off only
   * for checks that need an engine to be missing on a computer that has one.
   */
  systemWide?: boolean;
};

const pathOf = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);

/** The environment's value for a name, without regard to case on Windows (Path vs PATH). */
export function envValue(env: LocateContext["env"], name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return env[name];
  const key = Object.keys(env).find((entry) => entry.toUpperCase() === name.toUpperCase());
  return key ? env[key] : undefined;
}

export function pathDirs(env: LocateContext["env"], platform: NodeJS.Platform): string[] {
  const value = envValue(env, "PATH", platform) ?? "";
  return value
    .split(platform === "win32" ? ";" : ":")
    .map((dir) => dir.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
}

/** File names a command may have in a folder: PATHEXT's runnable extensions on Windows, then shims. */
export function commandNames(name: string, ctx: Pick<LocateContext, "platform" | "env">): string[] {
  if (ctx.platform !== "win32") return [name];
  const known = new Set([".exe", ".cmd", ".bat", ".com"]);
  const listed = (envValue(ctx.env, "PATHEXT", "win32") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => known.has(ext));
  const exts = [...new Set([...(listed.length ? listed : [".com", ".exe", ".bat", ".cmd"]), ".exe", ".cmd"])];
  // npm also writes a PowerShell shim and an sh shim (no extension) next to the .cmd one.
  return [...exts.map((ext) => `${name}${ext}`), `${name}.ps1`, name];
}

type Place = { dir: string; origin: EngineOrigin };

/** Folders where installers and Node version managers put command line tools, per OS. */
export function knownDirs(ctx: LocateContext): Place[] {
  const p = pathOf(ctx.platform);
  const home = ctx.home;
  const places: Place[] = [];
  const homeCase = ctx.platform === "win32" ? home.toLowerCase() : home;
  const add = (dir: string | undefined | null, origin: EngineOrigin) => {
    if (!dir) return;
    if (ctx.systemWide === false && !(ctx.platform === "win32" ? dir.toLowerCase() : dir).startsWith(homeCase) && !(ctx.platform === "win32" && /appdata/i.test(dir))) return;
    places.push({ dir, origin });
  };
  if (ctx.npmPrefix) add(ctx.platform === "win32" ? ctx.npmPrefix : p.join(ctx.npmPrefix, "bin"), "npm");
  if (ctx.platform === "win32") {
    const appData = envValue(ctx.env, "APPDATA", "win32") ?? p.join(home, "AppData", "Roaming");
    const local = envValue(ctx.env, "LOCALAPPDATA", "win32") ?? p.join(home, "AppData", "Local");
    const programFiles = envValue(ctx.env, "ProgramFiles", "win32") ?? "C:\\Program Files";
    add(envValue(ctx.env, "npm_config_prefix", "win32"), "npm");
    add(p.join(appData, "npm"), "npm");
    add(p.join(home, ".local", "bin"), "native");
    add(envValue(ctx.env, "NVM_SYMLINK", "win32"), "npm");
    add(p.join(programFiles, "nodejs"), "npm");
    add(p.join(local, "Volta", "bin"), "npm");
    add(p.join(local, "pnpm"), "npm");
    add(p.join(home, "scoop", "shims"), "path");
    add(p.join(home, ".bun", "bin"), "npm");
    return places;
  }
  add(envValue(ctx.env, "npm_config_prefix", ctx.platform) && p.join(envValue(ctx.env, "npm_config_prefix", ctx.platform)!, "bin"), "npm");
  add(p.join(home, ".local", "bin"), "native");
  if (ctx.platform === "darwin") {
    add("/opt/homebrew/bin", "homebrew");
    add("/usr/local/bin", "homebrew");
    add(p.join(home, "Library", "pnpm"), "npm");
  } else {
    add("/home/linuxbrew/.linuxbrew/bin", "homebrew");
    add(p.join(home, ".linuxbrew", "bin"), "homebrew");
    add(p.join(home, ".local", "share", "pnpm"), "npm");
    add("/usr/local/bin", "path");
    add("/usr/bin", "path");
  }
  add(p.join(home, ".npm-global", "bin"), "npm");
  add(p.join(home, ".volta", "bin"), "npm");
  add(p.join(home, ".bun", "bin"), "npm");
  add(p.join(home, ".yarn", "bin"), "npm");
  add(p.join(home, ".asdf", "shims"), "npm");
  const nvm = envValue(ctx.env, "NVM_DIR", ctx.platform) ?? p.join(home, ".nvm");
  for (const version of ctx.fs.list(p.join(nvm, "versions", "node")).sort().reverse()) add(p.join(nvm, "versions", "node", version, "bin"), "npm");
  return places;
}

/** Files that are an engine itself, outside any bin folder (desktop apps, editor extensions, own installers). */
function bundledCopies(engine: EngineName, ctx: LocateContext): Place[] {
  const p = pathOf(ctx.platform);
  const exe = ctx.platform === "win32" ? ".exe" : "";
  const home = ctx.home;
  const out: Place[] = [];
  if (engine === "claude") {
    // Claude Code's older "local" install.
    out.push({ dir: p.join(home, ".claude", "local", `claude${exe}`), origin: "native" });
    return out;
  }
  // Codex's own installer keeps versions under ~/.codex/packages/standalone (current → a release).
  const codexHome = envValue(ctx.env, "CODEX_HOME", ctx.platform) ?? p.join(home, ".codex");
  out.push({ dir: p.join(codexHome, "packages", "standalone", "current", "bin", `codex${exe}`), origin: "standalone" });
  out.push({ dir: p.join(codexHome, "packages", "standalone", "current", `codex${exe}`), origin: "standalone" });
  // The ChatGPT and Codex desktop apps carry an engine (often newer, which matters for new models).
  if (ctx.platform === "darwin") {
    for (const root of ["/Applications", p.join(home, "Applications")]) {
      for (const app of ["ChatGPT.app", "Codex.app"]) out.push({ dir: p.join(root, app, "Contents", "Resources", "codex"), origin: "app" });
    }
  } else if (ctx.platform === "win32") {
    const local = envValue(ctx.env, "LOCALAPPDATA", "win32") ?? p.join(home, "AppData", "Local");
    for (const app of ["ChatGPT", "Codex"]) out.push({ dir: p.join(local, "Programs", app, "resources", "codex.exe"), origin: "app" });
  } else {
    out.push({ dir: "/usr/lib/chatgpt/resources/codex", origin: "app" }, { dir: "/opt/ChatGPT/resources/codex", origin: "app" });
  }
  // The Codex editor extension (VS Code and its forks) ships the engine for each platform.
  for (const editor of [".vscode", ".vscode-insiders", ".vscode-oss", ".cursor", ".windsurf"]) {
    const extensions = p.join(home, editor, "extensions");
    for (const name of ctx.fs.list(extensions).filter((entry) => entry.startsWith("openai.chatgpt-")).sort().reverse()) {
      const bin = p.join(extensions, name, "bin");
      for (const target of ctx.fs.list(bin)) out.push({ dir: p.join(bin, target, `codex${exe}`), origin: "editor" });
    }
  }
  return out;
}

const BASE_MARKERS = ["%~dp0", "%dp0%", "$basedir", "${basedir}"];

/**
 * The program a shim runs: npm's `.cmd`, `.ps1` and sh shims (and pnpm's and yarn's, which are
 * alike) name it as a quoted path after a marker for the shim's own folder. The interpreter
 * (`node`) is skipped; the last such path is the target.
 */
export function shimTarget(text: string, shimPath: string, platform: NodeJS.Platform): string | null {
  const p = pathOf(platform);
  const dir = p.dirname(shimPath);
  let target: string | null = null;
  for (const match of text.matchAll(/"([^"\r\n]+)"/g)) {
    // Node's own npm.cmd sets variables first: SET "NPM_CLI_JS=%~dp0\node_modules\npm\bin\npm-cli.js".
    const quoted = match[1]!.replace(/^[A-Za-z_][A-Za-z0-9_]*=/, "");
    const marker = BASE_MARKERS.find((entry) => quoted.startsWith(entry));
    if (!marker) continue;
    const rest = quoted.slice(marker.length).replace(/^[\\/]+/, "");
    if (!rest || /^node(\.exe|\$exe)?$/i.test(rest) || rest.includes("%") || rest.includes("$")) continue;
    target = p.normalize(p.join(dir, rest.replace(/[\\/]+/g, p.sep)));
  }
  return target;
}

const isScript = (path: string) => /\.(c|m)?js$/i.test(path);

/** What a file starts with: a native program of some OS, a script with an interpreter line, or text. */
export function fileKind(head: Buffer | null): "native" | "node-script" | "script" | "text" | null {
  if (!head || head.length === 0) return null;
  if (head[0] === 0x4d && head[1] === 0x5a) return "native"; // MZ: Windows
  if (head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) return "native"; // ELF
  const magic = head.length >= 4 ? head.readUInt32BE(0) : 0;
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic)) return "native"; // Mach-O, universal
  const text = head.toString("utf8", 0, Math.min(head.length, 200));
  if (text.startsWith("#!")) return /\bnode\b/.test(text.split("\n")[0]!) ? "node-script" : "script";
  return "text";
}

/** Rust target names Codex's npm package uses for its platform packages. */
function codexTriple(platform: NodeJS.Platform, arch: string): string | null {
  const triples: Record<string, string> = {
    "linux-x64": "x86_64-unknown-linux-musl",
    "linux-arm64": "aarch64-unknown-linux-musl",
    "darwin-x64": "x86_64-apple-darwin",
    "darwin-arm64": "aarch64-apple-darwin",
    "win32-x64": "x86_64-pc-windows-msvc",
    "win32-arm64": "aarch64-pc-windows-msvc",
  };
  return triples[`${platform}-${arch}`] ?? null;
}

/**
 * The native Codex inside an npm install of `@openai/codex` (`pkgRoot`), where its own launcher
 * (bin/codex.js) looks: the platform package nested or next to it, then the package's vendor folder.
 */
export function codexNpmNative(pkgRoot: string, ctx: Pick<LocateContext, "platform" | "arch" | "fs">): { binary: string; paths: string[] } | null {
  const p = pathOf(ctx.platform);
  const triple = codexTriple(ctx.platform, ctx.arch);
  if (!triple) return null;
  const exe = ctx.platform === "win32" ? "codex.exe" : "codex";
  const platformPackage = `codex-${ctx.platform}-${ctx.arch}`;
  const roots = [p.join(pkgRoot, "node_modules", "@openai", platformPackage), p.join(p.dirname(pkgRoot), platformPackage), pkgRoot];
  for (const root of roots) {
    const vendor = p.join(root, "vendor", triple);
    for (const binary of [p.join(vendor, "bin", exe), p.join(vendor, "codex", exe)]) {
      if (ctx.fs.kind(binary) !== "file") continue;
      // Older packages kept ripgrep in vendor/<triple>/path, which the launcher put on PATH.
      const extra = p.join(vendor, "path");
      return { binary, paths: ctx.fs.kind(extra) === "dir" ? [extra] : [] };
    }
  }
  return null;
}

/**
 * The native Claude Code of an npm install of `@anthropic-ai/claude-code` (`pkgRoot`): its bin/claude.exe
 * once the install script placed it there, else the platform package it would have copied from.
 */
export function claudeNpmNative(pkgRoot: string, ctx: Pick<LocateContext, "platform" | "arch" | "fs">): string | null {
  const p = pathOf(ctx.platform);
  const placed = p.join(pkgRoot, "bin", "claude.exe");
  if (fileKind(ctx.fs.head(placed, 8)) === "native") return placed;
  const exe = ctx.platform === "win32" ? "claude.exe" : "claude";
  const names = ctx.platform === "linux" ? [`claude-code-linux-${ctx.arch}`, `claude-code-linux-${ctx.arch}-musl`] : [`claude-code-${ctx.platform}-${ctx.arch}`];
  for (const name of names) {
    for (const root of [p.join(pkgRoot, "node_modules", "@anthropic-ai", name), p.join(p.dirname(pkgRoot), name)]) {
      const binary = p.join(root, exe);
      if (fileKind(ctx.fs.head(binary, 8)) === "native") return binary;
    }
  }
  return null;
}

/** The npm package folder a file belongs to (`…/node_modules/@scope/name`), when it is in one. */
function packageRootOf(file: string, name: string, platform: NodeJS.Platform): string | null {
  const p = pathOf(platform);
  const parts = file.split(/[\\/]+/);
  const scope = name.split("/");
  for (let index = parts.length - scope.length - 1; index >= 1; index -= 1) {
    if (parts[index - 1] === "node_modules" && scope.every((part, offset) => parts[index + offset] === part)) {
      const root = parts.slice(0, index + scope.length).join(p.sep);
      return file.startsWith(p.sep) && !root.startsWith(p.sep) ? `${p.sep}${root}` : root;
    }
  }
  return null;
}

/**
 * How to start what was found at `path`: shims and links are followed (up to a few steps), npm
 * installs of the engines start their native binary, and JavaScript runs on the gateway's Node.
 * Null when it cannot be started without a shell (a Windows batch file that names nothing).
 */
export function launchFor(path: string, origin: EngineOrigin, ctx: LocateContext, depth = 0): EngineLaunch | null {
  if (depth > 4) return null;
  const p = pathOf(ctx.platform);
  const real = ctx.fs.real(path);
  const base = { path, env: {} as Record<string, string>, paths: [] as string[], origin };
  const lower = real.toLowerCase();
  const follow = (target: string | null) => (target && ctx.fs.kind(target) === "file" ? launchFor(target, origin, ctx, depth + 1) : null);
  const keepPath = (launch: EngineLaunch | null) => (launch ? { ...launch, path } : null);

  if (lower.endsWith(".cmd") || lower.endsWith(".bat") || lower.endsWith(".ps1")) {
    const text = ctx.fs.head(real, 16 * 1024)?.toString("utf8") ?? "";
    return keepPath(follow(shimTarget(text, real, ctx.platform)));
  }
  // An npm install of Codex: start the native engine its launcher would start.
  const codexRoot = packageRootOf(real, "@openai/codex", ctx.platform);
  if (codexRoot) {
    const native = codexNpmNative(ctx.fs.real(codexRoot), ctx);
    if (native) {
      return { ...base, command: native.binary, args: [], kind: "native", paths: native.paths, env: { CODEX_MANAGED_BY_NPM: "1", CODEX_MANAGED_PACKAGE_ROOT: ctx.fs.real(codexRoot) } };
    }
  }
  // An npm install of Claude Code: its native binary, placed or still in the platform package.
  const claudeRoot = packageRootOf(real, "@anthropic-ai/claude-code", ctx.platform);
  if (claudeRoot) {
    const native = claudeNpmNative(claudeRoot, ctx);
    if (native) return { ...base, command: native, args: [], kind: "native" };
    const wrapper = p.join(claudeRoot, "cli-wrapper.cjs");
    if (ctx.fs.kind(wrapper) === "file") return { ...base, command: ctx.node, args: [wrapper], kind: "node" };
  }
  if (isScript(real)) return { ...base, command: ctx.node, args: [real], kind: "node" };
  const head = ctx.fs.head(real, 16 * 1024);
  const kind = fileKind(head);
  // A native program is started by the path it was found at: installers that update by moving a
  // link (Claude Code's, Codex's, Homebrew) then start the new version, and the old one may go.
  if (kind === "native") return ctx.platform === "win32" && !lower.endsWith(".exe") && !lower.endsWith(".com") ? null : { ...base, command: path, args: [], kind: "native" };
  if (kind === "node-script") return { ...base, command: ctx.node, args: [real], kind: "node" };
  if (kind === "script" || kind === "text") {
    // An npm sh shim names its target; follow it so neither sh nor node has to be on PATH.
    const target = shimTarget(head!.toString("utf8"), real, ctx.platform);
    if (target) return keepPath(follow(target));
    if (ctx.platform === "win32") return null;
    // Another script with an interpreter line (a wrapper of the user's own): run it as it is.
    return kind === "script" ? { ...base, command: real, args: [], kind: "native" } : null;
  }
  // A Windows app alias (reparse point) cannot be read but can be started.
  if (kind === null && ctx.platform === "win32" && lower.endsWith(".exe") && ctx.fs.kind(real) === "file") return { ...base, command: real, args: [], kind: "native" };
  return null;
}

/** The engine Workbench installed, as its record names it. */
export function managedEntry(engine: EngineName, ctx: LocateContext): string | null {
  if (!ctx.managedDir) return null;
  const p = pathOf(ctx.platform);
  const record = ctx.fs.head(p.join(ctx.managedDir, engine, "current.json"), 64 * 1024);
  if (!record) return null;
  try {
    const entry = (JSON.parse(record.toString("utf8")) as { entry?: unknown }).entry;
    return typeof entry === "string" && ctx.fs.kind(entry) === "file" ? entry : null;
  } catch {
    return null;
  }
}

/**
 * Every copy of an engine on this computer, the user's own first (in the order a shell would find
 * them, then the usual folders), then Workbench's install, then the SDK's copy. Each only once.
 */
export function engineCandidates(engine: EngineName, ctx: LocateContext): EngineLaunch[] {
  const p = pathOf(ctx.platform);
  const out: EngineLaunch[] = [];
  const seen = new Set<string>();
  const shell = new Set(ctx.shellDirs ?? []);
  const take = (file: string, origin: EngineOrigin) => {
    if (ctx.fs.kind(file) !== "file") return;
    const launch = launchFor(file, origin, ctx);
    if (!launch) return;
    // The same program reached through different links counts once.
    const key = `${ctx.fs.real(launch.command)}\u0000${launch.args.join("\u0000")}`;
    const normalized = ctx.platform === "win32" ? key.toLowerCase() : key;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    out.push({ ...launch, origin: refineOrigin(ctx.fs.real(file), launch, engine, ctx) });
  };
  const names = commandNames(engine, ctx);
  const dirs: Place[] = [...pathDirs(ctx.env, ctx.platform).map((dir): Place => ({ dir, origin: shell.has(dir) ? "shell" : "path" })), ...knownDirs(ctx)];
  for (const { dir, origin } of dirs) {
    for (const name of names) take(p.join(dir, name), origin);
  }
  for (const { dir: file, origin } of bundledCopies(engine, ctx)) {
    if (ctx.systemWide === false && !file.startsWith(ctx.home)) continue;
    take(file, origin);
  }
  const managed = managedEntry(engine, ctx);
  if (managed) take(managed, "managed");
  if (engine === "claude" && ctx.sdkClaude) take(ctx.sdkClaude, "sdk");
  return out;
}

/**
 * Where a copy really comes from, by what it resolves to (a PATH entry is often a link into an
 * installer's folder): npm, Homebrew, Claude Code's or Codex's own installer, an app, an editor.
 */
function refineOrigin(real: string, launch: EngineLaunch, engine: EngineName, ctx: LocateContext): EngineOrigin {
  const origin = launch.origin;
  if (origin === "override" || origin === "managed" || origin === "sdk" || origin === "app" || origin === "editor") return origin;
  const target = `${real}\n${launch.command}\n${launch.args.join("\n")}`.replace(/\\/g, "/");
  const lower = ctx.platform === "win32" ? target.toLowerCase() : target;
  const home = (ctx.platform === "win32" ? ctx.home.toLowerCase() : ctx.home).replace(/\\/g, "/");
  if (engine === "codex" && lower.includes("/.codex/packages/standalone/")) return "standalone";
  if (engine === "claude" && (lower.includes(`${home}/.local/share/claude/`) || lower.includes(`${home}/.claude/local/`))) return "native";
  if (/\/(cellar|caskroom)\//i.test(target) || lower.startsWith("/opt/homebrew/") || lower.includes("/.linuxbrew/")) return "homebrew";
  if (lower.includes("/node_modules/")) return origin === "shell" ? "shell" : "npm";
  if (origin === "native" && engine !== "claude") return "path";
  return origin;
}

/** A real file system for `LocateContext.fs`. */
export const realFs: FsView = {
  kind(path) {
    try {
      const stat = statSync(path);
      return stat.isDirectory() ? "dir" : stat.isFile() ? "file" : null;
    } catch {
      try {
        // A Windows app execution alias: a reparse point stat cannot follow.
        return lstatSync(path).isSymbolicLink() || process.platform === "win32" ? "file" : null;
      } catch {
        return null;
      }
    }
  },
  head(path, bytes = 4096) {
    let fd: number | null = null;
    try {
      fd = openSync(path, "r");
      const buffer = Buffer.alloc(bytes);
      const read = readSync(fd, buffer, 0, bytes, 0);
      return buffer.subarray(0, read);
    } catch {
      return null;
    } finally {
      if (fd !== null) closeSync(fd);
    }
  },
  list(dir) {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
  real(path) {
    try {
      return realpathSync.native(path);
    } catch {
      return path;
    }
  },
};
