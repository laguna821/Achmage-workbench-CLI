import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandboxWrapper } from "../../apps/host/src/ieumoffice.ts";

// The official app seals a synthetic key on startup in this test's own profile.
// No real account/profile is read and the test owns the one child it terminates.
const config = process.env.XDG_CONFIG_HOME, runtime = process.env.XDG_RUNTIME_DIR;
assert.ok(config?.startsWith("/tmp/wb-app-e2e-") && runtime?.startsWith("/tmp/wb-app-e2e-") && process.env.DBUS_SESSION_BUS_ADDRESS);
const directory = join(config, "IeumOffice"), file = join(directory, "ai-settings.json");
mkdirSync(directory, { recursive: true });
writeFileSync(file, readFileSync(process.argv[3]));
writeFileSync(join(directory, "app-settings.json"), JSON.stringify({ autoUpdateCheck: false }));
const app = sandboxWrapper(process.argv[2], join(runtime, "original-ieum")) ?? process.argv[2];
const child = spawn(app, [], { stdio: "ignore", env: { ...process.env, XDG_CURRENT_DESKTOP: "GNOME" } });
let closed = false;
const exited = new Promise(resolve => { child.once("close", () => { closed = true; resolve(); }); child.once("error", () => { closed = true; resolve(); }); });
let sealed = false;
try {
  const until = Date.now() + 20_000;
  while (!closed && Date.now() < until) {
    try { sealed = JSON.parse(readFileSync(file, "utf8")).customEndpoints[0].apiKey.startsWith("sealed:v1:"); } catch {}
    if (sealed) break;
    await new Promise(done => setTimeout(done, 100));
  }
} finally {
  if (!closed) child.kill("SIGTERM");
  let timer;
  try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Owned original app did not stop normally")), 5000); })]); }
  finally { clearTimeout(timer); }
}
assert.ok(sealed, "Official app did not seal the synthetic key in its private profile");
console.log(JSON.stringify({ directory, sealed: true }));
