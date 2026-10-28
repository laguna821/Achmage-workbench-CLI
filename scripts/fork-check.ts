/// <reference lib="dom" />
// Browser check of "이 요청 전으로", for Codex and Claude alike, against a real gateway driving
// stand-in engines (no model): after three requests, the second one's "이 요청 전으로" opens a new
// session with the first request and its answer only, the second request back in its input;
// sending it, the engine answers from a conversation that holds one earlier request (Codex
// through thread/fork, Claude Code through its session file — kept in a temporary config folder,
// never the user's ~/.claude); the original conversation keeps all three.
// Usage: node scripts/fork-check.ts [outDir] [codex|claude]

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium } from "playwright-core";
import type { Provider, Session, TranscriptItem, Work } from "@workbench/contracts";

const outDir = process.argv[2] ?? join(tmpdir(), "wb-fork");
const providers: Provider[] = process.argv[3] === "codex" || process.argv[3] === "claude" ? [process.argv[3]] : ["codex", "claude"];
mkdirSync(outDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "workbench-fork-"));
const worksDir = mkdtempSync(join(tmpdir(), "workbench-fork-works-"));
const claudeConfig = mkdtempSync(join(tmpdir(), "workbench-fork-claude-"));
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
    // The stand-in keeps its session files here (as Claude Code does), and the SDK reads them here.
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
const sessions = async () => (await api<{ sessions: Session[] }>("GET", "/api/snapshot")).sessions;
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
  const work = await api<Work>("POST", "/api/works", { title: `${label} 갈래`, cwd: join(worksDir, provider) });
  const engine = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider, purpose: "원래 대화", access: "auto" });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on("console", (message) => message.type() === "error" && logs.push(`[${label} error] ${message.text().slice(0, 200)}`));
  page.on("pageerror", (error) => logs.push(`[${label} pageerror] ${error.message.slice(0, 200)}`));
  const shot = (name: string) => page.screenshot({ path: join(outDir, `${provider}-${name}`) });
  const pass = (step: string, ok: boolean, detail = "") => check(`[${label}] ${step}`, ok, detail);
  const idle = (id: string) => until(async () => (await sessions()).find((entry) => entry.id === id)?.status === "idle", 20_000);
  const input = page.locator(".composer-input");
  try {
    await page.addInitScript((id) => localStorage.setItem("workbench.lastWork", id), work.id);
    await page.goto(`${ready.url}/?token=${ready.token}`);
    await page.waitForSelector(".composer-input");
    for (const text of ["첫째 질문", "둘째 질문", "셋째 질문"]) {
      await input.fill(text);
      await input.press("Enter");
      await until(async () => (await items(engine.id)).some((item) => item.kind === "user" && item.text === text), 5000);
      await idle(engine.id);
    }

    // ── the second request's "이 요청 전으로" ────────────────────────────────────────────────
    const second = page.locator(".turn-request", { hasText: "둘째 질문" });
    await second.hover();
    await second.locator(".fork-button").click();
    const opened = await until(async () => (await sessions()).some((entry) => entry.workId === work.id && entry.id !== engine.id), 10_000);
    const forked = (await sessions()).find((entry) => entry.workId === work.id && entry.id !== engine.id)!;
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>(".composer-input")?.value === "둘째 질문", undefined, { timeout: 10_000 });
    const shown = await page.locator(".transcript-inner").innerText();
    await shot("01-forked.png");
    pass(
      "새 갈래에 첫 요청과 답만 있고, 고른 요청이 입력창에 돌아옴",
      opened && Boolean(forked?.nativeSessionId) && shown.includes("첫째 질문") && !shown.includes("셋째 질문") && shown.includes("갈라졌습니다"),
      `${forked?.purpose ?? ""} · ${forked?.nativeSessionId ?? "엔진 대화 없음"}`,
    );

    // ── sent again, the engine answers from the shorter conversation ─────────────────────────
    await input.fill("둘째 질문을 고쳐서 다시");
    await input.press("Enter");
    const answered = await until(async () => (await items(forked.id)).some((item) => item.kind === "assistant" && /갈래 스레드: 이전 턴 1개|이어 받은 기록: 요청 1개/.test(item.text)), 15_000);
    await idle(forked.id);
    const said = (await items(forked.id)).filter((item) => item.kind === "assistant").map((item) => (item.kind === "assistant" ? item.text : "")).join(" ");
    await shot("02-answered.png");
    pass("다시 보낸 요청에 엔진이 앞 요청 하나만 있는 대화에서 답함", answered, said.split("\n").find((line) => /갈래|이어 받은/.test(line)) ?? "");

    // ── the original keeps all three ─────────────────────────────────────────────────────────
    const original = (await items(engine.id)).filter((item) => item.kind === "user").map((item) => (item.kind === "user" ? item.text : ""));
    pass("원래 대화는 그대로(요청 3개)", original.join("|") === "첫째 질문|둘째 질문|셋째 질문", original.join(" | "));
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
