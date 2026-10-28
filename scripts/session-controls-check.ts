/// <reference lib="dom" />
// Browser check of the controls under the input, for Codex and Claude alike, against a real
// gateway driving stand-in engines (no model): the access a session starts with follows the
// engine's own settings; an approval card's "앞으로 묻지 않기" answers it and switches the session
// to full access, after which the engine no longer asks; "묻기" brings the question back; the
// context ring fills after replies and "지금 압축" compacts; the plan limits of both engines show
// at the foot of the sidebar. Usage: node scripts/session-controls-check.ts [outDir] [codex|claude]

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium } from "playwright-core";
import type { Provider, Session, TranscriptItem, UiPrefs, Work } from "@workbench/contracts";

const outDir = process.argv[2] ?? join(tmpdir(), "wb-session-controls");
const providers: Provider[] = process.argv[3] === "codex" || process.argv[3] === "claude" ? [process.argv[3]] : ["codex", "claude"];
mkdirSync(outDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "workbench-controls-"));
const worksDir = mkdtempSync(join(tmpdir(), "workbench-controls-works-"));
// Claude Code's own settings for the stand-in: ask before acting (Codex's say on-request + workspace-write).
const claudeConfig = mkdtempSync(join(tmpdir(), "workbench-controls-claude-"));
writeFileSync(join(claudeConfig, "settings.json"), JSON.stringify({ permissions: { defaultMode: "default" } }));
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
    CLAUDE_CONFIG_DIR: claudeConfig,
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
const snapshot = () => api<{ sessions: Session[]; prefs: UiPrefs }>("GET", "/api/snapshot");
const session = async (id: string) => (await snapshot()).sessions.find((entry) => entry.id === id)!;
const items = async (id: string) => (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${id}/items`)).items;
const until = async (what: () => Promise<boolean>, timeout = 15_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await what()) return true;
    await new Promise((done) => setTimeout(done, 100));
  }
  return false;
};
// Straight into the work (the app opens on home by default).
await api("PUT", "/api/prefs", { prefs: { onboarding: "done", startScreen: "last" } });

const browser = await chromium.launch();
const logs: string[] = [];

async function flow(provider: Provider) {
  const label = provider === "codex" ? "Codex" : "Claude";
  const work = await api<Work>("POST", "/api/works", { title: `${label} 권한`, cwd: worksDir });
  const engine = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider, purpose: "권한" });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on("console", (message) => message.type() === "error" && logs.push(`[${label} error] ${message.text().slice(0, 200)}`));
  page.on("pageerror", (error) => logs.push(`[${label} pageerror] ${error.message.slice(0, 200)}`));
  const shot = (name: string) => page.screenshot({ path: join(outDir, `${provider}-${name}`) });
  const pass = (step: string, ok: boolean, detail = "") => check(`[${label}] ${step}`, ok, detail);
  const type = async (text: string) => {
    const input = page.locator(".composer-input");
    await input.fill(text);
    await input.press("Enter");
  };
  const idle = () => until(async () => (await session(engine.id)).status === "idle", 15_000);
  const approvals = async () => (await items(engine.id)).filter((item): item is Extract<TranscriptItem, { kind: "approval" }> => item.kind === "approval");
  const ring = async () => Number.parseInt((await page.locator(".context-gauge").innerText()).replace(/\D+/g, "") || "0", 10);
  try {
    await page.addInitScript((id) => localStorage.setItem("workbench.lastWork", id), work.id);
    await page.goto(`${ready.url}/?token=${ready.token}`);
    await page.waitForSelector(".composer-input");
    await page.waitForTimeout(400);

    // ── the starting access is the engine's own setting ───────────────────────────────────────
    const start = (await page.locator(".access-select").innerText()).trim();
    pass("처음 권한은 엔진 자체 설정을 따름", start === (provider === "codex" ? "자동" : "묻기"), start);

    // ── an approval, then "앞으로 묻지 않기" ───────────────────────────────────────────────────
    await type("명령 실행해 줘");
    await page.waitForSelector(".approval-card", { timeout: 10_000 });
    await shot("01-approval.png");
    await page.locator(".approval-trust").click();
    const accepted = await until(async () => (await approvals()).some((item) => item.decision === "accept"), 8000);
    await idle();
    const trusted = await session(engine.id);
    // The UI saves its prefs a moment later (batched).
    const rememberedOf = async () => ((await snapshot()).prefs.access as Record<string, string> | undefined)?.[provider];
    await until(async () => (await rememberedOf()) === "full", 3000);
    const remembered = await rememberedOf();
    const picker = (await page.locator(".access-select").innerText()).trim();
    pass("'앞으로 묻지 않기'는 기다리던 승인을 허용하고 세션을 전체 접근으로", accepted && trusted.access === "full" && picker === "전체 접근" && remembered === "full", `access=${trusted.access} picker=${picker} prefs=${remembered}`);

    const before = (await approvals()).length;
    await type("명령 한 번 더");
    await until(async () => (await session(engine.id)).status !== "idle", 3000);
    await idle();
    const commands = (await items(engine.id)).filter((item) => item.kind === "tool" && item.tool === "command" && item.status === "completed").length;
    pass("전체 접근에서는 묻지 않고 명령을 실행", (await approvals()).length === before && commands === 2, `approvals ${before}→${(await approvals()).length}, commands=${commands}`);

    // ── the context ring and "지금 압축" ──────────────────────────────────────────────────────
    await page.waitForSelector(".context-gauge", { timeout: 5000 });
    const full = await ring();
    await page.locator(".context-gauge").click();
    await page.waitForSelector(".context-menu-card");
    await shot("02-context.png");
    const detail = await page.locator(".context-menu-card").innerText();
    await page.locator(".context-menu-card button", { hasText: "지금 압축" }).click();
    const noticed = await until(async () => (await items(engine.id)).some((item) => item.kind === "notice" && item.text.includes("압축")), 8000);
    await idle();
    await page.waitForTimeout(300);
    const after = await ring();
    const ends = (await items(engine.id)).filter((item) => item.kind === "turnEnd").length;
    pass("컨텍스트 고리가 차고, '지금 압축' 뒤에 줄어듦(답이 아니라 안내로 남음)", noticed && full > 0 && after < full && ends === 2, `${full}% → ${after}% · ${detail.replace(/\s+/g, " ").slice(0, 80)}`);

    // ── "묻기" brings the question back ────────────────────────────────────────────────────────
    await page.locator(".access-select").click();
    await page.waitForSelector(".access-menu");
    await shot("03-access-menu.png");
    const options = await page.locator(".access-menu .access-option").count();
    await page.locator(".access-menu .access-option", { hasText: "묻기" }).click();
    await until(async () => (await session(engine.id)).access === "ask", 3000);
    await type("명령 세 번째");
    const asked = await page.waitForSelector(".approval-card", { timeout: 10_000 }).then(() => true).catch(() => false);
    await page.locator(".approval-card .button.primary").click();
    await idle();
    pass("'묻기'로 바꾸면 다시 확인을 받음", options === 3 && asked && (await session(engine.id)).access === "ask");

    // ── Codex: an MCP tool approval is a card like any other (it used to fail) ───────────────
    if (provider === "codex") {
      await type("MCP 도구 써 줘");
      const card = await page.waitForSelector(".approval-card", { timeout: 10_000 }).then((element) => element.innerText()).catch(() => "");
      await page.locator(".approval-card .button.primary").click().catch(() => undefined);
      await idle();
      const tool = (await items(engine.id)).find((item) => item.kind === "tool" && item.tool === "mcp");
      pass("MCP 도구 승인이 카드로 와서 허용하면 이어서 끝남", card.includes("achmage MCP 도구를 쓸까요?") && tool?.kind === "tool" && tool.status === "completed", card.replace(/\s+/g, " ").slice(0, 60));
    }

    // ── plan limits of both engines at the foot of the sidebar ──────────────────────────────
    await page.locator(".usage-card").scrollIntoViewIfNeeded();
    const card = await page.locator(".usage-card").innerText();
    await page.locator(".usage-card").screenshot({ path: join(outDir, `${provider}-04-usage.png`) });
    pass("사이드바 아래 사용 한도에 두 엔진의 5시간·주간 막대", /Claude[\s\S]*5시간[\s\S]*%[\s\S]*Codex[\s\S]*5시간[\s\S]*%/.test(card), card.replace(/\s+/g, " "));
    await shot("05-final.png");
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
  for (const dir of [dataDir, worksDir, claudeConfig]) rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((result) => !result.ok).length;
  console.log(`${results.length - failed}/${results.length} passed · console: ${logs.length ? logs.slice(0, 6).join(" | ") : "clean"}`);
  process.exitCode = failed ? 1 : 0;
}
