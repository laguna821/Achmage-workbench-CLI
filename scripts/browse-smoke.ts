// Plumbing smoke of the agent browser with the real Playwright CLI and Chromium, and no model:
// the gateway installs both into a temp data folder; the CLI runs directly and through the
// wrapper engines use; a sign-in made in the plain window (a local fake site: /login sets a
// persistent cookie, / says whether it is there) survives closing everything and a gateway
// restart; the sign-in window and the agent's window take turns on the one profile.
// Never touches real accounts. Headless unless --headed (no window on the user's screen).
// Usage: node scripts/browse-smoke.ts [--headed] [--keep]

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { browserSessionName, type AgentBrowserStatus, type Session, type Work } from "@workbench/contracts";

const run = promisify(execFile);
const headed = process.argv.includes("--headed");
const keep = process.argv.includes("--keep");
const dataDir = mkdtempSync(join(tmpdir(), "workbench-browse-smoke-"));
const worksDir = mkdtempSync(join(tmpdir(), "workbench-browse-smoke-works-"));
const root = join(dataDir, "agent-browser");
const results: { step: string; ok: boolean; detail: string }[] = [];
const check = (step: string, ok: boolean, detail = "") => {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`);
};

// ── a fake site: a sign-in that sets a cookie for 30 days ─────────────────────────────────────
let loginsServed = 0;
const site = createServer((req, res) => {
  const signedIn = /(?:^|;\s*)wb_login=yes(?:;|$)/.test(req.headers.cookie ?? "");
  if (req.url?.startsWith("/login")) {
    loginsServed += 1;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "set-cookie": "wb_login=yes; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax" });
    res.end("<!doctype html><title>logged in</title><h1>logged in</h1>");
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><title>${signedIn ? "logged in" : "logged out"}</title><h1>${signedIn ? "logged in" : "logged out"}</h1>`);
});
await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
const siteUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}`;

// ── the gateway (started twice on the same data folder) ───────────────────────────────────────
type Gateway = { child: ChildProcess; url: string; token: string };
async function startGateway(): Promise<Gateway> {
  const child = spawn(process.execPath, ["apps/host/src/main.ts"], {
    env: {
      ...process.env,
      WORKBENCH_DATA_DIR: dataDir,
      WORKBENCH_BROWSER_HEADLESS: headed ? "0" : "1",
      WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"),
      WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"),
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const ready = await new Promise<{ url: string; token: string }>((done) => {
    createInterface({ input: child.stdout! }).on("line", (line) => {
      if (line.startsWith("WORKBENCH_READY ")) done(JSON.parse(line.slice(16)));
    });
  });
  return { child, ...ready };
}
async function stopGateway(gateway: Gateway) {
  gateway.child.kill("SIGTERM");
  await new Promise((done) => (gateway.child.exitCode === null && gateway.child.signalCode === null ? gateway.child.once("exit", done) : done(null)));
}
const call = async <T>(gateway: Gateway, method: string, path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${gateway.url}${path}`, { method, headers: { authorization: `Bearer ${gateway.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return (await response.json()) as T;
};
const until = async (what: () => Promise<boolean> | boolean, timeout: number, every = 250) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await what()) return true;
    await new Promise((done) => setTimeout(done, every));
  }
  return false;
};
/** The wrapper exactly as an engine's shell finds it on PATH. */
const wrapper = async (cwd: string, args: string[]) => {
  const started = Date.now();
  try {
    const { stdout, stderr } = await run("playwright-cli", args, { cwd, timeout: 180_000, env: { ...process.env, PATH: `${join(root, "bin")}${delimiter}${process.env.PATH}` } });
    return { code: 0, out: `${stdout}${stderr}`, ms: Date.now() - started };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, out: `${failure.stdout ?? ""}${failure.stderr ?? ""}`, ms: Date.now() - started };
  }
};
const title = (text: string) => /Page Title: (.*)/.exec(text)?.[1]?.trim() ?? null;
/** Who holds the profile (Chromium's lock), if anyone alive. */
const holder = () => {
  try {
    const pid = Number(readlinkSync(join(root, "profile", "SingletonLock")).split("-").at(-1));
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
};

let gateway = await startGateway();
try {
  // ── install into the temp data folder ───────────────────────────────────────────────────────
  const installStarted = Date.now();
  await call(gateway, "POST", "/api/agent-browser/install");
  const stages = new Set<string>();
  let install: AgentBrowserStatus["install"] | null = null;
  await until(async () => {
    install = (await call<AgentBrowserStatus>(gateway, "GET", "/api/agent-browser")).install;
    if (install.stage) stages.add(install.stage);
    return install.state === "ready" || install.state === "error";
  }, 15 * 60_000, 500);
  const seconds = Math.round((Date.now() - installStarted) / 1000);
  const { stdout: size } = await run("du", ["-sh", root]);
  const finished = install as AgentBrowserStatus["install"] | null;
  check("설치: 고정한 Playwright CLI와 Chromium을 데이터 폴더에(체크섬 확인)", finished?.state === "ready" && stages.has("cli") && stages.has("browser") && stages.has("verify"), `${seconds}초 · ${size.split("\t")[0]} · ${[...stages].join("→")} · ${finished?.message ?? ""}`);
  if (finished?.state !== "ready") throw new Error("설치 실패");

  // ── the CLI directly, as the gateway runs it ────────────────────────────────────────────────
  const cliJs = join(root, "cli/node_modules/@playwright/cli/playwright-cli.js");
  const direct = async (args: string[]) => {
    const { stdout } = await run(process.execPath, [cliJs, "-s=smoke-direct", ...args], { cwd: worksDir, timeout: 120_000, env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(root, "browsers"), NO_UPDATE_NOTIFIER: "1" } });
    return stdout;
  };
  const version = (await run(process.execPath, [cliJs, "--version"], { env: { ...process.env, NO_UPDATE_NOTIFIER: "1" } })).stdout.trim();
  // Its own config and throwaway profile: the agent profile is for the sign-in test below.
  const directConfig = join(dataDir, "direct.config.json");
  writeFileSync(
    directConfig,
    JSON.stringify({ browser: { browserName: "chromium", userDataDir: join(dataDir, "direct-profile"), launchOptions: { headless: !headed, chromiumSandbox: true, ...(headed ? {} : { channel: "chromium" }) } }, outputDir: join(dataDir, "direct-output") }),
  );
  const opened = await direct(["open", "https://example.com", `--config=${directConfig}`]);
  const snapshot = await direct(["snapshot"]);
  const evaluated = await direct(["eval", "document.title"]);
  await direct(["close"]);
  check("CLI 직접: example.com 열기 · 스냅숏 · 제목 읽기", title(opened) === "Example Domain" && /\[ref=e\d+\]/.test(snapshot) && evaluated.includes('"Example Domain"'), `playwright-cli ${version} · ${title(opened)} · ${evaluated.split("\n")[1] ?? ""}`);

  // ── the same through the wrapper engines use ────────────────────────────────────────────────
  const work = await call<Work>(gateway, "POST", "/api/works", { title: "브라우징 스모크", cwd: worksDir });
  const session = await call<Session>(gateway, "POST", `/api/works/${work.id}/sessions`, { provider: "claude", purpose: "스모크", access: "full", browser: true });
  const name = browserSessionName(session.id);
  const viaOpen = await wrapper(worksDir, [`-s=${name}`, "open", "https://example.com"]);
  const viaSnap = await wrapper(worksDir, [`-s=${name}`, "snapshot"]);
  const viaShot = await wrapper(worksDir, [`-s=${name}`, "screenshot"]);
  const shotPath = /\[Screenshot of viewport\]\(([^)]+)\)/.exec(viaShot.out)?.[1] ?? "";
  const blocked = await wrapper(worksDir, [`-s=${name}`, "cookie-list"]);
  check(
    "래퍼(엔진이 쓰는 playwright-cli): 열기 · 스냅숏 · 스크린숏 경로 · 쿠키 명령 거절",
    viaOpen.code === 0 && title(viaOpen.out) === "Example Domain" && /\[ref=e\d+\]/.test(viaSnap.out) && shotPath.startsWith("/") && existsSync(shotPath) && blocked.code === 1,
    `open ${viaOpen.ms}ms · snapshot ${viaSnap.ms}ms · ${shotPath.split("/").slice(-2).join("/")}`,
  );

  // ── sign in through the plain window; the agent waits meanwhile ─────────────────────────────
  const agentPid = holder();
  await call(gateway, "POST", "/api/agent-browser/login", { url: `${siteUrl}/login` });
  const loginOpen = await until(async () => (await call<AgentBrowserStatus>(gateway, "GET", "/api/agent-browser")).window.kind === "login", 15_000);
  const signedInPage = await until(() => loginsServed > 0, 20_000);
  const loginPid = holder();
  const waiting = await wrapper(worksDir, [`-s=${name}`, "open", `${siteUrl}/`]);
  // Give Chromium a moment with the page, then close it as a user would.
  await new Promise((done) => setTimeout(done, 1500));
  await call(gateway, "POST", "/api/agent-browser/login/close");
  const loginClosed = await until(async () => (await call<AgentBrowserStatus>(gateway, "GET", "/api/agent-browser")).window.kind === "closed" && !holder(), 20_000);
  check(
    "'로그인하기': 에이전트 창을 닫고 같은 프로필로 일반 창을 열며, 그동안 에이전트 명령은 기다리라고 거절",
    loginOpen && signedInPage && Boolean(agentPid) && Boolean(loginPid) && loginPid !== agentPid && waiting.code === 1 && waiting.out.includes("로그인하는 중") && loginClosed,
    `agent pid ${agentPid} → login pid ${loginPid} · ${waiting.out.trim().slice(0, 50)}`,
  );
  // Names only: the cookie's value is never read.
  const db = new DatabaseSync(`file:${encodeURI(join(root, "profile", "Default", "Cookies"))}?immutable=1`, { readOnly: true });
  const names = db.prepare("SELECT host_key, name FROM cookies WHERE host_key = '127.0.0.1'").all() as { host_key: string; name: string }[];
  db.close();
  check("로그인 쿠키가 프로필에 저장됨(이름만 확인)", names.some((row) => row.name === "wb_login"), names.map((row) => `${row.host_key}:${row.name}`).join(", "));

  // ── close everything, restart the gateway, use the CLI: still signed in ─────────────────────
  await stopGateway(gateway);
  const nothingLeft = await until(() => !holder(), 10_000);
  gateway = await startGateway();
  const after = await wrapper(worksDir, [`-s=${name}`, "open", `${siteUrl}/`]);
  check("모두 닫고 게이트웨이를 다시 켠 뒤 CLI로 열어도 로그인 유지", nothingLeft && after.code === 0 && title(after.out) === "logged in", `${title(after.out)} · ${after.ms}ms`);

  // ── the two windows take turns on the one profile ───────────────────────────────────────────
  await call(gateway, "POST", "/api/agent-browser/login", { url: `${siteUrl}/` });
  const swapped = await until(async () => (await call<AgentBrowserStatus>(gateway, "GET", "/api/agent-browser")).window.kind === "login", 15_000);
  await new Promise((done) => setTimeout(done, 1000));
  await call(gateway, "POST", "/api/agent-browser/login/close");
  await until(async () => (await call<AgentBrowserStatus>(gateway, "GET", "/api/agent-browser")).window.kind === "closed" && !holder(), 20_000);
  const back = await wrapper(worksDir, [`-s=${name}`, "open", `${siteUrl}/`]);
  check("로그인 창과 에이전트 창이 프로필을 번갈아 씀(동시에 두 Chromium 없음)", swapped && back.code === 0 && title(back.out) === "logged in", title(back.out) ?? back.out.slice(0, 80));
} catch (error) {
  check("실행", false, error instanceof Error ? error.message.split("\n")[0]! : String(error));
} finally {
  await stopGateway(gateway).catch(() => undefined);
  site.close();
  // The CLI's session records for this temp install (keyed by its playwright-core folder).
  const key = createHash("sha1").update(join(root, "cli/node_modules/playwright-core")).digest("hex").slice(0, 16);
  rmSync(join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "ms-playwright", "daemon", key), { recursive: true, force: true });
  if (!keep) for (const dir of [dataDir, worksDir]) rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((result) => !result.ok).length;
  console.log(`${results.length - failed}/${results.length} passed${keep ? ` · kept ${dataDir}` : ""}`);
  process.exitCode = failed ? 1 : 0;
}
