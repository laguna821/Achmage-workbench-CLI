/// <reference lib="dom" />
// First run on Linux, as release.yml's smoke job checks it on Windows and macOS, plus the screen:
//  A. The app as installed (a folder laid out like the bundle: host/, web/, skills/, ieumoffice/,
//     node/) with stand-in engines where people install them and an AppImage's PATH: both engines
//     found and answering, kordoc and IeumOffice shipped and working (scripts/setup-smoke.ts).
//  B. The first-run guide in Chromium with no engine on the computer: no command to type, a
//     "설치" button per engine that installs it (a stand-in npm), "로그인" that logs in through the
//     engine's own login (Codex: the browser comes back; Claude Code: the page's code pasted in),
//     and after the guide 설정 › AI 엔진 naming where each engine is and 설정 › 문서 도구 with the
//     document tools "앱에 들어 있음".
// Usage: node scripts/setup-check.ts [outDir] [folder with the unpacked Linux apps]

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright-core";
import type { ProviderStatus, Snapshot } from "@workbench/contracts";
import { apiChecks, client, installStandIns, startGateway, type Result } from "./setup-smoke.ts";

const outDir = resolve(process.argv[2] ?? join(tmpdir(), "wb-setup-check"));
// The apps an installer ships (scripts/fetch-bundled-apps.ts), unpacked once outside the checkout.
const bundledDir = resolve(process.argv[3] ?? process.env.WORKBENCH_TEST_BUNDLED ?? "/var/tmp/wb-setup/bundled-linux");
mkdirSync(outDir, { recursive: true });
const results: Result[] = [];
const check = (step: string, ok: boolean, detail = "") => {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`);
};

if (!existsSync(join(bundledDir, "ieumoffice/resources/cli/genoffice.cjs"))) {
  console.log(`The bundled apps are not unpacked at ${bundledDir}; fetching the pinned Linux builds…`);
  spawnSync(process.execPath, ["scripts/fetch-bundled-apps.ts", bundledDir, "linux-x64"], { stdio: "inherit" });
}
for (const [what, path] of [
  ["gateway bundle (npm run build -w @workbench/host)", "apps/host/dist/host.mjs"],
  ["screen (npm run build -w @workbench/web)", "apps/web/dist/index.html"],
] as const) {
  if (!existsSync(path)) throw new Error(`Build the ${what} first: ${path} is missing`);
}

// The app as an installer lays it out (resources folder), pointing at this checkout's builds.
const root = mkdtempSync(join(tmpdir(), "wb-setup-check-"));
const app = join(root, "app");
mkdirSync(join(app, "host"), { recursive: true });
mkdirSync(join(app, "node"), { recursive: true });
cpSync("apps/host/dist", join(app, "host"), { recursive: true });
symlinkSync(resolve("apps/web/dist"), join(app, "web"));
symlinkSync(resolve("third_party/skills"), join(app, "skills"));
symlinkSync(join(bundledDir, "ieumoffice"), join(app, "ieumoffice"));
symlinkSync(process.execPath, join(app, "node", "node"));

// ── A. installed app, engines already on the computer ────────────────────────────────────────
{
  const standIns = installStandIns(join(root, "a"), "linux");
  const gateway = await startGateway(app, standIns.env, join(root, "a", "data"));
  try {
    await apiChecks(gateway, app, standIns.expect, join(root, "a", "work"), (step, ok, detail) => check(`[설치본] ${step}`, ok, detail));
  } finally {
    await gateway.stop();
  }
}

// ── B. the first-run guide with no engine yet ────────────────────────────────────────────────
// A registry that answers what the installer asks before downloading (the sizes on screen).
const registry = createServer((request, response) => {
  const meta: Record<string, unknown> = {
    "/@openai%2fcodex/latest": { version: "0.0.0-fake", dist: { unpackedSize: 2_600_000 }, optionalDependencies: { "@openai/codex-linux-x64": "npm:@openai/codex@0.0.0-fake-linux-x64" } },
    "/@openai%2fcodex/0.0.0-fake-linux-x64": { version: "0.0.0-fake-linux-x64", dist: { unpackedSize: 1_600_000 } },
    "/@anthropic-ai%2fclaude-code/latest": { version: "2.1.999", dist: { unpackedSize: 2_600_000 }, optionalDependencies: { "@anthropic-ai/claude-code-linux-x64": "2.1.999" } },
    "/@anthropic-ai%2fclaude-code-linux-x64/2.1.999": { version: "2.1.999", dist: { unpackedSize: 1_600_000 } },
  };
  const body = meta[request.url ?? ""];
  response.writeHead(body ? 200 : 404, { "content-type": "application/json" });
  response.end(JSON.stringify(body ?? { error: "not found" }));
});
await new Promise<void>((done) => registry.listen(0, "127.0.0.1", done));
const registryUrl = `http://127.0.0.1:${(registry.address() as { port: number }).port}/`;

const b = join(root, "b");
mkdirSync(join(b, "home"), { recursive: true });
mkdirSync(join(b, "bin"), { recursive: true });
const openerLog = join(b, "opened.txt");
writeFileSync(openerLog, "");
const gateway = await startGateway(
  app,
  {
    // No engine anywhere: an empty PATH and home, and no system-wide folders (this computer has engines).
    HOME: join(b, "home"),
    PATH: join(b, "bin"),
    WORKBENCH_SHELL_PATH: "0",
    WORKBENCH_ENGINE_SEARCH: "user",
    WORKBENCH_NPM_CLI: resolve("scripts/fixtures/fake-npm-cli.mjs"),
    npm_config_registry: registryUrl,
    FAKE_ENGINE_AUTH_DIR: join(b, "auth"),
    WORKBENCH_OPEN_URL: resolve("scripts/fixtures/fake-opener.mjs"),
    FAKE_OPENER_LOG: openerLog,
    FAKE_OPENER_DELAY_MS: "2500",
    // Claude Code's page shows a code instead of coming back: the guide's code box is used.
    FAKE_CLAUDE_NO_BROWSER: "1",
  },
  join(b, "data"),
);
const { call } = client(gateway);
const providerStatus = async (provider: "claude" | "codex") => (await call<Snapshot>("GET", "/api/snapshot")).providers.find((entry) => entry.provider === provider) as ProviderStatus;
const until = async (what: () => Promise<boolean>, timeout = 20_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await what().catch(() => false)) return true;
    await new Promise((done) => setTimeout(done, 150));
  }
  return false;
};

const browser = await chromium.launch();
const logs: string[] = [];
const page: Page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
page.on("console", (message) => message.type() === "error" && logs.push(`[error] ${message.text().slice(0, 200)}`));
page.on("pageerror", (error) => logs.push(`[pageerror] ${error.message.slice(0, 200)}`));
const shot = (name: string) => page.screenshot({ path: join(outDir, name) });
const card = (provider: "claude" | "codex") => page.locator(`.setup-engine[data-provider="${provider}"]`);
const label = { codex: "Codex", claude: "Claude" } as const;

try {
  await page.goto(`${gateway.url}/?token=${gateway.token}`);
  await page.waitForSelector(".onboarding", { timeout: 15_000 });
  await page.locator(".onboarding-actions .button.primary").click();
  await page.waitForSelector('.setup-engine[data-provider="codex"]');
  await until(async () => (await providerStatus("codex")).error !== null && (await providerStatus("claude")).error !== null);
  await page.waitForTimeout(600);
  await shot("01-engines-missing.png");
  const dialog = await page.locator(".onboarding").innerText();
  check("처음 안내에 입력할 명령이 없음 (npm·curl·irm·brew)", !/npm install|curl |irm |\| ?iex|brew install|\| ?bash/i.test(dialog), dialog.replace(/\s+/g, " ").slice(0, 120));
  check("두 엔진 모두 카드와 '설치' 버튼", (await card("codex").getByRole("button", { name: "Codex 설치" }).count()) === 1 && (await card("claude").getByRole("button", { name: "Claude 설치" }).count()) === 1);
  check("'설치되지 않음' 대신 '이 컴퓨터에 없음'", !dialog.includes("설치되지 않음") && dialog.includes("이 컴퓨터에 없음"));

  for (const provider of ["codex", "claude"] as const) {
    await card(provider).getByRole("button", { name: `${label[provider]} 설치` }).click();
    const progressed = await until(async () => (await card(provider).locator(".setup-progress").count()) > 0, 5000);
    await page.waitForTimeout(700);
    await shot(`02-${provider}-installing.png`);
    const progressText = progressed ? await card(provider).locator(".setup-progress-block").innerText() : "";
    check(`[${label[provider]}] '설치'를 누르면 진행 막대와 크기`, progressed && /내려받는 중/.test(progressText), progressText.replace(/\s+/g, " "));
    const installed = await until(async () => {
      const status = await providerStatus(provider);
      return status.installed && status.origin === "managed" && status.loggedIn === false;
    }, 30_000);
    await page.waitForTimeout(400);
    const text = await card(provider).innerText();
    // Where it was found and the path are behind the row's "찾은 위치 보기" (textContent reads it folded).
    const found = (await card(provider).locator("details.settings-path", { hasText: "찾은 위치 보기" }).locator("code").textContent().catch(() => null)) ?? "";
    check(`[${label[provider]}] 설치 뒤 '이 컴퓨터에서 찾았습니다', 찾은 위치 보기에 '이 앱이 설치했습니다'와 경로, 로그인 버튼`, installed && text.includes("이 컴퓨터에서 찾았습니다") && found.includes("이 앱이 설치했습니다") && /[\\/]/.test(found) && (await card(provider).getByRole("button", { name: `${label[provider]} 로그인` }).count()) === 1, `${text.replace(/\s+/g, " ").slice(0, 120)} | ${found.replace(/\s+/g, " ").slice(0, 120)}`);
  }
  await shot("03-engines-installed.png");

  // Codex: "로그인 그만두기" while waiting goes back to "로그인 필요" without saying it failed.
  await card("codex").getByRole("button", { name: "Codex 로그인" }).click();
  await page.waitForSelector('.setup-engine[data-provider="codex"] .setup-login', { timeout: 5000 });
  await card("codex").getByRole("button", { name: "로그인 그만두기" }).click();
  const stopped = await until(async () => (await providerStatus("codex")).login == null && (await card("codex").getByRole("button", { name: "Codex 로그인" }).count()) === 1, 5000);
  await page.waitForTimeout(800);
  const stoppedText = await card("codex").innerText();
  check("[Codex] '로그인 그만두기'는 실패라고 하지 않고 처음으로", stopped && !stoppedText.includes("하지 못했습니다") && (await providerStatus("codex")).loggedIn === false, stoppedText.replace(/\s+/g, " ").slice(0, 100));

  // Codex: the browser opens (the stand-in opener) and comes back after a moment.
  await card("codex").getByRole("button", { name: "Codex 로그인" }).click();
  const waiting = await until(async () => (await card("codex").locator(".setup-login").count()) > 0, 5000);
  await page.waitForTimeout(300);
  await shot("04-codex-login-waiting.png");
  const opened = readFileSync(openerLog, "utf8").trim().split("\n").filter(Boolean);
  check("[Codex] '로그인'은 OS 기본 브라우저로 로그인 주소를 열고 기다림", waiting && opened.filter((url) => url.includes("/auth/callback")).length === 2 && (await card("codex").getByRole("button", { name: "로그인 페이지 열기" }).count()) === 1, opened.join(" "));
  const codexIn = await until(async () => (await providerStatus("codex")).loggedIn === true, 15_000);
  await page.waitForTimeout(400);
  const codexText = await card("codex").innerText();
  check("[Codex] 브라우저에서 돌아오면 저절로 '구독으로 연결됨'", codexIn && codexText.includes("구독으로 연결됨"), codexText.replace(/\s+/g, " ").slice(0, 120));

  // Claude Code: its page shows a code; pasted into the guide, the login finishes.
  await card("claude").getByRole("button", { name: "Claude 로그인" }).click();
  await until(async () => Boolean((await providerStatus("claude")).login?.url), 10_000);
  await page.waitForSelector("#setup-code-claude", { timeout: 5000 });
  await page.waitForTimeout(300);
  await shot("05-claude-login-code.png");
  const manual = (await providerStatus("claude")).login?.url ?? "";
  const pageHtml = manual ? await (await fetch(manual)).text() : "";
  const code = /<code id="code">([^<]+)<\/code>/.exec(pageHtml)?.[1] ?? "";
  check("[Claude Code] 브라우저가 안 열려도 주소와 코드 칸", Boolean(manual) && Boolean(code) && (await card("claude").getByRole("button", { name: "로그인 페이지 열기" }).count()) === 1, manual);
  await page.locator("#setup-code-claude").fill(code);
  await card("claude").getByRole("button", { name: "넣기" }).click();
  const claudeIn = await until(async () => (await providerStatus("claude")).loggedIn === true, 15_000);
  await page.waitForTimeout(400);
  const claudeText = await card("claude").innerText();
  check("[Claude Code] 코드를 넣으면 로그인되고 '구독으로 연결됨'", claudeIn && claudeText.includes("구독으로 연결됨"), claudeText.replace(/\s+/g, " ").slice(0, 120));
  await shot("06-engines-ready.png");

  // The rest of the guide (첫 프로젝트 skipped, 휴대폰에서도 쓰기 → 시작하기): the first run has no
  // document-tools step any more; the document tools are checked in 설정 › 문서 도구 below.
  await page.locator(".onboarding-actions .button.primary", { hasText: "다음" }).click();
  await page.locator(".onboarding-actions").getByRole("button", { name: "건너뛰기" }).click();
  await page.locator(".onboarding-actions .button.primary", { hasText: "시작하기" }).click();
  await page.waitForSelector(".onboarding", { state: "detached", timeout: 5000 });

  // After the guide: 설정 › AI 엔진 says where each engine is (was the ⋯ "연결과 설정" panel).
  await page.locator('.nav-rail button[data-rail="settings"]').click();
  await page.locator('.settings-dialog[open] .settings-nav [data-section="engines"]').click();
  const enginesPane = page.locator('.settings-dialog[open] .settings-pane[data-section="engines"]');
  await enginesPane.locator(".setup-engine").first().waitFor();
  await page.waitForTimeout(300);
  await page.locator(".settings-dialog").screenshot({ path: join(outDir, "08-connections.png") });
  const panel = await enginesPane.innerText();
  const foundAll = (await enginesPane.locator(".setup-engine details.settings-path", { hasText: "찾은 위치 보기" }).locator("code").allTextContents()).join("\n");
  check("설정 › AI 엔진: 두 엔진의 찾은 곳(이 앱이 설치했습니다)·로그인 상태(구독으로 연결됨)", (foundAll.match(/이 앱이 설치했습니다/g)?.length ?? 0) === 2 && (panel.match(/구독으로 연결됨/g)?.length ?? 0) === 2, `${panel.replace(/\s+/g, " ").slice(0, 160)} | ${foundAll.replace(/\s+/g, " ").slice(0, 120)}`);

  // The document tools ship with the app: 설정 › 문서 도구 (was the first run's document-tools step).
  await page.locator('.settings-dialog[open] .settings-nav [data-section="documents"]').click();
  const toolsPane = page.locator('.settings-dialog[open] .settings-pane[data-section="documents"]');
  await toolsPane.locator(".settings-state", { hasText: "앱에 들어 있음" }).first().waitFor({ timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(400);
  await shot("07-document-tools.png");
  const tools = await toolsPane.innerText();
  const shipped = toolsPane.locator(".settings-row", { has: page.locator(".settings-state", { hasText: "앱에 들어 있음" }) });
  const shippedCount = await shipped.count();
  const shippedButtons = await shipped.locator(".settings-row-control button").count();
  // WHICH four (tech review 7): the rows' own names, not only their count.
  const shippedNames = (await shipped.locator(".settings-row-label").allInnerTexts()).map((label) => label.replace("앱에 들어 있음", "").trim()).sort();
  const expectedNames = ["PDF 편집기", "워드, 파워포인트, 엑셀 편집기", "한글 문서 편집기", "한글 보고서 만들기"].sort();
  check("설정 › 문서 도구: 한글 문서 편집기, 워드/파워포인트/엑셀 편집기, PDF 편집기, 한글 보고서 만들기가 '앱에 들어 있음', '설치되지 않음'·설치 버튼 없음", shippedCount === 4 && JSON.stringify(shippedNames) === JSON.stringify(expectedNames) && shippedButtons === 0 && !tools.includes("설치되지 않음") && !tools.includes("이음오피스 받기"), `${shippedNames.join(" | ")} :: ${tools.replace(/\s+/g, " ").slice(0, 200)}`);
} finally {
  await browser.close();
  await gateway.stop();
  registry.close();
}

const passed = results.filter((entry) => entry.ok).length;
const clean = logs.length === 0;
console.log(`\n${passed}/${results.length} passed · console: ${clean ? "clean" : `${logs.length} errors`}`);
for (const line of logs) console.log(line);
writeFileSync(join(outDir, "setup-check.json"), JSON.stringify({ results, logs }, null, 2));
process.exit(passed === results.length && clean ? 0 : 1);
