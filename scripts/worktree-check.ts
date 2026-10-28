/// <reference lib="dom" />
// Browser check of "격리 사본", for Codex and Claude alike, against a real gateway driving stand-in
// engines (no model), in a temporary git repository: "새 … 세션 · 격리 사본에서" makes a session that
// works in a git worktree (the engine reports that folder), its header shows the copy's branch,
// "변경 검토" lists what changed in the copy with the diff, "원래 폴더에 적용" changes the original
// checkout's files, and "버리기" removes the copy and archives the session.
// Usage: node scripts/worktree-check.ts [outDir] [codex|claude]

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium } from "playwright-core";
import type { Provider, Session, TranscriptItem, Work } from "@workbench/contracts";

const outDir = process.argv[2] ?? join(tmpdir(), "wb-worktree");
const providers: Provider[] = process.argv[3] === "codex" || process.argv[3] === "claude" ? [process.argv[3]] : ["codex", "claude"];
mkdirSync(outDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "workbench-worktree-"));
const reposDir = mkdtempSync(join(tmpdir(), "workbench-worktree-repos-"));
const results: { step: string; ok: boolean; detail: string }[] = [];
const check = (step: string, ok: boolean, detail = "") => {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`);
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" });

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
  const repo = join(reposDir, provider);
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "강의계획.md"), "# 강의계획\n\n1주차: 소개\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "start");
  const work = await api<Work>("POST", "/api/works", { title: `${label} 격리 사본`, cwd: repo });
  const plain = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider, purpose: "원래 폴더 세션", access: "auto" });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on("console", (message) => message.type() === "error" && logs.push(`[${label} error] ${message.text().slice(0, 200)}`));
  page.on("pageerror", (error) => logs.push(`[${label} pageerror] ${error.message.slice(0, 200)}`));
  const shot = (name: string) => page.screenshot({ path: join(outDir, `${provider}-${name}`) });
  const pass = (step: string, ok: boolean, detail = "") => check(`[${label}] ${step}`, ok, detail);
  try {
    await page.addInitScript((id) => localStorage.setItem("workbench.lastWork", id), work.id);
    await page.goto(`${ready.url}/?token=${ready.token}`);
    await page.waitForSelector(".composer-input");

    // ── a session in a worktree, from the session picker ──────────────────────────────────────
    await page.locator(".composer .select-button", { hasText: label }).first().click();
    await page.locator(".menu-item", { hasText: "격리 사본에서" }).filter({ hasText: label }).click();
    const made = await until(async () => (await sessions()).some((entry) => entry.workId === work.id && entry.worktree), 10_000);
    const isolated = (await sessions()).find((entry) => entry.workId === work.id && entry.worktree)!;
    await page.waitForSelector(".worktree-chip", { timeout: 10_000 });
    const chip = await page.locator(".worktree-chip").innerText();
    await page.locator(".composer-input").fill("작업 폴더 알려줘");
    await page.locator(".composer-input").press("Enter");
    const answered = await until(async () => (await items(isolated.id)).some((item) => item.kind === "assistant" && item.text.includes("작업 폴더:")), 15_000);
    const said = (await items(isolated.id)).find((item) => item.kind === "assistant" && item.text.includes("작업 폴더:"));
    await shot("01-isolated.png");
    pass(
      "'격리 사본에서' 만든 세션은 git worktree에서 일하고(엔진이 그 폴더를 답함) 머리에 가지가 보임",
      made && answered && said?.kind === "assistant" && said.text.includes(isolated.worktree!.cwd) && chip.includes(isolated.worktree!.branch) && plain.id !== isolated.id,
      isolated.worktree?.branch ?? "",
    );

    // ── what changed in the copy, then applied to the original ────────────────────────────────
    writeFileSync(join(isolated.worktree!.path, "강의계획.md"), "# 강의계획\n\n1주차: 소개\n2주차: 실습\n");
    writeFileSync(join(isolated.worktree!.path, "과제.md"), "# 과제\n");
    await page.locator(".worktree-chip .text-button", { hasText: "변경 검토" }).click();
    await page.waitForSelector(".worktree-review .worktree-files li", { timeout: 10_000 });
    const files = await page.locator(".worktree-review .worktree-files").innerText();
    const diff = await page.locator(".worktree-review .worktree-diff").innerText();
    await shot("02-review.png");
    pass("'변경 검토'에 바뀐 파일과 차이가 보임(원래 폴더는 그대로)", files.includes("강의계획.md") && files.includes("과제.md") && diff.includes("+2주차: 실습") && !readFileSync(join(repo, "강의계획.md"), "utf8").includes("2주차"), files.replace(/\s+/g, " "));
    await page.locator(".worktree-review .button.primary", { hasText: "원래 폴더에 적용" }).click();
    const applied = await until(async () => readFileSync(join(repo, "강의계획.md"), "utf8").includes("2주차: 실습") && existsSync(join(repo, "과제.md")), 10_000);
    pass("'원래 폴더에 적용'하면 원래 폴더의 파일이 바뀜(사본은 남음)", applied && existsSync(isolated.worktree!.path));

    // ── thrown away: the copy goes, the session is archived ───────────────────────────────────
    await page.locator(".worktree-review .button.danger", { hasText: "버리기" }).click();
    const gone = await until(async () => !existsSync(isolated.worktree!.path) && Boolean((await sessions()).find((entry) => entry.id === isolated.id)?.archivedAt), 10_000);
    await shot("03-discarded.png");
    pass("'버리기'는 사본과 가지를 지우고 세션을 보관함", gone && git(repo, "branch", "--list", isolated.worktree!.branch).trim() === "");
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
  for (const dir of [dataDir, reposDir]) rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((result) => !result.ok).length;
  console.log(`${results.length - failed}/${results.length} passed · console: ${logs.length ? logs.slice(0, 6).join(" | ") : "clean"}`);
  process.exitCode = failed ? 1 : 0;
}
