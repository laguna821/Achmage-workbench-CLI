// Linux native OS-vault + built gateway validation, on a NEW private D-Bus/keyring.
// Never use the desktop bus or enumerate/read any existing user credential.
// Usage: node scripts/smoke-office-vault.ts <binary> <evidence-directory>
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { OfficeVault, nativeOfficeVault } from "../apps/host/src/office-vault.ts";

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
    const load = nativeOfficeVault(profile, binary);
    assert.equal(await load(false), null); assert.ok(!existsSync(join(profile, "office"))); checks.push("reading a fresh profile creates no key or files");
    const simultaneous = await Promise.all(Array.from({ length: 6 }, () => load(true)));
    const first = simultaneous[0]!;
    assert.ok(simultaneous.every((entry) => entry?.id === first.id && entry.key.equals(first.key)), "Concurrent helpers must share exactly one master key");
    checks.push("six simultaneous Rust helpers share one OS-stored key");
    assert.ok(readFileSync(join(profile, "office/vault-id"), "utf8") === first.id);
    assert.deepEqual(readdirSync(join(profile, "office")).sort(), ["vault-id", "vault.lock"]); checks.push("profile contains only public id and lock, no master key file");
    const vault = new OfficeVault(profile, load), plain = "private-fixture-api-key", sealed = await vault.seal(plain); vault.close();
    assert.ok(!sealed.includes(plain));
    await stop(); await start();
    const restored = new OfficeVault(profile, load);
    assert.ok((await restored.open(sealed)) === plain, "Restarted daemon/helper must decrypt the existing key"); restored.close();
    checks.push("encrypted setting survives keyring daemon and host-vault restart");
    const revealEnv = { ...process.env, WORKBENCH_DATA_DIR: profile, GENOFFICE_APP_BIN: binary, GENOFFICE_AI_SETTINGS: join(profile, "office/ai-settings.json") };
    const settings = JSON.stringify({ providers: { openai: { apiKey: sealed } } });
    writeFileSync(revealEnv.GENOFFICE_AI_SETTINGS, settings, { mode: 0o600 });
    const legacy = "sealed:v1:legacy-fixture", tag = sealed.lastIndexOf(".") + 1;
    const tampered = sealed.slice(0, tag) + (sealed[tag] === "A" ? "B" : "A") + sealed.slice(tag + 1);
    const reveal = await childRun(binary, ["--reveal-ai-secrets"], JSON.stringify([sealed, legacy, tampered]), revealEnv);
    assert.equal(reveal.code, 0);
    const answer = JSON.parse(reveal.stdout);
    assert.ok(answer.status === "ok" && answer.secrets[sealed] === plain && Object.keys(answer.secrets).length === 1);
    assert.ok(!reveal.stderr.includes(plain));
    checks.push("native reveal opens the Workbench envelope and omits legacy or tampered values without a GUI");
    for (const request of ["{}", JSON.stringify(Array(65).fill(sealed))]) {
      const bad = await childRun(binary, ["--reveal-ai-secrets"], request, revealEnv);
      assert.equal(bad.code, 1); assert.equal(JSON.parse(bad.stdout).status, "error");
    }
    checks.push("original reveal validator rejects malformed and oversized batches");
    const otherProfile = join(root, "other-profile");
    const other = await childRun(binary, ["--reveal-ai-secrets"], JSON.stringify([sealed]), { ...revealEnv, WORKBENCH_DATA_DIR: otherProfile });
    assert.equal(other.code, 0); assert.deepEqual(JSON.parse(other.stdout).secrets, {});
    assert.ok(!existsSync(join(otherProfile, "office")));
    checks.push("another profile cannot reveal the key and a read creates no vault");
    const fixture = join(root, "original-cli-secret.mjs");
    await build({
      stdin: { contents: `import { cliSecretCodec } from './vendor/ieumoffice/packages/cli/src/secrets.ts';
        import { readFileSync } from 'node:fs';
        const request = JSON.parse(readFileSync(0, 'utf8'));
        const codec = cliSecretCodec(process.env);
        if (codec.open(request.sealed) !== request.plain || codec.open(request.sealed) !== request.plain) process.exit(1);
        console.log('original CLI native secret lookup passed');`, resolveDir: repo },
      bundle: true, platform: "node", format: "esm", target: "node24", outfile: fixture, logLevel: "silent",
      banner: { js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" },
    });
    const cli = await childRun(process.execPath, [fixture], JSON.stringify({ sealed, plain }), revealEnv);
    assert.equal(cli.code, 0); assert.ok(cli.stdout.includes("original CLI native secret lookup passed"));
    checks.push("pinned original CLI codec starts native reveal and caches the decrypted key");
    assert.ok(readFileSync(revealEnv.GENOFFICE_AI_SETTINGS, "utf8") === settings);
    checks.push("native and original CLI reveal leave the saved settings bytes unchanged");
    simultaneous.forEach((entry) => entry?.key.fill(0));
    const built = await childRun(process.execPath, [join(repo, "scripts/smoke-office-ai.ts"), join(outDir, "gateway"), binary]);
    assert.equal(built.code, 0, "Built host settings/provider validation failed; inspect gateway results");
    checks.push("compiled host saves encrypted settings and uses the key through original provider protocol");
    const before = readFileSync(join(profile, "office/vault-id"));
    const brokenEnv = { ...process.env, DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(root, "no-bus")}` };
    const failed = await childRun(binary, ["--office-secret-key"], JSON.stringify({ directory: profile, create: true }), brokenEnv);
    assert.equal(failed.code, 1); assert.deepEqual(JSON.parse(failed.stdout), { ok: false, error: "vault_unavailable" });
    assert.ok(readFileSync(join(profile, "office/vault-id")).equals(before)); checks.push("unavailable OS vault refuses writes without replacing the existing id");
    const locked = await childRun(binary, ["--reveal-ai-secrets"], JSON.stringify([sealed]), { ...revealEnv, DBUS_SESSION_BUS_ADDRESS: brokenEnv.DBUS_SESSION_BUS_ADDRESS });
    assert.equal(locked.code, 0); assert.deepEqual(JSON.parse(locked.stdout).secrets, {});
    assert.ok(readFileSync(revealEnv.GENOFFICE_AI_SETTINGS, "utf8") === settings);
    checks.push("unavailable OS vault returns no CLI key and preserves saved settings");
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
