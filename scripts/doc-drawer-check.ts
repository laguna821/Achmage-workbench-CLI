/// <reference lib="dom" />
// Browser check of the conversation drawer under a document, for Codex and Claude alike, against a
// real gateway driving stand-in engines (no model): a request sent from the document brings the
// drawer up with what the engine is doing; the reply ends folded to its points ("답 전체" opens it);
// an approval is answered in the drawer without leaving the document; "대화 전체" lays the whole
// conversation over the document and Esc closes it without declining anything.
// Usage: node scripts/doc-drawer-check.ts [outDir] [codex|claude]

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium } from "playwright-core";
import type { Provider, Session, TranscriptItem, Work } from "@workbench/contracts";

const outDir = process.argv[2] ?? join(tmpdir(), "wb-doc-drawer");
const providers: Provider[] = process.argv[3] === "codex" || process.argv[3] === "claude" ? [process.argv[3]] : ["codex", "claude"];
mkdirSync(outDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "workbench-drawer-"));
const worksDir = mkdtempSync(join(tmpdir(), "workbench-drawer-works-"));
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
  const work = await api<Work>("POST", "/api/works", { title: `${label} 문서 서랍`, cwd: join(worksDir, provider) });
  // "묻기", so a command asks for approval with either engine.
  const engine = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider, purpose: "서랍", access: "ask" });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on("console", (message) => message.type() === "error" && logs.push(`[${label} error] ${message.text().slice(0, 200)}`));
  page.on("pageerror", (error) => logs.push(`[${label} pageerror] ${error.message.slice(0, 200)}`));
  const shot = (name: string) => page.screenshot({ path: join(outDir, `${provider}-${name}`) });
  const pass = (step: string, ok: boolean, detail = "") => check(`[${label}] ${step}`, ok, detail);
  const type = async (text: string) => {
    const input = page.locator(".doc-composer .composer-input");
    await input.fill(text);
    await input.press("Enter");
  };
  const idle = () => until(async () => (await session(engine.id)).status === "idle", 20_000);
  try {
    await page.addInitScript((id) => localStorage.setItem("workbench.lastWork", id), work.id);
    await page.goto(`${ready.url}/?token=${ready.token}`);
    await page.waitForSelector(".sidebar .side-tree");
    await page.locator(`.sidebar [data-row-id="${work.id}"]`).hover();
    await page.locator(`.sidebar [data-row-id="${work.id}"] .row-add`).click();
    await page.waitForSelector(".document-view .doc-composer .drawer", { timeout: 10_000 });

    // ── a request from the document: the drawer comes up with progress, then the folded reply ──
    await type("길게 설명해줘");
    await until(async () => (await session(engine.id)).status === "running", 5000);
    const progress = await page.waitForSelector(".drawer-peek", { timeout: 5000 }).then(() => page.locator(".drawer-state").innerText()).catch(() => "");
    await page.waitForTimeout(600);
    await shot("01-progress.png");
    const drawerClass = await page.locator(".drawer").first().getAttribute("class");
    const peeks = await page.locator(".drawer-peek").count();
    pass("문서에서 보낸 요청의 진행이 서랍에 보임", progress.length > 0 && peeks === 1, `${progress} · ${drawerClass} · peeks=${peeks} drawers=${await page.locator(".drawer").count()}`);
    await idle();
    await page.waitForTimeout(400);
    const folded = await page.locator(".drawer-answer").innerText();
    const toggle = await page.locator(".drawer-answer .link").innerText().catch(() => "");
    await shot("02-folded.png");
    await page.locator(".drawer-answer .link").click();
    const whole = await page.locator(".drawer-answer").innerText();
    pass("끝난 답이 서랍에 요점으로 접혀 보이고 '답 전체'로 펼쳐짐", toggle === "답 전체" && folded.includes("단락") && whole.length > folded.length * 2, `${folded.length} → ${whole.length}`);

    // ── an approval answered in the drawer, without leaving the document ───────────────────
    await type("명령 실행해 줘");
    await page.waitForSelector(".drawer-approval", { timeout: 10_000 });
    await shot("03-approval.png");
    await page.locator(".drawer-approval .button.primary").click();
    await idle();
    const approved = (await items(engine.id)).some((item) => item.kind === "approval" && item.decision === "accept");
    pass("승인 요청을 문서 화면 서랍에서 허용", approved && (await page.locator(".document-view").count()) === 1);

    // ── the whole conversation over the document; Esc closes it and declines nothing ─────────
    await type("명령 한 번 더");
    await page.waitForSelector(".drawer-approval", { timeout: 10_000 });
    await page.locator(".drawer-open").click();
    await page.waitForSelector(".drawer-sheet .transcript-inner");
    await page.waitForTimeout(300);
    await shot("04-sheet.png");
    const requests = await page.locator(".drawer-sheet .turn-request").count();
    await page.locator(".drawer-sheet-head").click();
    await page.keyboard.press("Escape");
    await page.waitForSelector(".drawer-sheet", { state: "detached", timeout: 3000 });
    const waiting = (await items(engine.id)).filter((item) => item.kind === "approval" && item.decision === null).length;
    pass("'대화 전체'는 문서 위에 대화를 띄우고 Esc는 닫기만 함(승인을 거절하지 않음)", requests >= 3 && waiting === 1, `requests=${requests} waiting=${waiting}`);
    await page.locator(".drawer-approval .button.primary").click();
    await idle();
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
  for (const dir of [dataDir, worksDir]) rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((result) => !result.ok).length;
  console.log(`${results.length - failed}/${results.length} passed · console: ${logs.length ? logs.slice(0, 6).join(" | ") : "clean"}`);
  process.exitCode = failed ? 1 : 0;
}
