// Stand-in for the desktop's openers (xdg-open, gio open, kde-open, …) inside the app-e2e harness,
// first on the app's PATH. It records what the app asked to open, which process asked, and which
// application the desktop would have picked for it, and opens nothing (the user's desktop stays
// untouched). Usage (from the wrappers the harness writes): node opener-shim.cjs <opener> [args…]
"use strict";
const { appendFileSync, existsSync, readFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");

const [opener = "?", ...args] = process.argv.slice(2);
const realPath = process.env.APP_E2E_REAL_PATH || process.env.PATH || "";

// `gio` has other uses (trash, info…): only `gio open` is stood in for; the rest runs the real one.
if (opener === "gio" && args[0] !== "open") {
  const real = realPath.split(":").map((dir) => `${dir}/gio`).find((path) => existsSync(path));
  const result = real ? spawnSync(real, args, { stdio: "inherit" }) : { status: 127 };
  process.exit(result.status ?? 1);
}

const env = { ...process.env, PATH: realPath };
if (process.env.APP_E2E_REAL_XDG_DATA_HOME) env.XDG_DATA_HOME = process.env.APP_E2E_REAL_XDG_DATA_HOME;
else delete env.XDG_DATA_HOME;
const query = (...queryArgs) => {
  const result = spawnSync("xdg-mime", ["query", ...queryArgs], { env, encoding: "utf8", timeout: 5000 });
  return (result.stdout || "").trim() || null;
};

const target = args.filter((arg) => arg !== "open" && !arg.startsWith("-")).pop() ?? null;
let mime = null;
let application = null;
if (target && /^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith("file:")) {
  mime = `x-scheme-handler/${target.split(":")[0].toLowerCase()}`;
  application = query("default", mime);
} else if (target) {
  const path = target.startsWith("file://") ? decodeURIComponent(target.slice(7)) : target;
  if (existsSync(path)) {
    mime = query("filetype", path);
    application = mime ? query("default", mime) : null;
  }
}
let parent = null;
try {
  parent = readFileSync(`/proc/${process.ppid}/cmdline`, "utf8").split("\0").filter(Boolean).slice(0, 3).join(" ");
} catch {
  // The parent is gone already.
}
const record = { at: Date.now(), opener, args, target, exists: target ? existsSync(target.replace(/^file:\/\//, "")) : false, mime, application, parent };
if (process.env.APP_E2E_OPEN_LOG) appendFileSync(process.env.APP_E2E_OPEN_LOG, `${JSON.stringify(record)}\n`);
