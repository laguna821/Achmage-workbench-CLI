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
//   페이지 2단계 — "템플릿으로 새 페이지" from the vault template fills only title and date created
//   (choice picked in the picker, the rest byte for byte, Templater kept as text); "+" on a page
//   makes a subpage shown under it; a session row dropped on a work row makes a "세션 기록" page
//   there; "페이지로 만들기" on a reply makes a page with its source.
//   보기·규칙 — a saved view (Notebook Navigator syntax) shows matching notes grouped by DIKM stage
//   with missing values under "값 없음", an `engine:` view shows that engine's sessions; a rule
//   "엔진 → 앱 폴더·태그" places a new work by itself (row marked with the rule), and "미리보기 →
//   적용" moves an existing work; nothing calls a model.
//   맥락 카드·쓰기 막기 — a note pinned to the work reaches a new session in its context card (Claude
//   systemPrompt.append, Codex developerInstructions; ≤ 2 KB); a write into the vault is refused
//   (Claude: the PreToolUse hook, even with full access; Codex: the sandbox keeps the vault out of
//   the writable roots); the pill under the input warns under full access.
//   인사이트 초안 — a finished session's "인사이트 초안" has the vault template's keys spelled exactly
//   with DIKM empty; a DIKM stage set by hand is refused; "발행 요청" asks the session's engine to
//   publish through Achmage MCP (draft_insight → publish_insight); nothing is written into the vault.
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
const readdirSafe = (dir: string) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};
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

    // ── a page from the vault's template: only title and date created filled ─────────────────
    await page.locator(`.sidebar [data-row-id="${work.id}"]`).click({ button: "right" });
    await page.locator(".context-menu [role=menuitem]", { hasText: "템플릿으로 새 페이지" }).click();
    await page.waitForSelector(".template-dialog .template-row", { timeout: 8000 });
    await page.locator(".template-row", { hasText: "New DIKM Note" }).click();
    await page.locator("#page-title").fill("1주차 계획");
    await page.locator(".template-choice", { hasText: "DIKM_단계:" }).locator(".template-option", { hasText: "🔵 I" }).click();
    await shot("07-template.png");
    await page.locator(".template-form button[type=submit]").click();
    await page.waitForSelector(".document-view", { timeout: 10_000 });
    const templated = readFileSync(join(work.cwd, "1주차 계획.md"), "utf8");
    const expectedHead = ["---", "title: 1주차 계획", "aliases: ", '"DIKM_단계:":', "  - 🔵 I", '"종류:":', "tags: ", '"저자:": ', '"관련문서:": '].join("\n");
    pass(
      "볼트 템플릿으로 새 페이지: 제목·date created만 채우고 고른 값만, 나머지 바이트·Templater 그대로",
      templated.startsWith(expectedHead) && /\ndate created: \d{4}-\d{2}-\d{2}T[\d:]+[+-]\d{2}:\d{2}\nsource:\n---\n/.test(templated) && templated.includes("<% tp.date.now() %>"),
      templated.split("\n").slice(0, 6).join(" ⏎ "),
    );

    // ── "+" on a page: a subpage beside it, shown under it ───────────────────────────────────
    const docOf = async (path: string) => (await api<{ artifacts: { id: string; path: string }[] }>("GET", "/api/snapshot")).artifacts.find((artifact) => artifact.path === path)?.id ?? "";
    const parentId = await docOf(join(work.cwd, "1주차 계획.md"));
    const parentRow = page.locator(`.sidebar [data-row-id="${parentId}"]`);
    await parentRow.hover();
    await parentRow.locator(".row-add").click();
    await until(async () => Boolean(await docOf(join(work.cwd, "1주차 계획", "제목 없음.md"))), 8000);
    const childId = await docOf(join(work.cwd, "1주차 계획", "제목 없음.md"));
    await page.locator(`.sidebar [data-row-id="${childId}"]`).waitFor({ timeout: 8000 });
    const indent = async (id: string) => Number.parseFloat(await page.locator(`.sidebar [data-row-id="${id}"]`).evaluate((element) => getComputedStyle(element).paddingLeft));
    const nested = (await indent(childId)) > (await indent(parentId));
    pass("페이지의 + 로 하위 페이지(1주차 계획/제목 없음.md)를 만들고 그 아래에 보임", nested && statSync(join(work.cwd, "1주차 계획", "제목 없음.md")).isFile());

    // ── a session row dropped on another work's row: its record as a page there ───────────────
    const second = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider, purpose: "둘째" });
    await page.locator(`.sidebar [data-row-id="${second.id}"]`).waitFor({ timeout: 8000 });
    const sessionRow = (await page.locator(`.sidebar [data-row-id="${second.id}"]`).boundingBox())!;
    const targetRow = (await page.locator(`.sidebar [data-row-id="${createdWork.id}"]`).boundingBox())!;
    await page.mouse.move(sessionRow.x + 30, sessionRow.y + sessionRow.height / 2);
    await page.mouse.down();
    await page.mouse.move(sessionRow.x + 40, sessionRow.y + 20, { steps: 3 });
    await page.mouse.move(targetRow.x + 60, targetRow.y + targetRow.height / 2, { steps: 8 });
    const accepting = await page.locator(`.sidebar [data-row-id="${createdWork.id}"].drop-page`).count();
    await shot("08-session-drop.png");
    await page.mouse.up();
    const recorded = await until(async () => (await snapshot()).works.length > 0 && readdirSafe(join(createdWork.cwd, "세션 기록")).some((name) => readFileSync(join(createdWork.cwd, "세션 기록", name), "utf8").includes(`session: ${second.id}`)), 8000);
    pass("세션 줄을 다른 작업 줄에 끌어 놓으면 그 작업에 세션 기록 페이지", accepting === 1 && recorded, readdirSafe(join(createdWork.cwd, "세션 기록")).join(", "));

    // ── "페이지로 만들기" on a reply ─────────────────────────────────────────────────────────
    await page.locator(`.sidebar [data-row-id="${createdWork.id}"]`).click();
    await page.waitForSelector(".work-view .turn-assistant .markdown", { timeout: 8000 });
    await page.locator(".work-view .turn-assistant").first().hover();
    await page.locator(".work-view .message-page").first().click();
    await page.waitForSelector(".document-view", { timeout: 10_000 });
    const madePage = readdirSafe(createdWork.cwd).find((name) => name.endsWith(".md") && readFileSync(join(createdWork.cwd, name), "utf8").includes(`source: workbench://session/${created?.id}#`));
    await shot("09-message-page.png");
    pass("답의 '페이지로 만들기'로 출처가 붙은 새 페이지", Boolean(madePage), madePage ?? "");

    // ── saved views: virtual folders with a query (no model) ─────────────────────────────────
    await page.waitForSelector(".views-section .view-row");
    const defaults = await page.locator(".views-section .view-row .side-row-label").allInnerTexts();
    const makeView = async (name: string, query: string, group: string) => {
      await page.locator(".views-section .side-tools button[title='새 보기']").click();
      await page.locator("#view-name").fill(name);
      await page.locator("#view-query").fill(query);
      await page.locator("#view-group").selectOption(group);
      await page.waitForFunction(() => /맞는 것 \d+개/.test(document.querySelector(".view-preview")?.textContent ?? ""), undefined, { timeout: 5000 });
      const counted = await page.locator(".view-preview").innerText();
      await page.locator(".view-dialog button[type=submit]").click();
      // The new view's own cards (not the previous view's, still on screen for a moment).
      await page.waitForFunction((title) => document.querySelector(".pkm-view .pkm-title")?.textContent === title && Boolean(document.querySelector(".pkm-card")), name, { timeout: 8000 });
      return counted;
    };
    const counted = await makeView(`${label} 정보 단계`, 'kind:note ."DIKM_단계:"="🔵 I"', "");
    await page.waitForSelector(".pkm-card");
    const infoTitles = await page.locator(".pkm-card .pkm-card-name").allInnerTexts();
    pass(
      `저장한 보기(NN 문법 ."DIKM_단계:"="🔵 I")가 가상 폴더로 맞는 노트를 보임`,
      defaults.includes("이번 주 노트") && counted.includes("3개") && infoTitles.length === 3 && infoTitles.includes("AI 글쓰기 수업 설계"),
      `${counted} · ${infoTitles.join(", ")}`,
    );
    await makeView(`${label} 단계별`, "kind:note", "DIKM_단계:");
    await page.waitForSelector(".pkm-group-label");
    const stageGroups = await page.locator(".pkm-group-label").allInnerTexts();
    await shot("10-view-groups.png");
    pass("DIKM 단계로 묶고 값이 없는 노트는 '값 없음'에(추정하지 않음)", stageGroups.at(-1) === "값 없음" && stageGroups.includes("🔵 I") && stageGroups.includes("🟢 D"), stageGroups.join(" · "));
    await makeView(`${label} 세션`, `engine:${provider} kind:session`, "");
    await page.waitForSelector(".pkm-card.kind-session");
    const engines = await page.locator(".pkm-card.kind-session .engine-mark").evaluateAll((marks) => marks.map((mark) => mark.getAttribute("aria-label") ?? mark.getAttribute("data-provider") ?? mark.textContent ?? ""));
    const sessionCards = await page.locator(".pkm-card.kind-session").count();
    const expectedSessions = (await snapshot()).sessions.filter((entry) => entry.provider === provider && !entry.archivedAt).length;
    pass(`engine:${provider} 보기는 그 엔진의 세션만`, sessionCards === expectedSessions && sessionCards > 0, `${sessionCards}/${expectedSessions} ${engines.length}`);

    // ── rules: 조건 → 배치 for new works, and 미리보기 → 적용 for existing ones ─────────────────
    await page.locator(".views-section .side-tools button[title='보기 메뉴']").click();
    await page.locator(".context-menu [role=menuitem]", { hasText: "자동 정리 규칙" }).click();
    await page.waitForSelector(".rules-dialog");
    await page.locator("#rule-name").fill(`${label} 작업`);
    await page.locator("#rule-engine").selectOption(provider);
    await page.locator("#rule-folder").fill(`엔진별/${label}`);
    await page.locator("#rule-tag").fill(label);
    await page.locator(".rule-form button", { hasText: "규칙 추가" }).click();
    await page.locator(".rule-preset").click();
    await page.waitForFunction(() => document.querySelectorAll(".rule-row").length === 2, undefined, { timeout: 5000 });
    await shot("11-rules.png");
    const fresh = await api<Work>("POST", "/api/works", { title: `${label} 새 작업`, cwd: join(worksDir, `${provider}-new`) });
    await api<Session>("POST", `/api/works/${fresh.id}/sessions`, { provider, purpose: "새" });
    const placed = await until(async () => {
      const state = await api<{ works: Work[]; folders: { id: string; name: string; parentId: string | null }[] }>("GET", "/api/snapshot");
      const moved = state.works.find((entry) => entry.id === fresh.id);
      const folder = state.folders.find((entry) => entry.id === moved?.folderId);
      return Boolean(moved?.tags?.includes(label) && folder?.name === label && state.folders.find((entry) => entry.id === folder.parentId)?.name === "엔진별");
    }, 8000);
    const mark = await page.locator(`.sidebar [data-row-id="${fresh.id}"] .rule-mark`).getAttribute("title", { timeout: 5000 }).catch(() => "");
    pass("규칙(엔진 → 앱 폴더·태그)이 새 작업을 스스로 배치하고 줄에 그 규칙을 표시", placed && (mark ?? "").includes(`${label} 작업`), mark ?? "");
    await page.locator(".rule-preview button", { hasText: "미리보기" }).click();
    await page.waitForSelector(".change-list li", { timeout: 8000 });
    const change = page.locator(".change-list li", { hasText: work.title });
    const listed = await change.count();
    if (listed) await change.locator("input[type=checkbox]").check();
    await shot("12-rules-preview.png");
    await page.locator(".rules-dialog .button.primary", { hasText: "적용" }).click();
    const applied = await until(async () => {
      const state = await api<{ works: Work[]; folders: { id: string; name: string }[] }>("GET", "/api/snapshot");
      return state.folders.find((entry) => entry.id === state.works.find((item) => item.id === work.id)?.folderId)?.name === label;
    }, 8000);
    pass("미리보기에서 고른 기존 작업만 '적용'으로 옮김", listed === 1 && applied, `${listed}`);
    await page.keyboard.press("Escape");
    // The next flow starts without these rules and views.
    await api("PUT", "/api/pkm/rules", { rules: [] });

    // ── a note pinned to the work reaches a new session's context card ───────────────────────
    await row(page, "20. Information (I)").click();
    await page.waitForSelector(".pkm-card");
    await page.locator(".pkm-card", { hasText: "용어 정리" }).click({ button: "right" });
    await page.locator(".context-menu [role=menuitem]", { hasText: "작업에 고정" }).hover();
    await page.locator(".context-menu [role=menuitem]", { hasText: work.title }).click();
    await until(async () => ((await api<{ pins: Record<string, string[]> }>("GET", "/api/pkm/state")).pins[work.id] ?? []).length === 1, 5000);
    const guarded = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider, purpose: "맥락", access: provider === "claude" ? "full" : "auto" });
    const ask = async (text: string) => {
      const before = (await items(guarded.id)).filter((item) => item.kind === "assistant").length;
      await api("POST", `/api/sessions/${guarded.id}/messages`, { requestId: `${provider}-${Date.now()}-${Math.random()}`, text });
      await until(async () => (await items(guarded.id)).filter((item) => item.kind === "assistant" && !item.streaming).length > before && (await snapshot()).sessions.find((entry) => entry.id === guarded.id)?.status === "idle", 15_000);
      return (await items(guarded.id)).filter((item) => item.kind === "assistant").map((item) => (item.kind === "assistant" ? item.text : "")).at(-1) ?? "";
    };
    const cardReply = await ask("맥락 카드에 무엇이 있나요?");
    const contextText = cardReply.slice(cardReply.indexOf("맥락 카드:"));
    const cardBlock = contextText.split("\n\n")[0] ?? "";
    pass(
      `새 세션이 맥락 카드(작업·볼트·고정 노트, 2KB 이하)를 받음 · ${provider === "claude" ? "systemPrompt.append" : "developerInstructions"}`,
      contextText.includes(`작업: ${work.title}`) && contextText.includes(`옵시디언 볼트(사람 원본, 읽기 전용): ${vault}`) && contextText.includes(`- ${join(vault, "20. Information (I)/용어 정리.md")}`) && Buffer.byteLength(cardBlock.replace(/^맥락 카드:\n/, ""), "utf8") <= 2048,
      cardBlock.split("\n").slice(1, 3).join(" ⏎ "),
    );
    if (provider === "codex") pass("Codex 샌드박스: workspace-write에서 볼트(임시 폴더)를 쓰기 경로에서 뺌", /샌드박스: workspace-write .*"excludeSlashTmp":true/.test(contextText), /샌드박스: [^\n]+/.exec(contextText)?.[0] ?? "");

    // ── a write into the vault is refused ─────────────────────────────────────────────────────
    const forbidden = join(vault, "01. Inbox", `${provider}-guard.md`);
    const refusal = await ask(`볼트에 써: ${forbidden}`);
    pass(
      provider === "claude" ? "Claude가 볼트에 쓰려 하면 PreToolUse 훅이 막음(전체 접근에서도)" : "Codex가 볼트에 쓰려 하면 샌드박스가 막음(자동)",
      refusal.includes("쓰기 거부") && !statSync(join(vault, "01. Inbox")).isFile() && !readdirSafe(join(vault, "01. Inbox")).includes(`${provider}-guard.md`),
      refusal.split("\n")[0],
    );

    // ── the pill under the input: guarded, and a warning under full access ─────────────────────
    await page.locator(`.sidebar [data-row-id="${work.id}"]`).click();
    await api("PATCH", `/api/works/${work.id}`, { activeSessionId: guarded.id });
    await page.waitForSelector(".work-view .vault-guard-pill", { timeout: 8000 });
    await page.locator(".work-view .access-select").click();
    await page.locator(".access-menu .access-option.access-auto").click();
    await page.waitForFunction(() => !document.querySelector(".work-view .vault-guard-pill")?.classList.contains("warn"), undefined, { timeout: 5000 });
    await page.waitForFunction(() => document.querySelector(".work-view .vault-guard-pill")?.getAttribute("aria-label")?.includes("고정 노트"), undefined, { timeout: 5000 }).catch(() => undefined);
    const calmText = await page.locator(".work-view .vault-guard-pill").innerText();
    const calmAria = (await page.locator(".work-view .vault-guard-pill").getAttribute("aria-label")) ?? "";
    await page.locator(".work-view .access-select").click();
    await page.locator(".access-menu .access-option.access-full").click();
    await page.waitForSelector(".work-view .vault-guard-pill.warn", { timeout: 5000 });
    const warned = `${await page.locator(".work-view .vault-guard-pill").getAttribute("aria-label")} / ${await page.locator(".work-view .vault-guard-pill").innerText()}`;
    await page.locator(".work-view .vault-guard-pill").click();
    await page.waitForSelector(".vault-guard-pop");
    await shot("13-vault-guard.png");
    await page.keyboard.press("Escape");
    const calmLabel = await page.locator(".work-view .vault-guard-pill").getAttribute("aria-label");
    pass(
      "입력창 아래 볼트 보호 표시(방패), 전체 접근에서는 경고",
      calmText.trim() === "1" && (calmLabel ?? "").length > 0 && calmAria.includes("읽기 전용") && calmAria.includes("고정 노트 1") && warned.includes(provider === "codex" ? "볼트 보호 꺼짐" : "볼트 보호 일부"),
      `${calmAria} → ${warned}`.replace(/\n/g, " "),
    );
    await page.locator(".work-view .access-select").click();
    await page.locator(".access-menu .access-option.access-auto").click();

    // ── "인사이트 초안": the vault template's keys, DIKM empty, published only through the engine ──
    await page.locator(".work-view .insight-pill").click();
    await page.waitForSelector(".insight-dialog .insight-text", { timeout: 8000 });
    const draft = await page.locator(".insight-text").inputValue();
    const draftKeys = [...(/^---\n([\s\S]*?)\n---/.exec(draft)?.[1] ?? "").matchAll(/^("(?:[^"]+)"|[^\s:"][^:]*):/gm)].map((match) => match[1]!.replace(/^"|"$/g, ""));
    pass(
      "인사이트 초안: 볼트 템플릿 키 글자·순서 그대로(끝 콜론 포함), DIKM_단계 빈칸",
      JSON.stringify(draftKeys) === JSON.stringify(["title", "aliases", "DIKM_단계:", "종류:", "tags", "저자:", "관련문서:", "date created", "source"]) && /\n"DIKM_단계:":\n"종류:":\n/.test(draft) && draft.includes(`source: workbench://session/${guarded.id}`),
      draftKeys.join(" | "),
    );
    await page.locator(".insight-text").fill(draft.replace('"DIKM_단계:":\n', '"DIKM_단계:":\n  - 🔵 I\n'));
    await page.waitForSelector(".insight-problems", { timeout: 5000 });
    const blocked = await page.locator(".insight-dialog .button.primary").isDisabled();
    await shot("14-insight-refused.png");
    await page.locator(".insight-text").fill(draft);
    await page.waitForSelector(".insight-ok", { timeout: 5000 });
    pass("DIKM 단계를 채우면 발행 요청을 막음", blocked);
    await shot("15-insight.png");
    const requestsBefore = (await items(guarded.id)).filter((item) => item.kind === "user").length;
    await page.locator(".insight-dialog .button.primary").click();
    await page.waitForSelector(".insight-dialog", { state: "detached", timeout: 8000 });
    // The engine may ask before it uses the Achmage MCP tool (the stand-in Codex does, as Codex on "자동" would): allowed here.
    let mcpAsked = false;
    await until(async () => {
      const status = (await snapshot()).sessions.find((entry) => entry.id === guarded.id)?.status;
      if (status === "awaitingApproval") {
        const waiting = (await items(guarded.id)).find((item) => item.kind === "approval" && item.decision === null);
        if (waiting) {
          mcpAsked = waiting.kind === "approval" && waiting.title.includes("MCP");
          await api("POST", `/api/sessions/${guarded.id}/approvals/${encodeURIComponent(waiting.id)}`, { decision: "accept" });
        }
        return false;
      }
      return (await items(guarded.id)).filter((item) => item.kind === "user").length > requestsBefore && status === "idle";
    }, 15_000);
    const publishText = (await items(guarded.id)).filter((item): item is Extract<TranscriptItem, { kind: "user" }> => item.kind === "user").at(-1)?.text ?? "";
    pass(
      "발행 요청은 이 세션의 엔진에게 Achmage MCP(draft_insight → publish_insight)로, 검토한 글 그대로",
      publishText.startsWith("[인사이트 발행 요청") && publishText.includes("draft_insight") && publishText.includes("publish_insight") && publishText.includes(draft.trimEnd()),
      `${publishText.split("\n")[0]}${mcpAsked ? " · MCP 도구 승인 카드 → 허용" : ""}`,
    );
  } catch (error) {
    const waiting = (await snapshot()).sessions.filter((entry) => entry.status !== "idle").map((entry) => `${entry.purpose}:${entry.status}`);
    pass("실행", false, `${error instanceof Error ? error.message.split("\n")[0]! : String(error)}${waiting.length ? ` · 진행 중: ${waiting.join(", ")}` : ""}`);
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
