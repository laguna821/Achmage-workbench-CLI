// A Hangul document AI turn (stand-in engine) with the REAL built app binary as the document executor,
// on a private Broadway display this script starts and stops itself — in three gateway environments:
//   present  the gateway has the display in its own environment                → the turn completes
//   session  the gateway has none, the user's session knows one (the 2026-11-17 login-unit case:
//            a stand-in `systemctl --user show-environment` reports it)       → the turn completes
//   none     no display anywhere                                               → the one true sentence, within its bound
//   kinds    display present: one executor turn for every other editor with an executor (Word, PowerPoint, Excel,
//            PDF, Markdown, HTML — scripts/office-ai-live-check.ts --hold-only); a per-kind table (Hangul is `present`)
// The rigs before used a stand-in for `--office-executor`, which is why a gateway without a display was never seen.
//
// The binary never reaches the owner's screen: the gateway runs with no WAYLAND_DISPLAY/DISPLAY, a private empty
// XDG_RUNTIME_DIR and an empty X11 folder, and the binary is started through a wrapper that maps only this script's
// display name (:47 — no X server here) to the private Broadway display; anything else runs it with no display at all.
// Broadway stands in for an X server because the machine has none it may start headless (no Xvfb).
//
// Usage (through ux/run-isolated.sh):
//   RIG_APP_BIN=<built achmage-workbench> node scripts/real-executor-check.ts <outDir> [--host=<gateway bundle>] [--only=present,session,none,kinds] [--formats=docx,xlsx,…]
// Exit 0 when every mode passed.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const outDir = resolve(args.find((arg) => !arg.startsWith("--")) ?? join(tmpdir(), "wb-real-executor"));
const host = args.find((arg) => arg.startsWith("--host="))?.slice(7);
const only = args.find((arg) => arg.startsWith("--only="))?.slice(7).split(",");
/** `--formats=xlsx,pdf`: the kinds mode runs only these editors. */
const formats = args.find((arg) => arg.startsWith("--formats="))?.slice(10);
const binary = process.env.RIG_APP_BIN;
if (!binary || !existsSync(binary)) { console.error("RIG_APP_BIN must name the built app binary"); process.exit(2); }
if (spawnSync("broadwayd", ["--help"], { stdio: "ignore" }).error) { console.error("broadwayd is needed"); process.exit(2); }
mkdirSync(outDir, { recursive: true });

const DISPLAY_NUM = 47, PORT = 18947;
const work = mkdtempSync(join(tmpdir(), "wb-real-executor-"));
const runtimeDir = join(work, "runtime"), x11Dir = join(work, "x11"), bin = join(work, "bin"), log = join(outDir, "executor.log");
for (const dir of [runtimeDir, x11Dir, bin]) mkdirSync(dir, { mode: 0o700 });
writeFileSync(log, "");
const sessionFile = join(work, "session-environment");
// The stand-in session manager: answers only `--user show-environment`, never touches the real one.
writeFileSync(join(bin, "systemctl"), `#!/bin/sh\nif [ "$1" = "--user" ] && [ "$2" = "show-environment" ]; then cat ${JSON.stringify(sessionFile)}; exit 0; fi\necho "systemctl $*" >> ${JSON.stringify(join(work, "other-systemctl.log"))}\nexit 0\n`);
// The wrapper the gateway starts as the app binary.
const wrapper = join(bin, "achmage-workbench");
writeFileSync(wrapper, `#!/bin/sh
echo "start $$ $(date +%T) DISPLAY=\${DISPLAY:-} WAYLAND_DISPLAY=\${WAYLAND_DISPLAY:-} $*" >> ${JSON.stringify(log)}
if [ "\${DISPLAY:-}" = ":${DISPLAY_NUM}" ] && [ -z "\${WAYLAND_DISPLAY:-}" ]; then
  unset DISPLAY; export GDK_BACKEND=broadway BROADWAY_DISPLAY=:${DISPLAY_NUM}
else
  unset DISPLAY WAYLAND_DISPLAY; export GDK_BACKEND=wayland,x11
fi
export WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
${JSON.stringify(binary)} "$@" <&0 &
child=$!
echo "pid $child" >> ${JSON.stringify(log)}
wait $child; code=$?
echo "exit $child $code $(date +%T)" >> ${JSON.stringify(log)}
exit $code
`);
for (const file of ["systemctl", "achmage-workbench"]) chmodSync(join(bin, file), 0o755);

const broadway = spawn("broadwayd", ["--address", "127.0.0.1", "--port", String(PORT), `:${DISPLAY_NUM}`], { stdio: "ignore", env: { ...process.env, XDG_RUNTIME_DIR: runtimeDir } });
const up = async () => { for (let i = 0; i < 50; i++) { if (await new Promise<boolean>((done) => { const s = createConnection(PORT, "127.0.0.1", () => { s.end(); done(true); }); s.on("error", () => done(false)); })) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };
if (!await up()) { console.error("broadwayd did not start"); broadway.kill(); process.exit(2); }

const ownedExecutors = () => [...readFileSync(log, "utf8").matchAll(/^pid (\d+)$/gm)].map((m) => Number(m[1]));
const modes = {
  present: { session: "", gateway: { DISPLAY: `:${DISPLAY_NUM}` }, scenario: "answer" },
  session: { session: `HOME=/nowhere\nDISPLAY=:${DISPLAY_NUM}\nXDG_SESSION_TYPE=x11\nLD_PRELOAD=/nowhere.so\n`, gateway: {}, scenario: "answer" },
  none: { session: "", gateway: {}, scenario: "noscreen" },
  kinds: { session: "", gateway: { DISPLAY: `:${DISPLAY_NUM}` }, scenario: "office" },
} as const;
const kinds: Record<string, string> = {};
const summary: { mode: string; ok: boolean; seconds: number; lines: string[] }[] = [];
for (const [mode, setup] of Object.entries(modes)) {
  if (only && !only.includes(mode)) continue;
  writeFileSync(sessionFile, setup.session);
  appendLog(`== ${mode}`);
  const dir = join(outDir, mode); mkdirSync(dir, { recursive: true });
  const gatewayEnv = { WAYLAND_DISPLAY: null, DISPLAY: null, GDK_BACKEND: null, BROADWAY_DISPLAY: null, XAUTHORITY: null,
    XDG_RUNTIME_DIR: runtimeDir, WORKBENCH_X11_DIR: x11Dir, PATH: `${bin}:${process.env.PATH}`, ...setup.gateway };
  const t0 = Date.now();
  const office = setup.scenario === "office";
  const run = spawnSync(process.execPath, office ? [resolve("scripts/office-ai-live-check.ts"), dir, "--hold-only", ...(formats ? [`--only=${formats}`] : [])] : [resolve("scripts/hwp-ai-check.ts"), dir, "--executor", `--only=${setup.scenario}`], {
    env: { ...process.env, WB_CHECK_APP_BIN: wrapper, WB_CHECK_EXECUTOR_LOG: log, WB_CHECK_GATEWAY_ENV: JSON.stringify(gatewayEnv), ...(host ? { WB_CHECK_HOST: resolve(host) } : {}) },
    encoding: "utf8", timeout: 900_000, maxBuffer: 16 * 1024 * 1024 });
  for (const pid of ownedExecutors()) { try { process.kill(pid, "SIGTERM"); } catch { /* ended */ } }
  const lines = `${run.stdout ?? ""}${run.stderr ?? ""}`.split("\n").filter(Boolean);
  writeFileSync(join(dir, "run.log"), lines.join("\n") + `\nexit ${run.status}\n`);
  const ok = run.status === 0;
  if (mode === "present") kinds.hwpx = lines.find((line) => /실행기의 답이 대화에 남음/.test(line))?.replace(/^(PASS|FAIL).*?— /, "$1 · ").slice(0, 160) ?? "not run";
  if (office) for (const line of lines) { const m = /^(PASS|FAIL) (\w+) hold: the executor turn completed(?: — (.*))?$/.exec(line); if (m) kinds[m[2]!] = `${m[1]}${m[3] ? ` · ${m[3]}` : ""}`.slice(0, 200); }
  summary.push({ mode, ok, seconds: Math.round((Date.now() - t0) / 1000), lines: lines.filter((line) => /^(PASS|FAIL)|passed;/.test(line)) });
  console.log(`${ok ? "PASS" : "FAIL"} [${mode}] ${Math.round((Date.now() - t0) / 1000)} s`);
  for (const line of summary.at(-1)!.lines) console.log(`    ${line}`);
}
if (Object.keys(kinds).length) { console.log("per kind (real binary, display present):"); for (const [kind, result] of Object.entries(kinds)) console.log(`    ${kind.padEnd(5)} ${result}`); }
function appendLog(line: string) { writeFileSync(log, `${line}\n`, { flag: "a" }); }

broadway.kill();
writeFileSync(join(outDir, "summary.json"), JSON.stringify({ binary, host: host ?? "apps/host/dist/host.mjs", summary, kinds }, null, 2));
rmSync(work, { recursive: true, force: true });
console.log(summary.every((item) => item.ok) ? "real executor check: all modes passed" : "real executor check: FAILED");
process.exit(summary.length && summary.every((item) => item.ok) ? 0 : 1);
