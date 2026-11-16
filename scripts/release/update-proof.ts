// The in-app update proven on a CI runner (release.yml, job "update-proof"): the candidate installer of this
// commit is installed, then its gateway is replaced by an OLDER test build of the same commit (version 0.0.1,
// trusting a throwaway key made in the web job); this script plays GitHub on 127.0.0.1 with a manifest signed
// by that key, drives 업데이트 through the old gateway's own route, and checks that the helper installed the
// candidate, started the app again (its gateway answers with the new version) and left the data folder intact.
//   node scripts/release/update-proof.ts --kind nsis|dmg|appimage --host <old host dir> --installer <file>
//        --version <new version> --key <pem> --app-bin <installed binary> [--appimage <file>] --out <dir>
// Runs only on a throwaway CI runner (it uses the runner account's default data folder, as the app does).
import { spawn } from "node:child_process";
import { createHash, randomBytes, sign, createPrivateKey } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { attachHost } from "../../apps/host/src/daemon/lifecycle.ts";
import { assetNamePattern, type AssetKind } from "../../apps/host/src/app-update/manifest.ts";

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const kind = arg("kind") as "nsis" | "dmg" | "appimage", host = resolve(arg("host") ?? ""), installer = resolve(arg("installer") ?? ""), version = arg("version") ?? "";
const out = resolve(arg("out") ?? "update-proof-out"), appBin = arg("app-bin") ?? "", appImage = arg("appimage");
if (!process.env.CI) throw Error("update-proof runs on a throwaway CI runner only (it installs software and uses the default data folder)");
if (!["nsis", "dmg", "appimage"].includes(kind) || !existsSync(join(host, "host.mjs")) || !existsSync(installer) || !/^\d+\.\d+\.\d+$/.test(version)) throw Error("usage: see the head of this file");
mkdirSync(out, { recursive: true });
const checks: { step: string; ok: boolean; detail?: string }[] = [];
const check = (step: string, ok: boolean, detail = "") => { checks.push({ step, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`); return ok; };
const until = async (what: () => boolean | Promise<boolean>, ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await what()) return true; } catch { /* not yet */ } await new Promise(r => setTimeout(r, 500)); } return false; };
const dataDir = process.env.WORKBENCH_DATA_DIR ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "achmage-workbench");

// The stand-in GitHub: one asset (this kind), named as the release names it.
const bytes = readFileSync(installer);
const name = basename(installer).replaceAll(" ", ".");
if (!assetNamePattern(kind as AssetKind, version).test(name)) throw Error(`the installer's name ${name} is not the published pattern for ${kind} ${version}`);
const manifest = Buffer.from(JSON.stringify({ version, published: new Date().toISOString(), notes: "update proof", assets: { [kind]: { name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } } }));
const key = createPrivateKey(readFileSync(arg("key") ?? "", "utf8"));
const server = createServer((req, res) => {
  if (req.url === "/update.json") return void res.end(manifest);
  if (req.url === "/update.json.sig") return void res.end(`${sign(null, manifest, key).toString("base64")}\n`);
  if (req.url === `/${name}`) return void res.end(bytes);
  res.writeHead(404); res.end();
});
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
const source = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;

mkdirSync(dataDir, { recursive: true });
const planted = join(dataDir, "update-proof-planted.txt"), plantedValue = `planted ${randomBytes(8).toString("hex")}\n`;
writeFileSync(planted, plantedValue);
const token = randomBytes(24).toString("base64url");
const repo = resolve(import.meta.dirname, "../..");
const gateway = spawn(process.execPath, [join(host, "host.mjs")], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, WORKBENCH_TOKEN: token, WORKBENCH_PORT: "0", WORKBENCH_EDITORS_PORT: "0",
  WORKBENCH_IEUM_BOOTSTRAP: "0", WORKBENCH_APP_BIN: appBin, WORKBENCH_UPDATE_SOURCE: source, ...(appImage ? { WORKBENCH_APPIMAGE_SOURCE: resolve(appImage) } : {}),
  WORKBENCH_CODEX_BIN: join(repo, "scripts/fixtures/fake-codex.mjs"), WORKBENCH_CLAUDE_BIN: join(repo, "scripts/fixtures/fake-claude.mjs") } });
let exited = false; gateway.once("exit", () => { exited = true; });
const ready = await new Promise<{ url: string; token: string }>((done, fail) => {
  gateway.once("exit", code => fail(Error(`the old gateway exited before it was ready (${code})`)));
  createInterface({ input: gateway.stdout! }).on("line", line => { if (line.startsWith("WORKBENCH_READY ")) done(JSON.parse(line.slice(16))); });
});
type Status = { state: string; installed: string; kind: string; installable: boolean; available: { version: string } | null; message: string | null; lastResult: { ok: boolean; message: string } | null };
const api = async (at: { url: string; token: string }, method: string, body?: unknown) =>
  await (await fetch(`${at.url}/api/host/app-update`, { method, headers: { authorization: `Bearer ${at.token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) })).json() as Status;
try {
  const first = await api(ready, "GET");
  check("the old test gateway (0.0.1) runs in the installed app", first.installed === "0.0.1", first.installed);
  check(`this copy is recognised as ${kind} and can be installed in place`, first.kind === kind && first.installable, `${first.kind} installable=${first.installable}`);
  const checked = await api(ready, "POST", { action: "check" });
  check(`업데이트 확인 → ${version} is offered`, checked.state === "available" && checked.available?.version === version, checked.message ?? checked.state);
  await api(ready, "POST", { action: "install" });
  let last: Status | null = null;
  await until(async () => { if (exited) return true; last = await api(ready, "GET"); return ["installing", "failed", "blocked", "saved"].includes(last.state); }, 600_000);
  check("업데이트 → the installer is downloaded, checked and handed to the helper", exited || (last as Status | null)?.state === "installing", (last as Status | null)?.message ?? (last as Status | null)?.state ?? "exited");
  check("the old gateway stops for the install", await until(() => exited, 60_000));
  const resultFile = join(dataDir, "updates/result.json");
  check("the helper leaves its result", await until(() => existsSync(resultFile), 20 * 60_000));
  const result = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, "utf8")) as { ok: boolean; message: string; detail?: string } : null;
  check("the helper installed the new version", !!result?.ok, `${result?.message ?? ""} ${result?.detail ?? ""}`.trim());
  let fresh: Status | null = null;
  const started = await until(async () => { const connection = await attachHost(dataDir); if (!connection) return false; fresh = await api(connection, "GET"); return fresh.installed === version; }, 180_000);
  check(`the app started again and its gateway runs ${version}`, started, (fresh as Status | null)?.installed ?? "no gateway");
  check("after the restart one line says it", (fresh as Status | null)?.lastResult?.ok === true, (fresh as Status | null)?.lastResult?.message ?? "");
  check("the data folder is intact (planted file, state.sqlite)", readFileSync(planted, "utf8") === plantedValue && existsSync(join(dataDir, "state.sqlite")));
} catch (error) {
  check("proof", false, error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  server.close();
  if (!exited) gateway.kill();
  writeFileSync(join(out, "update-proof.json"), JSON.stringify({ kind, version, checks }, null, 2));
  for (const file of ["updates/helper.log", "updates/result.json", "service.log"]) if (existsSync(join(dataDir, file))) writeFileSync(join(out, basename(file)), readFileSync(join(dataDir, file)));
  const failed = checks.filter(c => !c.ok).length;
  console.log(`${checks.length - failed}/${checks.length} passed`);
  process.exit(failed ? 1 : 0);
}
