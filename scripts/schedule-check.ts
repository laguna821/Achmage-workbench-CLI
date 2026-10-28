/// <reference lib="dom" />
// Browser check of "예약 작업", for Codex and Claude alike, against a real gateway driving stand-in
// engines (no model) with a short schedule tick: the session's right-click menu opens the dialog,
// a schedule added there is listed with when it goes next, can be turned off and removed; and a
// schedule due in a moment sends its request, marked "예약", which the engine answers.
// Usage: node scripts/schedule-check.ts [outDir] [codex|claude]

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium } from "playwright-core";
import type { Provider, Schedule, Session, TranscriptItem, Work } from "@workbench/contracts";

const outDir = process.argv[2] ?? join(tmpdir(), "wb-schedule");
const providers: Provider[] = process.argv[3] === "codex" || process.argv[3] === "claude" ? [process.argv[3]] : ["codex", "claude"];
mkdirSync(outDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "workbench-schedule-"));
const worksDir = mkdtempSync(join(tmpdir(), "workbench-schedule-works-"));
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
    WORKBENCH_SCHEDULE_TICK_MS: "400",
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
const items = async (id: string) => (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${id}/items`)).items;
const schedules = async () => (await api<{ schedules: Schedule[] }>("GET", "/api/schedules")).schedules;
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
  const work = await api<Work>("POST", "/api/works", { title: `${label} 예약`, cwd: join(worksDir, provider) });
  const engine = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider, purpose: "예약 받는 세션", access: "auto" });
  // A second session, so the sidebar lists sessions as rows of their own (one alone shows as the work).
  await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider, purpose: "다른 세션", access: "auto" });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on("console", (message) => message.type() === "error" && logs.push(`[${label} error] ${message.text().slice(0, 200)}`));
  page.on("pageerror", (error) => logs.push(`[${label} pageerror] ${error.message.slice(0, 200)}`));
  const shot = (name: string) => page.screenshot({ path: join(outDir, `${provider}-${name}`) });
  const pass = (step: string, ok: boolean, detail = "") => check(`[${label}] ${step}`, ok, detail);
  try {
    await page.addInitScript((id) => localStorage.setItem("workbench.lastWork", id), work.id);
    await page.goto(`${ready.url}/?token=${ready.token}`);
    await page.waitForSelector(".sidebar .side-tree");

    // ── the dialog from the session's menu: add, listed with its next time ─────────────────────
    await page.locator(`.sidebar [data-row-id="${engine.id}"]`).click({ button: "right" });
    await page.locator(".context-menu-item", { hasText: "예약 작업…" }).click();
    await page.waitForSelector(".schedule-dialog");
    await page.locator(".schedule-dialog textarea").fill("주간 진행 상황을 정리해 줘");
    await page.locator(".schedule-dialog .segmented button", { hasText: "N시간마다" }).click();
    await page.locator(".schedule-dialog .schedule-hours input").fill("2");
    await page.locator(".schedule-dialog .button.primary", { hasText: "예약 추가" }).click();
    await page.waitForSelector(".schedule-dialog .schedule-row");
    const row = await page.locator(".schedule-dialog .schedule-row").first().innerText();
    await shot("01-dialog.png");
    pass("세션 메뉴에서 예약을 추가하면 다음 시각과 함께 목록에 보임", row.includes("2시간마다") && row.includes("주간 진행 상황") && row.includes("다음:"), row.replace(/\s+/g, " "));

    // ── off, then removed ─────────────────────────────────────────────────────────────────────
    await page.locator(".schedule-dialog .schedule-row .text-button", { hasText: "끄기" }).click();
    const off = await until(async () => (await page.locator(".schedule-dialog .schedule-row.off").count()) === 1, 5000);
    await page.locator(".schedule-dialog .schedule-row button[aria-label='예약 지우기']").click();
    const removed = await until(async () => (await page.locator(".schedule-dialog .schedule-row").count()) === 0 && !(await schedules()).some((entry) => entry.sessionId === engine.id), 5000);
    pass("예약을 끄고 지울 수 있음", off && removed);
    await page.keyboard.press("Escape");

    // ── one due in a moment goes, marked "예약", and is answered ───────────────────────────────
    await api("POST", "/api/schedules", { sessionId: engine.id, text: "예약으로 보낸 요청", when: { kind: "once", at: Date.now() + 1500 } });
    const sent = await until(async () => (await items(engine.id)).some((item) => item.kind === "user" && item.text === "예약으로 보낸 요청" && item.scheduled === true), 10_000);
    const answered = await until(async () => (await items(engine.id)).some((item) => item.kind === "assistant"), 10_000);
    await page.locator(`.sidebar [data-row-id="${engine.id}"]`).click();
    await page.waitForSelector(".turn-request .scheduled-tag", { timeout: 10_000 }).catch(() => undefined);
    const tag = await page.locator(".turn-request .scheduled-tag").count();
    const done = (await schedules()).find((entry) => entry.sessionId === engine.id);
    await shot("02-sent.png");
    pass("정한 때가 되면 요청을 보내고(대화에 '예약' 표시) 엔진이 답함, 한 번짜리는 끝남", sent && answered && tag === 1 && done?.enabled === false && done.nextAt === null);
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
