/// <reference lib="dom" />
// Browser check of agentic browsing, for Codex and Claude alike, against a real gateway driving
// stand-in engines, a stand-in Playwright CLI and a stand-in Chromium (no model, no browser
// download): the "브라우저" pill under the input is off by default and the engine gets no
// instructions; switched on mid-session, the engine is told from its next request (Codex: a
// developer item, Claude: a restarted process with the instructions appended), runs
// `playwright-cli` from its PATH and the gateway asks before a new site under "자동"; the pill
// shows the page; "멈춤" refuses the engine's commands; "로그인하기" opens the plain window on
// the same profile (no automation switches, the same cookie store) and the agent waits while it is
// open; switched off, the engine is told so. Usage: node scripts/browse-check.ts [outDir] [codex|claude]

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Page } from "playwright-core";
import type { AgentBrowserStatus, Provider, Session, TranscriptItem, Work } from "@workbench/contracts";

const outDir = process.argv[2] ?? join(tmpdir(), "wb-browse-check");
const providers: Provider[] = process.argv[3] === "codex" || process.argv[3] === "claude" ? [process.argv[3]] : ["codex", "claude"];
mkdirSync(outDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "workbench-browse-"));
const worksDir = mkdtempSync(join(tmpdir(), "workbench-browse-works-"));
const fakeDir = mkdtempSync(join(tmpdir(), "workbench-browse-fake-"));
const chromeLog = join(fakeDir, "chrome.log");
const results: { step: string; ok: boolean; detail: string }[] = [];
const check = (step: string, ok: boolean, detail = "") => {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`);
};

const child = spawn(process.execPath, ["apps/host/src/main.ts"], {
  env: {
    ...process.env,
    WORKBENCH_DATA_DIR: dataDir,
    WORKBENCH_WEB_DIR: "apps/web/dist",
    WORKBENCH_HOST_LABEL: "노트북",
    WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"),
    WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"),
    WORKBENCH_BROWSER_CLI: resolve("scripts/fixtures/fake-playwright-cli.mjs"),
    WORKBENCH_BROWSER_CHROME: resolve("scripts/fixtures/fake-chrome.mjs"),
    FAKE_PWCLI_DIR: fakeDir,
    FAKE_CHROME_LOG: chromeLog,
  },
  stdio: ["ignore", "pipe", "inherit"],
});
const ready = await new Promise<{ url: string; token: string }>((done) => {
  createInterface({ input: child.stdout! }).on("line", (line) => {
    if (line.startsWith("WORKBENCH_READY ")) done(JSON.parse(line.slice(16)));
  });
});
const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${ready.url}${path}`, { method, headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return (await response.json()) as T;
};
const snapshot = () => api<{ sessions: Session[]; browser?: AgentBrowserStatus }>("GET", "/api/snapshot");
const session = async (id: string) => (await snapshot()).sessions.find((entry) => entry.id === id)!;
const status = () => api<AgentBrowserStatus>("GET", "/api/agent-browser");
const items = async (id: string) => (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${id}/items`)).items;
const until = async (what: () => Promise<boolean>, timeout = 15_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await what()) return true;
    await new Promise((done) => setTimeout(done, 100));
  }
  return false;
};
await api("PUT", "/api/prefs", { prefs: { onboarding: "done", startScreen: "last" } });

const browser = await chromium.launch();
const logs: string[] = [];

async function flow(provider: Provider) {
  const label = provider === "codex" ? "Codex" : "Claude";
  const work = await api<Work>("POST", "/api/works", { title: `${label} 브라우징`, cwd: worksDir });
  const engine = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider, purpose: "메일 정리", access: "auto" });
  const page: Page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on("console", (message) => message.type() === "error" && logs.push(`[${label} error] ${message.text().slice(0, 200)}`));
  page.on("pageerror", (error) => logs.push(`[${label} pageerror] ${error.message.slice(0, 200)}`));
  const shot = (name: string) => page.screenshot({ path: join(outDir, `${provider}-${name}`) });
  const pass = (step: string, ok: boolean, detail = "") => check(`[${label}] ${step}`, ok, detail);
  const type = async (text: string) => {
    const input = page.locator(".composer-input");
    await input.fill(text);
    await input.press("Enter");
  };
  const idle = async () => {
    await until(async () => (await session(engine.id)).status !== "idle", 2000);
    return until(async () => (await session(engine.id)).status === "idle", 20_000);
  };
  const lastAnswer = async () => (await items(engine.id)).filter((item) => item.kind === "assistant").at(-1)?.text ?? "";
  const menu = async () => {
    if (!(await page.locator(".browser-menu").isVisible().catch(() => false))) await page.locator(".browser-pill").click();
    await page.waitForSelector(".browser-menu");
  };
  try {
    await page.addInitScript((id) => localStorage.setItem("workbench.lastWork", id), work.id);
    await page.goto(`${ready.url}/?token=${ready.token}`);
    await page.waitForSelector(".composer-input");
    await page.waitForTimeout(300);

    // ── off by default: no instructions ───────────────────────────────────────────────────────
    const pillOff = await page.locator(".browser-pill").getAttribute("class");
    await type("브라우저 지침 확인");
    await idle();
    const offAnswer = await lastAnswer();
    pass("처음에는 꺼져 있고 엔진이 지침을 받지 않음", Boolean(pillOff && !pillOff.includes(" on")) && offAnswer.includes("브라우저 지침: 없음"), offAnswer.split("\n")[0]);

    // ── switched on mid-session from the pill ─────────────────────────────────────────────────
    await menu();
    await shot("01-pill-menu.png");
    const menuText = await page.locator(".browser-menu").innerText();
    await page.locator(".browser-switch").click();
    const switched = await until(async () => (await session(engine.id)).browser === true, 4000);
    await page.waitForTimeout(200);
    const pillOn = await page.locator(".browser-pill").getAttribute("class");
    pass("알약으로 켬(권한별 설명 포함)", switched && Boolean(pillOn?.includes(" on")) && menuText.includes("자동: 읽기와 이미 연 사이트 안 이동은 바로"), menuText.replace(/\s+/g, " ").slice(0, 90));
    await page.keyboard.press("Escape");

    // ── the next request: told, runs playwright-cli, a new site asks first ────────────────────
    await type("브라우저로 https://example.com 열고 제목 알려 줘");
    const card = await page.waitForSelector(".approval-card", { timeout: 15_000 }).then((element) => element.innerText()).catch(() => "");
    await shot("02-approval.png");
    await page.locator(".approval-card .button.primary").click().catch(() => undefined);
    await idle();
    const onAnswer = await lastAnswer();
    const told = onAnswer.includes("브라우저 지침: 받음") && onAnswer.includes("제목: Example Domain");
    const roots = provider !== "codex" || onAnswer.includes("쓰기 폴더 1개");
    const command = (await items(engine.id)).find((item) => item.kind === "tool" && item.title.includes("playwright-cli") && item.title.includes("open"));
    pass("켠 뒤 다음 요청부터 지침을 받고, 새 사이트는 카드로 확인한 뒤 제목을 읽음", card.includes("브라우저로 새 사이트를 열까요?") && told && roots && Boolean(command), `${card.replace(/\s+/g, " ").slice(0, 60)} | ${onAnswer.split("\n")[0]}`);

    // ── the pill shows the page while the session holds the window ─────────────────────────────
    await page.waitForTimeout(300);
    const host = await page.locator(".browser-pill .browser-host").innerText().catch(() => "");
    const window = (await status()).window;
    await shot("03-pill-open.png");
    pass("알약에 창 상태(사이트)가 보임", host === "example.com" && window.kind === "agent" && window.sessionId === engine.id && window.title === "Example Domain", `${host} · ${JSON.stringify(window).slice(0, 80)}`);

    // ── "멈춤" refuses the engine's commands ───────────────────────────────────────────────────
    await menu();
    await page.locator(".browser-menu button", { hasText: "멈춤" }).click();
    const paused = await until(async () => (await status()).paused.includes(engine.id), 3000);
    await page.keyboard.press("Escape");
    await type("브라우저로 https://example.com 다시 열어 줘");
    await idle();
    const pausedAnswer = await lastAnswer();
    await menu();
    await shot("04-paused.png");
    await page.locator(".browser-menu button", { hasText: "다시 쓰게 하기" }).click();
    const resumed = await until(async () => !(await status()).paused.includes(engine.id), 3000);
    pass("'멈춤' 동안 엔진의 브라우저 명령이 거절되고, 다시 쓰게 할 수 있음", paused && pausedAnswer.includes("멈췄습니다") && resumed, pausedAnswer.split("\n")[0].slice(0, 90));

    // ── "로그인하기": a plain window on the same profile; the agent waits meanwhile ─────────────
    writeFileSync(chromeLog, "");
    await page.locator(".browser-menu button", { hasText: "Google·Gmail" }).click();
    const login = await until(async () => (await status()).window.kind === "login", 5000);
    await page.waitForTimeout(200);
    await shot("05-login.png");
    const launched = readFileSync(chromeLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]).at(-1) ?? [];
    const profile = join(dataDir, "agent-browser", "profile");
    const plain =
      launched.includes(`--user-data-dir=${profile}`) &&
      launched.includes("--password-store=basic") &&
      !launched.some((arg) => /enable-automation|remote-debugging/.test(arg)) &&
      launched.some((arg) => arg.startsWith("https://accounts.google.com/"));
    const loginNote = await page.locator(".browser-menu .browser-login-open").innerText().catch(() => "");
    await page.keyboard.press("Escape");
    await type("브라우저로 https://example.com 열어 줘");
    await idle();
    const waitAnswer = await lastAnswer();
    await menu();
    await page.locator(".browser-menu button", { hasText: "로그인 창 닫기" }).click();
    const closed = await until(async () => (await status()).window.kind === "closed", 6000);
    pass(
      "'로그인하기'는 같은 프로필의 일반 창(자동화 스위치 없음, 같은 쿠키 저장 방식)을 열고, 그동안 에이전트는 기다림",
      login && plain && loginNote.includes("로그인 창이 열려 있습니다") && waitAnswer.includes("로그인하는 중") && closed,
      `${launched.filter((arg) => arg.startsWith("--")).join(" ")} | ${waitAnswer.split("\n")[0].slice(0, 60)}`,
    );

    // ── switched off: the engine is told so ────────────────────────────────────────────────────
    await page.locator(".browser-switch").click();
    const off = await until(async () => (await session(engine.id)).browser === false, 4000);
    await page.keyboard.press("Escape");
    await type("브라우저 지침 확인");
    await idle();
    const offAgain = await lastAnswer();
    pass("끄면 다음 요청부터 엔진이 브라우저를 쓰지 않음", off && offAgain.includes("브라우저 지침: 없음"), offAgain.split("\n")[0]);

    // ── the ⋯ menu: the agent browser, ready, with sign-in links ───────────────────────────────
    await page.locator('[aria-label="연결과 설정"]').click();
    await page.waitForSelector(".browser-connection");
    const connection = await page.locator(".browser-connection").innerText();
    await page.locator(".browser-connection").screenshot({ path: join(outDir, `${provider}-06-connections.png`) });
    await page.keyboard.press("Escape");
    pass("⋯ 연결에 '에이전트 브라우저 · 준비됨'과 로그인하기", connection.includes("에이전트 브라우저") && connection.includes("준비됨") && connection.includes("네이버"), connection.replace(/\s+/g, " ").slice(0, 80));
    await shot("07-final.png");
  } catch (error) {
    pass("실행", false, error instanceof Error ? error.message.split("\n")[0]! : String(error));
    await page.screenshot({ path: join(outDir, `${provider}-99-failure.png`) }).catch(() => undefined);
  } finally {
    await page.close();
  }
}

try {
  for (const provider of providers) await flow(provider);
} finally {
  writeFileSync(join(outDir, "console.log"), logs.join("\n"));
  writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
  await browser.close();
  child.kill();
  await new Promise((done) => (child.exitCode === null && child.signalCode === null ? child.once("exit", done) : done(null)));
  // Stand-in "daemons" the fake CLI left (the gateway closes its window on shutdown).
  for (const dir of [dataDir, worksDir, fakeDir]) if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((result) => !result.ok).length;
  console.log(`${results.length - failed}/${results.length} passed · console: ${logs.length ? logs.slice(0, 6).join(" | ") : "clean"}`);
  process.exitCode = failed ? 1 : 0;
}
