#!/usr/bin/env node
// A stand-in for Microsoft's Playwright CLI script (playwright-cli.js) for checks, with no
// browser: `open` starts a sleeping process as the "daemon" and prints its pid as the real CLI
// does; pages answer with the real CLI's output shape (Page URL/Title, a YAML snapshot with refs);
// `close` ends the daemon. State per session lives in FAKE_PWCLI_DIR (or the temp folder).

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  state = { pid: daemon.pid, url, title: titleOf(url) };
  writeFileSync(stateFile, JSON.stringify(state));
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
    console.log(`${page(state)}### Snapshot\n\`\`\`yaml\n${SNAPSHOT}\n\`\`\``);
    break;
  case "screenshot":
    console.log(`### Result\n- [Screenshot of viewport](.playwright-cli/page-1.png)`);
    break;
  default:
    console.log(`### Ran Playwright code\n\`\`\`js\nawait page.${command}(${rest.slice(1).map((arg) => JSON.stringify(arg)).join(", ")});\n\`\`\`\n${page(state)}`);
}
writeFileSync(stateFile, JSON.stringify(state));
