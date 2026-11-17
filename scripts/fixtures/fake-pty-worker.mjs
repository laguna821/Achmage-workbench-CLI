#!/usr/bin/env node
// A stand-in for the desktop binary's `--pty-worker` mode (apps/desktop/src-tauri/src/terminal_worker.rs):
// the same JSON-lines protocol over pipes, but the shell runs on plain pipes (no PTY). For gateway tests
// and the terminal rig on machines without the Rust build. Never used by the app.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

if (process.argv[2] !== "--pty-worker") { process.stderr.write("fake-pty-worker: expected --pty-worker\n"); process.exit(2); }
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const lines = createInterface({ input: process.stdin });
let child = null, closed = false;
lines.on("line", (raw) => {
  const message = JSON.parse(raw);
  if (!child) {
    const shell = message.shell ?? "/bin/sh";
    child = spawn(shell, message.args ?? [], { cwd: message.cwd, env: { ...process.env, ...(message.env ?? {}) }, stdio: "pipe" });
    emit({ type: "ready", pid: child.pid, cols: message.cols, rows: message.rows });
    const forward = (data) => emit({ type: "data", data: Buffer.from(data).toString("base64") });
    child.stdout.on("data", forward); child.stderr.on("data", forward);
    child.stdin.on("error", () => {});
    child.on("close", (code) => { emit({ type: "exit", code, closed }); process.exit(0); });
    return;
  }
  if (message.type === "input") child.stdin.write(Buffer.from(message.data, "base64"));
  else if (message.type === "resize") emit({ type: "resized", cols: message.cols, rows: message.rows });
  else if (message.type === "close") { closed = true; child.kill("SIGHUP"); }
});
lines.on("close", () => { if (child && child.exitCode === null) { closed = true; child.kill("SIGHUP"); } else if (!child) process.exit(0); });
