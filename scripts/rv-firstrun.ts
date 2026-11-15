/// <reference lib="dom" />
// Copied from the design reviewer's scratch tree (ROOT/wt/relrv, uncommitted there) for fix round 1; two steps follow
// the fixed app: step 2's way on is the LAST footer key (quiet when no engine is ready, I2), and a new document
// is made from the tab bar's + (the create menu opens a conversation now, I5).
// Reviewer's own frames of the first hour (not for commit): a FRESH gateway per scenario (no seed,
// prefs untouched so the first run shows as on a new install), stand-in engines only.
// atlas-look: the first run is one centred panel with three steps (화면, AI 엔진, 휴대폰 메신저); the first project is
// no longer one of them (the "ready" scenario makes it through the gateway after the first run). --palette=atlas
// runs it in the 색 조합 Atlas (the default); --palette=workbench in Workbench.
// Usage: node scripts/rv-firstrun.ts <outDir> <scenario: none|oneout|ready> [--theme=light|dark] [--palette=workbench] [--width=1440 --height=900] [--phone]
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Page } from "playwright-core";

const args = process.argv.slice(2);
const out = resolve(args[0]!); const scenario = args[1]!;
const opt = (n: string) => args.find(a => a.startsWith(`--${n}=`))?.split("=")[1];
const theme = opt("theme") ?? "light";
const phone = args.includes("--phone");
const viewport = { width: Number(opt("width") ?? (phone ? 390 : 1440)), height: Number(opt("height") ?? (phone ? 844 : 900)) };
const palette = opt("palette") === "workbench" ? "workbench" : "atlas";
const tag = `${palette}-${theme}-${viewport.width}`;
mkdirSync(out, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "rv-data-")), auth = mkdtempSync(join(tmpdir(), "rv-auth-")), claudeCfg = mkdtempSync(join(tmpdir(), "rv-claude-"));
writeFileSync(join(claudeCfg, "settings.json"), JSON.stringify({ permissions: { defaultMode: "default" } }));
if (scenario === "oneout") writeFileSync(join(auth, "codex"), "signed in");
if (scenario === "ready") { writeFileSync(join(auth, "codex"), "signed in"); writeFileSync(join(auth, "claude"), "signed in"); }
const engines = scenario === "none"
  ? { WORKBENCH_CODEX_BIN: "/nonexistent/codex", WORKBENCH_CLAUDE_BIN: "/nonexistent/claude" }
  : { WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"), WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"), FAKE_ENGINE_AUTH_DIR: auth, FAKE_CLAUDE_NO_BROWSER: "1" };
const child = spawn(process.execPath, ["apps/host/dist/host.mjs"], {
  env: { ...process.env, ...engines, WORKBENCH_DATA_DIR: dataDir, WORKBENCH_WEB_DIR: "apps/web/dist", WORKBENCH_HOST_LABEL: "연구실 PC", CLAUDE_CONFIG_DIR: claudeCfg },
  stdio: ["ignore", "pipe", "inherit"],
});
const ready = await new Promise<{ url: string; token: string }>((done, reject) => {
  child.once("exit", c => reject(new Error(`host exited ${c}`)));
  createInterface({ input: child.stdout! }).on("line", l => { if (l.startsWith("WORKBENCH_READY ")) done(JSON.parse(l.slice(16))); });
});
const api = async (method: string, path: string, body?: unknown) => (await fetch(`${ready.url}${path}`, { method, headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })).json();
const prefs = (await api("GET", "/api/snapshot")).prefs ?? {};
await api("PUT", "/api/prefs", { prefs: { ...prefs, theme, ...(palette === "workbench" ? { palette } : {}) } });

const browser = await chromium.launch();
const page: Page = await browser.newPage({ viewport, ...(phone ? { hasTouch: true, isMobile: true } : {}) });
const logs: string[] = [];
page.on("console", m => { if (m.type() === "error") logs.push(m.text().slice(0, 200)); });
let n = 0;
const shot = async (name: string, settle = 600) => {
  await page.waitForTimeout(settle);
  const file = `${String(++n).padStart(2, "0")}-${scenario}-${tag}-${name}`;
  await page.screenshot({ path: join(out, `${file}.png`) });
  const text = await page.evaluate(() => document.body.innerText);
  const focus = await page.evaluate(() => { const a = document.activeElement as HTMLElement | null; return a ? `${a.tagName.toLowerCase()}${a.id ? "#" + a.id : ""}.${a.className} "${(a.textContent ?? "").trim().slice(0, 40)}"` : "none"; });
  writeFileSync(join(out, `${file}.txt`), `focus: ${focus}\n\n${text}`);
  console.log("SHOT", file, "focus:", focus);
};
const click = async (text: string, scope = "button") => { const l = page.locator(scope, { hasText: text }).filter({ visible: true }).first(); await l.click({ timeout: 8000 }); };
const tryStep = async (label: string, fn: () => Promise<void>) => { try { await fn(); } catch (e) { console.log("FAIL", label, String(e).slice(0, 200)); await shot(`FAIL-${label}`, 100).catch(() => {}); } };

await page.goto(`${ready.url}/?token=${ready.token}`);
await page.waitForSelector(".onboarding-first", { timeout: 25_000 }).catch(() => console.log("FAIL no onboarding at launch"));
await page.waitForTimeout(1500); // engine probes settle
await shot("onb1-launch");
if (scenario === "ready" && !phone) {
  // The keyboard: what has focus at launch, Tab order, then Esc.
  for (let i = 0; i < 4; i++) { await page.keyboard.press("Tab"); await shot(`onb1-tab${i + 1}`, 150); }
}
await tryStep("onb2", async () => { await click("다음", ".onboarding-actions button"); await shot("onb2-engines", 1500); });
if (scenario === "oneout" && !phone) {
  await tryStep("login", async () => { await click("Claude 로그인"); await shot("onb2-login-waiting", 1500); });
}
await tryStep("onb3", async () => {
  await page.locator(".onboarding-actions button").last().click();
  await page.waitForFunction(() => document.querySelector(".onboarding-steps li.active, .onboarding-count")?.textContent?.includes("휴대폰"), null, { timeout: 8000 });
  await shot("onb3-phone");
});
if (scenario === "oneout") {
  // 텔레그램 hands over to 설정 › 메신저; closing it comes back to the same step.
  await tryStep("onb3-messenger", async () => { await page.locator("[data-messenger=telegram] button").click(); await shot("onb3-messenger-opened", 1000); await page.keyboard.press("Escape"); await shot("onb3-after-esc", 800); });
}
await tryStep("finish", async () => { await click("시작하기", ".onboarding-actions button"); await page.waitForSelector(".onboarding-first", { state: "detached", timeout: 8000 }); await shot("after-first-run", 900); });
if (scenario === "ready") await api("POST", "/api/works", { title: "3주차 강의", folderId: null, cwd: null });
if (scenario === "none") {
  await tryStep("home", async () => { await page.locator('.nav-rail [data-rail="now"], .nav-rail button', { hasText: "지금" }).first().click(); await shot("now-empty", 900); });
  await tryStep("level1", async () => { await page.locator('.nav-rail button', { hasText: "프로젝트" }).first().click(); await shot("projects-level1", 800); });
}
if (scenario === "ready") {
  // Esc on the first run, coming back through 설정 › 일반 › 처음 안내.
  await tryStep("reopen", async () => {
    await page.keyboard.press("Control+Comma"); await page.waitForSelector(".settings-dialog[open]", { timeout: 5000 });
    await shot("settings-open-keyboard", 500);
    for (let i = 0; i < 3; i++) { await page.keyboard.press("Tab"); await shot(`settings-tab${i + 1}`, 150); }
    await page.locator('.settings-nav [data-section="general"]').click();
    await click("다시 보기", ".settings-row-control button");
    await page.waitForSelector(".onboarding-first", { timeout: 5000 });
    await shot("onb-again", 800);
    await page.keyboard.press("Escape"); await page.waitForTimeout(500);
    await shot("onb-again-after-esc", 300);
  });
  // The first conversation from the project.
  await tryStep("conversation", async () => {
    await page.locator('.nav-rail button', { hasText: "프로젝트" }).first().click(); await page.waitForTimeout(400);
    await shot("project-list", 400);
    await page.locator(".sidebar [data-list-row]", { hasText: "3주차 강의" }).first().click().catch(() => {});
    await shot("project-opened", 900);
    const create = page.locator("button", { hasText: "새로 만들기" }).filter({ visible: true }).first();
    await create.click(); await shot("create-menu", 400);
    await page.locator("[role=menuitem], .context-menu-item", { hasText: "새 대화" }).first().click();
    await shot("conversation-new", 900);
    const box = page.locator(".composer-input, .hig-composer textarea, textarea").filter({ visible: true }).first();
    await box.fill("이번 주 강의 개요를 다섯 줄로 정리해 줘"); await page.keyboard.press("Enter");
    await page.waitForTimeout(4000); await shot("conversation-answer", 600);
  });
  await tryStep("markdown", async () => {
    await page.locator(".group-tab-new").filter({ visible: true }).first().click(); await page.waitForTimeout(300);
    await page.locator("[role=menuitem], .context-menu-item", { hasText: /^새 문서$/ }).first().click(); await page.waitForTimeout(300);
    await shot("newdoc-menu", 300);
    await page.locator("[role=menuitem], .context-menu-item", { hasText: "Markdown" }).first().click();
    await shot("newdoc-dialog", 500);
    const name = page.locator("dialog[open] input").first(); if (await name.count()) { await name.fill("강의 개요"); await page.keyboard.press("Enter"); }
    await page.waitForTimeout(3500); await shot("markdown-doc", 800);
  });
}
console.log("CONSOLE", JSON.stringify(logs.slice(0, 15)));
await browser.close(); child.kill();
