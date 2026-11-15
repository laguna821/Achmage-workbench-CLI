// sec-vault round 2, the check every OS can run with its OWN credential store (Windows Credential
// Manager, macOS Keychain, Linux Secret Service): for the release workflow's Windows and macOS jobs, in
// the runner's throwaway account (on Linux: inside scripts/with-private-keyring.sh, never the
// person's keyring). The Linux-only scripts/sec-vault-attack.ts adds the review's full set (old
// binaries, the default folder, the login unit, the way back).
// The BUILT binary starts the BUILT gateway through its launcher on a fresh data folder; the gateway
// seals and opens a messenger token and a 비밀 보관함 entry (its own unseal); then everything that is
// not the gateway with its per-run ticket asks the binary for the key:
//   a plain process; a plain process with a made-up ticket; a child the gateway itself starts (an
//   engine binary it probes); any caller while no gateway runs.
// Prints booleans only ("the planted value came back: false"). Exit 1 on any failure.
// Usage: node scripts/sec-vault-native.ts <binary> [host dir, default apps/host/dist]
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { FAKE_TOKEN, FakeTelegram } from "../apps/host/src/channels/fake-telegram.ts";
import { gatewayLaunch } from "./fixtures/launch-gateway.ts";

const repo = fileURLToPath(new URL("../", import.meta.url));
const binary = resolve(process.argv[2]!), hostDir = resolve(process.argv[3] ?? join(repo, "apps/host/dist"));
const windows = process.platform === "win32";
if (process.platform === "linux" && (!process.env.DBUS_SESSION_BUS_ADDRESS || process.env.DBUS_SESSION_BUS_ADDRESS.includes("/run/user/"))) {
  console.log("FAIL on Linux run this inside scripts/with-private-keyring.sh (never the person's keyring)"); process.exit(1);
}
const failures: string[] = [];
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failures.push(what); };
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const S = mkdtempSync(join(tmpdir(), "wb-sec-native-"));
const D = join(S, "data"); mkdirSync(D, { recursive: true });
const install = gatewayLaunch(join(hostDir, "host.mjs"), binary, { copyHost: true, under: S });
const fake = new FakeTelegram();
const request = join(S, "request.json");
writeFileSync(request, JSON.stringify({ directory: D, create: false }));
const keyOf = (stdout: string) => { try { const answer = JSON.parse(stdout.trim().split("\n").pop() ?? ""); return typeof answer.key === "string"; } catch { return false; } };
const answerOf = (stdout: string) => { try { const a = JSON.parse(stdout.trim().split("\n").pop() ?? ""); return a.ok ? (a.key ? "KEY" : "no key") : String(a.error); } catch { return `unreadable(${stdout.length})`; } };
const ask = (input: string) => { const r = spawnSync(install.command, ["--office-secret-key"], { input, encoding: "utf8", timeout: 30_000 }); return { came: keyOf(r.stdout), answer: answerOf(r.stdout) }; };
let launcher: ChildProcess | null = null;
const logs: string[] = [];
try {
  await fake.start();
  // A child the gateway starts itself: the engine binary it probes with --version asks the helper.
  const childOut = join(S, "child.out");
  const evil = join(S, windows ? "evil-codex.cmd" : "evil-codex");
  writeFileSync(evil, windows
    ? `@echo off\r\nif "%~1"=="--version" if not exist "${childOut}" "${install.command}" --office-secret-key < "${request}" > "${childOut}"\r\necho codex-cli 0.0.1\r\n`
    : `#!/bin/sh\nif [ "$1" = "--version" ] && [ ! -e "${childOut}" ]; then exec "${install.command}" --office-secret-key < "${request}" > "${childOut}"; fi\necho "codex-cli 0.0.1"\n`, { mode: 0o755 });
  launcher = spawn(install.command, install.args, {
    env: { ...process.env, ...install.env, WORKBENCH_DATA_DIR: D, WORKBENCH_IEUM_BOOTSTRAP: "0", WORKBENCH_PORT: "0", WORKBENCH_EDITORS_PORT: "0", WORKBENCH_HOST_LABEL: "보안 확인",
      WORKBENCH_CLAUDE_BIN: join(repo, "scripts/fixtures/fake-claude.mjs"), WORKBENCH_CODEX_BIN: evil, WORKBENCH_TELEGRAM_API: fake.url, WORKBENCH_SHELL_PATH: "0" },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  launcher.stderr!.on("data", (part: Buffer) => logs.push(String(part)));
  const ready = await new Promise<{ url: string; token: string }>((done, reject) => {
    const timer = setTimeout(() => reject(new Error("gateway not ready in 90 s")), 90_000);
    launcher!.once("exit", (code) => { clearTimeout(timer); reject(new Error(`gateway exited before readiness (${code})`)); });
    createInterface({ input: launcher!.stdout! }).on("line", (line) => { if (line.startsWith("WORKBENCH_READY ")) { clearTimeout(timer); done(JSON.parse(line.slice(16))); } });
  });
  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${ready.url}${path}`, { method, headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`);
    return await response.json() as T;
  };
  // The gateway's own unseal: a messenger token and a 비밀 보관함 entry, sealed and opened through the helper.
  await api("POST", "/api/channels/telegram/bots", { token: FAKE_TOKEN });
  check(fake.of("getMe").length > 0, "the gateway sealed and opened a messenger token through the helper (its own unseal)");
  const word = `planted-native-word-${randomBytes(3).toString("hex")}`;
  await api("POST", "/api/channels/credentials", { name: "보안 확인", kind: "login", site: "https://example.invalid", values: { 아이디: "zz-native-user", 비밀번호: word } }).catch(() => null);
  check(existsSync(join(D, "office", "vault-id")), "the vault was made in the fresh data folder");
  check((await api<{ vault?: { state: string } }>("GET", "/api/host")).vault?.state === "open", "the gateway reports its vault open");
  const plain = ask(JSON.stringify({ directory: D, create: false }));
  check(!plain.came, `a plain process: the planted value came back: ${plain.came} (${plain.answer})`);
  const guessed = ask(JSON.stringify({ directory: D, create: false, ticket: "0".repeat(64) }));
  check(!guessed.came, `a plain process with a made-up ticket: the planted value came back: ${guessed.came} (${guessed.answer})`);
  await api("GET", "/api/engines").catch(() => null);
  for (let i = 0; i < 300 && !existsSync(childOut); i++) await sleep(100);
  // On Windows the gateway does not start a .cmd stand-in for an engine (Node refuses batch files without a shell), so
  // this one case cannot be staged there: it is SKIPPED with its reason (trial build 4), never passed silently. The
  // direct-child case runs on Linux and macOS; a plain process and a made-up ticket are refused on every OS (above).
  if (windows && !existsSync(childOut)) console.log("SKIP a program the gateway started itself asked the helper — the gateway started no .cmd stand-in on Windows");
  else {
    check(existsSync(childOut), "a program the gateway started itself asked the helper");
    const fromChild = existsSync(childOut) ? readFileSync(childOut, "utf8") : "";
    check(!keyOf(fromChild), `a child of the gateway without the ticket: the planted value came back: ${keyOf(fromChild)} (${answerOf(fromChild)})`);
  }
  // The launcher stops; its gateway goes with it.
  const gone = new Promise((done) => launcher!.once("exit", done));
  launcher.kill("SIGTERM");
  await Promise.race([gone, sleep(20_000)]);
  for (let i = 0; i < 150 && existsSync(join(D, "host.lock")); i++) await sleep(100);
  check(!existsSync(join(D, "host.lock")), "the gateway stopped with its launcher");
  const gap = ask(JSON.stringify({ directory: D, create: false }));
  check(!gap.came, `no gateway running, a short-lived caller: the planted value came back: ${gap.came} (${gap.answer})`);
} catch (error) { check(false, `harness: ${error instanceof Error ? error.message : String(error)}`); }
finally {
  if (launcher && launcher.exitCode === null) launcher.kill("SIGKILL");
  await fake.stop().catch(() => {});
  if (failures.length) console.log(logs.join("").split("\n").filter((line) => line.trim() && !line.includes("planted")).slice(-40).join("\n"));
  await sleep(500);
  rmSync(S, { recursive: true, force: true });
}
console.log(failures.length ? `${failures.length} sec-vault native checks FAILED` : "all sec-vault native checks passed");
process.exitCode = failures.length ? 1 : 0;
