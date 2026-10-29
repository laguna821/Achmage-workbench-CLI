#!/usr/bin/env node
// A stand-in for the desktop's "open this address in the browser" (WORKBENCH_OPEN_URL), for setup
// checks: notes the address in $FAKE_OPENER_LOG and, like a browser where the user finishes
// logging in, opens it after $FAKE_OPENER_DELAY_MS — except a page that only shows a code to copy
// ("/oauth/manual"), which the check reads itself.

import { appendFileSync } from "node:fs";

const url = process.argv[2] ?? "";
if (process.env.FAKE_OPENER_LOG) appendFileSync(process.env.FAKE_OPENER_LOG, `${url}\n`);
if (!url.includes("/oauth/manual")) {
  await new Promise((done) => setTimeout(done, Number(process.env.FAKE_OPENER_DELAY_MS ?? 0)));
  await fetch(url).catch(() => undefined);
}
