import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import { Store } from "../store.ts";
import { EventBus } from "../bus.ts";
import { SessionManager } from "../sessions.ts";
import { DeviceService } from "./service.ts";
import { scopedRoute } from "./scope.ts";
import { detectTailscale, endLeftoverServe, locateTailscale, machineName, serveOffArgv, serveOnArgv, tailscaleCandidates, tailscaleProgram, writeServeChildFile, type TailscaleRun } from "./tailscale.ts";

// Every check here runs the STAND-IN CLI (scripts/fixtures/fake-tailscale.mjs) through the same
// execFile / spawn path the gateway uses; no Tailscale is installed and no tailnet is contacted.
const FAKE = fileURLToPath(new URL("../../../../scripts/fixtures/fake-tailscale.mjs", import.meta.url));
chmodSync(FAKE, 0o755);
const cleanup: (() => void | Promise<void>)[] = [];
let dir = "", stateFile = "", logFile = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "workbench-tailscale-"));
  stateFile = join(dir, "state.json"); logFile = join(dir, "calls.log");
  process.env.FAKE_TAILSCALE_STATE = stateFile; process.env.FAKE_TAILSCALE_LOG = logFile;
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.FAKE_TAILSCALE_STATE; delete process.env.FAKE_TAILSCALE_LOG; delete process.env.FAKE_TAILSCALE_CWD_LOG;
});
const NAME = "desk.tail1a2b.ts.net";
const scenario = (patch: Record<string, unknown> = {}) => writeFileSync(stateFile, JSON.stringify({ daemon: true, backend: "Running", dnsName: NAME + ".", hostName: "desk", tailnet: "kim@example.com", magicDNS: true, certDomains: [NAME], serve: {}, ...patch }));
/** Changes the scenario while a stand-in serve may be running (its session stays). */
const patch = (change: Record<string, unknown>) => writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(readFileSync(stateFile, "utf8")), ...change }));
const current = () => JSON.parse(readFileSync(stateFile, "utf8")) as { serve: { Foreground?: Record<string, { Web?: Record<string, { Handlers: Record<string, { Proxy: string }> }> }>; TCP?: unknown } };
const calls = () => existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]) : [];
const changing = () => calls().filter(argv => !argv.includes("--json"));
const program = () => tailscaleProgram(dir, [FAKE]);
const run: TailscaleRun = (argv) => program().run(argv);
const context = (port = 41733) => ({ port, record: null, seenAt: null, listening: false, publicUrl: "" });
const detect = (change: Record<string, unknown> = {}, port = 41733) => { scenario(change); return detectTailscale(run, context(port)); };
const until = async (what: () => boolean | Promise<boolean>, timeout = 8000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await what()) return true; await new Promise(resolve => setTimeout(resolve, 25)); }
  return false;
};
/** Ends a child this test started and waits until it is gone (it may still write its scenario file). */
const end = (child: import("node:child_process").ChildProcess) => new Promise<void>(resolve => {
  if (child.exitCode !== null || child.signalCode !== null) return resolve();
  child.once("exit", () => resolve()); child.kill("SIGTERM");
});
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sessions = () => Object.values(current().serve.Foreground ?? {});
const sessionPort = () => Number(/:(\d+)$/.exec(Object.values(sessions()[0]?.Web ?? {})[0]?.Handlers["/"]?.Proxy ?? "")?.[1] ?? 0);

// ── the panel's state machine, from the stand-in CLI's answers ──────────────────────────────────

test("no tailscale program on this PC → missing, with the official download page", async () => {
  const view = await detectTailscale(tailscaleProgram(dir, [join(dir, "no-such-tailscale")]).run, context());
  expect(view).toEqual({ ours: false, state: "missing", downloadUrl: "https://tailscale.com/download" });
});

test("installed but its service is not running, logged out, or stopped → one state each", async () => {
  expect(await detect({ daemon: false })).toMatchObject({ state: "stopped", backend: "NoDaemon" });
  expect(await detect({ backend: "NeedsLogin" })).toMatchObject({ state: "needs-login" });
  expect(await detect({ backend: "Stopped" })).toMatchObject({ state: "stopped", backend: "Stopped" });
});

test("logged in without MagicDNS or without HTTPS certificates → the one setting to turn on, with the admin page Tailscale's docs name", async () => {
  expect(await detect({ magicDNS: false })).toMatchObject({ state: "no-https", reason: "magicdns", machine: NAME, adminUrl: "https://console.tailscale.com/admin/dns" });
  expect(await detect({ certDomains: undefined })).toMatchObject({ state: "no-https", reason: "https", machine: NAME });
  expect(await detect({ certDomains: ["other.tail1a2b.ts.net"] })).toMatchObject({ state: "no-https", reason: "https" });
});

test("ready → the address is the CLI's own name and the command is the fixed foreground serve to 127.0.0.1:<device port>", async () => {
  expect(await detect({}, 41733)).toEqual({ ours: false, state: "ready", address: "https://" + NAME, command: ["serve", "--https=443", "http://127.0.0.1:41733"] });
  // Nothing was changed by looking.
  expect(changing()).toEqual([]);
  expect(calls()).toEqual([["status", "--json"], ["serve", "status", "--json"]]);
});

test("odd tailnet and machine names: the tailnet's display name is never used; a DNS name that is not a plain host name is refused", async () => {
  // A tailnet named after an e-mail address with Korean in the machine's display name: the DNS name is still plain.
  expect(await detect({ tailnet: "김교수@hallym.ac.kr", hostName: "김교수의 노트북", dnsName: "kim-laptop.tail-9z.ts.net.", certDomains: ["kim-laptop.tail-9z.ts.net"] }))
    .toMatchObject({ state: "ready", address: "https://kim-laptop.tail-9z.ts.net" });
  // Upper case and the trailing dot are normalised; the address is never anything else.
  expect(await detect({ dnsName: "Desk.Tail1A2B.ts.net.", certDomains: ["desk.tail1a2b.ts.net"] })).toMatchObject({ state: "ready", address: "https://" + NAME });
  for (const dnsName of ["desk.evil.example/x.ts.net.", "desk@evil.ts.net.", "데스크.tail.ts.net.", "desk .tail.ts.net.", "desk.tail.ts.net:8443.", "-desk.tail.ts.net.", "desk", ""]) {
    expect(await detect({ dnsName, certDomains: [dnsName.replace(/\.$/, "")] })).toMatchObject({ state: "no-https", reason: "name" });
  }
  expect(machineName("a.b.c")).toBe("a.b.c");
  expect(machineName({ toString: () => NAME })).toBeNull();
});

test("Serve already used on 443 by something else → taken, named, and not taken over", async () => {
  const other = { TCP: { 443: { HTTPS: true } }, Web: { [NAME + ":443"]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } } };
  expect(await detect({ serve: other })).toMatchObject({ state: "taken", address: "https://" + NAME, by: "http://127.0.0.1:3000" });
  expect(await detect({ serve: { TCP: { 443: { TCPForward: "127.0.0.1:22" } } } })).toMatchObject({ state: "taken", by: "TCP 127.0.0.1:22" });
  // Our port but on a sub-path among others: not ours either.
  expect(await detect({ serve: { TCP: { 443: { HTTPS: true } }, Web: { [NAME + ":443"]: { Handlers: { "/": { Proxy: "http://127.0.0.1:41733" }, "/grafana": { Proxy: "http://127.0.0.1:3001" } } } } } })).toMatchObject({ state: "taken" });
  expect(changing()).toEqual([]);
});

test("Funnel on for 443 → refused, even when the handler is this app's", async () => {
  const funnel = { TCP: { 443: { HTTPS: true } }, Web: { [NAME + ":443"]: { Handlers: { "/": { Proxy: "http://127.0.0.1:41733" } } } }, AllowFunnel: { [NAME + ":443"]: true } };
  expect(await detect({ serve: funnel })).toMatchObject({ state: "funnel", address: "https://" + NAME });
  expect(changing()).toEqual([]);
});

// ── M2: terminal-run (foreground) sessions and services are read too ─────────────────────────────

const fg = (layer: Record<string, unknown>) => ({ Foreground: { "terminal-session": layer } });
const proxyTo = (target: string) => ({ TCP: { 443: { HTTPS: true } }, Web: { [NAME + ":443"]: { Handlers: { "/": { Proxy: target } } } } });

test("M2: a foreground Funnel on 443 run in a terminal → the Funnel refusal (the review's probe config)", async () => {
  expect(await detect({ serve: fg({ ...proxyTo("http://127.0.0.1:3000"), AllowFunnel: { [NAME + ":443"]: true } }) })).toMatchObject({ state: "funnel" });
  // Funnel allowed in a foreground layer even without a handler of its own.
  expect(await detect({ serve: fg({ AllowFunnel: { [NAME + ":443"]: true } }) })).toMatchObject({ state: "funnel" });
  expect(changing()).toEqual([]);
});

test("M2: another program's foreground session on 443 → 이미 다른 것이 쓰고 있습니다, never offered 켜기", async () => {
  expect(await detect({ serve: fg(proxyTo("http://127.0.0.1:3000")) })).toMatchObject({ state: "taken", by: "http://127.0.0.1:3000" });
  // Even pointing at this app's port: a session this gateway did not start is never reported as ours.
  expect(await detect({ serve: fg(proxyTo("http://127.0.0.1:41733")) })).toMatchObject({ state: "taken", by: expect.stringContaining("이 앱이 아닌") });
  // Two holders (a background one and a foreground one): taken.
  expect(await detect({ serve: { ...proxyTo("http://127.0.0.1:41733"), ...fg(proxyTo("http://127.0.0.1:41733")) } })).toMatchObject({ state: "taken" });
  // A Tailscale service on 443.
  expect(await detect({ serve: { Services: { "svc:files": { TCP: { 443: { HTTPS: true } }, Web: { "files.tail1a2b.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8080" } } } } } } } }))
    .toMatchObject({ state: "taken", by: "테일스케일 서비스 svc:files" });
  expect(changing()).toEqual([]);
});

test("M3: a background (--bg) entry on 443 to this app's port → said, with the command to remove it as text; nothing runs", async () => {
  const view = await detect({ serve: proxyTo("http://127.0.0.1:41733") });
  expect(view).toEqual({ ours: false, state: "background", address: "https://" + NAME, command: ["serve", "--https=443", "off"] });
  expect(changing()).toEqual([]);
});

test("the exact argv of the foreground serve (no --bg, no funnel); the removal command is text only", () => {
  expect(serveOnArgv(41733)).toEqual(["serve", "--https=443", "http://127.0.0.1:41733"]);
  expect(serveOffArgv()).toEqual(["serve", "--https=443", "off"]);
  for (const bad of [0, 80, 1024, 70000, 1.5, Number.NaN]) expect(() => serveOnArgv(bad)).toThrow();
  expect(serveOnArgv(41733).join(" ")).not.toMatch(/funnel|--bg/i);
});

test("a CLI that throws or answers nonsense is an error state, never a guess", async () => {
  const broken: TailscaleRun = async () => { throw new Error("boom"); };
  expect(await detectTailscale(broken, context())).toMatchObject({ state: "error" });
  const nonsense: TailscaleRun = async () => ({ code: 0, stdout: "<html>", stderr: "" });
  expect(await detectTailscale(nonsense, context())).toMatchObject({ state: "error" });
});

// ── M1: which program runs, and from where ───────────────────────────────────────────────────────

test("M1: on Windows only the installer's absolute places from the environment, never a bare name", () => {
  const env = { ProgramFiles: "C:\\Program Files", ProgramW6432: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", PATH: "C:\\Windows" };
  expect(tailscaleCandidates(env, "win32")).toEqual(["C:\\Program Files\\Tailscale\\tailscale.exe", "C:\\Program Files (x86)\\Tailscale\\tailscale.exe"]);
  expect(tailscaleCandidates({}, "win32")).toEqual([]);
  // A relative or network folder from the environment is not trusted.
  expect(tailscaleCandidates({ ProgramFiles: "Program Files", "ProgramFiles(x86)": "\\\\server\\share" }, "win32")).toEqual([]);
  // A bare name never resolves on Windows, wherever the app was started from.
  expect(locateTailscale(["tailscale.exe", "tailscale"], { PATH: dir }, "win32")).toBeNull();
  // The stand-in's override is honoured only as an absolute path.
  expect(tailscaleCandidates({ WORKBENCH_TAILSCALE_BIN: "tailscale.exe" }, "win32")).toEqual([]);
  expect(tailscaleCandidates({ WORKBENCH_TAILSCALE_BIN: "./fake" }, "linux")).toEqual([]);
});

test("M1: on macOS and Linux the known absolute places come first, the bare name through PATH only last", () => {
  for (const platform of ["linux", "darwin"] as const) {
    const list = tailscaleCandidates({}, platform);
    expect(list.at(-1)).toBe("tailscale");
    expect(list.slice(0, -1).every(file => file.startsWith("/"))).toBe(true);
  }
  expect(tailscaleCandidates({}, "darwin")[0]).toBe("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
  expect(tailscaleCandidates({}, "linux").slice(0, 2)).toEqual(["/usr/bin/tailscale", "/usr/local/bin/tailscale"]);
  // The bare name resolves only through absolute PATH entries, to an absolute file.
  const bin = join(dir, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "tailscale"), "#!/bin/sh\nexit 0\n"); chmodSync(join(bin, "tailscale"), 0o755);
  expect(locateTailscale(["tailscale"], { PATH: `relative:.::${bin}` }, "linux")).toBe(join(bin, "tailscale"));
  expect(locateTailscale(["tailscale"], { PATH: "relative:." }, "linux")).toBeNull();
});

test("M1: a program this user may not run (EACCES) is an error state with a plain line, not 'not installed'", async () => {
  const locked = join(dir, "tailscale"); writeFileSync(locked, "#!/bin/sh\nexit 0\n"); chmodSync(locked, 0o644);
  await expect(tailscaleProgram(dir, [locked]).run(["status", "--json"])).rejects.toMatchObject({ code: "tailscale_not_runnable" });
  const view = await detectTailscale(tailscaleProgram(dir, [locked]).run, context());
  expect(view).toMatchObject({ state: "error", message: expect.stringContaining("실행할 권한이 없습니다") });
  expect(() => tailscaleProgram(dir, [locked]).spawn(serveOnArgv(41733))).toThrow(/실행할 권한이 없습니다/);
});

test("M1: every call and the serve child run in the app's data folder, whatever folder the gateway was started from", async () => {
  scenario();
  const cwdLog = join(dir, "cwd.log"); process.env.FAKE_TAILSCALE_CWD_LOG = cwdLog;
  const data = join(dir, "data"); mkdirSync(data);
  const tool = tailscaleProgram(data, [FAKE]);
  await tool.run(["status", "--json"]);
  const started = tool.spawn(serveOnArgv(41733))!;
  cleanup.push(() => end(started.child));
  expect(await until(() => existsSync(cwdLog) && readFileSync(cwdLog, "utf8").trim().split("\n").length === 2)).toBe(true);
  expect(readFileSync(cwdLog, "utf8").trim().split("\n")).toEqual([realpathSync(data), realpathSync(data)]);
});

// ── the gateway side: 켜기 / 끄기 and the foreground child through the device service ────────────

async function occupy(port: number): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => resolve()); });
  return server;
}
function gateway(directory = mkdtempSync(join(tmpdir(), "workbench-tailscale-gw-")), extra: Partial<ConstructorParameters<typeof DeviceService>[0]> = {}) {
  const store = new Store(join(directory, `state-${Math.random().toString(36).slice(2)}.sqlite`));
  const bus = new EventBus(8);
  const manager = new SessionManager(store, bus, { hostId: "tailscale-host", hostLabel: "테일스케일 검사 PC", dataDir: directory, managedWorksDir: join(directory, "works") });
  const tool = tailscaleProgram(directory, [FAKE]);
  const service = new DeviceService({ dataDir: directory, manager, bus, localToken: "test-local-owner", localOrigin: () => null, webDir: null,
    tailscale: tool.run, tailscaleSpawn: tool.spawn, serveConfirm: { tries: 40, everyMs: 50 }, serveRetryMs: 50, portRetryMs: 50, ...extra });
  let open = true;
  const close = async () => { if (!open) return; open = false; service.close(); await manager.shutdown(); store.close(); };
  cleanup.push(async () => { await close(); rmSync(directory, { recursive: true, force: true }); });
  return { service, directory, close };
}
const turnOn = async (service: DeviceService) => {
  const ready = await service.tailscaleState();
  if (ready.state !== "ready") throw new Error("not ready: " + ready.state);
  return { ready, on: await service.tailscaleOn({ command: ready.command }) };
};

test("켜기 runs only the command that was shown, as one foreground child; 'on' only once 443 points at the app's port; 끄기 ends it and runs no Tailscale command", async () => {
  scenario();
  const { service } = gateway(); await service.start();
  const before = service.state();
  expect(before.config).toMatchObject({ enabled: false, listenHost: "127.0.0.1" });
  const ready = await service.tailscaleState();
  expect(ready).toMatchObject({ state: "ready", address: "https://" + NAME });
  if (ready.state !== "ready") throw new Error("not ready");
  expect(ready.commandLine).toBe(`tailscale serve --https=443 http://127.0.0.1:${ready.port}`);

  // A command other than the one shown is refused and nothing runs (the old --bg form included).
  await expect(service.tailscaleOn({ command: ["serve", "--https=443", "http://127.0.0.1:1"] })).rejects.toMatchObject({ code: "tailscale_command_changed" });
  await expect(service.tailscaleOn({ command: ["serve", "--bg", "--https=443", `http://127.0.0.1:${ready.port}`] })).rejects.toMatchObject({ code: "tailscale_command_changed" });
  await expect(service.tailscaleOn({ command: ["funnel", "--bg", "443"] })).rejects.toMatchObject({ code: "tailscale_command_changed" });
  await expect(service.tailscaleOn({})).rejects.toMatchObject({ code: "tailscale_command_changed" });
  expect(changing()).toEqual([]);

  const on = await service.tailscaleOn({ command: ready.command });
  expect(changing()).toEqual([ready.command]);
  expect(on).toMatchObject({ state: "on", address: "https://" + NAME, ours: true, seenAt: null, command: ready.command });
  // The session is a foreground one (it ends with the child); nothing was written into the background config.
  expect(sessions()).toHaveLength(1); expect(sessionPort()).toBe(ready.port); expect(current().serve.TCP).toBeUndefined();
  const state = service.state();
  expect(state).toMatchObject({ status: "listening", port: ready.port, phoneUrl: "https://" + NAME });
  expect(state.config).toMatchObject({ enabled: true, listenHost: "127.0.0.1", publicUrl: "https://" + NAME });

  const off = await service.tailscaleOff();
  expect(changing()).toEqual([ready.command]);
  expect(off).toMatchObject({ state: "ready", ours: false });
  expect(service.state().config).toMatchObject({ enabled: false, listenHost: "127.0.0.1", publicUrl: "" });
  expect(current().serve).toEqual({});
});

test("M3: the gateway stopping ends the child and its session; at the next start, with 켜기 standing, it opens again by itself", async () => {
  scenario();
  const first = gateway(); await first.service.start();
  const { ready } = await turnOn(first.service);
  const pid = (JSON.parse(readFileSync(join(first.directory, "remote-devices", "tailscale-serve.json"), "utf8")) as { pid: number }).pid;
  expect(alive(pid)).toBe(true);
  await first.close();
  expect(await until(() => !alive(pid) && sessions().length === 0)).toBe(true);
  const second = gateway(first.directory); await second.service.start();
  expect(await until(async () => (await second.service.tailscaleState()).state === "on")).toBe(true);
  expect(sessionPort()).toBe(ready.port);
  expect(changing()).toEqual([ready.command, ready.command]);
});

test("M3: a serve child left by a hard-killed gateway is ended at the next start, before anything else; another process under that PID is left alone", async () => {
  scenario();
  // A leftover: the stand-in's foreground serve, running with its session, recorded as the gateway records it.
  const data = mkdtempSync(join(tmpdir(), "workbench-tailscale-gw-")); mkdirSync(join(data, "remote-devices"));
  const pidFile = join(data, "remote-devices", "tailscale-serve.json");
  const leftover = tailscaleProgram(data, [FAKE]).spawn(serveOnArgv(41733))!.child;
  cleanup.push(() => end(leftover));
  expect(await until(() => sessions().length === 1)).toBe(true);
  writeServeChildFile(pidFile, leftover.pid!, serveOnArgv(41733));
  const { service } = gateway(data); await service.start();
  expect(await until(() => !alive(leftover.pid!) && sessions().length === 0)).toBe(true);

  // Under that PID now: a program that is not the serve command, or the serve command started at another time → left alone.
  const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  cleanup.push(() => end(other));
  await new Promise(resolve => other.once("spawn", resolve));
  writeServeChildFile(pidFile, other.pid!, serveOnArgv(41733));
  expect(await endLeftoverServe(pidFile)).toBe("none");
  const second = tailscaleProgram(data, [FAKE]).spawn(serveOnArgv(41734))!.child;
  cleanup.push(() => end(second));
  expect(await until(() => sessions().length === 1)).toBe(true);
  writeServeChildFile(pidFile, second.pid!, serveOnArgv(41734));
  writeFileSync(pidFile, JSON.stringify({ ...JSON.parse(readFileSync(pidFile, "utf8")), started: "1" }));
  expect(await endLeftoverServe(pidFile)).toBe("other");
  expect(alive(other.pid!) && alive(second.pid!)).toBe(true);
});

test("M3: the listener's port busy at start → no serve while the kept-port retry runs; it opens for that port once the listener holds it", async () => {
  scenario();
  const first = gateway(); await first.service.start();
  const { ready } = await turnOn(first.service);
  await first.close();
  expect(await until(() => sessions().length === 0)).toBe(true);
  const blocker = await occupy(ready.port);
  const second = gateway(first.directory); await second.service.start();
  expect(second.service.state()).toMatchObject({ status: "error", port: null });
  await new Promise(resolve => setTimeout(resolve, 400));
  expect(changing()).toEqual([ready.command]);
  expect(sessions()).toEqual([]);
  await new Promise<void>(resolve => blocker.close(() => resolve()));
  expect(await until(async () => (await second.service.tailscaleState()).state === "on")).toBe(true);
  expect(second.service.state()).toMatchObject({ status: "listening", port: ready.port });
  expect(sessionPort()).toBe(ready.port);
});

test("M3: the child closing by itself → the panel says the road is gone and why; tried again with a growing back-off only while 켜기 stands", async () => {
  scenario();
  const { service } = gateway(); await service.start();
  const { ready } = await turnOn(service);
  patch({ kickServe: "HTTPS certificates are not enabled for this tailnet (stand-in)" });
  // Between two tries the panel says the road is gone, and why (the child's last line, as text).
  let lost: Awaited<ReturnType<DeviceService["tailscaleState"]>> | null = null;
  expect(await until(async () => { const view = await service.tailscaleState(); if (view.state === "ready" && view.why) lost = view; return !!lost; }, 4000)).toBe(true);
  expect(lost).toMatchObject({ state: "ready", ours: true, lost: true, why: expect.stringContaining("HTTPS certificates are not enabled") });
  expect(lost!.why).not.toMatch(/Ctrl\+C/);
  patch({ kickServe: undefined, failServe: "error: not logged in (stand-in)" });
  // Back-off steps of 50, 150, 300, 600, 1200 ms here (5 s … 5 min in the app): a handful of tries, never a tight loop.
  // A slow machine starts each try's program late, so the third try is waited for rather than expected by a fixed time.
  expect(await until(async () => changing().length >= 3, 20_000)).toBe(true);
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(changing().length).toBeLessThanOrEqual(7);
  expect(await until(async () => { const view = await service.tailscaleState(); return view.retrying === true && !!view.why?.includes("not logged in"); }, 4000)).toBe(true);
  // 끄기: no more tries.
  await service.tailscaleOff();
  const after = changing().length;
  await new Promise(resolve => setTimeout(resolve, 600));
  expect(changing().length).toBe(after);
  expect(changing().every(argv => JSON.stringify(argv) === JSON.stringify(ready.command))).toBe(true);
});

test("L1: 켜기 says 여는 중 while it waits, and 'on' only when 443 really points at the app's port; otherwise the child is ended and why is said", async () => {
  // The CLI keeps running but never applies its session: 여는 중, then ended with a reason; nothing half-done.
  scenario({ serveSilent: true });
  const { service, directory } = gateway(undefined, { serveConfirm: { tries: 20, everyMs: 50 } });
  await service.start();
  const ready = await service.tailscaleState();
  if (ready.state !== "ready") throw new Error("not ready");
  const pressing = service.tailscaleOn({ command: ready.command });
  pressing.catch(() => {});
  expect(await until(async () => (await service.tailscaleState()).state === "opening", 3000)).toBe(true);
  await expect(pressing).rejects.toMatchObject({ code: "tailscale_failed", message: expect.stringContaining("이 앱의 길을 열지 않았습니다") });
  expect(existsSync(join(directory, "remote-devices", "tailscale-serve.json"))).toBe(false);
  expect(service.state()).toMatchObject({ status: "disabled", config: { enabled: false, publicUrl: "" } });
  // The CLI prints the "enable HTTPS" address and exits 0 without applying: not "on"; the line is said.
  patch({ serveSilent: false, serveNoApply: true });
  await expect(service.tailscaleOn({ command: ready.command })).rejects.toMatchObject({ code: "tailscale_failed", message: expect.stringContaining("login.tailscale.com/f/serve") });
  expect(existsSync(join(directory, "remote-devices", "tailscale.json"))).toBe(false);
  expect(await service.tailscaleState()).toMatchObject({ state: "ready", ours: false });
});

test("끄기 puts back what the person had (listening on the network with their own address)", async () => {
  scenario();
  const { service } = gateway(); await service.start();
  await service.configure({ enabled: true, listenHost: "0.0.0.0", port: 0, publicUrl: "https://desk.example.org" });
  const { ready } = await turnOn(service);
  expect(service.state().config).toMatchObject({ listenHost: "127.0.0.1", publicUrl: "https://" + NAME });
  await service.tailscaleOff();
  expect(changing()).toEqual([ready.command]);
  expect(service.state().config).toMatchObject({ enabled: true, listenHost: "0.0.0.0", publicUrl: "https://desk.example.org" });
  expect(sessions()).toEqual([]);
});

test("켜기 is refused from any state but ready: taken port, Funnel in a terminal, logged out", async () => {
  const { service } = gateway(); await service.start();
  for (const change of [{ serve: { TCP: { 443: { TCPForward: "127.0.0.1:22" } } } }, { serve: fg({ ...proxyTo("http://127.0.0.1:3000"), AllowFunnel: { [NAME + ":443"]: true } }) }, { serve: fg(proxyTo("http://127.0.0.1:3000")) }, { backend: "NeedsLogin" }, { magicDNS: false }]) {
    scenario(change);
    const view = await service.tailscaleState();
    await expect(service.tailscaleOn({ command: serveOnArgv(view.port) })).rejects.toMatchObject({ code: "tailscale_not_ready" });
  }
  expect(changing()).toEqual([]);
  expect(service.state().config.enabled).toBe(false);
});

test("when serve fails, nothing half-done is left; the operator advice says what it allows (L2)", async () => {
  scenario({ failServe: "serve config denied: you need operator rights (stand-in)" });
  const { service, directory } = gateway(); await service.start();
  const ready = await service.tailscaleState();
  if (ready.state !== "ready") throw new Error("not ready");
  await expect(service.tailscaleOn({ command: ready.command })).rejects.toMatchObject({ code: "tailscale_failed",
    message: expect.stringMatching(/설정을 바꿀 권한이 없습니다.*sudo tailscale set --operator=\$USER.*모든 프로그램\(AI 엔진 포함\)이 테일스케일의 Serve와 Funnel 설정을 바꿀 수 있게 됩니다.*operator rights/) });
  expect(service.state()).toMatchObject({ status: "disabled", config: { enabled: false, publicUrl: "" } });
  expect(existsSync(join(directory, "remote-devices", "tailscale.json"))).toBe(false);
});

test("Tailscale stopping later: the panel says the road is gone (lost) instead of still on", async () => {
  scenario();
  const { service } = gateway(); await service.start();
  await turnOn(service);
  patch({ backend: "Stopped" });
  expect(await until(async () => (await service.tailscaleState()).state === "stopped")).toBe(true);
  expect(await service.tailscaleState()).toMatchObject({ state: "stopped", ours: true, lost: true });
  patch({ daemon: false });
  expect(await service.tailscaleState()).toMatchObject({ state: "stopped", lost: true });
  // A Funnel turned on later for the same port: refused and called out.
  patch({ daemon: true, backend: "Running", serve: { AllowFunnel: { [NAME + ":443"]: true } } });
  expect(await service.tailscaleState()).toMatchObject({ state: "funnel", lost: true });
});

test("the Tailscale routes are the PC owner's only: a phone's channel cannot reach them", () => {
  const manager = { view: { works: new Map(), sessions: new Map() }, snapshot: () => ({ hostId: "h" }) } as never;
  for (const [method, path] of [["GET", "/api/devices/tailscale"], ["POST", "/api/devices/tailscale/on"], ["POST", "/api/devices/tailscale/off"], ["PUT", "/api/devices/config"]] as const) {
    expect(() => scopedRoute(manager, method, path, {})).toThrow(/허용되지 않은/);
  }
});
