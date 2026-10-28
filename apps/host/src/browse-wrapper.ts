// The `playwright-cli` engines find on their PATH. Commands of a Workbench browser session
// (`wb-…`, named by -s, by PLAYWRIGHT_CLI_SESSION for Claude, or by the Codex thread the command
// runs in) are written as a request file into that session's spool folder and answered by the
// gateway, which runs them against the one browser window. Files, not sockets: Codex's sandbox
// lets a command write into a folder it is given, but not connect anywhere. Any other use goes to
// another playwright-cli on PATH, so a developer's own install keeps working.

const WRAPPER = String.raw`// Achmage Workbench: playwright-cli for engine sessions (written by the gateway; see browse-wrapper.ts).
import { existsSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { delimiter, join } from "node:path";

const ROOT = __ROOT__;
const BIN = join(ROOT, "bin");
const argv = process.argv.slice(2);
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const say = (fd, text) => { if (text) writeSync(fd, text); };

function sessionName() {
  for (let index = 0; index < argv.length; index += 1) {
    const inline = /^(?:-s|--session)=(.*)$/.exec(argv[index]);
    if (inline) return inline[1];
    if ((argv[index] === "-s" || argv[index] === "--session") && index + 1 < argv.length) return argv[index + 1];
  }
  if (process.env.PLAYWRIGHT_CLI_SESSION) return process.env.PLAYWRIGHT_CLI_SESSION;
  const thread = process.env.CODEX_THREAD_ID;
  if (thread) {
    try {
      return JSON.parse(readFileSync(join(ROOT, "threads.json"), "utf8"))[thread] ?? null;
    } catch {}
  }
  return null;
}

function elsewhere() {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir || dir === BIN) continue;
    const candidate = join(dir, "playwright-cli");
    if (existsSync(candidate)) return spawnSync(candidate, argv, { stdio: "inherit" }).status ?? 1;
  }
  say(2, "playwright-cli: 이 세션에서는 Workbench 브라우저가 꺼져 있습니다. 사용자에게 입력창 아래 '브라우저'를 켜 달라고 하세요.\n");
  return 127;
}

function main() {
  const name = sessionName();
  if (!name || !/^wb-[a-z0-9]+$/.test(name)) return elsewhere();
  const dir = join(ROOT, "spool", name);
  if (!existsSync(dir)) {
    say(2, "playwright-cli: 세션 " + name + "의 Workbench 브라우저가 꺼져 있습니다. 사용자에게 입력창 아래 '브라우저'를 켜 달라고 하세요.\n");
    return 1;
  }
  const id = Date.now().toString(36) + "-" + randomBytes(4).toString("hex");
  const request = join(dir, id + ".req.json");
  const response = join(dir, id + ".res.json");
  // Touched while this command waits, so an approval given after the engine gave up runs nothing.
  const waiting = join(dir, id + ".wait");
  try {
    writeFileSync(waiting, "");
    writeFileSync(request + ".tmp", JSON.stringify({ id, args: argv, cwd: process.cwd() }));
    renameSync(request + ".tmp", request);
  } catch {
    // A sandboxed turn that started before the browser was switched on cannot write here yet.
    say(2, "playwright-cli: 이 요청에서는 아직 브라우저를 쓸 수 없습니다. 브라우저는 사용자의 다음 요청부터 쓸 수 있습니다.\n");
    return 1;
  }
  // Approvals can take a while: the user decides in Workbench.
  const deadline = Date.now() + 15 * 60_000;
  let beat = Date.now();
  while (Date.now() < deadline) {
    if (Date.now() - beat > 1000) {
      beat = Date.now();
      try {
        utimesSync(waiting, new Date(), new Date());
      } catch {}
    }
    if (existsSync(response)) {
      let result;
      try {
        result = JSON.parse(readFileSync(response, "utf8"));
      } catch {
        Atomics.wait(sleeper, 0, 0, 50);
        continue;
      }
      rmSync(response, { force: true });
      rmSync(waiting, { force: true });
      say(1, result.stdout);
      say(2, result.stderr);
      return typeof result.code === "number" ? result.code : 1;
    }
    Atomics.wait(sleeper, 0, 0, 80);
  }
  rmSync(request, { force: true });
  rmSync(waiting, { force: true });
  say(2, "playwright-cli: Workbench가 15분 동안 응답하지 않았습니다. 사용자에게 알리세요.\n");
  return 1;
}

process.exitCode = main();
`;

/** The wrapper's JavaScript for an agent-browser folder. */
export function wrapperSource(root: string) {
  return WRAPPER.replace("__ROOT__", JSON.stringify(root));
}

/** The `playwright-cli` launcher: the gateway's own Node runs the wrapper (no reliance on PATH's node). */
export function launcherSource(node: string, script: string) {
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  return `#!/bin/sh\nexec ${quote(node)} ${quote(script)} "$@"\n`;
}
