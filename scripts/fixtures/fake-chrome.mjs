#!/usr/bin/env node
// A stand-in for Chromium in the agent browser's sign-in launch, for checks: writes the switches
// it was started with (one JSON line to FAKE_CHROME_LOG) and stays open until it is closed.

import { appendFileSync } from "node:fs";

if (process.env.FAKE_CHROME_LOG) appendFileSync(process.env.FAKE_CHROME_LOG, `${JSON.stringify(process.argv.slice(2))}\n`);
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1 << 30);
