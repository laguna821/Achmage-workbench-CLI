/// <reference lib="dom" />
// Browser check of two panes and of the vault section's fold-all, for Codex and Claude alike,
// against a real gateway driving stand-in engines (no model) and a fixture vault in a temporary
// folder (the user's vault is never touched):
//   볼트 전체 접기 — "전체 접기" in the vault section's header folds every folder and stays folded
//   after a reload (as the tree remembers); "⋯ › 전체 펼치기" unfolds them all.
//   두 칸 — a pinned vault note dragged with the pointer onto the right half next to a session shows
//   where it lands and opens there: two panes, the new one focused (ruled header); a request sent
//   in the session pane is answered there while the note stays; the note pane's header dragged onto
//   the session's input attaches the note (no drop zone takes it) and the engine reads its copy;
//   the divider resizes by dragging (remembered) and from the keyboard, double-click halves;
//   "오른쪽에 열기" on a vault folder shows its cards on the right and a card opens its note in
//   that pane; Ctrl+click opens on the right; swap; two sessions of one work side by side, each
//   pane sending to its own; a click on a conversation already in the other pane goes there
//   (never twice); a narrow window shows one pane with a notice, never overlapping; closing a pane
//   leaves one; a reload brings one pane back (views are not restored), the width stays.
// Usage: node scripts/panes-check.ts [outDir] [codex|claude]

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Page } from "playwright-core";
import type { Provider, Session, TranscriptItem, UiPrefs, Work } from "@workbench/contracts";
import { makePkmVault } from "./fixtures/pkm-vault.ts";

const outDir = process.argv[2] ?? join(tmpdir(), "wb-panes-check");
const providers: Provider[] = process.argv[3] === "codex" || process.argv[3] === "claude" ? [process.argv[3]] : ["codex", "claude"];
mkdirSync(outDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "workbench-panes-"));
const worksDir = mkdtempSync(join(tmpdir(), "workbench-panes-works-"));
const vault = makePkmVault(mkdtempSync(join(tmpdir(), "workbench-panes-vault-")));
const results: { step: string; ok: boolean; detail: string }[] = [];
const check = (step: string, ok: boolean, detail = "") => {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`);
};

const child = spawn(process.execPath, ["apps/host/src/main.ts"], {
  env: {
    ...process.env,
    WORKBENCH_DATA_DIR: dataDir,
    WORKBENCH_WEB_DIR: process.env.PANES_WEB_DIR ?? "apps/web/dist",
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
const snapshot = () => api<{ sessions: Session[]; works: Work[]; prefs: UiPrefs }>("GET", "/api/snapshot");
const items = async (id: string) => (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${id}/items`)).items;
const turnsOf = async (id: string) => (await items(id)).filter((item) => item.kind === "turnEnd").length;
const until = async (what: () => Promise<boolean>, timeout = 15_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await what()) return true;
    await new Promise((done) => setTimeout(done, 100));
  }
  return false;
};
await api("PUT", "/api/prefs", { prefs: { onboarding: "done", startScreen: "last" } });
await api("PUT", "/api/pkm/vault", { path: vault });

const browser = await chromium.launch();
const logs: string[] = [];
const NOTE = "20. Information (I)/201. 주제별/AI 글쓰기 수업 설계.md";

const vaultRow = (page: Page, path: string) => page.locator(`.vault-row[data-vault-path="${path}"]`);
const center = (box: { x: number; y: number; width: number; height: number }) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

/** Press, move past the drag threshold, move to `to`, look around (`during`), release — pointer events only. */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, during?: () => Promise<void>) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 14, from.y + 6, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await during?.();
  await page.mouse.up();
}

const widthOf = async (page: Page, selector: string) => (await page.locator(selector).boundingBox())?.width ?? 0;

/** A work row unfolded in the sidebar (the work on screen starts unfolded once it has two sessions). */
async function unfold(page: Page, workId: string) {
  const row = page.locator(`.sidebar [data-row-id="${workId}"]`);
  await page.waitForFunction((id) => document.querySelector(`.sidebar [data-row-id="${id}"]`)?.getAttribute("aria-expanded") !== null, workId, { timeout: 8000 });
  if ((await row.getAttribute("aria-expanded")) === "false") await row.locator(".row-chevron").click();
}

async function flow(provider: Provider) {
  const label = provider === "codex" ? "Codex" : "Claude";
  // Each engine starts from the same screen preferences (no width remembered from the other run).
  await api("PUT", "/api/prefs", { prefs: { onboarding: "done", startScreen: "last" } });
  const work = await api<Work>("POST", "/api/works", { title: `${label} 두 칸`, cwd: join(worksDir, provider) });
  const session = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider, purpose: "대화", access: "auto" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("console", (message) => message.type() === "error" && logs.push(`[${label} error] ${message.text().slice(0, 200)}`));
  page.on("pageerror", (error) => logs.push(`[${label} pageerror] ${error.message.slice(0, 200)}`));
  const shot = (name: string) => page.screenshot({ path: join(outDir, `${provider}-${name}`) });
  const pass = (step: string, ok: boolean, detail = "") => check(`[${label}] ${step}`, ok, detail);
  try {
    await page.addInitScript((id) => localStorage.setItem("workbench.lastWork", id), work.id);
    await page.goto(`${ready.url}/?token=${ready.token}`);
    await page.waitForSelector(".work-view .composer-input");
    await page.waitForSelector(".vault-tree .vault-row", { timeout: 10_000 });

    // ── 볼트 전체 접기 / 전체 펼치기 ─────────────────────────────────────────────────────────
    const info = vaultRow(page, "20. Information (I)");
    await info.scrollIntoViewIfNeeded();
    await info.locator(".row-chevron").click();
    await page.waitForSelector('.vault-row[data-vault-path="20. Information (I)/201. 주제별"]');
    const open = await page.locator(".vault-tree .vault-row").count();
    await page.locator(".vault-collapse").click();
    await page.waitForSelector('.vault-row[data-vault-path="20. Information (I)/201. 주제별"]', { state: "detached" });
    const folded = await page.locator(".vault-tree .vault-row").count();
    const resting = await page.locator(".vault-collapse").isDisabled();
    const remembered = await page.evaluate(() => localStorage.getItem("workbench.vaultOpen"));
    await page.locator(".vault-section").screenshot({ path: join(outDir, `${provider}-01-vault-folded.png`) });
    await page.reload();
    await page.waitForSelector(".vault-tree .vault-row", { timeout: 10_000 });
    const afterReload = await page.locator('.vault-row[data-vault-path="20. Information (I)/201. 주제별"]').count();
    pass("볼트 '전체 접기': 펼친 폴더가 모두 접히고(버튼은 쉼) 다시 열어도 접힌 채", folded === open - 1 && resting && remembered === "[]" && afterReload === 0, `${open} → ${folded}줄 · 저장 ${remembered}`);
    await page.locator('.vault-section .side-tools [title="볼트 메뉴"]').click();
    await page.locator(".context-menu [role=menuitem]", { hasText: "전체 펼치기" }).click();
    await page.waitForSelector('.vault-row[data-vault-path="10. Data (D)/101. 기록"]');
    const unfolded = await page.locator(".vault-tree .vault-row").allInnerTexts();
    await page.locator(".vault-section").screenshot({ path: join(outDir, `${provider}-02-vault-unfolded.png`) });
    pass(
      "볼트 '⋯ › 전체 펼치기': 하위 폴더가 있는 폴더가 모두 펼쳐짐",
      ["101. 기록", "201. 주제별", "AI영상제작실습"].every((name) => unfolded.some((text) => text.includes(name))),
      `${unfolded.length}줄`,
    );
    await page.locator(".vault-collapse").click();

    // ── the whole vault folded to its heading line (the heading, or the vault's own row) ─────────
    await page.locator(".vault-fold").click();
    await page.waitForSelector(".vault-section.folded");
    const oneLine = (await page.locator(".vault-section .vault-row, .vault-section .vault-pins").count()) === 0;
    const foldedCount = (await page.locator(".vault-section.folded .vault-count").innerText()).trim();
    await page.locator(".sidebar").screenshot({ path: join(outDir, `${provider}-03-vault-one-line.png`) });
    await page.reload();
    await page.waitForSelector(".vault-section.folded", { timeout: 10_000 });
    const staysFolded = (await page.locator(".vault-section .vault-row").count()) === 0;
    await page.locator(".vault-fold").click();
    await page.waitForSelector(".vault-row.vault-root");
    await page.locator(".vault-row.vault-root .row-chevron").click();
    await page.waitForSelector(".vault-section.folded");
    const rootFolds = (await page.locator(".vault-section .vault-row").count()) === 0;
    const headFocused = await until(() => page.evaluate(() => document.activeElement?.classList.contains("vault-fold") ?? false), 2000);
    await page.locator(".vault-fold").click();
    await page.waitForSelector(".vault-row.vault-root");
    pass(
      "볼트 한 줄로 접기: 머리나 볼트 맨 위 줄로 접으면 머리 한 줄만(노트 수와 함께), 다시 열어도 접힌 채, 펼치면 돌아옴",
      oneLine && Boolean(foldedCount) && staysFolded && rootFolds && headFocused,
      `접힌 머리 ${foldedCount}`,
    );

    // ── the document on screen: its tab dragged to the right half, its conversation stays left ──
    const doc = await api<{ id: string; name: string }>("POST", `/api/works/${work.id}/pages`, { name: "수업 계획" });
    await page.locator(".work-view .docs-button").click();
    await page.locator(".docs-menu .menu-item", { hasText: "수업 계획" }).click();
    await page.waitForSelector(".document-view .doc-tab-open");
    const tab = page.locator(".doc-tab-open", { hasText: "수업 계획" });
    const area = (await page.locator(".panes").boundingBox())!;
    let docPreview = "";
    await drag(page, center((await tab.boundingBox())!), { x: area.x + area.width * 0.8, y: area.y + area.height * 0.5 }, async () => {
      docPreview = (await page.locator(".pane-drop-zone.right .pane-drop-label").innerText().catch(() => "")).trim();
    });
    await page.waitForSelector(".panes.two .pane.right .document-view", { timeout: 10_000 });
    const conversationLeft = await page.locator(".pane.left .work-view").count();
    const splitRests = await page.locator('.pane.right .work-mode-bar [data-mode="split"]').isDisabled();
    await page.waitForTimeout(300);
    await shot("03a-doc-tab.png");
    pass("보던 문서의 탭을 오른쪽 반에 끌면 문서는 오른쪽, 그 작업의 대화는 왼쪽('나란히'는 쉼)", docPreview.includes("오른쪽에 열기") && conversationLeft === 1 && splitRests, doc.name);
    await page.locator('.pane.right .pane-head [aria-label$="칸 닫기"]').click();
    await page.waitForSelector(".panes.two", { state: "detached" });

    // ── a pinned vault note dragged onto the right half: two panes ───────────────────────────
    const pins = page.locator(".vault-pins");
    await pins.scrollIntoViewIfNeeded();
    if ((await pins.getAttribute("aria-expanded")) !== "true") await pins.click();
    const pinned = page.locator(".vault-note", { hasText: "AI 글쓰기 수업 설계" });
    await pinned.scrollIntoViewIfNeeded();
    const host = (await page.locator(".panes").boundingBox())!;
    let preview = "";
    await drag(page, center((await pinned.boundingBox())!), { x: host.x + host.width * 0.8, y: host.y + host.height * 0.45 }, async () => {
      preview = (await page.locator(".pane-drop-zone.right .pane-drop-label").innerText().catch(() => "")).trim();
      await shot("03-drag-note.png");
    });
    await page.waitForSelector(".panes.two .pane.right .pkm-note-view .pkm-note-body", { timeout: 10_000 });
    const leftChat = await page.locator(".panes.two .pane.left .work-view").count();
    const noteTitle = await page.locator(".pane.right .pkm-title").innerText();
    const focusedRight = await page.locator(".pane.right.focused").count();
    const ruled = await page.locator(".pane.right .pane-head").evaluate((element) => getComputedStyle(element).boxShadow);
    await page.waitForTimeout(250);
    await shot("04-two-panes.png");
    pass(
      "볼트 노트를 오른쪽 반에 끌어 놓으면(포인터) 놓을 자리가 보이고 두 칸: 왼쪽 대화, 오른쪽 노트(초점, 머리 밑줄)",
      preview.includes("오른쪽에 열기") && leftChat === 1 && noteTitle.includes("AI 글쓰기 수업 설계") && focusedRight === 1 && ruled.includes("inset"),
      `미리보기 "${preview}" · ${noteTitle}`,
    );

    // ── a request in the session pane while the note stays ───────────────────────────────────
    const leftInput = page.locator(".pane.left .composer-input");
    await leftInput.click();
    const focusedLeft = await page.locator(".pane.left.focused").count();
    const before = await turnsOf(session.id);
    await leftInput.fill("두 칸에서 보낸 요청");
    await leftInput.press("Enter");
    const answered = await until(async () => (await turnsOf(session.id)) > before, 20_000);
    await page.locator(".pane.left .turn-request", { hasText: "두 칸에서 보낸 요청" }).waitFor({ timeout: 8000 });
    await page.waitForTimeout(400);
    const noteStays = await page.locator(".pane.right .pkm-note-view .pkm-title").innerText().catch(() => "");
    await shot("05-sent.png");
    pass("왼쪽 대화 칸에서 보낸 요청의 답이 그 칸에, 오른쪽 노트는 그대로(누른 칸에 초점)", answered && focusedLeft === 1 && noteStays.includes("AI 글쓰기 수업 설계"));

    // ── the note's header dropped on the session's input attaches it (no drop zone takes it) ──
    const head = center((await page.locator(".pane.right .pane-head-title").boundingBox())!);
    const input = center((await page.locator(".pane.left .composer").boundingBox())!);
    let over = 0;
    let zones = -1;
    await drag(page, head, input, async () => {
      over = await page.locator(".pane.left .composer-area.note-over").count();
      zones = await page.locator(".pane-drop-zone").count();
      await shot("06-note-on-input.png");
    });
    const chip = await page.locator(".pane.left .composer-area .note-chip").innerText().catch(() => "");
    pass("노트 칸의 머리를 대화 입력창에 끌어 놓으면 노트가 붙음(놓을 자리 표시가 가로채지 않음)", over === 1 && zones === 0 && chip.includes("AI 글쓰기 수업 설계"), chip.split("\n")[0]);
    const before2 = await turnsOf(session.id);
    await leftInput.fill("이 노트를 참고해 줘");
    await leftInput.press("Enter");
    await until(async () => (await turnsOf(session.id)) > before2, 20_000);
    const log = await items(session.id);
    const request = [...log].reverse().find((item): item is Extract<TranscriptItem, { kind: "user" }> => item.kind === "user");
    const reply = log.filter((item) => item.kind === "assistant").map((item) => (item.kind === "assistant" ? item.text : "")).join("\n");
    const copy = /받은 노트 사본: ([^\n|]+)/.exec(reply)?.[1]?.trim() ?? "";
    await page.locator(".pane.left .turn-request .note-chip").first().waitFor({ timeout: 5000 });
    pass("붙인 노트는 그 세션의 다음 요청과 가고 엔진은 읽기 전용 사본을 받음", request?.notes?.[0]?.path === NOTE && copy.startsWith(".workbench/notes/"), copy);

    // ── the divider: drag (remembered), keyboard, double-click ───────────────────────────────
    const leftBefore = await widthOf(page, ".pane.left");
    const divider = (await page.locator(".pane-divider").boundingBox())!;
    await page.mouse.move(divider.x + divider.width / 2, divider.y + 300);
    await page.mouse.down();
    await page.mouse.move(divider.x + 160, divider.y + 320, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const leftAfter = await widthOf(page, ".pane.left");
    const saved = await until(async () => Number((await snapshot()).prefs.paneRatio) > 0.55, 3000);
    pass("가운데 막대를 끌어 너비 조절(기억됨)", leftAfter > leftBefore + 120 && saved, `${Math.round(leftBefore)} → ${Math.round(leftAfter)}px`);
    await page.locator(".pane-divider").focus();
    const valueBefore = Number(await page.locator(".pane-divider").getAttribute("aria-valuenow"));
    for (let step = 0; step < 5; step += 1) await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(200);
    const valueAfter = Number(await page.locator(".pane-divider").getAttribute("aria-valuenow"));
    const keyed = await widthOf(page, ".pane.left");
    await page.locator(".pane-divider").dblclick();
    await page.waitForTimeout(300);
    const halves = [await widthOf(page, ".pane.left"), await widthOf(page, ".pane.right")];
    pass(
      "막대에 초점을 두고 ←로 줄이고(키보드), 두 번 누르면 반반",
      valueAfter === valueBefore - 10 && keyed < leftAfter - 60 && Math.abs(halves[0]! - halves[1]!) < 4,
      `${valueBefore}% → ${valueAfter}% · 반반 ${halves.map(Math.round).join("/")}`,
    );

    // ── "오른쪽에 열기" on a vault folder: its cards on the right, a card opens there ─────────
    await vaultRow(page, "30. Knowledge (K)").scrollIntoViewIfNeeded();
    await vaultRow(page, "30. Knowledge (K)").click({ button: "right" });
    await page.locator(".context-menu [role=menuitem]", { hasText: "오른쪽에 열기" }).click();
    await page.waitForSelector(".pane.right .pkm-cards .pkm-card", { timeout: 10_000 });
    await page.locator(".pane.right .pkm-card", { hasText: "글쓰기 피드백 원칙" }).click();
    await page.waitForSelector(".pane.right .pkm-note-view .pkm-note-body");
    const cardNote = await page.locator(".pane.right .pkm-title").innerText();
    const chatStays = await page.locator(".pane.left .work-view .turn-request", { hasText: "두 칸에서 보낸 요청" }).count();
    await shot("07-open-right.png");
    pass("볼트 폴더의 '오른쪽에 열기': 오른쪽 칸에 카드, 카드를 누르면 그 칸에서 노트(왼쪽 대화 그대로)", cardNote.includes("글쓰기 피드백 원칙") && chatStays === 1, cardNote);

    // ── Ctrl+click and a middle click: on the right ─────────────────────────────────────────
    await page.locator(".vault-note", { hasText: "AI 글쓰기 수업 설계" }).click({ button: "middle" });
    const middle = await page
      .waitForFunction(() => document.querySelector(".pane.right .pkm-title")?.textContent?.includes("AI 글쓰기 수업 설계"), undefined, { timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    await page.locator(".vault-note", { hasText: "연구 질문 모음" }).click({ modifiers: ["Control"] });
    await page.waitForFunction(() => document.querySelector(".pane.right .pkm-title")?.textContent?.includes("연구 질문 모음"));
    pass("가운데 클릭·Ctrl+클릭은 오른쪽 칸에 엶(왼쪽 대화 그대로)", middle && (await page.locator(".pane.left .work-view").count()) === 1);

    // ── swap ────────────────────────────────────────────────────────────────────────────────
    await page.locator('.pane.right .pane-head [aria-label="두 칸 자리 바꾸기"]').click();
    await page.waitForSelector(".pane.left .pkm-note-view");
    const swapped = (await page.locator(".pane.right .work-view").count()) === 1;
    await shot("08-swapped.png");
    await page.locator('.pane.left .pane-head [aria-label="두 칸 자리 바꾸기"]').click();
    await page.waitForSelector(".pane.right .pkm-note-view");
    pass("자리 바꾸기: 두 칸이 좌우를 바꾸고 다시 돌아옴", swapped);

    // ── ⋯ › 단축키 "다른 칸으로" (F6) and Alt+Enter in the search box ─────────────────────────
    const focusedSide = () => page.evaluate(() => (document.querySelector(".pane.focused")?.classList.contains("right") ? "right" : "left"));
    const sideBefore = await focusedSide();
    await page.locator("body").press("F6");
    const moved = await until(async () => (await focusedSide()) !== sideBefore, 3000);
    await page.locator("body").press("F6");
    const back = await until(async () => (await focusedSide()) === sideBefore, 3000);
    pass("F6(다른 칸으로): 초점이 다른 칸으로 갔다가 돌아옴", moved && back, `${sideBefore} → ${moved ? (sideBefore === "left" ? "right" : "left") : sideBefore}`);
    await page.locator(".pane.left").click({ position: { x: 40, y: 120 } });
    await page.keyboard.press("Control+K");
    await page.waitForSelector(".palette-input input");
    await page.locator(".palette-input input").fill("연구 질문");
    await page.waitForFunction(() => document.querySelector(".palette .search-summary") !== null && !document.querySelector(".palette .spinner"), undefined, { timeout: 8000 }).catch(() => undefined);
    await page.locator(".palette-input input").press("Alt+Enter");
    const opened = await page
      .waitForFunction(() => document.querySelector(".pane.right .pkm-title")?.textContent?.includes("연구 질문"), undefined, { timeout: 6000 })
      .then(() => true)
      .catch(() => false);
    pass("찾기에서 Alt+Enter: 고른 결과가 오른쪽 칸에 열림", opened && (await page.locator(".palette").count()) === 0);

    // ── home's number keys (1–4) belong to the pane with the focus ───────────────────────────
    await page.locator(".pane.left").click({ position: { x: 40, y: 120 } });
    await page.locator(".sidebar .side-home").click();
    await page.waitForSelector(".pane.left .home-modes");
    const homeMode = () => page.evaluate(() => document.querySelector(".pane.left .home-modes")?.className.match(/\bmode-[a-z]+/)?.[0] ?? "");
    const homeBefore = await homeMode();
    const digit = homeBefore === "mode-flow" ? "4" : "3";
    await page.locator(".pane.right .pkm-note-body").click();
    await page.waitForSelector(".pane.right.focused");
    await page.keyboard.press(digit);
    await page.waitForTimeout(400);
    const stayed = (await homeMode()) === homeBefore;
    await page.locator(".pane.left .pane-head-title").click();
    await page.waitForSelector(".pane.left.focused");
    await page.keyboard.press(digit);
    const homeSwitched = await until(async () => (await homeMode()) !== homeBefore, 3000);
    pass("두 칸일 때 홈의 숫자 키는 초점 있는 칸만: 노트 칸에서 누르면 홈 그대로, 홈 칸에서 누르면 바뀜", stayed && homeSwitched, `${homeBefore} → ${await homeMode()}`);
    // The conversation back on the left, as the steps below expect.
    await page.locator(`.sidebar [data-row-id="${work.id}"]`).click();
    await page.waitForSelector(".pane.left .work-view .composer-input");

    // ── a conversation already in the other pane: the click goes there, not twice ────────────
    await page.locator(".pane.right .pkm-note-body").click();
    const noteFocused = await page.locator(".pane.right.focused").count();
    await page.locator(`.sidebar [data-row-id="${work.id}"]`).click();
    await page.waitForSelector(".pane.left.focused");
    pass(
      "다른 칸에 이미 열린 대화를 사이드바에서 누르면 그 칸으로 초점(두 번 열리지 않음)",
      noteFocused === 1 && (await page.locator(".work-view").count()) === 1 && (await page.locator(".pane.right .pkm-note-view").count()) === 1,
    );

    // ── two sessions of one work side by side, each pane sending to its own ───────────────────
    // A new session becomes its work's active one, and the focused pane follows it (as the single
    // view always has); the first one goes back to the left pane from the sidebar.
    const second = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider, purpose: "둘째", access: "auto" });
    await unfold(page, work.id);
    await page.locator(`.sidebar [data-row-id="${second.id}"]`).waitFor({ timeout: 8000 });
    await page.locator(`.sidebar [data-row-id="${session.id}"]`).click();
    await page.locator(".pane.left .turn-request", { hasText: "두 칸에서 보낸 요청" }).waitFor({ timeout: 8000 });
    await page.locator(`.sidebar [data-row-id="${second.id}"]`).click({ button: "right" });
    await page.locator(".context-menu [role=menuitem]", { hasText: "오른쪽에 열기" }).click();
    await page.waitForSelector(".pane.right .work-view .composer-input");
    const rightInput = page.locator(".pane.right .composer-input");
    await rightInput.click();
    const secondBefore = await turnsOf(second.id);
    const firstBefore = await turnsOf(session.id);
    await rightInput.fill("둘째 칸 요청");
    await rightInput.press("Enter");
    const secondAnswered = await until(async () => (await turnsOf(second.id)) > secondBefore, 20_000);
    await page.locator(".pane.right .turn-request", { hasText: "둘째 칸 요청" }).waitFor({ timeout: 8000 });
    await page.locator(".pane.left .composer-input").click();
    await page.waitForTimeout(300);
    const leftKeeps = await page.locator(".pane.left .turn-request", { hasText: "두 칸에서 보낸 요청" }).count();
    const rightKeeps = await page.locator(".pane.right .turn-request", { hasText: "둘째 칸 요청" }).count();
    const active = (await snapshot()).works.find((entry) => entry.id === work.id)?.activeSessionId;
    await shot("09-two-sessions.png");
    pass(
      "같은 작업의 두 세션을 두 칸에: 오른쪽에서 보낸 요청은 둘째 세션으로, 초점을 옮겨도 각 칸은 자기 세션",
      secondAnswered && (await turnsOf(session.id)) === firstBefore && leftKeeps === 1 && rightKeeps === 1 && active === session.id,
      `작업의 앞 세션 ${active === session.id ? "첫째" : active}`,
    );

    // ── a narrow window: one pane and a notice, never overlapping ───────────────────────────
    await page.setViewportSize({ width: 960, height: 900 });
    await page.waitForTimeout(400);
    const shown = await page.locator(".pane:not([hidden])").count();
    const notice = await page.locator(".pane:not([hidden]) .pane-narrow").innerText().catch(() => "");
    const panesBox = (await page.locator(".panes").boundingBox())!;
    const paneBox = (await page.locator(".pane:not([hidden])").boundingBox())!;
    await shot("10-narrow.png");
    await page.locator(".pane:not([hidden]) .pane-narrow button").click();
    await page.waitForTimeout(200);
    const switched = await page.locator(".pane.right:not([hidden]) .work-view").count();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(300);
    pass(
      "좁은 창: 초점 칸 하나만 보이고 '창이 좁아 한 칸만 보입니다' · 다른 칸 보기로 바꿈(겹치지 않음)",
      shown === 1 && notice.includes("창이 좁아 한 칸만 보입니다") && paneBox.x >= panesBox.x - 1 && paneBox.x + paneBox.width <= panesBox.x + panesBox.width + 1 && switched === 1,
      `보이는 칸 ${shown} · ${notice.split("\n")[0]}`,
    );

    // ── close a pane, then a reload: one pane, the width remembered ─────────────────────────
    await page.locator('.pane.right .pane-head [aria-label$="칸 닫기"]').click();
    await page.waitForSelector(".panes.two", { state: "detached" });
    const closed = (await page.locator(".pane").count()) === 1 && (await page.locator(".work-view").count()) === 1;
    pass("칸 닫기: 한 칸으로 돌아오고 남은 칸이 초점", closed && (await page.locator(".pane-head").count()) === 0);
    await page.locator(`.sidebar [data-row-id="${second.id}"]`).click({ modifiers: ["Control"] });
    await page.waitForSelector(".panes.two");
    const divider2 = (await page.locator(".pane-divider").boundingBox())!;
    await page.mouse.move(divider2.x + divider2.width / 2, divider2.y + 300);
    await page.mouse.down();
    await page.mouse.move(divider2.x + 110, divider2.y + 300, { steps: 6 });
    await page.mouse.up();
    const ratio = await until(async () => Number((await snapshot()).prefs.paneRatio) > 0.55, 3000);
    const kept = Number((await snapshot()).prefs.paneRatio);
    await page.reload();
    await page.waitForSelector(".work-view .composer-input");
    await page.waitForTimeout(300);
    const single = (await page.locator(".pane").count()) === 1 && (await page.locator(".panes.two").count()) === 0;
    await page.locator(`.sidebar [data-row-id="${session.id}"]`).click({ button: "right" });
    await page.locator(".context-menu [role=menuitem]", { hasText: "오른쪽에 열기" }).click().catch(() => undefined);
    await page.waitForSelector(".panes.two").catch(() => undefined);
    await page.waitForTimeout(300);
    const [left, right] = [await widthOf(page, ".pane.left"), await widthOf(page, ".pane.right")];
    pass("다시 열면 한 칸(보기는 복원하지 않음), 칸 너비는 기억됨", ratio && single && Math.abs(left / (left + right) - kept) < 0.02, `너비 ${kept.toFixed(2)} → ${(left / (left + right)).toFixed(2)}`);
    await shot("11-after-reload.png");
  } catch (error) {
    pass("실행", false, error instanceof Error ? error.message.split("\n")[0]! : String(error));
    await shot("failure.png").catch(() => undefined);
  } finally {
    await page.close();
  }
}

/** Two panes in the dark theme (two engines' papers side by side), for the eye. */
async function darkLook() {
  const work = await api<Work>("POST", "/api/works", { title: "어두운 두 칸", cwd: join(worksDir, "dark") });
  const codex = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "codex", purpose: "코덱스", access: "auto" });
  const claude = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "claude", purpose: "클로드", access: "auto" });
  await api("PUT", "/api/prefs", { prefs: { onboarding: "done", startScreen: "last", theme: "dark" } });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("console", (message) => message.type() === "error" && logs.push(`[dark error] ${message.text().slice(0, 200)}`));
  page.on("pageerror", (error) => logs.push(`[dark pageerror] ${error.message.slice(0, 200)}`));
  try {
    await page.addInitScript((id) => localStorage.setItem("workbench.lastWork", id), work.id);
    await page.goto(`${ready.url}/?token=${ready.token}`);
    await page.waitForSelector(".work-view .composer-input");
    await unfold(page, work.id);
    await page.locator(`.sidebar [data-row-id="${codex.id}"]`).click();
    await page.locator(`.sidebar [data-row-id="${claude.id}"]`).click({ modifiers: ["Control"] });
    await page.waitForSelector(".panes.two .pane.right .work-view");
    await page.waitForTimeout(400);
    const looks = await page.locator(".pane").evaluateAll((panes) => panes.map((pane) => `${(pane as HTMLElement).dataset.theme}:${getComputedStyle(pane).backgroundColor}`));
    await page.screenshot({ path: join(outDir, "dark-two-engines.png") });
    check("다크: 두 엔진 세션이 두 칸에서 각자의 룩(종이색)", looks.length === 2 && looks[0] !== looks[1], looks.join(" | "));
  } finally {
    await page.close();
    await api("PUT", "/api/prefs", { prefs: { onboarding: "done", startScreen: "last" } });
  }
}

try {
  for (const provider of providers) await flow(provider);
  await darkLook();
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
