/// <reference lib="dom" />
// Browser check of "다른 곳의 대화 가져오기", for Claude Code and Codex alike, against a real gateway
// driving stand-in engines (no model): a conversation made in a terminal is listed (Claude Code's
// session files — here a made-up one in a temporary config folder, never the user's own — and
// Codex's thread/list), imported into the work of its folder with its record shown, continued
// with a new request that resumes the same conversation, and offered as "이미 가져옴" afterwards.
// Usage: node scripts/import-check.ts [outDir] [codex|claude]

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium } from "playwright-core";
import type { Provider, Session, TranscriptItem, Work } from "@workbench/contracts";

const outDir = process.argv[2] ?? join(tmpdir(), "wb-import");
const providers: Provider[] = process.argv[3] === "codex" || process.argv[3] === "claude" ? [process.argv[3]] : ["codex", "claude"];
mkdirSync(outDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "workbench-import-"));
const worksDir = mkdtempSync(join(tmpdir(), "workbench-import-works-"));
const claudeConfig = mkdtempSync(join(tmpdir(), "workbench-import-claude-"));
const results: { step: string; ok: boolean; detail: string }[] = [];
const check = (step: string, ok: boolean, detail = "") => {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`);
};

// The folders the terminal conversations ran in, and a Claude Code record made up for the check.
const folders: Record<Provider, string> = { claude: join(worksDir, "claude-terminal"), codex: join(worksDir, "codex-terminal") };
for (const folder of Object.values(folders)) mkdirSync(folder, { recursive: true });
const claudeSession = randomUUID();
{
  const cwd = folders.claude;
  const dir = join(claudeConfig, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const base = { isSidechain: false, userType: "external", cwd, sessionId: claudeSession, version: "2.1.292", gitBranch: "", entrypoint: "cli" };
  const [u1, a1] = [randomUUID(), randomUUID()];
  const at = new Date(Date.now() - 2 * 3600_000);
  const lines = [
    { ...base, parentUuid: null, type: "user", message: { role: "user", content: "터미널에서 시작한 Claude 대화" }, uuid: u1, timestamp: at.toISOString() },
    {
      ...base,
      parentUuid: u1,
      type: "assistant",
      message: { id: "msg_t1", type: "message", role: "assistant", model: "claude-fake", content: [{ type: "text", text: "터미널에서 받은 Claude 답입니다." }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
      requestId: "req_t1",
      uuid: a1,
      timestamp: new Date(at.getTime() + 5000).toISOString(),
    },
  ];
  writeFileSync(join(dir, `${claudeSession}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  // Claude Code's list dates a conversation by its file's last change: two hours ago, like the record.
  utimesSync(join(dir, `${claudeSession}.jsonl`), at, new Date(at.getTime() + 5000));
}
const nativeId: Record<Provider, string> = { claude: claudeSession, codex: "thr_cli_1" };

const child = spawn(process.execPath, ["apps/host/src/main.ts"], {
  env: {
    ...process.env,
    WORKBENCH_DATA_DIR: dataDir,
    WORKBENCH_WEB_DIR: "apps/web/dist",
    WORKBENCH_HOST_LABEL: "노트북",
    WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"),
    WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"),
    // Claude Code's session files are read from here (the SDK honours it), not from ~/.claude.
    CLAUDE_CONFIG_DIR: claudeConfig,
    FAKE_CODEX_IMPORT_CWD: folders.codex,
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
const snapshot = () => api<{ sessions: Session[]; works: Work[] }>("GET", "/api/snapshot");
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
  const engineName = provider === "codex" ? "Codex" : "Claude Code";
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on("console", (message) => message.type() === "error" && logs.push(`[${label} error] ${message.text().slice(0, 200)}`));
  page.on("pageerror", (error) => logs.push(`[${label} pageerror] ${error.message.slice(0, 200)}`));
  const shot = (name: string) => page.screenshot({ path: join(outDir, `${provider}-${name}`) });
  const pass = (step: string, ok: boolean, detail = "") => check(`[${label}] ${step}`, ok, detail);
  const openDialog = async () => {
    // In the two-pane navigator "다른 곳의 대화 가져오기…" is in the sidebar's ⋯ (the single tree keeps it in its 정렬 menu too).
    await page.locator(".sidebar .side-head [aria-label='사이드바 메뉴']").click();
    await page.locator(".context-menu, [role='menu']").getByText("다른 곳의 대화 가져오기…").click();
    await page.waitForSelector(".import-dialog");
    await page.locator(".import-tab", { hasText: engineName }).click();
  };
  try {
    await page.goto(`${ready.url}/?token=${ready.token}`);
    await page.waitForSelector(".sidebar .side-tree");

    // ── the terminal's conversation is listed ─────────────────────────────────────────────────
    await openDialog();
    const row = page.locator(".import-row", { hasText: `터미널에서 시작한 ${label} 대화` });
    await row.waitFor({ timeout: 10_000 });
    const meta = await row.locator(".picker-meta").innerText();
    await shot("01-list.png");
    pass("터미널에서 만든 대화가 폴더·시각과 함께 보임", meta.includes(`${provider}-terminal`) && /시간 전|분 전/.test(meta), meta.replace(/\s+/g, " "));

    // ── imported into the work of its folder, with its record ────────────────────────────────
    await row.click();
    await page.waitForSelector(".import-dialog", { state: "detached", timeout: 10_000 });
    await page.waitForSelector(".turn-request", { timeout: 10_000 });
    const text = await page.locator(".transcript-inner").innerText();
    const state = await snapshot();
    const session = state.sessions.find((entry) => entry.nativeSessionId === nativeId[provider]);
    const work = state.works.find((entry) => entry.id === session?.workId);
    await shot("02-imported.png");
    pass(
      "가져온 대화가 그 폴더의 작업에 지난 내용과 함께 열림",
      Boolean(session && work?.cwd === folders[provider]) && text.includes(`터미널에서 받은 ${label} 답입니다.`) && text.includes(`${engineName}에서 가져온 대화입니다`),
      `${work?.title ?? "작업 없음"} · ${session?.purpose ?? ""}`,
    );

    // ── a new request goes on with the same conversation ─────────────────────────────────────
    await page.locator(".composer-input").fill("이어서 질문합니다");
    await page.locator(".composer-input").press("Enter");
    const answered = await until(async () => (await items(session!.id)).filter((item) => item.kind === "assistant").length >= 2 && (await snapshot()).sessions.find((entry) => entry.id === session!.id)?.status === "idle", 15_000);
    const after = (await snapshot()).sessions.find((entry) => entry.id === session!.id);
    pass("이어 쓴 요청이 같은 대화로 이어짐(같은 엔진 세션 id)", answered && after?.nativeSessionId === nativeId[provider], after?.nativeSessionId ?? "");

    // ── offered again as "already here", and opened rather than copied ────────────────────────
    await openDialog();
    const again = page.locator(".import-row", { hasText: `터미널에서 시작한 ${label} 대화` });
    await again.waitFor({ timeout: 10_000 });
    const here = await again.locator(".import-here").count();
    await again.click();
    await page.waitForSelector(".import-dialog", { state: "detached", timeout: 10_000 });
    const copies = (await snapshot()).sessions.filter((entry) => entry.nativeSessionId === nativeId[provider]).length;
    await shot("03-again.png");
    pass("다시 열면 '이미 가져옴'이고 같은 세션을 엶(복사하지 않음)", here === 1 && copies === 1);
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
