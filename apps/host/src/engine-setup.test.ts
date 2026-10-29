import { describe, expect, it } from "vitest";
import { installError } from "./engine-install.ts";
import { engineCandidates, type FsView } from "./engine-locate.ts";
import { isWebAddress, openerFor } from "./open-url.ts";
import { loginAddress, loginFailure, plainText } from "./providers/claude.ts";
import { missingDirs, parseShellPath } from "./shell-env.ts";

describe("one-click install", () => {
  it("says in plain Korean what went wrong, from npm's output", () => {
    expect(installError("npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org/x failed", "/d")).toContain("인터넷에 연결하지 못했습니다");
    expect(installError("npm ERR! code ENOSPC", "/d")).toContain("디스크 공간이 부족합니다");
    expect(installError("npm error code EPERM\nnpm error syscall rename", "C:\\Users\\u\\wb")).toContain("C:\\Users\\u\\wb");
    expect(installError("npm error code EINTEGRITY", "/d")).toContain("배포본과 달라");
    expect(installError("npm error something odd\nnpm error A complete log of this run can be found in: /x.log", "/d")).toBe("설치하지 못했습니다: something odd");
  });
});

describe("login", () => {
  it("finds the address Claude Code prints for when the browser did not open, inside a terminal link", () => {
    const url = "https://claude.ai/oauth/authorize?code=true&client_id=abc&state=xyz";
    const output = `Opening browser to sign in… \nIf the browser didn't open, visit: \u001b]8;;${url}\u0007${url}\u001b]8;;\u0007 \nPaste code here if prompted > `;
    expect(plainText(output)).not.toContain("\u001b");
    expect(loginAddress(output)).toBe(url);
    expect(loginAddress("Opening browser to sign in…")).toBeNull();
    expect(loginAddress("visit: javascript:alert(1)")).toBeNull();
  });

  it("keeps the engine's own reason when a login fails", () => {
    expect(loginFailure("Opening browser…\nOAuth login failed: invalid_grant\n")).toBe("OAuth login failed: invalid_grant");
    expect(loginFailure("Login successful.\n")).toBeNull();
  });

  it("opens only web addresses, with each OS's opener and no shell", () => {
    expect(isWebAddress("https://auth.openai.com/oauth/authorize?a=1&b=2")).toBe(true);
    expect(isWebAddress("file:///etc/passwd")).toBe(false);
    expect(isWebAddress("https://x.test/a b")).toBe(false);
    const url = "https://auth.openai.com/x?a=1&b=2";
    expect(openerFor(url, "win32", { SystemRoot: "C:\\Windows" })).toEqual({ command: "C:\\Windows\\System32\\rundll32.exe", args: ["url.dll,FileProtocolHandler", url] });
    expect(openerFor(url, "darwin", {})).toEqual({ command: "open", args: [url] });
    expect(openerFor(url, "linux", {})).toEqual({ command: "xdg-open", args: [url] });
    expect(openerFor(url, "linux", { WORKBENCH_OPEN_URL: "/x/opener.mjs" }).args).toEqual(["/x/opener.mjs", url]);
  });
});

describe("a desktop launcher's PATH", () => {
  it("reads the login shell's PATH between markers, whatever the rc files print", () => {
    expect(parseShellPath("Welcome!\n__WORKBENCH_PATH__/opt/homebrew/bin:/Users/u/.nvm/versions/node/v24/bin:/usr/bin\n__WORKBENCH_PATH__")).toEqual(["/opt/homebrew/bin", "/Users/u/.nvm/versions/node/v24/bin", "/usr/bin"]);
    expect(parseShellPath("no markers")).toBeNull();
  });

  it("adds only the folders the app's PATH lacks, in the shell's order", () => {
    expect(missingDirs("/usr/bin:/bin", ["/opt/homebrew/bin", "/usr/bin", "/opt/homebrew/bin", "/Users/u/.local/bin"])).toEqual(["/opt/homebrew/bin", "/Users/u/.local/bin"]);
  });

  it("looks only in the user's own folders when asked (checks on a computer that has engines)", () => {
    const files = new Set(["/usr/bin/codex", "/home/u/.local/bin/codex"]);
    const fs: FsView = {
      kind: (path) => (files.has(path) ? "file" : null),
      head: (path) => (files.has(path) ? Buffer.from([0x7f, 0x45, 0x4c, 0x46]) : null),
      list: () => [],
      real: (path) => path,
    };
    const base = { platform: "linux" as const, arch: "x64", env: { PATH: "" }, home: "/home/u", fs, node: "/n" };
    expect(engineCandidates("codex", base).map((entry) => entry.path)).toEqual(["/home/u/.local/bin/codex", "/usr/bin/codex"]);
    expect(engineCandidates("codex", { ...base, systemWide: false }).map((entry) => entry.path)).toEqual(["/home/u/.local/bin/codex"]);
  });
});
