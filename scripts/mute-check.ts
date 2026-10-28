/// <reference lib="dom" />
// Browser check of "알림 끄기" on a session's right-click menu, for a Codex and a Claude session:
// the menu turns notifications off for that session only (kept by the gateway) and the same entry
// then reads "알림 켜기". The OS notification itself and the tray's "확인 필요 N" exist only in the
// desktop window and are not checked here (Chromium).
// Usage: node scripts/mute-check.ts [outDir]

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium } from "playwright-core";
import type { Provider, Session, Work } from "@workbench/contracts";

const outDir = process.argv[2] ?? join(tmpdir(), "wb-mute");
mkdirSync(outDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "workbench-mute-"));
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
const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${ready.url}${path}`, { method, headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return (await response.json()) as T;
};
const sessionOf = async (id: string) => (await api<{ sessions: Session[] }>("GET", "/api/snapshot")).sessions.find((entry) => entry.id === id)!;
await api("PUT", "/api/prefs", { prefs: { onboarding: "done", startScreen: "last" } });

const work = await api<Work>("POST", "/api/works", { title: "알림 확인" });
const made: Record<Provider, Session> = {
  codex: await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "codex", purpose: "Codex 세션" }),
  claude: await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "claude", purpose: "Claude 세션" }),
};
const browser = await chromium.launch();
const logs: string[] = [];
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
page.on("console", (message) => message.type() === "error" && logs.push(`[error] ${message.text().slice(0, 200)}`));
page.on("pageerror", (error) => logs.push(`[pageerror] ${error.message.slice(0, 200)}`));
try {
  await page.addInitScript((id) => localStorage.setItem("workbench.lastWork", id), work.id);
  await page.goto(`${ready.url}/?token=${ready.token}`);
  await page.waitForSelector(".sidebar .side-tree");
  for (const provider of ["codex", "claude"] as const) {
    const label = provider === "codex" ? "Codex" : "Claude";
    const session = made[provider];
    const row = page.locator(`.sidebar [data-row-id="${session.id}"]`);
    await row.click({ button: "right" });
    await page.locator(".context-menu-item", { hasText: "알림 끄기" }).click();
    const off = await (async () => {
      for (let tries = 0; tries < 50; tries += 1) {
        if ((await sessionOf(session.id)).muted) return true;
        await page.waitForTimeout(100);
      }
      return false;
    })();
    await row.click({ button: "right" });
    const again = await page.locator(".context-menu-item", { hasText: "알림 켜기" }).count();
    await page.screenshot({ path: join(outDir, `${provider}-muted.png`) });
    await page.keyboard.press("Escape");
    const other = made[provider === "codex" ? "claude" : "codex"];
    check(`[${label}] '알림 끄기'는 그 세션만 끄고, 메뉴는 '알림 켜기'로 바뀜`, off && again === 1 && (provider === "claude" || !(await sessionOf(other.id)).muted));
  }
} catch (error) {
  check("실행", false, error instanceof Error ? error.message.split("\n")[0]! : String(error));
  await page.screenshot({ path: join(outDir, "99-failure.png") }).catch(() => undefined);
} finally {
  writeFileSync(join(outDir, "console.log"), logs.join("\n"));
  await browser.close();
  child.kill();
  await new Promise((done) => (child.exitCode === null && child.signalCode === null ? child.once("exit", done) : done(null)));
  rmSync(dataDir, { recursive: true, force: true });
  const failed = results.filter((result) => !result.ok).length;
  console.log(`${results.length - failed}/${results.length} passed · console: ${logs.length ? logs.slice(0, 6).join(" | ") : "clean"}`);
  process.exitCode = failed ? 1 : 0;
}
