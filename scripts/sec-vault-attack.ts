// Regression check for sec-vault (round 1 and the independent review's round 2): a process an engine
// runs — or any program of the person that does not hold the gateway's per-run ticket — must get
// NOTHING stored in the vault through the app's own binary (new or OLD), while the gateway's own
// unseal keeps working through every way it is started.
// Runs on a NEW private D-Bus with a private gnome-keyring unlocked with a made-up password (never the
// desktop bus or the person's keyring), in a mount namespace in which the person's DEFAULT data
// folder path is an empty temp folder (asserted empty before anything; the real one is never seen),
// with planted FAKE words only. Prints booleans ("the planted value came back: false"), never a key.
//
// Usage (through ux/run-isolated.sh, Linux):
//   node scripts/sec-vault-attack.ts <new binary> --maker <binary that makes the vault> --maker-host <its host dir>
//        [--host <new host dir, default apps/host/dist>] [--old <binary>]... [--back <binary> --back-host <dir>]
// --maker: an OLD binary (before round 1, or round 1 = wave 21) that makes the vault and seals the
// planted words, as the person's install did; its host registers a messenger bot (the upgrade path).
// --old: further old binaries tried as attackers. --back: the build the way back returns to.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createDecipheriv, createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { FAKE_TOKEN, FakeTelegram } from "../apps/host/src/channels/fake-telegram.ts";
import { gatewayLaunch } from "./fixtures/launch-gateway.ts";

const self = fileURLToPath(import.meta.url), repo = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const flag = (name: string) => { const at = args.indexOf(name); return at >= 0 ? resolve(args[at + 1]!) : undefined; };
const flags = (name: string) => args.flatMap((value, at) => value === name && args[at + 1] ? [resolve(args[at + 1]!)] : []);
const newBinary = resolve(args[0]!), hostDir = flag("--host") ?? join(repo, "apps/host/dist");
const maker = flag("--maker"), makerHost = flag("--maker-host"), back = flag("--back"), backHost = flag("--back-host");
const olds = [...new Set([...flags("--old"), ...(maker ? [maker] : []), ...(back ? [back] : [])])];
const DEFAULT = join(userInfo().homedir, ".local/share/achmage-workbench");
const MASK = ".sec-vault-mask";
const VAULT = "kr.achmage.workbench.vault", LEGACY = "kr.achmage.workbench.office-ai";
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const run = (command: string, argv: string[], env: NodeJS.ProcessEnv, input = "") => new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
  const child = spawn(command, argv, { env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("owned process timed out")); }, 300_000);
  child.stdout!.on("data", (part: Buffer) => { stdout += part; }); child.stderr!.on("data", (part: Buffer) => { stderr += part; });
  child.once("error", (error) => { clearTimeout(timer); reject(error); });
  child.once("close", (code) => { clearTimeout(timer); done({ code, stdout, stderr }); }); child.stdin!.end(input);
});

if (!args.includes("--private-bus")) {
  assert.equal(process.platform, "linux", "Linux-only: other OS keyrings need their own native checks");
  assert.ok(maker && makerHost, "--maker <old binary> --maker-host <its host dir> are required");
  // The default folder must already exist to be masked; it is never created in the real home.
  assert.ok(existsSync(DEFAULT) || process.env.SEC_VAULT_DEFAULT_ABSENT_OK === "1", "the default data folder path does not exist; refusing to create it in the real home");
  const sandbox = mkdtempSync(join(tmpdir(), "wb-sec-attack-"));
  for (const rel of ["data/keyrings", "config", "runtime", "control", "mask"]) mkdirSync(join(sandbox, rel), { recursive: true, mode: 0o700 });
  writeFileSync(join(sandbox, "mask", MASK), "");
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_DATA_HOME: join(sandbox, "data"), XDG_CONFIG_HOME: join(sandbox, "config"), XDG_RUNTIME_DIR: join(sandbox, "runtime"), WB_SEC_ROOT: sandbox };
  for (const name of ["DBUS_SESSION_BUS_ADDRESS", "DBUS_STARTER_ADDRESS", "DBUS_STARTER_BUS_TYPE", "GNOME_KEYRING_CONTROL", "GNOME_KEYRING_PID", "SSH_AUTH_SOCK", "DISPLAY", "WAYLAND_DISPLAY"]) delete env[name];
  try {
    const result = await run("dbus-run-session", ["--", "bwrap", "--dev-bind", "/", "/", "--bind", join(sandbox, "mask"), DEFAULT, "--", process.execPath, self, ...args, "--private-bus"], env);
    process.stdout.write(result.stdout);
    if (result.code !== 0) { process.stderr.write(result.stderr.split("\n").filter((line) => !line.includes("planted")).slice(-40).join("\n")); process.exitCode = 1; }
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
} else {
  const root = process.env.WB_SEC_ROOT!;
  // Never the desktop's bus, never the real default folder: refuse unless both are the private stand-ins.
  assert.ok(root && process.env.DBUS_SESSION_BUS_ADDRESS && !process.env.DBUS_SESSION_BUS_ADDRESS.includes("/run/user/"), "not on a private bus");
  assert.deepEqual(readdirSync(DEFAULT), [MASK], "the default data folder is not the empty mask");
  const D = DEFAULT;
  const failures: string[] = [];
  const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failures.push(what); };
  const keyring = spawn("gnome-keyring-daemon", ["--foreground", "--components=secrets", "--unlock", "--control-directory", join(root, "control")], { stdio: ["pipe", "ignore", "ignore"] });
  keyring.stdin!.end(randomBytes(24).toString("base64"));
  const fake = new FakeTelegram();
  const owned = new Set<ChildProcess>();
  /** The gateways' stderr, shown (without lines naming planted words) when a check fails. */
  const logs: string[] = [];
  const S = mkdtempSync(join(root, "s-"));
  const home = join(S, "home"); mkdirSync(home, { recursive: true });
  const planted = { office: "planted-office-word-for-sec-check", cred: "planted-cred-word-for-sec-check", channel: "planted-channel-word-for-sec-check" };
  const PREFIX = "sealed:v1:workbench:";
  let sealed: { office: string; cred: string; channel: string; credBind: string } | null = null;
  const openOne = (key: string, value: string, purpose?: string, bind?: string) => {
    try {
      const [id, ...rest] = value.slice(PREFIX.length).split(":");
      const body = purpose ? rest.slice(1).join(":") : rest.join(":");
      const [nonce, bytes, tag] = body.split(".").map((part) => Buffer.from(part, "base64url"));
      const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "base64"), nonce!);
      decipher.setAAD(Buffer.from(`${PREFIX}${id}${purpose ? `:${purpose}` : ""}${bind ? `\n${bind}` : ""}`)); decipher.setAuthTag(tag!);
      return Buffer.concat([decipher.update(bytes!), decipher.final()]).toString("utf8");
    } catch { return null; }
  };
  /** Whether a helper's answer (its stdout) carries the master key — which opens every planted word. */
  const cameBack = (stdout: string) => {
    let key: unknown; try { key = JSON.parse(stdout.trim().split("\n").pop() ?? "").key; } catch { return false; }
    if (typeof key !== "string") return false;
    if (sealed && ![openOne(key, sealed.office), openOne(key, sealed.cred, "cred", sealed.credBind), openOne(key, sealed.channel, "channel")].some((word) => word && Object.values(planted).includes(word))) console.log("note: a key came back that opens none of the planted words");
    return true;
  };
  const answerOf = (stdout: string) => { try { const a = JSON.parse(stdout.trim().split("\n").pop() ?? ""); return a.ok ? (a.key ? "KEY" : "no key") : String(a.error); } catch { return `unreadable(${stdout.length})`; } };
  const request = JSON.stringify({ directory: D, create: false });
  const askAs = (binary: string, input = request) => { const r = spawnSync(binary, ["--office-secret-key"], { input, encoding: "utf8", timeout: 30_000, env: { PATH: process.env.PATH!, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS!, HOME: home } }); return { came: cameBack(r.stdout), answer: answerOf(r.stdout) }; };
  const items = (service: string) => {
    const r = spawnSync("secret-tool", ["search", "--all", "service", service], { encoding: "utf8", env: { PATH: process.env.PATH!, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS! } });
    return [...`${r.stdout}\n${r.stderr}`.matchAll(/attribute\.username = (.+)/g)].map((m) => m[1]!.trim().replace(/^[a-f0-9]{32}/, "<id>").replace(/^gateway:[a-f0-9]+$/, "gateway:<hash>")).sort();
  };

  // ---- gateways
  type Gateway = { child: ChildProcess; url: string; token: string; mode: "launcher" | "direct" };
  const newInstall = gatewayLaunch(join(hostDir, "host.mjs"), newBinary, { copyHost: true, under: S });
  const installRoot = newInstall.root!;
  const stagedBinary = newInstall.command, stagedHost = join(installRoot, "app/host");
  const gatewayEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    PATH: process.env.PATH!, HOME: home, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS!, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR!,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME!, SHELL: "/bin/bash", TMPDIR: S,
    WORKBENCH_DATA_DIR: D, WORKBENCH_IEUM_BOOTSTRAP: "0", WORKBENCH_PORT: "0", WORKBENCH_EDITORS_PORT: "0", WORKBENCH_HOST_LABEL: "보안 확인",
    WORKBENCH_CLAUDE_BIN: join(repo, "scripts/fixtures/fake-claude.mjs"), WORKBENCH_TELEGRAM_API: fake.url, ...extra,
  });
  const ready = (child: ChildProcess) => new Promise<{ url: string; token: string }>((done, reject) => {
    const timer = setTimeout(() => reject(new Error("gateway not ready in 60 s")), 60_000);
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`gateway exited before readiness (${code})`)); });
    createInterface({ input: child.stdout! }).on("line", (line) => { if (line.startsWith("WORKBENCH_READY ")) { clearTimeout(timer); done(JSON.parse(line.slice(16))); } });
  });
  /** The NEW gateway, started as the app starts it: by the binary's launcher. */
  const startNew = async (extra: Record<string, string> = {}): Promise<Gateway> => {
    const child = spawn(stagedBinary, ["--host-runtime"], { env: gatewayEnv({ WORKBENCH_HOST_MODE: "shell", ...extra }), stdio: ["ignore", "pipe", "pipe"] });
    owned.add(child); child.stderr!.on("data", (part: Buffer) => { logs.push(`[new] ${part}`); });
    return { child, ...(await ready(child)), mode: "launcher" };
  };
  /** An OLD build's gateway (its host started directly, its binary as helper — as that build did). */
  const startOld = async (binary: string, host: string): Promise<Gateway> => {
    const child = spawn(process.execPath, [join(host, "host.mjs")], { env: gatewayEnv({ WORKBENCH_SECRET_BIN: binary, WORKBENCH_PTY_BIN: binary, WORKBENCH_APP_BIN: binary, WORKBENCH_EXIT_ON_STDIN_CLOSE: "1" }), stdio: ["pipe", "pipe", "pipe"] });
    owned.add(child); child.stderr!.on("data", (part: Buffer) => { logs.push(`[old] ${part}`); });
    return { child, ...(await ready(child)), mode: "direct" };
  };
  const stop = async (gateway: Gateway | null) => {
    if (!gateway || gateway.child.exitCode !== null || gateway.child.signalCode !== null) return;
    const gone = new Promise((done) => gateway.child.once("exit", done));
    if (gateway.mode === "direct") gateway.child.stdin?.end(); else gateway.child.kill("SIGTERM");
    await Promise.race([gone, sleep(15_000).then(() => gateway.child.kill("SIGKILL"))]);
    // The launcher waits for its gateway; the lock is gone with it.
    for (let i = 0; i < 100 && existsSync(join(D, "host.lock")); i++) await sleep(100);
  };
  const api = async <T>(gateway: { url: string; token: string }, method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${gateway.url}${path}`, { method, headers: { authorization: `Bearer ${gateway.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`);
    return await response.json() as T;
  };
  /** The messenger's long poll reached the stand-in Telegram after `mark` (the stored token opened). */
  const messengerAlive = async (mark: number, ms = 15_000) => { for (let i = 0; i < ms / 100; i++) { if (fake.calls.slice(mark).some((call) => call.method === "getUpdates")) return true; await sleep(100); } return false; };
  const vaultOf = async (gateway: Gateway) => (await api<{ vault?: { state: string; reason: string | null } }>(gateway, "GET", "/api/host")).vault;

  let gateway: Gateway | null = null;
  try {
    for (let i = 0; i < 50; i++) {
      const bus = await run("gdbus", ["call", "--session", "--dest", "org.freedesktop.DBus", "--object-path", "/org/freedesktop/DBus", "--method", "org.freedesktop.DBus.NameHasOwner", "org.freedesktop.secrets"], process.env);
      if (bus.stdout.includes("true")) break;
      await sleep(100);
    }
    await fake.start();
    // Code a planted package would run inside the gateway if Node found it by walking up from the install.
    const moduleMark = join(S, "planted-module-ran");
    for (const name of ["bufferutil", "utf-8-validate", "supports-color"]) {
      mkdirSync(join(installRoot, "node_modules", name), { recursive: true });
      writeFileSync(join(installRoot, "node_modules", name, "package.json"), JSON.stringify({ name, main: "index.js" }));
      writeFileSync(join(installRoot, "node_modules", name, "index.js"), `require("node:fs").appendFileSync(${JSON.stringify(moduleMark)}, ${JSON.stringify(name)} + "\\n"); module.exports = {};`);
    }

    // ---- 1. The vault as the person's OLD install made it: the old binary seals the planted words; the
    //         old gateway registers a messenger bot (its token sealed by the same key).
    const plant = await run(process.execPath, ["--input-type=module", "-e", `
      import { OfficeVault, nativeOfficeVault } from ${JSON.stringify(join(repo, "apps/host/src/office-vault.ts"))};
      import { writeFileSync } from "node:fs";
      const [dataDir, binary, office, cred, channel] = process.argv.slice(1), credBind = "entry-sec\\u0000password";
      const vault = new OfficeVault(dataDir, nativeOfficeVault(dataDir, binary));
      const sealed = { office: await vault.seal(office), cred: await vault.sealFor("cred", cred, credBind), channel: await vault.sealFor("channel", channel), credBind };
      vault.close();
      writeFileSync(dataDir + "/sec-planted-sealed.json", JSON.stringify(sealed), { mode: 0o600 });
      console.log(Object.values(sealed).slice(0, 3).every((value) => value.startsWith("sealed:v1:workbench:")));`, D, maker!, planted.office, planted.cred, planted.channel], gatewayEnv());
    check(plant.code === 0 && plant.stdout.trim() === "true", "the OLD binary made the vault and sealed three planted words");
    sealed = JSON.parse(readFileSync(join(D, "sec-planted-sealed.json"), "utf8"));
    const old = await startOld(maker!, makerHost!);
    await api(old, "POST", "/api/channels/telegram/bots", { token: FAKE_TOKEN });
    check(fake.of("getMe").length > 0, "the OLD gateway registered a messenger bot (its token sealed)");
    await stop(old);
    console.log(`keyring before the upgrade — old name: ${JSON.stringify(items(LEGACY))}; new name: ${JSON.stringify(items(VAULT))}`);
    const beforeUpgrade = olds.map((binary) => askAs(binary));
    check(beforeUpgrade.some((answer) => answer.came), `BASELINE: before the upgrade an old binary hands the key to a plain process (the hole the move closes): ${beforeUpgrade.some((a) => a.came)}`);

    // ---- 2. The upgrade: the NEW gateway through the launcher, on the old vault.
    let mark = fake.calls.length;
    gateway = await startNew();
    check(await messengerAlive(mark), "UPGRADE: the messenger reconnected with the token the old build sealed (the gateway's own unseal works)");
    check((await vaultOf(gateway))?.state === "open", "UPGRADE: the gateway's vault is open");
    const legacyAfter = items(LEGACY), vaultAfter = items(VAULT);
    console.log(`keyring after the upgrade — old name: ${JSON.stringify(legacyAfter)}; new name: ${JSON.stringify(vaultAfter)}`);
    check(legacyAfter.length === 0, "UPGRADE: nothing is left under the name old binaries read");
    check(vaultAfter.includes("<id>") && vaultAfter.includes("<id>:folder") && vaultAfter.includes("gateway:<hash>"), "UPGRADE: the key, its folder binding and the gateway's registration are under the new name");

    // ---- 3. Attacks while the NEW gateway runs.
    for (const binary of olds) check(!askAs(binary).came, `OLD binary (${createHash("sha256").update(readFileSync(binary)).digest("hex").slice(0, 8)}…) asked by a plain process while the new gateway runs: the planted value came back: ${askAs(binary).came}`);
    const plainNew = askAs(stagedBinary);
    check(!plainNew.came, `NEW binary asked by a plain process: the planted value came back: ${plainNew.came} (${plainNew.answer})`);
    const withTicketGuess = askAs(stagedBinary, JSON.stringify({ directory: D, create: false, ticket: "0".repeat(64) }));
    check(!withTicketGuess.came, `NEW binary with a made-up ticket: the planted value came back: ${withTicketGuess.came} (${withTicketGuess.answer})`);
    // The engine in 전체 접근 (Bash, no prompt) runs the round-1 attack file with exactly the engine's environment.
    const scratch = mkdtempSync(join(S, "attack-"));
    const attack = join(scratch, "engine-attack.mjs"), result = join(scratch, "attack-result.json");
    copyFileSync(join(repo, "scripts/fixtures/engine-attack.mjs"), attack);
    const work = await api<{ id: string }>(gateway, "POST", "/api/works", { title: "보안 확인", cwd: scratch });
    const session = await api<{ id: string }>(gateway, "POST", `/api/works/${work.id}/sessions`, { provider: "claude", purpose: "보안 확인", access: "full" });
    await api(gateway, "POST", `/api/sessions/${session.id}/messages`, { requestId: `sec-${randomBytes(4).toString("hex")}`, text: `[[node ${attack} ${stagedBinary}]]` });
    for (let i = 0; i < 600 && !existsSync(result); i++) await sleep(100);
    check(existsSync(result), "the engine ran the attack file through Bash (전체 접근, no prompt)");
    const fromEngine = existsSync(result) ? JSON.parse(readFileSync(result, "utf8")) as { opened: string[]; helperPathsInEnvironment: string[]; inspectorOpened: boolean | string; grandchildRan: boolean; fakeFolderTried?: boolean; recordRewriteTried?: boolean } : null;
    rmSync(result, { force: true });
    const came = (opened: string[] | undefined) => Object.values(planted).some((word) => (opened ?? []).includes(word));
    check(!!fromEngine && !came(fromEngine.opened), `from the engine (both switches, its double-forked grandchild, a fake folder, a rewritten lock record): the planted value came back: ${fromEngine ? came(fromEngine.opened) : "unknown"}`);
    check(!!fromEngine && fromEngine.grandchildRan && fromEngine.fakeFolderTried === true && fromEngine.recordRewriteTried === true, "…and each of those was really tried");
    check(!!fromEngine && fromEngine.helperPathsInEnvironment.length === 0, `the engine's environment names the helper or the gateway token: ${fromEngine ? fromEngine.helperPathsInEnvironment.length > 0 : "unknown"}`);
    check(!!fromEngine && fromEngine.inspectorOpened === false, `SIGUSR1 to the gateway opened Node's inspector: ${fromEngine?.inspectorOpened}`);
    // A `git` planted in <data>/bin, the folder the earlier login unit put first; the gateway is made to look at a git folder.
    const gitMark = join(S, "git.ran"), gitOut = join(S, "git.out");
    mkdirSync(join(D, "bin"), { recursive: true });
    writeFileSync(join(S, "req.json"), request);
    writeFileSync(join(D, "bin/git"), `#!/bin/sh\nif [ ! -e "${gitMark}" ]; then : > "${gitMark}"; exec "${stagedBinary}" --office-secret-key < "${S}/req.json" > "${gitOut}"; fi\nexec /usr/bin/git "$@"\n`, { mode: 0o755 });
    const project = join(S, "project"); mkdirSync(project); spawnSync("/usr/bin/git", ["init", "-q", project]);
    await api(gateway, "POST", "/api/works", { title: "경로 확인", cwd: project }).catch(() => null);
    const ids = [...new Set(JSON.stringify(await api(gateway, "GET", "/api/snapshot").catch(() => ({}))).match(/"id":"[^"]+"/g) ?? [])].map((m) => m.slice(6, -1));
    let gitAsked = 0;
    for (const id of ids.slice(0, 80)) for (const sub of ["repository", "scm"]) { if (await fetch(`${gateway.url}/api/workspaces/${id}/${sub}`, { headers: { authorization: `Bearer ${gateway.token}` } }).then((r) => r.ok).catch(() => false)) gitAsked += 1; }
    await sleep(1500);
    check(gitAsked > 0, `the gateway was made to look at a git folder (${gitAsked} answered)`);
    check(!existsSync(gitMark), `the \`git\` planted in <data>/bin was run by the gateway: ${existsSync(gitMark)}`);
    check(!(existsSync(gitOut) && cameBack(readFileSync(gitOut, "utf8"))), "…and the planted value came back through it: false");
    // A direct child of the gateway that execs the helper (an engine binary the gateway probes with --version):
    // the right parent, no ticket.
    const childOut = join(S, "child.out"), evil = join(S, "evil-codex");
    writeFileSync(evil, `#!/bin/sh\nif [ "$1" = "--version" ] && [ ! -e "${childOut}" ]; then exec "${stagedBinary}" --office-secret-key < "${S}/req.json" > "${childOut}"; fi\necho "codex-cli 0.0.1"\n`, { mode: 0o755 });

    // ---- 4. The registration item deleted while the gateway runs (anyone with the keyring tool).
    const busEnv = { PATH: process.env.PATH!, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS! };
    const listed = spawnSync("secret-tool", ["search", "--all", "service", VAULT], { encoding: "utf8", env: busEnv });
    const gatewayUser = `${listed.stdout}\n${listed.stderr}`.match(/attribute\.username = (gateway:[a-f0-9]+)/)?.[1] ?? "none";
    const deleted = spawnSync("secret-tool", ["clear", "service", VAULT, "username", gatewayUser], { encoding: "utf8", env: busEnv });
    check(deleted.status === 0 && !items(VAULT).includes("gateway:<hash>"), "the registration item was deleted with secret-tool");
    const afterDelete = askAs(stagedBinary);
    check(!afterDelete.came, `registration deleted, then a plain caller: the planted value came back: ${afterDelete.came} (${afterDelete.answer})`);
    check(!items(VAULT).includes("gateway:<hash>"), "…and that caller did not register itself");
    const retried = await api<{ state: string }>(gateway, "POST", "/api/host/vault/retry").catch(() => ({ state: "error" }));
    check(retried.state === "open" && items(VAULT).includes("gateway:<hash>"), `다시 시도: the launcher wrote the registration again (vault ${retried.state})`);
    await stop(gateway); gateway = null;

    // ---- 5. No gateway running (after a stop, a crash, before the login unit): nobody registers.
    const gap = askAs(stagedBinary);
    check(!gap.came, `no gateway running, a short-lived caller: the planted value came back: ${gap.came} (${gap.answer})`);
    for (const binary of olds) check(!askAs(binary).came, `no gateway running, an OLD binary: the planted value came back: false`);

    // ---- 6. Restart with every start-time attack armed: an rc file that execs the helper in the login-shell
    //         check, an evil engine binary probed by the gateway as its direct child, NODE_OPTIONS/LD_PRELOAD
    //         handed to the launcher, planted packages above the install.
    const rcOut = join(S, "rc.out"), evilRan = join(S, "evil-require-ran");
    writeFileSync(join(home, ".bash_profile"), `if [ -n "$WORKBENCH_SHELL_PROBE" ] && [ ! -e "${rcOut}" ]; then exec "${stagedBinary}" --office-secret-key < "${S}/req.json" > "${rcOut}"; fi\n`);
    writeFileSync(join(S, "evil.cjs"), `require("node:fs").writeFileSync(${JSON.stringify(evilRan)}, "ran");`);
    mark = fake.calls.length;
    gateway = await startNew({ NODE_OPTIONS: `--require ${join(S, "evil.cjs")}`, LD_PRELOAD: join(S, "no-such-library.so"), WORKBENCH_CODEX_BIN: evil });
    check(await messengerAlive(mark), "RESTART (attacks armed): the messenger reconnected");
    for (let i = 0; i < 100 && !existsSync(rcOut); i++) await sleep(100);
    check(existsSync(rcOut), "the rc file's exec ran in the gateway's login-shell check");
    check(!(existsSync(rcOut) && cameBack(readFileSync(rcOut, "utf8"))), `RC FILE: the planted value came back: ${existsSync(rcOut) && cameBack(readFileSync(rcOut, "utf8"))} (${existsSync(rcOut) ? answerOf(readFileSync(rcOut, "utf8")) : "-"})`);
    await api(gateway, "GET", "/api/engines").catch(() => null);
    for (let i = 0; i < 100 && !existsSync(childOut); i++) await sleep(100);
    check(existsSync(childOut), "an engine binary the gateway probes as its DIRECT child exec'd the helper");
    check(!(existsSync(childOut) && cameBack(readFileSync(childOut, "utf8"))), `DIRECT CHILD without the ticket: the planted value came back: ${existsSync(childOut) && cameBack(readFileSync(childOut, "utf8"))} (${existsSync(childOut) ? answerOf(readFileSync(childOut, "utf8")) : "-"})`);
    check(!existsSync(evilRan), `NODE_OPTIONS --require given to the launcher ran inside the gateway: ${existsSync(evilRan)}`);
    check(!existsSync(moduleMark), `a package planted in node_modules above the install was loaded into the gateway: ${existsSync(moduleMark)}`);
    rmSync(join(home, ".bash_profile"), { force: true });

    // ---- 7. The login unit: generated by the gateway, started as systemd starts it; prepare-update + start; two quick restarts.
    await api(gateway, "PUT", "/api/host/autostart", { enabled: true }).catch(() => null);
    const launcherFile = join(D, "login-start.mjs");
    check(existsSync(launcherFile), "the gateway wrote the login unit's launcher (login-start.mjs)");
    check(existsSync(launcherFile) && !readFileSync(launcherFile, "utf8").includes(join(D, "bin")), "…and its PATH does not hold <data>/bin");
    await stop(gateway); gateway = null;
    const service = (action: string) => run(process.execPath, [join(stagedHost, "workbench-service.mjs"), action], gatewayEnv());
    const loginStart = () => run(process.execPath, [launcherFile], gatewayEnv());
    const attached = async () => {
      const status = await service("status");
      try { return JSON.parse(status.stdout.trim().split("\n").pop()!) as { state: string; vault?: string }; } catch { return { state: "unknown" }; }
    };
    for (const [label, startIt] of [["LOGIN UNIT", loginStart], ["PREPARE-UPDATE + START", async () => { await service("prepare-update"); return loginStart(); }], ["QUICK RESTART 1", async () => { await service("stop"); return loginStart(); }], ["QUICK RESTART 2", async () => { await service("stop"); return loginStart(); }]] as const) {
      mark = fake.calls.length;
      const started = await startIt();
      const status = await attached();
      check(started.code === 0 && status.state === "running", `${label}: the service runs (${status.state})`);
      check(status.vault === "비밀 보관함: 열림", `${label}: the service status says the vault is open (${status.vault ?? "-"})`);
      check(await messengerAlive(mark), `${label}: the messenger reconnected`);
    }
    // An earlier build's login unit: its PATH starts with <data>/bin (where the planted git still is).
    rmSync(gitMark, { force: true }); rmSync(gitOut, { force: true });
    await service("stop");
    const oldUnit = join(D, "login-start-old.mjs");
    writeFileSync(oldUnit, readFileSync(launcherFile, "utf8").replace(/"PATH":"/, `"PATH":"${join(D, "bin")}:`));
    mark = fake.calls.length;
    await run(process.execPath, [oldUnit], gatewayEnv());
    check(await messengerAlive(mark), "an EARLIER build's login unit (PATH with <data>/bin first) starts the new gateway; the messenger reconnected");
    // An OLDER login unit that names neither WORKBENCH_SECRET_BIN nor WORKBENCH_APP_BIN (check F3): the
    // service still starts the gateway through the binary beside the install.
    await service("stop");
    mark = fake.calls.length;
    const bare = await service("start");
    const bareStatus = await attached();
    check(bare.code === 0 && bareStatus.state === "running" && bareStatus.vault === "비밀 보관함: 열림", `a login unit naming no binary: the service runs through the launcher, vault open (${bareStatus.state}, ${bareStatus.vault ?? "-"})`);
    check(await messengerAlive(mark), "a login unit naming no binary: the messenger reconnected");
    await service("prepare-update");

    // ---- 8. The way back, then up again.
    if (back && backHost) {
      const once = await startNew();
      const backStatus = await run(process.execPath, [join(stagedHost, "workbench-service.mjs"), "prepare-rollback"], gatewayEnv());
      await Promise.race([new Promise((done) => once.child.once("exit", done)), sleep(15_000)]);
      check(backStatus.code === 0, `WAY BACK: prepare-rollback wrote the key back and stopped the service (exit ${backStatus.code})`);
      mark = fake.calls.length;
      const previous = await startOld(back, backHost);
      check(await messengerAlive(mark), "WAY BACK: the earlier build's gateway opens the vault (the messenger reconnected)");
      await stop(previous);
      mark = fake.calls.length;
      gateway = await startNew();
      check(await messengerAlive(mark), "UP AGAIN: the new gateway opens the vault (the messenger reconnected)");
      check(items(LEGACY).length === 0, `UP AGAIN: nothing is left under the old name (${JSON.stringify(items(LEGACY))})`);
      for (const binary of olds) check(!askAs(binary).came, "UP AGAIN: an OLD binary from a plain process: the planted value came back: false");
      await stop(gateway); gateway = null;
    }

    // The honest limit (not a failure of this check): any program of this person can ask the Secret
    // Service for the item directly. Reported as a fact; the length only, never the bytes.
    const direct = await run("secret-tool", ["lookup", "service", VAULT], { PATH: process.env.PATH ?? "", DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS! }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    console.log(`KNOWN LIMIT (Linux Secret Service, not this fix's scope): an item under the new name is readable by any same-user program without a prompt: ${direct.code === 0 && direct.stdout.length > 0}`);
  } catch (error) { check(false, `harness: ${error instanceof Error ? error.message : String(error)}`); }
  finally {
    await stop(gateway).catch(() => {});
    await run(process.execPath, [join(installRoot, "app/host/workbench-service.mjs"), "stop"], gatewayEnv()).catch(() => null);
    for (const child of owned) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await fake.stop().catch(() => {});
    keyring.kill("SIGTERM");
    newInstall.cleanup();
  }
  if (failures.length) {
    const service = existsSync(join(D, "service.log")) ? readFileSync(join(D, "service.log"), "utf8") : "";
    console.log("--- gateway output (last lines; lines naming planted words left out)");
    console.log([...logs.join("").split("\n"), ...service.split("\n").map((line) => `[service.log] ${line}`)].filter((line) => line.trim() && !line.includes("planted")).slice(-60).join("\n"));
  }
  console.log(failures.length ? `${failures.length} sec-vault checks FAILED` : "all sec-vault checks passed");
  process.exitCode = failures.length ? 1 : 0;
}
