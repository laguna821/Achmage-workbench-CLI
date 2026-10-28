/// <reference lib="dom" />
// Browser check of "/" in the input, for Codex and Claude alike, against a real gateway driving
// stand-in engines (no model): "/" lists the engine's commands and skills (Claude Code's own list
// with its user skill, Codex's skills/list plus compact); typing narrows it and Enter picks; a
// picked skill reaches the engine as a skill (Codex as a skill input, Claude as its slash command);
// "/compact" compacts like "지금 압축".
// Usage: node scripts/commands-check.ts [outDir] [codex|claude]

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium } from "playwright-core";
import type { Provider, Session, TranscriptItem, Work } from "@workbench/contracts";

const outDir = process.argv[2] ?? join(tmpdir(), "wb-commands");
const providers: Provider[] = process.argv[3] === "codex" || process.argv[3] === "claude" ? [process.argv[3]] : ["codex", "claude"];
mkdirSync(outDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "workbench-commands-"));
const worksDir = mkdtempSync(join(tmpdir(), "workbench-commands-works-"));
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
const session = async (id: string) => (await api<{ sessions: Session[] }>("GET", "/api/snapshot")).sessions.find((entry) => entry.id === id)!;
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
  mkdirSync(join(worksDir, provider), { recursive: true });
  const work = await api<Work>("POST", "/api/works", { title: `${label} 명령`, cwd: join(worksDir, provider) });
  const engine = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider, purpose: "명령", access: "auto" });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on("console", (message) => message.type() === "error" && logs.push(`[${label} error] ${message.text().slice(0, 200)}`));
  page.on("pageerror", (error) => logs.push(`[${label} pageerror] ${error.message.slice(0, 200)}`));
  const shot = (name: string) => page.screenshot({ path: join(outDir, `${provider}-${name}`) });
  const pass = (step: string, ok: boolean, detail = "") => check(`[${label}] ${step}`, ok, detail);
  const answers = async () => (await items(engine.id)).filter((item) => item.kind === "assistant").map((item) => (item.kind === "assistant" ? item.text : "")).join("\n");
  const input = page.locator(".composer-input");
  const skill = provider === "claude" ? "정리" : "review-notes";
  try {
    await page.addInitScript((id) => localStorage.setItem("workbench.lastWork", id), work.id);
    await page.goto(`${ready.url}/?token=${ready.token}`);
    await page.waitForSelector(".composer-input");

    // ── "/" lists the engine's commands and skills ───────────────────────────────────────────
    await input.click();
    await page.keyboard.type("/");
    await page.waitForSelector(".slash-list .slash-row", { timeout: 15_000 });
    const names = await page.locator(".slash-list .slash-name").allInnerTexts();
    const kinds = await page.locator(".slash-list .slash-kind").allInnerTexts();
    await shot("01-list.png");
    pass("'/'가 엔진의 명령과 스킬을 보여 줌", names.includes(`/${skill}`) && names.includes("/compact") && kinds.includes("스킬") && kinds.includes("명령"), names.join(" "));

    // ── typing narrows it, Enter picks ───────────────────────────────────────────────────────
    await page.keyboard.type(skill.slice(0, 2));
    await page.waitForTimeout(150);
    const narrowed = await page.locator(".slash-list .slash-name").allInnerTexts();
    await page.keyboard.press("Enter");
    const picked = await input.inputValue();
    pass("글자를 치면 좁혀지고 Enter로 고름", narrowed[0] === `/${skill}` && picked === `/${skill} `, `${narrowed.join(" ")} → "${picked}"`);

    // ── a picked skill reaches the engine as a skill ─────────────────────────────────────────
    await page.keyboard.type("회의록");
    await page.keyboard.press("Enter");
    const ran = await until(async () => (await answers()).includes(provider === "claude" ? "스킬 /정리를 실행했습니다: 회의록" : "스킬 review-notes를 받았습니다 ($review-notes 회의록)") && (await session(engine.id)).status === "idle", 15_000);
    await page.waitForTimeout(300);
    await shot("02-skill.png");
    pass("고른 스킬이 엔진에 스킬로 전해짐", ran, (await answers()).split("\n").find((line) => line.includes("스킬")) ?? "");

    // ── "/compact" compacts like "지금 압축" ─────────────────────────────────────────────────
    await input.fill("/compact");
    await page.waitForSelector(".slash-list", { timeout: 5000 });
    await page.keyboard.press("Escape");
    await input.press("Enter");
    const compacted = await until(async () => (await items(engine.id)).some((item) => item.kind === "notice" && item.text.includes("압축")) && (await session(engine.id)).status === "idle", 15_000);
    const sentAsText = (await items(engine.id)).some((item) => item.kind === "user" && item.text.startsWith("/compact"));
    pass("'/compact'는 '지금 압축'처럼 대화를 압축함", compacted && !sentAsText && (await input.inputValue()) === "");
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
  for (const dir of [dataDir, worksDir]) rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((result) => !result.ok).length;
  console.log(`${results.length - failed}/${results.length} passed · console: ${logs.length ? logs.slice(0, 6).join(" | ") : "clean"}`);
  process.exitCode = failed ? 1 : 0;
}
