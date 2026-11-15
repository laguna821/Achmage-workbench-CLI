// sec-vault round 2 (ux/briefs/sec-vault-round2-brief.md): the gateway's half of "only the gateway,
// with its per-run ticket" — the ticket's way in (stdin only) and out (the helper's stdin only), the
// gateway's own PATH without `<data>/bin`, the login-shell probe behind an intermediate process, and a
// refused vault said instead of swallowed (review I3). Made-up values only.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { engineEnv, setEngineToolDir, withEngineTools } from "./engine-env.ts";
import { IEUM_CLOUD_COMMANDS, IEUM_CLOUD_NOTE, installToolWrappers, withoutToolDir, wrapperFiles } from "./tool-bin.ts";
import { forgetOwnTools, ownTool } from "./own-tools.ts";
import { loginShellPath } from "./shell-env.ts";
import { launcherOf } from "./daemon/lifecycle.ts";

const TICKET = "ab".repeat(32);
const probe = (code: string, env: Record<string, string>, input?: string) => spawnSync(process.execPath, ["--input-type=module", "-e", code], {
  env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8", cwd: import.meta.dirname, ...(input !== undefined ? { input } : {}),
});
const temps: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "wb-r2-")); temps.push(dir); return dir; };
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); setEngineToolDir(null); forgetOwnTools(); });

/** A stand-in vault helper: records the request it got on stdin, answers what FAKE_ANSWER says. */
function fakeHelper(dir: string) {
  const file = join(dir, "helper.mjs");
  writeFileSync(file, `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
let input = ""; process.stdin.on("data", (c) => input += c); process.stdin.on("end", () => {
  appendFileSync(${JSON.stringify(join(dir, "requests"))}, JSON.stringify({ input, argv: process.argv.slice(2), env: Object.keys(process.env).filter((k) => k.startsWith("WORKBENCH_")) }) + "\\n");
  const answer = readFileSync(${JSON.stringify(join(dir, "answer"))}, "utf8");
  process.stdout.write(answer); process.exit(JSON.parse(answer).ok ? 0 : 1);
});
`);
  chmodSync(file, 0o755);
  return file;
}

describe("the per-run ticket", () => {
  it("is read from the first line of stdin, kept out of the environment, and sent only on the helper's stdin", () => {
    const dir = temp(), helper = fakeHelper(dir);
    writeFileSync(join(dir, "answer"), JSON.stringify({ ok: true, id: "c".repeat(32), key: Buffer.alloc(32, 7).toString("base64") }));
    const run = probe(`
      import { takeGatewayOnlyEnv, takeGatewayTicket, gatewayTicket } from "./gateway-env.ts";
      import { OfficeVault, vaultStatus } from "./office-vault.ts";
      import { spawnSync } from "node:child_process";
      takeGatewayOnlyEnv(); takeGatewayTicket();
      const vault = new OfficeVault(${JSON.stringify(dir)});
      const state = await vault.register();
      const child = spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify({ env: process.env, argv: process.argv }))"], { encoding: "utf8" });
      console.log(JSON.stringify({ held: gatewayTicket() === ${JSON.stringify(TICKET)}, state, child: child.stdout }));
    `, { WORKBENCH_GATEWAY_TICKET: "stdin", WORKBENCH_SECRET_BIN: helper }, `${TICKET}\n`);
    expect(run.stderr).toBe("");
    const seen = JSON.parse(run.stdout.trim());
    expect(seen.held).toBe(true);
    expect(seen.state.state).toBe("open");
    // Not in anything a child inherits.
    expect(seen.child).not.toContain(TICKET);
    expect(seen.child).not.toContain("WORKBENCH_GATEWAY_TICKET");
    // The helper got it on stdin — and only there (not in its arguments or environment).
    const request = JSON.parse(readFileSync(join(dir, "requests"), "utf8").trim());
    expect(JSON.parse(request.input)).toEqual({ directory: dir, create: false, ticket: TICKET });
    expect(request.argv).toEqual(["--office-secret-key"]);
    expect(JSON.stringify(request.env)).not.toContain(TICKET);
  });

  it("is none when the binary did not start this gateway, or when the line is not a ticket", () => {
    for (const [env, input] of [[{}, `${TICKET}\n`], [{ WORKBENCH_GATEWAY_TICKET: "stdin" }, "not a ticket\n"], [{ WORKBENCH_GATEWAY_TICKET: TICKET }, ""]] as const) {
      const run = probe(`
        import { takeGatewayTicket } from "./gateway-env.ts";
        console.log(JSON.stringify({ ticket: takeGatewayTicket(), left: process.env.WORKBENCH_GATEWAY_TICKET ?? null }));
      `, env, input);
      expect(JSON.parse(run.stdout.trim())).toEqual({ ticket: null, left: null });
    }
  });
});

describe("a refused vault is said, not swallowed (review I3)", () => {
  for (const reason of ["caller_not_gateway", "gateway_not_registered", "vault_unavailable", "vault_key_missing"]) {
    it(`${reason}: one line in the log, the reason in the state, no secret, no loop`, () => {
      const dir = temp(), helper = fakeHelper(dir);
      writeFileSync(join(dir, "answer"), JSON.stringify({ ok: false, error: reason }));
      const run = probe(`
        import { takeGatewayTicket } from "./gateway-env.ts";
        import { OfficeVault, vaultStatus } from "./office-vault.ts";
        takeGatewayTicket();
        const vault = new OfficeVault(${JSON.stringify(dir)});
        const state = await vault.register();
        const errors = [];
        for (let i = 0; i < 3; i++) await vault.openFor("channel", "sealed:v1:workbench:" + "c".repeat(32) + ":channel:AAAAAAAAAAAAAAAA.AA.AAAAAAAAAAAAAAAAAAAAAA").catch((e) => errors.push(e.message));
        console.log(JSON.stringify({ state, errors }));
      `, { WORKBENCH_SECRET_BIN: helper, WORKBENCH_GATEWAY_TICKET: "stdin" }, `${TICKET}\n`);
      const seen = JSON.parse(run.stdout.trim().split("\n").pop()!);
      expect(seen.state.state).toBe("refused");
      expect(seen.state.reason).toBe(reason);
      expect(seen.state.message).toMatch(/[가-힣]/);
      expect(run.stderr.trim().split("\n")).toHaveLength(1);
      expect(run.stderr).toContain(`Vault: refused (${reason})`);
      expect(seen.errors).toHaveLength(3);
      for (const message of seen.errors) expect(message).toContain("비밀 보관함을 열지 못했습니다");
      const calls = readFileSync(join(dir, "requests"), "utf8").trim().split("\n").length;
      // A standing refusal is not asked again on every use (a missing registration: after its one heal);
      // a locked keyring or a missing key is.
      expect(calls).toBe(reason === "caller_not_gateway" ? 1 : reason === "gateway_not_registered" ? 2 : 4);
    });
  }

  it("a gateway started without the app's binary (no ticket) is told so, not 'unlock the keyring' (check F3)", () => {
    const dir = temp(), helper = fakeHelper(dir);
    writeFileSync(join(dir, "answer"), JSON.stringify({ ok: false, error: "caller_not_gateway" }));
    for (const env of [{}, { WORKBENCH_SECRET_BIN: helper }] as Record<string, string>[]) {
      const run = probe(`
        import { takeGatewayOnlyEnv, takeGatewayTicket } from "./gateway-env.ts";
        import { OfficeVault, VAULT_REFUSALS } from "./office-vault.ts";
        takeGatewayOnlyEnv(); takeGatewayTicket();
        const vault = new OfficeVault(${JSON.stringify(dir)});
        const state = await vault.register();
        const error = await vault.openFor("channel", "sealed:v1:workbench:" + "c".repeat(32) + ":channel:AAAAAAAAAAAAAAAA.AA.AAAAAAAAAAAAAAAAAAAAAA").catch((e) => e.message);
        console.log(JSON.stringify({ state, error, unlock: VAULT_REFUSALS.vault_unavailable }));
      `, env);
      const seen = JSON.parse(run.stdout.trim());
      expect(seen.state).toMatchObject({ state: "refused", reason: "gateway_without_launcher" });
      expect(seen.state.message).toContain("앱을 거치지 않고 시작");
      expect(seen.state.message).toContain("다시 여세요");
      expect(seen.state.message).not.toBe(seen.unlock);
      expect(seen.error).toContain(seen.state.message);
      expect(run.stderr).toContain("Vault: refused (gateway_without_launcher)");
    }
  });

  it("a missing registration heals once: one request to the launcher (a stdout line), one more call — never a loop", () => {
    const dir = temp(), helper = fakeHelper(dir);
    writeFileSync(join(dir, "answer"), JSON.stringify({ ok: false, error: "gateway_not_registered" }));
    const run = probe(`
      import { takeGatewayTicket } from "./gateway-env.ts";
      import { OfficeVault } from "./office-vault.ts";
      takeGatewayTicket();
      const vault = new OfficeVault(${JSON.stringify(dir)});
      process.stderr.write(JSON.stringify(await vault.register()) + "\\n");
      for (let i = 0; i < 3; i++) await vault.open("sealed:v1:workbench:" + "c".repeat(32) + ":AAAAAAAAAAAAAAAA.AA.AAAAAAAAAAAAAAAAAAAAAA").catch(() => {});
    `, { WORKBENCH_SECRET_BIN: helper, WORKBENCH_GATEWAY_TICKET: "stdin" }, `${TICKET}\n`);
    expect(run.stdout).toBe("WORKBENCH_VAULT_REGISTER\n");
    expect(JSON.parse(run.stderr.split("\n").find((line) => line.startsWith("{"))!).reason).toBe("gateway_not_registered");
    expect(readFileSync(join(dir, "requests"), "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("다시 시도 asks the launcher to register again (one stdout line), then the helper once more", () => {
    const dir = temp(), helper = fakeHelper(dir);
    writeFileSync(join(dir, "answer"), JSON.stringify({ ok: false, error: "gateway_not_registered" }));
    const run = probe(`
      import { OfficeVault } from "./office-vault.ts";
      import { writeFileSync } from "node:fs";
      const vault = new OfficeVault(${JSON.stringify(dir)});
      await vault.register();
      writeFileSync(${JSON.stringify(join(dir, "answer"))}, JSON.stringify({ ok: true, missing: true }));
      const after = await vault.retry(10);
      process.stderr.write(JSON.stringify(after));
    `, { WORKBENCH_SECRET_BIN: helper });
    expect(run.stdout).toBe("WORKBENCH_VAULT_REGISTER\n");
    expect(JSON.parse(run.stderr.split("\n").pop()!).state).toBe("open");
  });
});

describe("the gateway's own PATH never holds <data>/bin (C1 c)", () => {
  it("is taken out of the gateway's PATH; engines and the person's terminals still get it first", () => {
    const data = temp(), bin = join(data, "bin");
    const env: NodeJS.ProcessEnv = { PATH: [bin, "/usr/bin", bin, "/bin"].join(delimiter) };
    withoutToolDir(data, env);
    expect(env.PATH).toBe(["/usr/bin", "/bin"].join(delimiter));
    const before = process.env.PATH;
    installToolWrappers(data, { kordoc: null, ieum: null });
    expect(process.env.PATH).toBe(before);
    expect(engineEnv({ base: { PATH: "/usr/bin" } }).PATH).toBe([bin, "/usr/bin"].join(delimiter));
    expect(withEngineTools({ PATH: "/usr/bin" }).PATH).toBe([bin, "/usr/bin"].join(delimiter));
  });

  it("the gateway runs git from a folder the person cannot write before one they can", () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const mine = temp();
    writeFileSync(join(mine, "git"), "#!/bin/sh\nexit 0\n"); chmodSync(join(mine, "git"), 0o755);
    const system = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    if (!system) return;
    // The planted one comes first on PATH; the system's is chosen.
    expect(ownTool("git", { PATH: [mine, "/usr/local/bin", "/usr/bin", "/bin"].join(delimiter) })).toBe(system);
    forgetOwnTools();
    expect(ownTool("git", { PATH: mine })).toBe(join(mine, "git"));
  });
});

describe("the login-shell probe runs behind an intermediate process (C1 d)", () => {
  it("whatever an rc file execs is never the gateway's direct child", async () => {
    if (process.platform === "win32") return;
    const dir = temp(), shell = join(dir, "shell"), seen = join(dir, "seen");
    // A "login shell" whose rc file execs another program: that program records its parent.
    writeFileSync(shell, `#!/bin/sh\nexec ${process.execPath} -e 'require("node:fs").writeFileSync(${JSON.stringify(seen)}, String(process.ppid)); console.log("__WORKBENCH_PATH__/usr/bin__WORKBENCH_PATH__")'\n`);
    chmodSync(shell, 0o755);
    const dirs = await loginShellPath({ ...process.env, SHELL: shell }, "linux");
    expect(dirs).toEqual(["/usr/bin"]);
    expect(Number(readFileSync(seen, "utf8"))).not.toBe(process.pid);
  });
});

describe("every gateway start goes through the app's binary", () => {
  it("the AppImage runner, else the binary the app or the login unit names; none from a source checkout", () => {
    expect(launcherOf({ WORKBENCH_HOST_RUNNER: "/img", WORKBENCH_SECRET_BIN: "/bin/app" }, "linux")).toBe("/img");
    expect(launcherOf({ WORKBENCH_SECRET_BIN: "/opt/app" }, "linux")).toBe("/opt/app");
    expect(launcherOf({ WORKBENCH_HOST_RUNNER: "/img", WORKBENCH_APP_BIN: "/opt/app" }, "darwin")).toBe("/opt/app");
    expect(launcherOf({}, "linux")).toBeUndefined();
  });
  it("a login unit that names no binary still starts through the binary beside the install (check F3)", () => {
    const install = temp(), entry = join(install, "host", "host.mjs");
    mkdirSync(join(install, "host")); writeFileSync(entry, "");
    // A source checkout (no binary beside it): none, as before.
    expect(launcherOf({}, "linux", entry)).toBeUndefined();
    writeFileSync(join(install, "achmage-workbench"), "");
    expect(launcherOf({}, "linux", entry)).toBe(join(install, "achmage-workbench"));
    expect(launcherOf({ WORKBENCH_SECRET_BIN: "/opt/app" }, "linux", entry)).toBe("/opt/app");
    writeFileSync(join(install, "achmage-workbench.exe"), "");
    expect(launcherOf({}, "win32", entry)).toBe(join(install, "achmage-workbench.exe"));
    // macOS: Contents/Resources/host/host.mjs → Contents/MacOS/achmage-workbench.
    const app = temp(), macEntry = join(app, "Contents", "Resources", "host", "host.mjs");
    mkdirSync(join(app, "Contents", "Resources", "host"), { recursive: true }); mkdirSync(join(app, "Contents", "MacOS"));
    writeFileSync(join(app, "Contents", "MacOS", "achmage-workbench"), "");
    expect(launcherOf({}, "darwin", macEntry)).toBe(join(app, "Contents", "MacOS", "achmage-workbench"));
    // Debian package: /usr/lib/<product>/host/host.mjs → /usr/bin/achmage-workbench.
    const usr = temp(), debEntry = join(usr, "lib", "Achmage Workbench", "host", "host.mjs");
    mkdirSync(join(usr, "lib", "Achmage Workbench", "host"), { recursive: true }); mkdirSync(join(usr, "bin"));
    writeFileSync(join(usr, "bin", "achmage-workbench"), "");
    expect(launcherOf({}, "linux", debEntry)).toBe(join(usr, "bin", "achmage-workbench"));
  });
});

describe("IeumOffice's cloud commands from an engine (review M2)", () => {
  it("a failing cloud command says the key is kept and where to use it, never to enter it again", () => {
    if (process.platform === "win32") return;
    const dir = temp(), cli = join(dir, "cli.mjs");
    writeFileSync(cli, `process.stderr.write("search key missing\\n"); process.exit(process.argv[2] === "ok" ? 0 : 3);`);
    const files = wrapperFiles("ieumoffice", { file: process.execPath, args: [cli], onFailure: { commands: IEUM_CLOUD_COMMANDS, note: IEUM_CLOUD_NOTE } }, "linux");
    const wrapper = join(dir, "ieumoffice");
    writeFileSync(wrapper, files.ieumoffice!); chmodSync(wrapper, 0o755);
    const failed = spawnSync(wrapper, ["search", "q", "--json"], { encoding: "utf8" });
    expect(failed.status).toBe(3);
    expect(failed.stderr).toContain("저장한 AI·검색 키는 지워지지 않았습니다");
    expect(failed.stderr).toContain("키를 다시 넣지 마시고");
    const flagFirst = spawnSync(wrapper, ["--json", "read-url", "x"], { encoding: "utf8" });
    expect(flagFirst.stderr).toContain("지워지지 않았습니다");
    const other = spawnSync(wrapper, ["create", "x"], { encoding: "utf8" });
    expect(other.status).toBe(3);
    expect(other.stderr).not.toContain("지워지지 않았습니다");
  });
});
