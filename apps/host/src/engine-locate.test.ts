import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { commandNames, engineCandidates, fileKind, launchFor, shimTarget, type FsView, type LocateContext } from "./engine-locate.ts";

// Fake directory layouts of each OS, as people really have the engines installed.

type Entry = string | Buffer | { link: string };

/** A file system from a map of absolute paths (files, and links with their target). */
function fakeFs(platform: NodeJS.Platform, entries: Record<string, Entry>): FsView {
  const p = platform === "win32" ? win32 : posix;
  const norm = (path: string) => (platform === "win32" ? p.normalize(path).toLowerCase() : p.normalize(path));
  const files = new Map<string, Entry>();
  const dirs = new Map<string, Set<string>>();
  for (const [path, entry] of Object.entries(entries)) {
    files.set(norm(path), entry);
    let child = p.normalize(path);
    for (let parent = p.dirname(child); parent !== child; child = parent, parent = p.dirname(parent)) {
      const names = dirs.get(norm(parent)) ?? new Set<string>();
      names.add(p.basename(child));
      dirs.set(norm(parent), names);
    }
  }
  /** Follow links in every part of the path. */
  const real = (path: string, depth = 0): string => {
    if (depth > 20) return path;
    const parts = p.normalize(path).split(p.sep);
    let current = parts[0] === "" ? p.sep : parts[0]!;
    for (const part of parts.slice(1)) {
      if (!part) continue;
      current = p.join(current, part);
      const entry = files.get(norm(current));
      if (entry && typeof entry === "object" && !Buffer.isBuffer(entry)) current = real(p.resolve(p.dirname(current), entry.link), depth + 1);
    }
    return current;
  };
  const content = (path: string) => {
    const entry = files.get(norm(real(path)));
    return entry === undefined || (typeof entry === "object" && !Buffer.isBuffer(entry)) ? null : Buffer.from(entry);
  };
  return {
    kind: (path) => (content(path) ? "file" : dirs.has(norm(real(path))) ? "dir" : null),
    head: (path, bytes = 4096) => content(path)?.subarray(0, bytes) ?? null,
    list: (dir) => [...(dirs.get(norm(real(dir))) ?? [])],
    real: (path) => real(path),
  };
}

const PE = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 1, 2, 3, 4]);
const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 1]);

// npm's shims (cmd-shim), as `npm install -g @openai/codex` writes them.
const cmdShim = (target: string) =>
  `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*\r\n`;
const cmdShimNative = (target: string) => `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\${target}"   %*\r\n`;
const ps1Shim = (target: string) =>
  `#!/usr/bin/env pwsh\n$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n\n$exe=""\nif ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {\n  $exe=".exe"\n}\n$ret=0\nif (Test-Path "$basedir/node$exe") {\n  & "$basedir/node$exe"  "$basedir/${target}" $args\n} else {\n  & "node$exe"  "$basedir/${target}" $args\n}\nexit $ret\n`;
const shShim = (target: string) =>
  `#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")\n\ncase \`uname\` in\n    *CYGWIN*|*MINGW*|*MSYS*)\n        if command -v cygpath > /dev/null 2>&1; then\n            basedir=\`cygpath -w "$basedir"\`\n        fi\n    ;;\nesac\n\nif [ -x "$basedir/node" ]; then\n  exec "$basedir/node"  "$basedir/${target}" "$@"\nelse \n  exec node  "$basedir/${target}" "$@"\nfi\n`;
const codexJs = "#!/usr/bin/env node\n// Unified entry point for the Codex CLI.\nimport { spawn } from 'node:child_process';\n";
const claudeStub = 'echo "Error: claude native binary not installed." >&2\nexit 1\n';

function context(platform: NodeJS.Platform, entries: Record<string, Entry>, extra: Partial<LocateContext> = {}): LocateContext {
  const home = platform === "win32" ? "C:\\Users\\u" : platform === "darwin" ? "/Users/u" : "/home/u";
  return { platform, arch: platform === "darwin" ? "arm64" : "x64", env: {}, home, fs: fakeFs(platform, entries), node: platform === "win32" ? "C:\\App\\node\\node.exe" : "/app/node/node", ...extra };
}

describe("shims", () => {
  it("reads what npm's .cmd, .ps1 and sh shims run", () => {
    const dir = "C:\\Users\\u\\AppData\\Roaming\\npm";
    const target = "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js";
    expect(shimTarget(cmdShim("node_modules\\@openai\\codex\\bin\\codex.js"), `${dir}\\codex.cmd`, "win32")).toBe(target);
    expect(shimTarget(ps1Shim("node_modules/@openai/codex/bin/codex.js"), `${dir}\\codex.ps1`, "win32")).toBe(target);
    expect(shimTarget(shShim("node_modules/@openai/codex/bin/codex.js"), `${dir}\\codex`, "win32")).toBe(target);
    expect(shimTarget(cmdShimNative("node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"), `${dir}\\claude.cmd`, "win32")).toBe(
      "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe",
    );
    // Older cmd-shim and pnpm write %~dp0 directly, with a path that leaves the folder.
    const pnpm = '@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\..\\@openai\\codex\\bin\\codex.js" %*\r\n) ELSE (\r\n  node  "%~dp0\\..\\@openai\\codex\\bin\\codex.js" %*\r\n)';
    expect(shimTarget(pnpm, "C:\\Users\\u\\AppData\\Local\\pnpm\\bin\\codex.cmd", "win32")).toBe("C:\\Users\\u\\AppData\\Local\\pnpm\\@openai\\codex\\bin\\codex.js");
    expect(shimTarget("@echo off\r\nnode %*\r\n", `${dir}\\x.cmd`, "win32")).toBeNull();
    // Node's own npm.cmd names npm's script in a variable.
    const npmCmd =
      ':: Created by npm, please don\'t edit manually.\r\n@ECHO OFF\r\nSETLOCAL\r\nSET "NODE_EXE=%~dp0\\node.exe"\r\nIF NOT EXIST "%NODE_EXE%" (\r\n  SET "NODE_EXE=node"\r\n)\r\nSET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"\r\nSET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"\r\n"%NODE_EXE%" "%NPM_CLI_JS%" %*\r\n';
    expect(shimTarget(npmCmd, "C:\\Program Files\\nodejs\\npm.cmd", "win32")).toBe("C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js");
  });

  it("tells native programs of every OS from scripts", () => {
    expect(fileKind(PE)).toBe("native");
    expect(fileKind(ELF)).toBe("native");
    expect(fileKind(MACHO)).toBe("native");
    expect(fileKind(Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2]))).toBe("native");
    expect(fileKind(Buffer.from(codexJs))).toBe("node-script");
    expect(fileKind(Buffer.from("#!/bin/sh\nexec x\n"))).toBe("script");
    expect(fileKind(Buffer.from(claudeStub))).toBe("text");
    expect(fileKind(null)).toBeNull();
  });

  it("looks for PATHEXT's extensions on Windows, then npm's other shims", () => {
    expect(commandNames("codex", { platform: "win32", env: { PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS;.JS" } })).toEqual(["codex.com", "codex.exe", "codex.bat", "codex.cmd", "codex.ps1", "codex"]);
    expect(commandNames("codex", { platform: "linux", env: {} })).toEqual(["codex"]);
  });
});

describe("Windows", () => {
  const npm = "C:\\Users\\u\\AppData\\Roaming\\npm";
  const env = { Path: `C:\\Windows\\system32;C:\\Windows;${npm}`, PATHEXT: ".COM;.EXE;.BAT;.CMD", APPDATA: "C:\\Users\\u\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" };
  const codexPkg = `${npm}\\node_modules\\@openai\\codex`;
  const npmCodex = {
    [`${npm}\\codex`]: shShim("node_modules/@openai/codex/bin/codex.js"),
    [`${npm}\\codex.cmd`]: cmdShim("node_modules\\@openai\\codex\\bin\\codex.js"),
    [`${npm}\\codex.ps1`]: ps1Shim("node_modules/@openai/codex/bin/codex.js"),
    [`${codexPkg}\\bin\\codex.js`]: codexJs,
    [`${codexPkg}\\package.json`]: '{"name":"@openai/codex"}',
  };

  it("finds Codex installed with npm (codex.cmd) and starts its native engine, not the shim", () => {
    const ctx = context("win32", {
      ...npmCodex,
      [`${codexPkg}\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`]: PE,
    }, { env });
    const [found, ...rest] = engineCandidates("codex", ctx);
    expect(rest).toEqual([]);
    expect(found).toMatchObject({
      path: `${npm}\\codex.cmd`,
      command: `${codexPkg}\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`,
      args: [],
      kind: "native",
      origin: "npm",
      env: { CODEX_MANAGED_BY_NPM: "1", CODEX_MANAGED_PACKAGE_ROOT: codexPkg },
    });
  });

  it("runs Codex's launcher on the app's Node when the platform package is not there", () => {
    const ctx = context("win32", npmCodex, { env });
    const [found] = engineCandidates("codex", ctx);
    expect(found).toMatchObject({ command: "C:\\App\\node\\node.exe", args: [`${codexPkg}\\bin\\codex.js`], kind: "node", origin: "npm" });
  });

  it("finds npm's folder even when it is not on PATH (a GUI start with a short PATH)", () => {
    const ctx = context("win32", { ...npmCodex, [`${codexPkg}\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`]: PE }, { env: { ...env, Path: "C:\\Windows\\system32" } });
    expect(engineCandidates("codex", ctx)[0]).toMatchObject({ path: `${npm}\\codex.cmd`, kind: "native", origin: "npm" });
  });

  it("finds Claude Code from its own installer (%USERPROFILE%\\.local\\bin\\claude.exe) without PATH", () => {
    const ctx = context("win32", { "C:\\Users\\u\\.local\\bin\\claude.exe": PE }, { env });
    expect(engineCandidates("claude", ctx)).toEqual([
      { path: "C:\\Users\\u\\.local\\bin\\claude.exe", command: "C:\\Users\\u\\.local\\bin\\claude.exe", args: [], env: {}, paths: [], kind: "native", origin: "native" },
    ]);
  });

  it("starts the native Claude Code of an npm install (claude.cmd → bin\\claude.exe)", () => {
    const pkg = `${npm}\\node_modules\\@anthropic-ai\\claude-code`;
    const ctx = context("win32", { [`${npm}\\claude.cmd`]: cmdShimNative("node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"), [`${pkg}\\bin\\claude.exe`]: PE }, { env });
    expect(engineCandidates("claude", ctx)[0]).toMatchObject({ path: `${npm}\\claude.cmd`, command: `${pkg}\\bin\\claude.exe`, kind: "native", origin: "npm" });
  });

  it("uses the platform package when Claude Code's install script did not run", () => {
    const root = "C:\\Users\\u\\AppData\\Local\\wb\\engines\\claude\\2.1.312\\node_modules\\@anthropic-ai";
    const ctx = context(
      "win32",
      {
        [`${root}\\claude-code\\bin\\claude.exe`]: claudeStub,
        [`${root}\\claude-code\\cli-wrapper.cjs`]: "// fallback",
        [`${root}\\claude-code-win32-x64\\claude.exe`]: PE,
        "C:\\Users\\u\\AppData\\Local\\wb\\engines\\claude\\current.json": JSON.stringify({ entry: `${root}\\claude-code\\bin\\claude.exe` }),
      },
      { env, managedDir: "C:\\Users\\u\\AppData\\Local\\wb\\engines" },
    );
    expect(engineCandidates("claude", ctx)).toMatchObject([{ command: `${root}\\claude-code-win32-x64\\claude.exe`, kind: "native", origin: "managed" }]);
  });

  it("counts one engine once however many shims point at it", () => {
    const ctx = context("win32", { ...npmCodex, [`${codexPkg}\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`]: PE }, { env: { ...env, Path: `${npm};${npm}` } });
    expect(engineCandidates("codex", ctx)).toHaveLength(1);
  });

  it("does not try to start a batch file that names nothing it can run", () => {
    const ctx = context("win32", { [`${npm}\\codex.cmd`]: "@echo off\r\ncodex-real %*\r\n" }, { env });
    expect(engineCandidates("codex", ctx)).toEqual([]);
  });

  it("finds the engine of the Codex editor extension", () => {
    const ext = "C:\\Users\\u\\.vscode\\extensions\\openai.chatgpt-26.1018.0-win32-x64";
    const ctx = context("win32", { [`${ext}\\bin\\windows-x86_64\\codex.exe`]: PE }, { env });
    expect(engineCandidates("codex", ctx)).toMatchObject([{ command: `${ext}\\bin\\windows-x86_64\\codex.exe`, origin: "editor" }]);
  });
});

describe("macOS", () => {
  // Apps opened from Finder get only the system PATH.
  const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };

  it("finds Homebrew's Codex and Claude Code's own installer outside the GUI PATH", () => {
    const ctx = context(
      "darwin",
      {
        "/opt/homebrew/bin/codex": { link: "../Caskroom/codex/0.165.0/codex-aarch64-apple-darwin" },
        "/opt/homebrew/Caskroom/codex/0.165.0/codex-aarch64-apple-darwin": MACHO,
        "/Users/u/.local/bin/claude": { link: "/Users/u/.local/share/claude/versions/2.1.300" },
        "/Users/u/.local/share/claude/versions/2.1.300": MACHO,
      },
      { env },
    );
    // Started through the link, so an update that moves the link starts the new version.
    expect(engineCandidates("codex", ctx)).toMatchObject([{ path: "/opt/homebrew/bin/codex", command: "/opt/homebrew/bin/codex", kind: "native", origin: "homebrew" }]);
    expect(engineCandidates("claude", ctx)).toMatchObject([{ path: "/Users/u/.local/bin/claude", command: "/Users/u/.local/bin/claude", kind: "native", origin: "native" }]);
  });

  it("finds an npm install under nvm from the login shell's PATH and starts the native engine", () => {
    const bin = "/Users/u/.nvm/versions/node/v24.11.0/bin";
    const lib = "/Users/u/.nvm/versions/node/v24.11.0/lib/node_modules";
    const ctx = context(
      "darwin",
      {
        [`${bin}/codex`]: { link: "../lib/node_modules/@openai/codex/bin/codex.js" },
        [`${lib}/@openai/codex/bin/codex.js`]: codexJs,
        [`${lib}/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`]: MACHO,
      },
      { env: { PATH: `${env.PATH}:${bin}` }, shellDirs: [bin] },
    );
    expect(engineCandidates("codex", ctx)).toMatchObject([
      { path: `${bin}/codex`, command: `${lib}/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`, kind: "native", origin: "shell", env: { CODEX_MANAGED_BY_NPM: "1" } },
    ]);
  });

  it("runs a JavaScript engine on the app's Node (no node on a Finder PATH)", () => {
    const ctx = context("darwin", { "/usr/local/bin/claude": { link: "../lib/node_modules/@anthropic-ai/claude-code/cli.js" }, "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js": "#!/usr/bin/env node\n" }, { env });
    expect(engineCandidates("claude", ctx)).toMatchObject([{ command: "/app/node/node", args: ["/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js"], kind: "node" }]);
  });

  it("finds the engine inside the ChatGPT app", () => {
    const ctx = context("darwin", { "/Applications/ChatGPT.app/Contents/Resources/codex": MACHO }, { env });
    expect(engineCandidates("codex", ctx)).toMatchObject([{ command: "/Applications/ChatGPT.app/Contents/Resources/codex", origin: "app" }]);
  });
});

describe("Linux", () => {
  // An AppImage or desktop launcher: no ~/.local/bin on PATH.
  const env = { PATH: "/usr/bin:/bin" };

  it("finds Claude Code's installer and Codex's own installer with a launcher's PATH", () => {
    const ctx = context(
      "linux",
      {
        "/home/u/.local/bin/claude": { link: "/home/u/.local/share/claude/versions/2.1.292" },
        "/home/u/.local/share/claude/versions/2.1.292": ELF,
        "/home/u/.local/bin/codex": { link: "/home/u/.codex/packages/standalone/current/bin/codex" },
        "/home/u/.codex/packages/standalone/current": { link: "releases/0.153.4-x86_64-unknown-linux-musl" },
        "/home/u/.codex/packages/standalone/releases/0.153.4-x86_64-unknown-linux-musl/bin/codex": ELF,
        "/usr/lib/chatgpt/resources/codex": ELF,
      },
      { env },
    );
    expect(engineCandidates("claude", ctx)).toMatchObject([{ command: "/home/u/.local/bin/claude", origin: "native" }]);
    expect(engineCandidates("codex", ctx)).toMatchObject([
      { path: "/home/u/.local/bin/codex", command: "/home/u/.local/bin/codex", origin: "standalone" },
      { command: "/usr/lib/chatgpt/resources/codex", origin: "app" },
    ]);
  });

  it("puts the user's own engine before Workbench's install and the SDK's copy", () => {
    const managed = "/home/u/.local/share/wb/engines";
    const ctx = context(
      "linux",
      {
        "/usr/bin/claude": ELF,
        [`${managed}/claude/current.json`]: JSON.stringify({ entry: `${managed}/claude/2.1.312/node_modules/@anthropic-ai/claude-code/bin/claude.exe` }),
        [`${managed}/claude/2.1.312/node_modules/@anthropic-ai/claude-code/bin/claude.exe`]: claudeStub,
        [`${managed}/claude/2.1.312/node_modules/@anthropic-ai/claude-code-linux-x64/claude`]: ELF,
        "/sdk/claude": ELF,
      },
      { env, managedDir: managed, sdkClaude: "/sdk/claude" },
    );
    expect(engineCandidates("claude", ctx).map((entry) => entry.origin)).toEqual(["path", "managed", "sdk"]);
  });

  it("follows an npm sh shim without needing sh or node", () => {
    const ctx = context("linux", { "/opt/tools/codex": shShim("lib/codex/bin/codex.js"), "/opt/tools/lib/codex/bin/codex.js": codexJs }, { env: { PATH: "/opt/tools" } });
    expect(engineCandidates("codex", ctx)).toMatchObject([{ command: "/app/node/node", args: ["/opt/tools/lib/codex/bin/codex.js"], kind: "node" }]);
  });

  it("keeps a wrapper script of the user's own as it is", () => {
    const ctx = context("linux", { "/home/u/bin/claude": "#!/bin/bash\nexec /opt/claude/claude \"$@\"\n" }, { env: { PATH: "/home/u/bin" } });
    expect(launchFor("/home/u/bin/claude", "path", ctx)).toMatchObject({ command: "/home/u/bin/claude", kind: "native" });
  });
});
