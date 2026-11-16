// The in-app update on THIS Linux machine, end to end, with nothing real touched (app-update brief, "Tests and
// evidence"): a throwaway user-folder install (the pacman payload's layout) of an OLDER gateway built from this
// worktree, a throwaway data folder, a stand-in server on 127.0.0.1 that plays GitHub with a manifest signed by
// a key made for this run (the older gateway is a TEST build that trusts it — WORKBENCH_UPDATE_TEST_KEYS at build
// time), and the real gateway + the real detached helper doing the work.
//   node scripts/update-rig.ts [--keep]          (run it through ux/run-isolated.sh)
// The app's binary is a stand-in script (a real window cannot be driven here): when the helper starts it again it
// starts the gateway of its folder, as the window does. The login unit is a stand-in `systemctl` on the gateway's
// PATH that only records the call. Never the installed app, its data, the real login unit, pkexec or sudo.
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { zstdCompressSync } from "node:zlib";

const repo = resolve(import.meta.dirname, "..");
const keep = process.argv.includes("--keep");
const rig = mkdtempSync("/var/tmp/wb-update-rig-");
// The owner's real install and data (read-only stat before and after: their times must not move).
const owner = process.env.WB_OWNER_HOME ?? "";
const real = owner ? [join(owner, ".local/opt/achmage-workbench"), join(owner, ".local/share/achmage-workbench")] : [];
const stamp = () => real.map(path => { try { return statSync(path).mtimeMs; } catch { return null; } }).join(",");
const realBefore = stamp();
if (!rig.startsWith("/var/tmp/")) throw Error("the rig works only under /var/tmp");
const results: { step: string; ok: boolean; detail?: string }[] = [];
const check = (step: string, ok: boolean, detail = "") => { results.push({ step, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`); };
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const until = async (what: () => boolean | Promise<boolean>, ms = 30_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await what()) return true; await new Promise(r => setTimeout(r, 150)); } return false; };
const started: number[] = [];

// 1. Two gateway builds from this worktree: the OLD one (0.5.0, trusts the rig's key) and the NEW one (0.5.2).
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64");
const build = (dir: string, version: string) => execFileSync(process.execPath, [join(repo, "scripts/build-host.mjs")], { cwd: join(repo, "apps/host"), stdio: ["ignore", "ignore", "inherit"],
  env: { ...process.env, WORKBENCH_HOST_BUILD_DIR: dir, WORKBENCH_BUILD_VERSION: version, WORKBENCH_UPDATE_TEST_KEYS: spki } });
build(join(rig, "build-old/host"), "0.5.0");
build(join(rig, "build-new/host"), "0.5.2");

// 2. The stand-in app binary (both versions): records its start and starts its folder's gateway, as the window does.
const token = randomBytes(24).toString("base64url");
const standIn = (version: string) => `#!/bin/sh
# Stand-in for the app's binary in the update rig (scripts/update-rig.ts).
here=$(dirname "$(readlink -f "$0")")
echo "${version} $here" >> "${rig}/launched.log"
WORKBENCH_DATA_DIR="${rig}/data" WORKBENCH_WEB_DIR="$here/web" WORKBENCH_APP_BIN="$here/achmage-workbench" WORKBENCH_TOKEN="${token}" \\
WORKBENCH_PORT=0 WORKBENCH_EDITORS_PORT=0 WORKBENCH_IEUM_BOOTSTRAP=0 WORKBENCH_UPDATE_SOURCE="$RIG_SOURCE" \\
WORKBENCH_UPDATE_SYSTEMCTL="${rig}/bin/systemctl" WORKBENCH_CODEX_BIN="${repo}/scripts/fixtures/fake-codex.mjs" WORKBENCH_CLAUDE_BIN="${repo}/scripts/fixtures/fake-claude.mjs" PATH="${rig}/bin:$PATH" \\
setsid "${process.execPath}" "$here/host/host.mjs" > "${rig}/gateway-${version}.log" 2>&1 < /dev/null &
echo $! > "${rig}/gateway-${version}.pid"
`;
const layout = (root: string, version: string) => {
  mkdirSync(root, { recursive: true });
  cpSync(join(rig, `build-${version === "0.5.0" ? "old" : "new"}/host`), join(root, "host"), { recursive: true });
  // The web UI: the app's own files (the editors' bundles are not needed for this check).
  mkdirSync(join(root, "web"));
  for (const item of ["index.html", "manifest.webmanifest", "workbench-icon.png", "assets", "fonts"]) cpSync(join(repo, "apps/web/dist", item), join(root, "web", item), { recursive: true });
  writeFileSync(join(root, "web/rig-version.txt"), version);
  mkdirSync(join(root, "skills")); writeFileSync(join(root, "skills/README.md"), `skills ${version}\n`);
  writeFileSync(join(root, "achmage-workbench"), standIn(version)); chmodSync(join(root, "achmage-workbench"), 0o755);
};

// 3. The OLD install: a user folder in the person's own place (here: the rig), no marker (as the owner's).
const folder = join(rig, "home/.local/opt/achmage-workbench");
layout(folder, "0.5.0");
writeFileSync(join(folder, "WORKBENCH-INSTALL.json"), JSON.stringify({ version: "0.5.0", note: "the person's own record: kept across the update" }));

// 4. The NEW package: pacman's layout (usr/lib/achmage-workbench + .PKGINFO + usr/bin), tar (pax) + zstd.
const pkgRoot = join(rig, "pkg");
layout(join(pkgRoot, "usr/lib/achmage-workbench"), "0.5.2");
writeFileSync(join(pkgRoot, "usr/lib/achmage-workbench/install-kind.json"), JSON.stringify({ kind: "pacman" }));
mkdirSync(join(pkgRoot, "usr/bin")); writeFileSync(join(pkgRoot, "usr/bin/achmage-workbench"), "#!/bin/sh\nexec /usr/lib/achmage-workbench/achmage-workbench \"$@\"\n");
writeFileSync(join(pkgRoot, ".PKGINFO"), "pkgname = achmage-workbench\npkgver = 0.5.2-1\n");
execFileSync("tar", ["--format=pax", "-C", pkgRoot, "-cf", join(rig, "pkg.tar"), ".PKGINFO", "usr"]);
const pkgName = "achmage-workbench-0.5.2-1-x86_64.pkg.tar.zst";
const pkg = zstdCompressSync(readFileSync(join(rig, "pkg.tar")));

// 5. The stand-in GitHub on 127.0.0.1: update.json + update.json.sig + the asset (or a tampered asset).
const manifest = Buffer.from(JSON.stringify({ version: "0.5.2", published: "2026-11-16T00:00:00Z", notes: "업데이트 시험", assets: { pacman: { name: pkgName, size: pkg.length, sha256: sha(pkg) } } }, null, 2));
let serveTampered = true;
const asked: string[] = [];
const server = createServer((req, res) => {
  asked.push(req.url ?? "");
  if (req.url === "/update.json") return void res.end(manifest);
  if (req.url === "/update.json.sig") return void res.end(sign(null, manifest, privateKey).toString("base64") + "\n");
  if (req.url === `/${pkgName}`) { const body = Buffer.from(pkg); if (serveTampered) body[Math.floor(body.length / 2)] ^= 0xff; return void res.end(body); }
  res.writeHead(404); res.end();
});
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
const source = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;

// 6. The stand-in login unit manager: says the unit is enabled, records every other call.
mkdirSync(join(rig, "bin"));
writeFileSync(join(rig, "bin/systemctl"), `#!/bin/sh\necho "systemctl $*" >> "${rig}/systemctl.log"\ncase "$*" in *is-enabled*) echo enabled;; esac\nexit 0\n`);
chmodSync(join(rig, "bin/systemctl"), 0o755);

// 7. The data folder with a planted file; the old app starts (its gateway makes state.sqlite).
mkdirSync(join(rig, "data"), { recursive: true, mode: 0o700 });
writeFileSync(join(rig, "data/planted.txt"), `planted ${randomBytes(16).toString("hex")}\n`);
const env = { ...process.env, RIG_SOURCE: source };
const launch = (bin: string) => execFileSync(bin, [], { env, stdio: "ignore" });
const ready = async (version: string) => {
  const log = join(rig, `gateway-${version}.log`);
  let line = "";
  await until(() => { if (!existsSync(log)) return false; line = readFileSync(log, "utf8").split("\n").find(l => l.startsWith("WORKBENCH_READY ")) ?? ""; return !!line; }, 60_000);
  if (!line) throw Error(`the ${version} gateway did not start: ${existsSync(log) ? readFileSync(log, "utf8").slice(-2000) : "no log"}`);
  const pid = Number(readFileSync(join(rig, `gateway-${version}.pid`), "utf8")); started.push(pid);
  return { ...(JSON.parse(line.slice(16)) as { url: string; token: string }), pid };
};
const api = async <T>(gateway: { url: string; token: string }, method: string, body?: unknown) => {
  const response = await fetch(`${gateway.url}/api/host/app-update`, { method, headers: { authorization: `Bearer ${gateway.token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return await response.json() as T;
};
type Status = { state: string; installed: string; kind: string; available: { version: string } | null; message: string | null; progress: number | null; lastResult: { ok: boolean; message: string } | null };
const tree = (root: string) => execFileSync("find", [root, "-printf", "%P %s %m\n"], { encoding: "utf8" }).split("\n").sort().join("\n");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

try {
  launch(join(folder, "achmage-workbench"));
  const old = await ready("0.5.0");
  const plantedHash = sha(readFileSync(join(rig, "data/planted.txt")));
  check("the old gateway runs from the user folder", (await api<Status>(old, "GET")).installed === "0.5.0");
  const first = await api<Status>(old, "GET");
  check("the user folder is recognised (no marker, the person's own folder)", first.kind === "user-folder", first.kind);
  const checked = await api<Status>(old, "POST", { action: "check" });
  check("업데이트 확인 → 0.5.2가 나왔습니다 (signed by the rig's key)", checked.state === "available" && checked.available?.version === "0.5.2", JSON.stringify({ state: checked.state, message: checked.message }));

  // Refusal first: the stand-in serves a tampered package → nothing changes, the gateway keeps running.
  const before = tree(folder);
  await api<Status>(old, "POST", { action: "install" });
  await until(async () => ["failed", "installing"].includes((await api<Status>(old, "GET")).state));
  const refused = await api<Status>(old, "GET");
  check("tampered package → 내려받은 파일이 게시된 것과 다릅니다. 설치하지 않았습니다.", refused.state === "failed" && refused.message === "내려받은 파일이 게시된 것과 다릅니다. 설치하지 않았습니다.", refused.message ?? refused.state);
  check("tampered package → the folder is unchanged, no backup, the gateway still runs", tree(folder) === before && !existsSync(`${folder}.previous`) && alive(old.pid));

  // The real update.
  serveTampered = false;
  await api<Status>(old, "POST", { action: "install" });
  const seen = new Set<string>();
  await until(async () => { try { const s = await api<Status>(old, "GET"); seen.add(s.state + (s.state === "downloading" ? "" : "")); return s.state === "installing" || s.state === "failed"; } catch { return true; } });
  check("업데이트 → 내려받는 중 → 확인하는 중 → 설치하는 중", seen.has("installing") || !alive(old.pid), [...seen].join(" → "));
  check("the old gateway stops for the install", await until(() => !alive(old.pid), 20_000));
  check("the helper writes its result", await until(() => existsSync(join(rig, "data/updates/result.json")), 60_000));
  const result = JSON.parse(readFileSync(join(rig, "data/updates/result.json"), "utf8")) as { ok: boolean; message: string };
  check("result: 0.5.2로 업데이트했습니다.", result.ok && result.message === "0.5.2로 업데이트했습니다.", result.message);
  check("the new files are in place (gateway, web, skills, binary)", readFileSync(join(folder, "web/rig-version.txt"), "utf8") === "0.5.2" && readFileSync(join(folder, "skills/README.md"), "utf8").includes("0.5.2")
    && readFileSync(join(folder, "achmage-workbench"), "utf8").includes('echo "0.5.2'));
  check("the previous folder is the one backup", tree(`${folder}.previous`) === before && readdirSync(join(rig, "home/.local/opt")).sort().join(",") === "achmage-workbench,achmage-workbench.previous", readdirSync(join(rig, "home/.local/opt")).join(","));
  check("the person's own record is kept; the folder is marked user-folder", existsSync(join(folder, "WORKBENCH-INSTALL.json")) && JSON.parse(readFileSync(join(folder, "install-kind.json"), "utf8")).kind === "user-folder");
  const units = existsSync(join(rig, "systemctl.log")) ? readFileSync(join(rig, "systemctl.log"), "utf8") : "";
  check("the login unit is restarted (stand-in systemctl)", /systemctl --user restart kr\.achmage\.workbench\.[0-9a-f]{12}\.service/.test(units), units.trim().split("\n").join(" | "));
  const fresh = await ready("0.5.2");
  check("the app is started again and its gateway runs the new version", (await api<Status>(fresh, "GET")).installed === "0.5.2" && readFileSync(join(rig, "launched.log"), "utf8").includes("0.5.2"));
  const after = await api<Status>(fresh, "GET");
  check("after the restart: one quiet line 0.5.2로 업데이트했습니다.", after.lastResult?.ok === true && after.lastResult.message === "0.5.2로 업데이트했습니다.", after.lastResult?.message);
  check("the data folder is untouched (planted file hash, state.sqlite present)", sha(readFileSync(join(rig, "data/planted.txt"))) === plantedHash && existsSync(join(rig, "data/state.sqlite")));
  const checkedAgain = await api<Status>(fresh, "POST", { action: "check" });
  check("the same version again is 최신 버전입니다 (no sidegrade)", checkedAgain.state === "latest", checkedAgain.state);
  check("only the stand-in source was asked", asked.every(path => ["/update.json", "/update.json.sig", `/${pkgName}`].includes(path)), [...new Set(asked)].join(" "));
  check("the real install and data folders were not touched (their times did not move)", stamp() === realBefore, owner ? realBefore : "WB_OWNER_HOME not given");
} catch (error) {
  check("rig", false, error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  for (const pid of started) try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
  await new Promise(r => setTimeout(r, 1500));
  for (const pid of started) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  server.close();
  writeFileSync(join(rig, "rig-results.json"), JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} passed${keep ? ` — kept at ${rig}` : ""}`);
  if (!keep) rmSync(rig, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
