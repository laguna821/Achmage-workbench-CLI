#!/usr/bin/env node
// A STAND-IN for the `tailscale` CLI (Tailscale is not installed on the machines these checks run on,
// and nothing here contacts a tailnet). It answers the three commands the app uses, with the JSON
// shapes as Tailscale's source defines them (to confirm with the real CLI — see ux/reports/tailscale-report.md):
//   tailscale status --json
//   tailscale serve status --json           (ipn.ServeConfig: TCP, Web, AllowFunnel, Foreground, Services)
//   tailscale serve --https=443 http://127.0.0.1:<port>
//       FOREGROUND, as the real CLI without --bg: it adds a session under ServeConfig.Foreground, prints
//       where it is reachable, and keeps running. The session goes when the process ends — on SIGTERM /
//       SIGINT it removes it itself, and when it is killed hard every later read drops sessions whose
//       process is gone (as tailscaled drops a session when its IPN-bus watcher ends). It refuses when a
//       listener on 443 exists already ("listener already exists for port 443"), and ends by itself
//       (one line on stderr) when the scenario says Tailscale stopped or `kickServe` is set.
// The scenario lives in the JSON file named by FAKE_TAILSCALE_STATE:
//   { "daemon": true|false, "backend": "Running"|"NeedsLogin"|"Stopped",
//     "dnsName": "desk.tail1a2b.ts.net.", "hostName": "desk", "tailnet": "kim@example.com",
//     "magicDNS": true, "certDomains": ["desk.tail1a2b.ts.net"], "serve": { …ServeConfig… },
//     "failServe": "message"            — serve exits 1 at once with this line,
//     "serveNoApply": true              — serve prints the "enable HTTPS" URL and exits 0 without applying,
//     "serveSilent": true               — serve keeps running but never applies its session,
//     "kickServe": "message" }          — a running serve ends with this line.
// Every call is appended to FAKE_TAILSCALE_LOG (one JSON argv per line) so tests can see the exact argv;
// FAKE_TAILSCALE_CWD_LOG, when set, gets the working folder of every call.
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const file = process.env.FAKE_TAILSCALE_STATE;
if (process.env.FAKE_TAILSCALE_LOG) appendFileSync(process.env.FAKE_TAILSCALE_LOG, JSON.stringify(argv) + "\n");
if (process.env.FAKE_TAILSCALE_CWD_LOG) appendFileSync(process.env.FAKE_TAILSCALE_CWD_LOG, process.cwd() + "\n");
if (!file) { process.stderr.write("FAKE_TAILSCALE_STATE is not set\n"); process.exit(2); }
const read = () => { for (let i = 0; i < 20; i++) { try { return JSON.parse(readFileSync(file, "utf8")); } catch { /* being written */ } } return JSON.parse(readFileSync(file, "utf8")); };
const save = (value) => { const temp = `${file}.${process.pid}.tmp`; writeFileSync(temp, JSON.stringify(value, null, 2)); renameSync(temp, file); };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
/** tailscaled's view: a foreground session lives only as long as its CLI process. */
const prune = (value) => {
  const sessions = value.sessions ?? {};
  let changed = false;
  for (const [id, pid] of Object.entries(sessions)) if (!alive(pid)) { delete sessions[id]; if (value.serve?.Foreground) delete value.serve.Foreground[id]; changed = true; }
  if (value.serve?.Foreground && !Object.keys(value.serve.Foreground).length) { delete value.serve.Foreground; changed = true; }
  return changed;
};
let state = read();
if (prune(state)) save(state);
const out = (value) => { process.stdout.write(JSON.stringify(value, null, 2) + "\n"); process.exit(0); };
const fail = (message, code = 1) => { process.stderr.write(message + "\n"); process.exit(code); };
const noDaemon = () => fail("failed to connect to local tailscaled; it doesn't appear to be running (sudo systemctl start tailscaled ?)");
const same = (want) => want.length === argv.length && want.every((part, index) => part === argv[index]);

if (same(["status", "--json"])) {
  if (state.daemon === false) noDaemon();
  const running = state.backend === "Running";
  const suffix = (state.dnsName ?? "").replace(/\.$/, "").split(".").slice(1).join(".");
  out({
    Version: "1.76.1-stand-in", TUN: true, BackendState: state.backend ?? "Running",
    AuthURL: state.backend === "NeedsLogin" ? "https://login.tailscale.com/a/stand-in" : "",
    TailscaleIPs: running ? ["100.64.0.10", "fd7a:115c:a1e0::a"] : [],
    Self: { ID: "nStandIn", HostName: state.hostName ?? "desk", DNSName: running ? state.dnsName ?? "" : "", OS: "linux", Online: running },
    Health: [], MagicDNSSuffix: suffix,
    CurrentTailnet: running ? { Name: state.tailnet ?? "kim@example.com", MagicDNSSuffix: suffix, MagicDNSEnabled: state.magicDNS !== false } : null,
    ...(running && state.certDomains ? { CertDomains: state.certDomains } : {}),
    Peer: {}, User: {},
  });
}
if (same(["serve", "status", "--json"])) {
  if (state.daemon === false) noDaemon();
  out(state.serve ?? {});
}
const host = (state.dnsName ?? "").replace(/\.$/, "") + ":443";
if (argv.length === 3 && argv[0] === "serve" && argv[1] === "--https=443" && /^http:\/\/127\.0\.0\.1:\d+$/.test(argv[2])) {
  if (state.daemon === false) noDaemon();
  if (state.backend !== "Running") fail("Tailscale is stopped.");
  if (state.failServe) fail(state.failServe);
  if (state.serveNoApply) {
    // As enableFeatureInteractive when the tailnet's HTTPS is off and the CLI should not wait: a URL, exit 0, nothing applied.
    process.stdout.write("\nServe is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=nStandIn\n\n");
    process.exit(0);
  }
  const serve = state.serve ?? {};
  const taken = !!serve.TCP?.["443"] || Object.values(serve.Foreground ?? {}).some((layer) => !!layer?.TCP?.["443"]);
  if (taken) fail("listener already exists for port 443");
  const session = `stand-in-${process.pid}`;
  if (!state.serveSilent) {
    state.serve = { ...serve, Foreground: { ...(serve.Foreground ?? {}), [session]: { TCP: { 443: { HTTPS: true } }, Web: { [host]: { Handlers: { "/": { Proxy: argv[2] } } } } } } };
    state.sessions = { ...(state.sessions ?? {}), [session]: process.pid };
    save(state);
  }
  process.stdout.write(`Available within your tailnet:\n\nhttps://${host.replace(/:443$/, "")}/\n|-- proxy ${argv[2]}\n\nPress Ctrl+C to exit.\n`);
  const end = (code, message) => {
    try {
      const now = read();
      if (now.serve?.Foreground) { delete now.serve.Foreground[session]; if (!Object.keys(now.serve.Foreground).length) delete now.serve.Foreground; }
      if (now.sessions) delete now.sessions[session];
      save(now);
    } catch { /* the scenario file is gone */ }
    if (message) process.stderr.write(message + "\n");
    process.exit(code);
  };
  process.on("SIGTERM", () => end(0));
  process.on("SIGINT", () => end(0));
  setInterval(() => {
    let now; try { now = read(); } catch (error) { if (error.code === "ENOENT") process.exit(0); return; }
    if (now.daemon === false || now.backend !== "Running") end(1, "lost connection to tailscaled: stand-in stopped");
    else if (now.kickServe) end(1, String(now.kickServe));
  }, 150);
} else fail(`stand-in tailscale: unknown command: ${argv.join(" ")}`, 64);
