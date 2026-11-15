#!/usr/bin/env node
// A stand-in for the app's OS keyring helper (`WORKBENCH_SECRET_BIN --office-secret-key`) in checks
// and captures: answers a fixed made-up key. While the file named by FAKE_SECRET_OFF exists it fails
// as a machine without a keyring does. Never used by the app itself.
import { existsSync } from "node:fs";

if (process.argv[2] !== "--office-secret-key" || (process.env.FAKE_SECRET_OFF && existsSync(process.env.FAKE_SECRET_OFF))) process.exit(1);
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ ok: true, id: "c".repeat(32), key: Buffer.alloc(32, 7).toString("base64") }));
});
