/// <reference lib="dom" />
// Browser check of the Notion-like organisation with the Obsidian vault mirror, for Codex and Claude
// alike, against a real gateway driving stand-in engines (no model) and a fixture vault in a
// temporary folder (the user's vault is never touched):
//   볼트 거울 — the suggested vault attaches from the dialog; folders wear Notebook Navigator colours
//   and the add-on's group borders; counts read "현재 · 하위"; a note added on disk shows up; the
//   vault's bytes are the same at the end.
// Usage: node scripts/pkm-check.ts [outDir] [codex|claude]

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Page } from "playwright-core";
import type { Provider, Session, VaultTree, Work } from "@workbench/contracts";
import { makePkmVault } from "./fixtures/pkm-vault.ts";

const outDir = process.argv[2] ?? join(tmpdir(), "wb-pkm-check");
const providers: Provider[] = process.argv[3] === "codex" || process.argv[3] === "claude" ? [process.argv[3]] : ["codex", "claude"];
mkdirSync(outDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "workbench-pkm-"));
const worksDir = mkdtempSync(join(tmpdir(), "workbench-pkm-works-"));
const vault = makePkmVault(mkdtempSync(join(tmpdir(), "workbench-pkm-vault-")));
const results: { step: string; ok: boolean; detail: string }[] = [];
const check = (step: string, ok: boolean, detail = "") => {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`);
};

/** Every file of the fixture vault with its size and modification time. */
function listing(root: string) {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.set(relative(root, full), `${statSync(full).size}:${statSync(full).mtimeMs}`);
    }
  };
  walk(root);
  return out;
}
const vaultBefore = listing(vault);
/** Files this check itself puts into the fixture vault (to see the watcher follow). */
const ownWrites = new Set<string>();

const child = spawn(process.execPath, ["apps/host/src/main.ts"], {
  env: {
    ...process.env,
    WORKBENCH_DATA_DIR: dataDir,
    WORKBENCH_WEB_DIR: "apps/web/dist",
    WORKBENCH_HOST_LABEL: "노트북",
    WORKBENCH_VAULT_SUGGEST: vault,
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
let vaultAttached = false;

const row = (page: Page, path: string) => page.locator(`.vault-row[data-vault-path="${path}"]`);

async function vaultSteps(page: Page, pass: (step: string, ok: boolean, detail?: string) => void, shot: (name: string) => Promise<unknown>) {
  if (!vaultAttached) {
    // ── attach the suggested vault from the dialog ───────────────────────────────────────
    const offer = await page.locator(".vault-connect").innerText();
    await page.locator(".vault-connect").click();
    await page.waitForSelector(".pkm-dialog");
    await shot("01-vault-dialog.png");
    await page.locator(".pkm-suggest").click();
    await page.waitForSelector(".vault-tree .vault-row", { timeout: 10_000 });
    vaultAttached = true;
    pass("볼트 연결: 이 컴퓨터의 볼트를 제안하고 대화상자에서 붙임", offer.includes(vault.split("/").pop()!), offer);
  }
  await page.waitForSelector(".vault-tree .vault-row", { timeout: 10_000 });
  // ── folders, counts, colours and borders as Notebook Navigator and the add-on draw them ──
  const names = await page.locator(".vault-tree .vault-row:not(.vault-root) .side-row-label").allInnerTexts();
  const info = (await row(page, "20. Information (I)").locator(".vault-count").innerText()).trim();
  pass("볼트 폴더 트리(숨긴 폴더 빠짐)와 '현재 · 하위' 개수", names.includes("01. Inbox") && !names.some((name) => name.startsWith("90.")) && info === "1 · 2", `${names.length}개 · 20. Information = ${info}`);
  const color = await row(page, "20. Information (I)").locator(".side-row-label").evaluate((element) => getComputedStyle(element).color);
  const groups = await page.locator(".vault-group").count();
  const firstGroup = await page.locator(".vault-group").first().locator(".vault-row").count();
  pass("폴더 색(라이트 테마 덮어쓰기)과 묶음 테두리 2개", color === "rgb(28, 108, 117)" && groups === 2 && firstGroup === 5, `${color} · 묶음 ${groups} · 첫 묶음 ${firstGroup}줄`);
  await row(page, "20. Information (I)").locator(".row-chevron").click();
  await page.waitForSelector('.vault-row[data-vault-path="20. Information (I)/201. 주제별"]');
  await shot("02-vault-tree.png");
}

async function flow(provider: Provider) {
  const label = provider === "codex" ? "Codex" : "Claude";
  const work = await api<Work>("POST", "/api/works", { title: `${label} 정리`, cwd: join(worksDir, provider) });
  await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider, purpose: "정리", access: "auto" });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on("console", (message) => message.type() === "error" && logs.push(`[${label} error] ${message.text().slice(0, 200)}`));
  page.on("pageerror", (error) => logs.push(`[${label} pageerror] ${error.message.slice(0, 200)}`));
  const shot = (name: string) => page.screenshot({ path: join(outDir, `${provider}-${name}`) });
  const pass = (step: string, ok: boolean, detail = "") => check(`[${label}] ${step}`, ok, detail);
  try {
    await page.addInitScript((id) => localStorage.setItem("workbench.lastWork", id), work.id);
    await page.goto(`${ready.url}/?token=${ready.token}`);
    await page.waitForSelector(".sidebar .vault-section");
    await vaultSteps(page, pass, shot);

    // ── a note written on disk shows up (debounced watch) ──────────────────────────────────
    const name = `01. Inbox/${label} 새 노트.md`;
    const before = (await row(page, "01. Inbox").locator(".vault-count").innerText()).trim();
    writeFileSync(join(vault, name), "# 새 노트\n");
    ownWrites.add(name);
    const followed = await until(async () => (await row(page, "01. Inbox").locator(".vault-count").innerText()).trim() !== before, 8000);
    pass("디스크에 생긴 노트를 지켜보다가 개수에 반영", followed, `${before} → ${(await row(page, "01. Inbox").locator(".vault-count").innerText()).trim()}`);
  } catch (error) {
    pass("실행", false, error instanceof Error ? error.message.split("\n")[0]! : String(error));
    await page.screenshot({ path: join(outDir, `${provider}-99-failure.png`) }).catch(() => undefined);
  } finally {
    await page.close();
  }
}

try {
  for (const provider of providers) await flow(provider);
  const tree = await api<VaultTree>("GET", "/api/pkm/vault/tree");
  check("볼트 API에 다른 플러그인 설정이 나오지 않음", !JSON.stringify(tree).includes("FIXTURE-SECRET"));
  const after = listing(vault);
  const changed = [...new Set([...vaultBefore.keys(), ...after.keys()])].filter((path) => !ownWrites.has(path) && vaultBefore.get(path) !== after.get(path));
  check("볼트는 읽기만 함(검사가 직접 만든 파일 말고는 바이트·시각 그대로)", changed.length === 0, changed.slice(0, 5).join(", "));
} finally {
  writeFileSync(join(outDir, "console.log"), logs.join("\n"));
  writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
  await browser.close();
  child.kill();
  await new Promise((done) => (child.exitCode === null && child.signalCode === null ? child.once("exit", done) : done(null)));
  for (const dir of [dataDir, worksDir, vault]) rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((result) => !result.ok).length;
  console.log(`${results.length - failed}/${results.length} passed · console: ${logs.length ? logs.slice(0, 6).join(" | ") : "clean"}`);
  process.exitCode = failed ? 1 : 0;
}
