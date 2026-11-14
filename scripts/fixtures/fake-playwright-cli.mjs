#!/usr/bin/env node
// A stand-in for Microsoft's Playwright CLI script (playwright-cli.js) for checks, with no
// browser: `open` starts a sleeping process as the "daemon" and prints its pid as the real CLI
// does; pages answer with the real CLI's output shape (Page URL/Title, a YAML snapshot with refs);
// `close` ends the daemon. State per session lives in FAKE_PWCLI_DIR (or the temp folder).

import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const argv = process.argv.slice(2);
const session = argv.find((arg) => arg.startsWith("-s="))?.slice(3) ?? "default";
const rest = argv.filter((arg) => !arg.startsWith("-s=") && !arg.startsWith("--config="));
const command = rest[0];
const dir = process.env.FAKE_PWCLI_DIR ?? tmpdir();
const stateFile = join(dir, `fake-pwcli-${session}.json`);
const SNAPSHOT = ['- generic [active] [ref=e1]:', '  - heading "받은편지함" [level=1] [ref=e2]', '  - textbox "받는 사람" [ref=e4]', '  - button "보내기" [ref=e5] [cursor=pointer]'].join("\n");

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const read = () => {
  try {
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    return alive(state.pid) ? state : null;
  } catch {
    return null;
  }
};
/** The page's text: FAKE_PWCLI_DIR/page.txt when a check put one there. */
const pageText = (fallback) => {
  try { return readFileSync(join(dir, "page.txt"), "utf8").replace(/\n$/, ""); } catch { return fallback; }
};
const page = (state) => `### Page\n- Page URL: ${state.url}\n- Page Title: ${state.title}\n`;
const titleOf = (url) => {
  try {
    const host = new URL(url).host;
    return host === "example.com" ? "Example Domain" : host || "";
  } catch {
    return "";
  }
};

if (argv.includes("--version")) {
  console.log("0.1.22");
  process.exit(0);
}
if (!command || argv.includes("--help")) {
  console.log("playwright-cli - run playwright mcp commands from terminal (stand-in)");
  process.exit(0);
}
mkdirSync(dir, { recursive: true });
// What ran, for checks that something did not.
appendFileSync(join(dir, "commands.log"), `${session} ${rest.join(" ")}\n`);
let state = read();
if (command === "open") {
  if (state) process.kill(state.pid);
  const daemon = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], { detached: true, stdio: "ignore" });
  daemon.unref();
  const url = rest[1] ?? "about:blank";
  // The config's output folder: files a command writes without --filename go there, as the real CLI's.
  let outputDir = null;
  const config = argv.find((arg) => arg.startsWith("--config="))?.slice(9);
  try { outputDir = config ? JSON.parse(readFileSync(config, "utf8")).outputDir ?? null : null; } catch { /* none */ }
  state = { pid: daemon.pid, url, title: titleOf(url), outputDir };
  writeFileSync(stateFile, JSON.stringify(state));
  // What a real daemon would be started with (unit 9: its socket folder, no global config).
  writeFileSync(join(dir, `fake-pwcli-${session}.env.json`), JSON.stringify({ PWTEST_SOCKETS_DIR: process.env.PWTEST_SOCKETS_DIR ?? null, PWTEST_CLI_GLOBAL_CONFIG: process.env.PWTEST_CLI_GLOBAL_CONFIG ?? null }));
  console.log(`### Browser \`${session}\` opened with pid ${daemon.pid}.\n${page(state)}`);
  process.exit(0);
}
if (!state) {
  console.log(`The browser '${session}' is not open, please run open first\n\n  playwright-cli -s=${session} open [params]`);
  process.exit(1);
}
switch (command) {
  case "close":
    process.kill(state.pid);
    rmSync(stateFile, { force: true });
    console.log(`Browser '${session}' closed\n`);
    process.exit(0);
    break;
  case "goto":
    state.url = new URL(rest[1]).href;
    state.title = titleOf(state.url);
    console.log(`### Ran Playwright code\n\`\`\`js\nawait page.goto('${state.url}');\n\`\`\`\n${page(state)}### Snapshot\n- [Snapshot](.playwright-cli/page-1.yml)`);
    break;
  case "snapshot":
    // --json: what the real CLI prints then, one object per element with its value as "text".
    if (rest.includes("--json")) {
      const elements = pageText(SNAPSHOT).split("\n").map((line) => /^\s*- (\w+)(?: "([^"]*)")?((?: \[[^\]]*\])*):?\s?(.*)$/.exec(line)).filter(Boolean)
        .map(([, role, name, attrs, text]) => ({ role, ...(name !== undefined ? { name } : {}), ...(/\[ref=(\w+)\]/.exec(attrs)?.[1] ? { ref: /\[ref=(\w+)\]/.exec(attrs)[1] } : {}), ...(text ? { text } : {}) }));
      console.log(JSON.stringify({ page: { url: state.url, title: state.title }, snapshot: elements }, null, 2));
      break;
    }
    console.log(`${page(state)}### Snapshot\n\`\`\`yaml\n${SNAPSHOT}\n\`\`\``);
    break;
  case "screenshot":
  case "pdf": {
    // The picture (or PDF) is FAKE_PWCLI_DIR/<command>.bin when a check put one there; written to
    // --filename (as given, from the working folder) or the config's output folder, and linked.
    let bytes = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    try { bytes = readFileSync(join(dir, `${command}.bin`)); } catch { /* the default */ }
    const at = rest.findIndex((arg) => arg === "--filename" || arg.startsWith("--filename="));
    const named = at < 0 ? null : rest[at].startsWith("--filename=") ? rest[at].slice(11) : rest[at + 1];
    const file = named ? resolve(process.cwd(), named) : join(state.outputDir ?? join(process.cwd(), ".playwright-cli"), `page-${Date.now()}.${command === "pdf" ? "pdf" : "png"}`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    console.log(`### Result\n- [${command === "pdf" ? "Saved PDF" : "Screenshot of viewport"}](${named ?? file})`);
    break;
  }
  case "find":
    // --json: the matching lines as one string, the field's value quoted (the real CLI's form).
    if (rest.includes("--json")) {
      const query = rest[1] ?? "";
      const lines = pageText("").split("\n").filter((line) => line.includes(query)).map((line) => line.replace(/\]: (.*)$/, (_, value) => `]: ${JSON.stringify(value)}`));
      console.log(JSON.stringify({ result: lines.join("\n") }, null, 2));
      break;
    }
  // falls through
  case "eval":
  case "console": {
    // A result written to a file and linked under the command's own title (the real CLI's form). The
    // page's text is FAKE_PWCLI_DIR/page.txt (a check puts a field's value there).
    let page = "";
    try { page = readFileSync(join(dir, "page.txt"), "utf8"); } catch { /* an empty page */ }
    const at = rest.findIndex((arg) => arg === "--filename" || arg.startsWith("--filename="));
    const named = at < 0 ? null : rest[at].startsWith("--filename=") ? rest[at].slice(11) : rest[at + 1];
    const title = { find: "Find results", eval: "Evaluation result", console: "Console messages" }[command];
    const file = named ? resolve(process.cwd(), named) : join(state.outputDir ?? join(process.cwd(), ".playwright-cli"), `${command}-${Date.now()}.${command === "eval" ? "json" : "md"}`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, command === "eval" && file.endsWith(".bin") ? Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(page)]) : page);
    // FAKE_PWCLI_LOCK: a file the gateway can neither read nor rewrite.
    if (process.env.FAKE_PWCLI_LOCK === command) chmodSync(file, 0);
    console.log(`### Result\n- [${title}](${file})`);
    break;
  }
  default:
    console.log(`### Ran Playwright code\n\`\`\`js\nawait page.${command}(${rest.slice(1).map((arg) => JSON.stringify(arg)).join(", ")});\n\`\`\`\n${page(state)}`);
}
writeFileSync(stateFile, JSON.stringify(state));
