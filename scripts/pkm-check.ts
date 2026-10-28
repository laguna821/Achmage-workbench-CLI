/// <reference lib="dom" />
// Browser check of the Notion-like organisation with the Obsidian vault mirror, for Codex and Claude
// alike, against a real gateway driving stand-in engines (no model) and a fixture vault in a
// temporary folder (the user's vault is never touched):
//   볼트 거울 — the suggested vault attaches from the dialog; folders wear Notebook Navigator colours
//   and the add-on's group borders; counts read "현재 · 하위"; a note added on disk shows up; the
//   vault's bytes are the same at the end.
//   카드 목록 — a vault folder opens as cards (title, excerpt, tag pills in Notebook Navigator colours,
//   date, thumbnail, pinned first); a card opens the note read-only with its properties and
//   "Obsidian에서 열기" (obsidian://open?path=); a note card dragged onto the input goes with a new
//   session's request as a read-only reference (the engine names the copy it got, the copy is
//   in the work folder, read-only, with the vault's bytes); a work opens as cards too.
// Usage: node scripts/pkm-check.ts [outDir] [codex|claude]

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Page } from "playwright-core";
import { readFileSync } from "node:fs";
import type { Provider, Session, TranscriptItem, VaultTree, Work } from "@workbench/contracts";
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
const snapshot = () => api<{ works: Work[]; sessions: Session[] }>("GET", "/api/snapshot");
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
    await page.addInitScript((id) => {
      localStorage.setItem("workbench.lastWork", id);
      // Record links the app opens (obsidian://) instead of leaving the page.
      const opened: string[] = [];
      (window as unknown as { __opened: string[] }).__opened = opened;
      window.open = ((url?: string | URL) => {
        opened.push(String(url));
        return null;
      }) as typeof window.open;
    }, work.id);
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

    // ── a vault folder as cards ─────────────────────────────────────────────────────────────
    await row(page, "20. Information (I)").click();
    await page.waitForSelector(".pkm-card", { timeout: 10_000 });
    const pinnedCard = page.locator(".pkm-card").first();
    await page.waitForFunction(() => Boolean(document.querySelector<HTMLImageElement>(".pkm-card-thumb img")?.naturalWidth), undefined, { timeout: 8000 });
    const first = await pinnedCard.innerText();
    const groupsShown = await page.locator(".pkm-group-label").allInnerTexts();
    const tagColor = await pinnedCard.locator(".pkm-tag", { hasText: "AI_교육" }).evaluate((element) => getComputedStyle(element).getPropertyValue("--tag-color").trim());
    await shot("03-cards.png");
    pass(
      "볼트 폴더 카드: 제목·발췌·태그 알약(NN 색)·날짜·썸네일, 고정 먼저",
      (await page.locator(".pkm-card").count()) === 3 && groupsShown[0] === "고정" && first.includes("AI 글쓰기 수업 설계") && first.includes("수업 첫 주에는") && first.includes("🔵 I") && tagColor === "#4a70b7",
      `${await page.locator(".pkm-card").count()}장 · ${groupsShown.join(",")} · 태그색 ${tagColor}`,
    );

    // ── a card opens the note read-only, with "Obsidian에서 열기" ───────────────────────────
    await pinnedCard.click();
    await page.waitForSelector(".pkm-note-body", { timeout: 10_000 });
    await page.waitForFunction(() => Boolean(document.querySelector<HTMLImageElement>(".pkm-note-body img")?.naturalWidth), undefined, { timeout: 8000 });
    const keys = await page.locator(".pkm-prop dt").allInnerTexts();
    await page.locator(".pkm-obsidian").click();
    const opened = await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened.at(-1) ?? "");
    const expected = `obsidian://open?path=${encodeURIComponent(`${vault}/20. Information (I)/201. 주제별/AI 글쓰기 수업 설계.md`)}`;
    await shot("04-note.png");
    pass("노트를 읽기 전용으로 열고(속성 키 글자 그대로) Obsidian에서 열기", keys.includes("DIKM_단계:") && (await page.locator(".pkm-note-view .vault-readonly").count()) === 1 && opened === expected, `${keys.join("|")} · ${opened.slice(0, 60)}…`);

    // ── a note card dragged onto the input: a new session reads it as a read-only reference ──
    await row(page, "20. Information (I)").click();
    await page.waitForSelector(".pkm-card");
    const card = page.locator(".pkm-card", { hasText: "용어 정리" });
    const from = (await card.boundingBox())!;
    const to = (await page.locator(".pkm-composer .composer").boundingBox())!;
    await page.mouse.move(from.x + 40, from.y + 20);
    await page.mouse.down();
    await page.mouse.move(from.x + 60, from.y + 60, { steps: 4 });
    await page.mouse.move(to.x + 120, to.y + 30, { steps: 8 });
    const dropping = await page.locator(".pkm-composer.dropping").count();
    await shot("05-drag.png");
    await page.mouse.up();
    const chip = await page.locator(".pkm-composer .note-chip").innerText().catch(() => "");
    pass("노트 카드를 입력창으로 끌어 놓으면 읽기 전용으로 붙음", dropping === 1 && chip.includes("용어 정리"), chip);
    await page.locator(`.pkm-composer .engine-tab:has-text("${label}")`).click();
    const before2 = new Set((await snapshot()).sessions.map((entry) => entry.id));
    await page.locator(".pkm-composer .composer-input").fill("이 노트로 용어를 정리해 줘");
    await page.locator(".pkm-composer .composer-input").press("Enter");
    await page.waitForSelector(".work-view .turn-request", { timeout: 10_000 });
    let created: Session | undefined;
    await until(async () => {
      created = (await snapshot()).sessions.find((entry) => !before2.has(entry.id));
      return Boolean(created && created.status === "idle" && created.previewAt);
    }, 20_000);
    const createdWork = (await snapshot()).works.find((entry) => entry.id === created?.workId)!;
    const log = created ? await items(created.id) : [];
    const request = log.find((item): item is Extract<TranscriptItem, { kind: "user" }> => item.kind === "user");
    const reply = log.filter((item) => item.kind === "assistant").map((item) => (item.kind === "assistant" ? item.text : "")).join("\n");
    const copyName = /받은 노트 사본: ([^\n|]+)/.exec(reply)?.[1]?.trim() ?? "";
    const copy = copyName ? join(createdWork.cwd, copyName) : "";
    const sameBytes = copy ? readFileSync(copy).equals(readFileSync(join(vault, "20. Information (I)/용어 정리.md"))) : false;
    const readOnly = copy ? (statSync(copy).mode & 0o222) === 0 : false;
    await page.waitForSelector(".turn-request .note-chip", { timeout: 5000 });
    await shot("06-session-with-note.png");
    pass(
      "새 세션 요청에 노트가 붙고 엔진은 작업 폴더의 읽기 전용 사본을 받음",
      created?.provider === provider && request?.notes?.[0]?.path === "20. Information (I)/용어 정리.md" && copyName.startsWith(".workbench/notes/") && sameBytes && readOnly,
      `${copyName} · 같은 바이트 ${sameBytes} · 읽기 전용 ${readOnly}`,
    );

    // ── a work as cards (sessions and pages) ───────────────────────────────────────────────
    await page.locator(`.sidebar [data-row-id="${work.id}"]`).click({ button: "right" });
    await page.locator(".context-menu [role=menuitem]", { hasText: "카드로 보기" }).click();
    await page.waitForSelector(".pkm-card.kind-session", { timeout: 10_000 });
    pass("작업을 카드로 보기(세션 카드)", (await page.locator(".pkm-card.kind-session").count()) >= 1, await page.locator(".pkm-title").innerText());
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
