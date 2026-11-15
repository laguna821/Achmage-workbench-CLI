// Linux native OS-vault + built gateway validation, on a NEW private D-Bus/keyring.
// Never use the desktop bus or enumerate/read any existing user credential.
// Usage: node scripts/smoke-office-vault.ts <binary> <evidence-directory>
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const self = fileURLToPath(import.meta.url), repo = fileURLToPath(new URL("../", import.meta.url));
const binary = resolve(process.argv[2]!), outDir = resolve(process.argv[3]!);
function childRun(command: string, args: string[], input = "", env = process.env) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("Owned fixture process timed out")); }, 30_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.stdout.on("data", (part: Buffer) => { stdout += part.toString(); });
    child.stderr.on("data", (part: Buffer) => { stderr += part.toString(); });
    child.once("close", (code) => { clearTimeout(timer); done({ code, stdout, stderr }); }); child.stdin.end(input);
  });
}
if (!process.argv.includes("--private-bus")) {
  assert.equal(process.platform, "linux", "This fixture is Linux-only; other OS vaults need their own native checks");
  mkdirSync(outDir, { recursive: true });
  const sandbox = mkdtempSync(join(tmpdir(), "wb-vault-native-"));
  // Pre-create XDG keyrings: GNOME otherwise may fall back to ~/.gnome2/keyrings.
  for (const rel of ["data/keyrings", "config", "runtime", "profile", "control"]) mkdirSync(join(sandbox, rel), { recursive: true, mode: 0o700 });
  const env = { ...process.env, XDG_DATA_HOME: join(sandbox, "data"), XDG_CONFIG_HOME: join(sandbox, "config"), XDG_RUNTIME_DIR: join(sandbox, "runtime"), WB_VAULT_TEST_ROOT: sandbox };
  for (const name of ["DBUS_SESSION_BUS_ADDRESS", "DBUS_STARTER_ADDRESS", "DBUS_STARTER_BUS_TYPE", "GNOME_KEYRING_CONTROL", "GNOME_KEYRING_PID", "DISPLAY", "WAYLAND_DISPLAY"]) delete env[name as keyof typeof env];
  try {
    const result = await childRun("dbus-run-session", ["--", process.execPath, self, binary, outDir, "--private-bus"], "", env);
    writeFileSync(join(outDir, "private-bus.log"), result.stderr, { mode: 0o600 });
    assert.equal(result.code, 0, "Private vault fixture failed; inspect results.json (no secret output)");
    console.log(result.stdout.trim());
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
} else {
  const root = process.env.WB_VAULT_TEST_ROOT!;
  assert.ok(root && process.env.XDG_DATA_HOME === join(root, "data") && existsSync(join(root, "data/keyrings")) && process.env.DBUS_SESSION_BUS_ADDRESS);
  const password = randomBytes(32).toString("base64"), profile = join(root, "profile"), checks: string[] = [];
  let daemon: ChildProcessWithoutNullStreams | null = null, stopped: Promise<void> | null = null;
  let daemonOutput = "", failure: unknown;
  const stop = async () => {
    if (!daemon) return;
    daemon.kill("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([stopped, new Promise<never>((_done, reject) => { timer = setTimeout(() => reject(new Error("Owned keyring did not stop normally")), 5000); })]); }
    finally { clearTimeout(timer); }
    daemon = null;
  };
  const start = async () => {
    daemon = spawn("gnome-keyring-daemon", ["--foreground", "--components=secrets", "--unlock", "--control-directory", join(root, "control")], { stdio: ["pipe", "pipe", "pipe"] });
    stopped = new Promise<void>((done) => daemon!.once("close", () => done()));
    daemon.on("error", () => {});
    daemon.stdout.on("data", (part: Buffer) => { daemonOutput += part.toString(); });
    daemon.stderr.on("data", (part: Buffer) => { daemonOutput += part.toString(); });
    daemon.stdin.end(password);
    for (let attempt = 0; attempt < 40; attempt++) {
      const result = await childRun("gdbus", ["call", "--session", "--dest", "org.freedesktop.DBus", "--object-path", "/org/freedesktop/DBus", "--method", "org.freedesktop.DBus.NameHasOwner", "org.freedesktop.secrets"]);
      if (result.code === 0 && result.stdout.includes("true")) return;
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error("Private keyring did not become ready");
  };
  try {
    await start();
    // A stand-in gateway, started as every gateway is since sec-vault round 2: by the binary's launcher,
    // which registers it with the vault and hands it its per-run ticket. The launcher runs the install's
    // own host/host.mjs, so a throwaway install holds the stand-in there (the person's install is never used).
    const stage = join(root, "stage"); mkdirSync(join(stage, "host"), { recursive: true });
    const staged = join(stage, "achmage-workbench"); copyFileSync(binary, staged); chmodSync(staged, 0o755);
    writeFileSync(join(stage, "host/host.mjs"), `
      import { takeGatewayTicket } from ${JSON.stringify(join(repo, "apps/host/src/gateway-env.ts"))};
      import { OfficeVault, nativeOfficeVault } from ${JSON.stringify(join(repo, "apps/host/src/office-vault.ts"))};
      import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      takeGatewayTicket();
      const profile = process.env.WORKBENCH_DATA_DIR, load = nativeOfficeVault(profile, process.env.WORKBENCH_SECRET_BIN), result = {};
      if (process.env.SMOKE_STEP === "1") {
        result.freshNull = (await load(false)) === null && !existsSync(join(profile, "office"));
        const six = await Promise.all(Array.from({ length: 6 }, () => load(true)));
        result.oneKey = six.every((entry) => entry && entry.id === six[0].id && entry.key.equals(six[0].key));
        result.idFile = readFileSync(join(profile, "office/vault-id"), "utf8") === six[0].id;
        result.files = readdirSync(join(profile, "office")).sort();
        const vault = new OfficeVault(profile, load); result.sealed = await vault.seal(process.env.SMOKE_PLAIN); vault.close();
        six.forEach((entry) => entry.key.fill(0));
      } else {
        const vault = new OfficeVault(profile, load); result.reopened = (await vault.open(process.env.SMOKE_SEALED)) === process.env.SMOKE_PLAIN; vault.close();
      }
      writeFileSync(process.env.SMOKE_OUT, JSON.stringify(result), { mode: 0o600 });
    `);
    const plain = "private-fixture-api-key", stepOut = join(root, "step.json");
    const gatewayStep = async (step: string, extra: Record<string, string> = {}) => {
      rmSync(stepOut, { force: true });
      const ran = await childRun(staged, ["--host-runtime"], "", { ...process.env, WORKBENCH_DATA_DIR: profile, SMOKE_STEP: step, SMOKE_OUT: stepOut, SMOKE_PLAIN: plain, ...extra });
      assert.equal(ran.code, 0, `the stand-in gateway's step ${step} failed`);
      return JSON.parse(readFileSync(stepOut, "utf8")) as { freshNull?: boolean; oneKey?: boolean; idFile?: boolean; files?: string[]; sealed?: string; reopened?: boolean };
    };
    const first = await gatewayStep("1");
    assert.equal(first.freshNull, true); checks.push("reading a fresh profile creates no key or files");
    assert.equal(first.oneKey, true, "Concurrent helpers must share exactly one master key");
    checks.push("six simultaneous Rust helpers share one OS-stored key");
    assert.equal(first.idFile, true);
    assert.deepEqual(first.files, ["vault-id", "vault.lock"]); checks.push("profile contains only public id and lock, no master key file");
    const sealed = first.sealed!;
    assert.ok(!sealed.includes(plain));
    await stop(); await start();
    assert.equal((await gatewayStep("2", { SMOKE_SEALED: sealed })).reopened, true, "Restarted daemon/helper must decrypt the existing key");
    checks.push("encrypted setting survives keyring daemon and host-vault restart");
    const revealEnv = { ...process.env, WORKBENCH_DATA_DIR: profile, GENOFFICE_APP_BIN: binary, GENOFFICE_AI_SETTINGS: join(profile, "office/ai-settings.json") };
    const settings = JSON.stringify({ providers: { openai: { apiKey: sealed } } });
    writeFileSync(revealEnv.GENOFFICE_AI_SETTINGS, settings, { mode: 0o600 });
    const legacy = "sealed:v1:legacy-fixture", tag = sealed.lastIndexOf(".") + 1;
    const tampered = sealed.slice(0, tag) + (sealed[tag] === "A" ? "B" : "A") + sealed.slice(tag + 1);
    // Anyone else — a process an engine runs knows the binary, the folder and the sealed values — gets
    // nothing by either switch (this ASSERTED the opposite before 2026-11-15: sec-vault).
    const engine = (args: string[], input: string, env = revealEnv) => childRun(process.execPath, ["-e", `
      const r = require("node:child_process").spawnSync(process.argv[1], JSON.parse(process.argv[2]), { input: process.argv[3], encoding: "utf8", timeout: 30000 });
      process.stdout.write(JSON.stringify({ code: r.status, stdout: r.stdout, stderr: r.stderr }));`, binary, JSON.stringify(args), input], "", env);
    const asEngine = async (args: string[], input: string, env = revealEnv) => JSON.parse((await engine(args, input, env)).stdout) as { code: number; stdout: string; stderr: string };
    const reveal = await asEngine(["--reveal-ai-secrets"], JSON.stringify([sealed, legacy, tampered]));
    assert.equal(reveal.code, 2); assert.equal(reveal.stdout, "");
    assert.ok(!reveal.stdout.includes(plain) && !reveal.stderr.includes(plain));
    checks.push("--reveal-ai-secrets opens nothing for anyone and starts no window");
    const key = await asEngine(["--office-secret-key"], JSON.stringify({ directory: profile, create: false }));
    // No gateway runs now (the stand-in exited): nobody registers, nobody is answered.
    assert.equal(key.code, 1); assert.deepEqual(JSON.parse(key.stdout), { ok: false, error: "gateway_not_registered" });
    checks.push("--office-secret-key refuses a process that is not the folder's gateway (and does not register it)");
    // A fake folder: the vault-id copied, a lock record naming the engine-run process; it registers itself there.
    const fake = join(root, "fake-profile");
    mkdirSync(join(fake, "office"), { recursive: true }); mkdirSync(join(fake, "host.lock"), { recursive: true });
    writeFileSync(join(fake, "office/vault-id"), readFileSync(join(profile, "office/vault-id")));
    const forged = await asEngine(["--office-secret-key"], JSON.stringify({ directory: fake, create: false }));
    assert.equal(forged.code, 1); assert.equal(JSON.parse(forged.stdout).ok, false); assert.equal(JSON.parse(forged.stdout).key, undefined);
    checks.push("a fake folder with a copied vault-id gets no key");
    const fixture = join(root, "original-cli-secret.mjs");
    await build({
      stdin: { contents: `import { cliSecretCodec } from './vendor/ieumoffice/packages/cli/src/secrets.ts';
        import { readFileSync } from 'node:fs';
        const request = JSON.parse(readFileSync(0, 'utf8'));
        const codec = cliSecretCodec(process.env);
        if (codec.open(request.sealed) !== null) process.exit(1);
        console.log('original CLI gets no stored key');`, resolveDir: repo },
      bundle: true, platform: "node", format: "esm", target: "node24", outfile: fixture, logLevel: "silent",
      banner: { js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" },
    });
    const cli = await childRun(process.execPath, [fixture], JSON.stringify({ sealed, plain }), revealEnv);
    assert.equal(cli.code, 0); assert.ok(cli.stdout.includes("original CLI gets no stored key"));
    checks.push("IeumOffice's original CLI, as an engine runs it, opens no stored key");
    assert.ok(readFileSync(revealEnv.GENOFFICE_AI_SETTINGS, "utf8") === settings);
    checks.push("the refusals leave the saved settings bytes unchanged");
    const built = await childRun(process.execPath, [join(repo, "scripts/smoke-office-ai.ts"), join(outDir, "gateway"), binary]);
    assert.equal(built.code, 0, "Built host settings/provider validation failed; inspect gateway results");
    checks.push("compiled host saves encrypted settings and uses the key through original provider protocol");
    const before = readFileSync(join(profile, "office/vault-id"));
    const brokenEnv = { ...process.env, DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(root, "no-bus")}` };
    const failed = await childRun(binary, ["--office-secret-key"], JSON.stringify({ directory: profile, create: true }), brokenEnv);
    assert.equal(failed.code, 1); assert.deepEqual(JSON.parse(failed.stdout), { ok: false, error: "vault_unavailable" });
    assert.ok(readFileSync(join(profile, "office/vault-id")).equals(before)); checks.push("unavailable OS vault refuses writes without replacing the existing id");
    await stop(); checks.push("owned keyring stops normally");
  } catch (error) { failure = error; }
  finally {
    try { await stop(); } catch (error) { failure ??= error; }
    writeFileSync(join(outDir, "keyring.log"), daemonOutput, { mode: 0o600 });
    writeFileSync(join(outDir, "results.json"), JSON.stringify({ passed: checks.length, checks, failure: failure instanceof Error ? failure.message : failure ? String(failure) : null, isolatedBusAndKeyring: true, realUserCredentials: false }, null, 2));
  }
  if (failure) { console.error(failure instanceof Error ? failure.message : "Vault test failed"); process.exitCode = 1; }
  else console.log(`${checks.length} native OS-vault checks passed`);
}
