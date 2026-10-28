/// <reference lib="dom" />
// Browser check of "계획 먼저", for Codex and Claude alike, against a real gateway driving stand-in
// engines (no model): with the toggle on, a request comes back as a plan with "계획대로 진행" /
// "더 다듬기" (Claude: its plan mode's ExitPlanMode, Codex: a read-only turn); refining keeps
// planning; going ahead runs with the session's access (the stand-ins report the permission mode
// and sandbox they then run in) and turns the toggle off.
// Usage: node scripts/plan-check.ts [outDir] [codex|claude]

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium } from "playwright-core";
import type { Provider, Session, TranscriptItem, Work } from "@workbench/contracts";

const outDir = process.argv[2] ?? join(tmpdir(), "wb-plan");
const providers: Provider[] = process.argv[3] === "codex" || process.argv[3] === "claude" ? [process.argv[3]] : ["codex", "claude"];
mkdirSync(outDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "workbench-plan-"));
const worksDir = mkdtempSync(join(tmpdir(), "workbench-plan-works-"));
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
  const work = await api<Work>("POST", "/api/works", { title: `${label} 계획 먼저`, cwd: join(worksDir, provider) });
  const engine = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider, purpose: "계획", access: "auto" });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on("console", (message) => message.type() === "error" && logs.push(`[${label} error] ${message.text().slice(0, 200)}`));
  page.on("pageerror", (error) => logs.push(`[${label} pageerror] ${error.message.slice(0, 200)}`));
  const shot = (name: string) => page.screenshot({ path: join(outDir, `${provider}-${name}`) });
  const pass = (step: string, ok: boolean, detail = "") => check(`[${label}] ${step}`, ok, detail);
  const answers = async () => (await items(engine.id)).filter((item) => item.kind === "assistant").map((item) => (item.kind === "assistant" ? item.text : "")).join("\n");
  const waitingPlan = () => page.waitForSelector(".plan-approval", { timeout: 10_000 });
  const input = page.locator(".composer-input");
  try {
    await page.addInitScript((id) => localStorage.setItem("workbench.lastWork", id), work.id);
    await page.goto(`${ready.url}/?token=${ready.token}`);
    await page.waitForSelector(".composer-input");

    // ── the toggle, then a request that only plans ───────────────────────────────────────────
    await page.locator(".plan-toggle").click();
    const on = await page.locator(".plan-toggle").getAttribute("aria-pressed");
    const placeholder = await input.getAttribute("placeholder");
    await input.fill("로그인 화면 고쳐 줘");
    await input.press("Enter");
    await waitingPlan();
    await page.waitForTimeout(300);
    await shot("01-plan.png");
    const card = await page.locator(".plan-approval").innerText();
    const tag = await page.locator(".turn-request .plan-tag").count();
    const planShown = provider === "claude" ? card.includes("지금 상태 살펴보기") : (await answers()).includes("## 계획") && card.includes("위 계획을 확인해 주세요");
    pass("'계획 먼저'로 보낸 요청이 계획과 '계획대로 진행'·'더 다듬기'로 돌아옴", on === "true" && Boolean(placeholder?.startsWith("계획부터")) && tag === 1 && planShown, card.split("\n")[0]);

    // ── refining keeps planning ──────────────────────────────────────────────────────────────
    await page.locator(".plan-approval .button:not(.primary)").click();
    await page.waitForSelector(".plan-done", { timeout: 10_000 });
    await until(async () => (await session(engine.id)).status === "idle", 10_000);
    const stillOn = await page.locator(".plan-toggle").getAttribute("aria-pressed");
    const refined = await page.locator(".plan-done").first().innerText();
    pass("'더 다듬기'는 계획을 이어 가고 '계획 먼저'를 그대로 둠", stillOn === "true" && refined.includes("더 다듬기"), refined);
    await input.fill("2단계를 더 자세히");
    await input.press("Enter");
    await until(async () => (await items(engine.id)).filter((item) => item.kind === "approval" && item.plan && item.decision === null).length === 1, 10_000);
    await page.waitForTimeout(300);

    // ── going ahead runs with the session's access and turns the toggle off ───────────────────
    await page.locator(".plan-approval .button.primary").click();
    const went = await until(async () => (await answers()).includes("계획대로 진행합니다") && (await session(engine.id)).status === "idle", 15_000);
    await page.waitForTimeout(300);
    await shot("02-going.png");
    const after = (await answers()).split("\n").find((line) => line.includes("계획대로 진행합니다")) ?? "";
    const off = await page.locator(".plan-toggle").getAttribute("aria-pressed");
    const expected = provider === "claude" ? "권한: acceptEdits" : "샌드박스: workspaceWrite";
    pass("'계획대로 진행'은 세션 권한으로 실행하고 '계획 먼저'를 끔", went && after.includes(expected) && off === "false", after);
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
