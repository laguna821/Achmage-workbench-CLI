// Starts the WebDriver under the harness's NEW D-Bus session with a private keyring.
// The random test password arrives over stdin and is never logged or put in the environment.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const data = process.env.XDG_DATA_HOME!, runtime = process.env.XDG_RUNTIME_DIR!;
assert.ok(data?.startsWith("/tmp/wb-app-e2e-") && runtime?.startsWith("/tmp/wb-app-e2e-") && existsSync(join(data, "keyrings")) && process.env.DBUS_SESSION_BUS_ADDRESS);
let password = "";
for await (const part of process.stdin) { password += String(part); assert.ok(password.length <= 128); }
assert.ok(password.length >= 32);
const control = join(runtime, "keyring"); mkdirSync(control, { recursive: true, mode: 0o700 });
const keyring = spawn("gnome-keyring-daemon", ["--foreground", "--components=secrets", "--unlock", "--control-directory", control], { stdio: ["pipe", "inherit", "inherit"] });
keyring.stdin!.end(password); password = "";
let driver: ChildProcess | undefined, stopping = false;
const exited = (child: ChildProcess) => new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
const keyringDone = exited(keyring);
const stop = () => { stopping = true; driver?.kill("SIGTERM"); keyring.kill("SIGTERM"); };
process.once("SIGTERM", stop); process.once("SIGINT", stop);
try {
  let ready = false;
  for (let tries = 0; !stopping && tries < 40; tries++) {
    const probe = spawnSync("gdbus", ["call", "--session", "--dest", "org.freedesktop.DBus", "--object-path", "/org/freedesktop/DBus", "--method", "org.freedesktop.DBus.NameHasOwner", "org.freedesktop.secrets"], { encoding: "utf8", timeout: 2000 });
    if (probe.status === 0 && probe.stdout.includes("true")) { ready = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready && !stopping, "Private native UI keyring did not become ready");
  driver = spawn(process.argv[2]!, process.argv.slice(3), { stdio: "inherit" });
  process.exitCode = (await exited(driver)) ?? (stopping ? 0 : 1);
} finally {
  keyring.kill("SIGTERM");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([keyringDone, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Private UI keyring did not stop normally")), 5000); })]); }
  finally { clearTimeout(timer); }
}
