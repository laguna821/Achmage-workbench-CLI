/// <reference lib="dom" />
// The 문서 AI settings after the IeumOffice v0.13.0 pin (unit ieum-pin; the owner's decision): only Claude Code and Codex
// in view, everything else in one fold "고급 · 다른 AI 연결", closed by default. Real built UI and gateway, Chromium;
// frames of the fold closed and open, light and dark, 1440×900 (fixture data only: a fresh data folder).
// Usage: node scripts/office-settings-fold-shots.ts <out folder>   (through ux/run-isolated.sh)
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Browser } from "playwright-core";

const out = resolve(process.argv[2] ?? "settings-fold"); mkdirSync(out, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), "wb-settings-fold-"));
const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`); };
let child: ChildProcess | null = null, browser: Browser | null = null;
try {
  child = spawn(process.execPath, ["apps/host/dist/host.mjs"], { env: { ...process.env,
    WORKBENCH_DATA_DIR: dir, WORKBENCH_HOST_ID: "fixture", WORKBENCH_IEUM_BOOTSTRAP: "0", WORKBENCH_WEB_DIR: resolve("apps/web/dist"),
    WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"), WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"), WORKBENCH_VAULT_SUGGEST: "",
  }, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr!.on("data", data => writeFileSync(join(out, "host.log"), data, { flag: "a" }));
  const ready = await new Promise<{ url: string; token: string }>((done, fail) => {
    const timer = setTimeout(() => fail(Error("gateway start timeout")), 60_000);
    child!.once("exit", code => { clearTimeout(timer); fail(Error(`gateway exited: ${code}`)); });
    createInterface({ input: child!.stdout! }).on("line", line => { if (line.startsWith("WORKBENCH_READY ")) { clearTimeout(timer); done(JSON.parse(line.slice(16))); } });
  });
  const api = async (path: string, method = "GET", body?: unknown) => {
    const r = await fetch(`${ready.url}${path}`, { method, headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await r.json(); if (!r.ok) throw Error(`${path}: ${r.status} ${result.message}`); return result;
  };
  browser = await chromium.launch();
  for (const theme of ["light", "dark"] as const) {
    await api("/api/prefs", "PUT", { prefs: { onboarding: "done", sidebar: false, theme } });
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme })).newPage();
    await page.goto(`${ready.url}/?token=${ready.token}`);
    await page.waitForLoadState("networkidle");
    await page.keyboard.press("Control+,");
    const key = page.getByRole("button", { name: /문서 AI 설정/ });
    for (const section of ["문서 도구"]) {
      if (await key.first().isVisible().catch(() => false)) break;
      await page.locator(".settings-nav").getByText(section, { exact: true }).first().click({ timeout: 5000 }).catch(() => {});
    }
    await key.first().click({ timeout: 15_000 });
    const frame = page.frameLocator('iframe[title="문서 AI 설정 화면"]');
    const toggle = frame.locator(".wb-other-ai-toggle");
    await toggle.waitFor({ timeout: 30_000 });
    await page.waitForTimeout(1500);
    check(`${theme}: the fold is closed at first`, (await toggle.getAttribute("aria-expanded")) === "false");
    const cards = await frame.locator(".set-sub-cards").first().locator("[data-provider]").evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-provider")));
    check(`${theme}: only Claude Code and Codex in view`, JSON.stringify([...new Set(cards)]) === JSON.stringify(["claude-code", "codex"]), JSON.stringify(cards));
    await page.screenshot({ path: join(out, `fold-closed-1440x900-${theme}.png`) });
    await toggle.click();
    await page.waitForTimeout(800);
    const inside = await frame.locator("body").evaluate((body) => ({ chatgpt: !!body.querySelector('[data-provider="chatgpt"]'), free: !!body.querySelector("#set-free-ai") }));
    check(`${theme}: the ChatGPT card and free AI are inside the fold`, inside.chatgpt && inside.free, JSON.stringify(inside));
    await toggle.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(out, `fold-open-1440x900-${theme}.png`) });
    await page.context().close();
  }
} catch (error) {
  check("shots ran to the end", false, error instanceof Error ? error.stack : String(error));
} finally {
  await browser?.close().catch(() => {});
  child?.kill();
}
console.log(`${results.filter(r => r.ok).length}/${results.length} passed`);
process.exit(results.every(r => r.ok) ? 0 : 1);
