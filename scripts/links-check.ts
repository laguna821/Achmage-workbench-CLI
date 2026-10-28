/// <reference lib="dom" />
// Browser check of "세션 잇기" against a real gateway driving stand-in engines (no model):
// a Claude↔Codex link set up in the dialog (presets, steppers, the session row's right-click menu)
// runs two rounds and ends with a card in both conversations — once with Claude speaking first,
// once with Codex; the bar, the sidebar badges and the connector show while it runs; "주고받은
// 내용" lists every turn in one column and saves as Markdown. Then three sessions linked by
// dragging one session row onto another: typing into a participant pauses it, "이어 가기" goes on,
// "끊기" ends it and stops the running turn. A link started from Ctrl+K ends on [[합의]], and a
// message another Claude Code session sends shows in the conversation.
// Usage: node scripts/links-check.ts [outDir]

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Page } from "playwright-core";
import type { Provider, Session, SessionLink, TranscriptItem, Work } from "@workbench/contracts";

const outDir = process.argv[2] ?? join(tmpdir(), "wb-links");
mkdirSync(outDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "workbench-links-"));
const worksDir = mkdtempSync(join(tmpdir(), "workbench-links-works-"));
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
const snapshot = () => api<{ sessions: Session[]; links: SessionLink[] }>("GET", "/api/snapshot");
const session = async (id: string) => (await snapshot()).sessions.find((entry) => entry.id === id)!;
const linkWith = async (sessionId: string) => (await snapshot()).links.filter((link) => link.participants.includes(sessionId)).sort((a, b) => b.startedAt - a.startedAt)[0];
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

// Two works: a Claude and a Codex session to link in the dialog; three sessions to link by dragging.
for (const name of ["pair", "trio"]) mkdirSync(join(worksDir, name), { recursive: true });
const pairWork = await api<Work>("POST", "/api/works", { title: "강의 계획", cwd: join(worksDir, "pair") });
const claude = await api<Session>("POST", `/api/works/${pairWork.id}/sessions`, { provider: "claude", purpose: "검토" });
const codex = await api<Session>("POST", `/api/works/${pairWork.id}/sessions`, { provider: "codex", purpose: "초안" });
const trioWork = await api<Work>("POST", "/api/works", { title: "세 세션", cwd: join(worksDir, "trio") });
const c2 = await api<Session>("POST", `/api/works/${trioWork.id}/sessions`, { provider: "claude", purpose: "구성" });
const x2 = await api<Session>("POST", `/api/works/${trioWork.id}/sessions`, { provider: "codex", purpose: "자료" });
const c3 = await api<Session>("POST", `/api/works/${trioWork.id}/sessions`, { provider: "claude", purpose: "편집" });

const browser = await chromium.launch();
const logs: string[] = [];

async function open(work: Work, active: Session) {
  await api("PATCH", `/api/works/${work.id}`, { activeSessionId: active.id });
  const page = await browser.newPage({ viewport: { width: 1320, height: 880 } });
  page.on("console", (message) => message.type() === "error" && logs.push(`[error] ${message.text().slice(0, 200)}`));
  page.on("pageerror", (error) => logs.push(`[pageerror] ${error.message.slice(0, 200)}`));
  await page.addInitScript((id) => localStorage.setItem("workbench.lastWork", id), work.id);
  await page.goto(`${ready.url}/?token=${ready.token}`);
  await page.waitForSelector(".composer-input");
  await page.waitForSelector(`.side-tree [data-row-id="${active.id}"]`);
  await page.waitForTimeout(300);
  return page;
}

const row = (page: Page, id: string) => page.locator(`.side-tree [data-row-id="${id}"]`);
const stepper = async (page: Page, label: string) => (await page.locator(`.linked-stepper[aria-label="${label}"] .linked-stepper-value`).innerText()).trim();

/** Claude↔Codex in the dialog, two rounds, `first` speaking first. */
async function dialogFlow(first: Provider) {
  const label = first === "claude" ? "Claude 먼저" : "Codex 먼저";
  const starter = first === "claude" ? claude : codex;
  const other = first === "claude" ? codex : claude;
  const pass = (step: string, ok: boolean, detail = "") => check(`[${label}] ${step}`, ok, detail);
  // The Codex-first run is seen in the dark theme.
  await api("PUT", "/api/prefs", { prefs: { onboarding: "done", startScreen: "last", ...(first === "codex" ? { theme: "dark" } : {}) } });
  const page = await open(pairWork, starter);
  const shot = (name: string) => page.screenshot({ path: join(outDir, `${first}-${name}`) });
  try {
    // ── the dialog from the session row's right-click menu ───────────────────────────────────
    await row(page, starter.id).click({ button: "right" });
    await page.locator(".context-menu-item", { hasText: "세션 잇기…" }).click();
    await page.waitForSelector(".linked-dialog");
    const preselected = (await page.locator(".linked-order-chip").allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim());
    await page.locator(".linked-candidate", { hasText: other.purpose }).click();
    const order = (await page.locator(".linked-order-chip").allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim());
    pass("오른쪽 클릭 '세션 잇기…'로 연 창에 그 세션이 먼저, 고른 세션이 다음", preselected.length === 1 && preselected[0]!.includes(starter.purpose) && order.length === 2 && order[1]!.includes(other.purpose), order.join(" → "));

    // ── presets and steppers ───────────────────────────────────────────────────────────────────
    const values: string[] = [];
    await page.locator(".linked-preset", { hasText: "가볍게" }).click();
    values.push(`${await stepper(page, "왕복")}·${await stepper(page, "시간")}`);
    await page.locator('button[aria-label="왕복 늘리기"]').click();
    await page.locator('button[aria-label="시간 늘리기"]').click();
    values.push(`${await stepper(page, "왕복")}·${await stepper(page, "시간")}`);
    const noPreset = (await page.locator(".linked-preset.active").count()) === 0;
    await page.locator(".linked-preset", { hasText: "깊게" }).click();
    values.push(`${await stepper(page, "왕복")}·${await stepper(page, "시간")}`);
    await page.locator(".linked-preset", { hasText: "보통" }).click();
    await page.locator('button[aria-label="왕복 줄이기"]').click();
    values.push(`${await stepper(page, "왕복")}·${await stepper(page, "시간")}`);
    await page.locator("#linked-goal").fill("천천히: 강의 계획을 검토하고 고칠 점에 합의");
    const summary = await page.locator(".linked-summary").innerText();
    if (first === "claude") await page.locator(".linked-dialog").screenshot({ path: join(outDir, "01-dialog.png") });
    pass(
      "미리 정한 양(가볍게·깊게·보통)과 왕복·시간 조절",
      values.join(" | ") === "1왕복·10분 | 2왕복·15분 | 6왕복·60분 | 2왕복·30분" && noPreset && summary.includes("모두 4번 주고받고, 길어도 30분이면"),
      `${values.join(" | ")} · ${summary.slice(0, 40)}`,
    );
    await page.locator(".linked-dialog-foot .button.primary").click();
    await page.waitForSelector(".linked-dialog", { state: "detached" });

    // ── while it runs: the bar, the badges and the connector ──────────────────────────────────
    const running = await until(async () => (await linkWith(starter.id))?.hops === 2, 10_000);
    await page.waitForSelector(".linked-bar");
    await page.waitForTimeout(400);
    const bar = (await page.locator(".linked-bar").innerText()).replace(/\s+/g, " ");
    const badges = await page.locator(".side-tree .linked-badge").allInnerTexts();
    const lines = await page.locator(".side-tree .linked-line").count();
    const ticks = await page.locator(".side-tree .linked-line .linked-tick").count();
    await shot("02-running.png");
    pass(
      "진행 중: 입력창 위 막대(⇄ 2/4 · 분 · 차례 · 목표 · 멈춤·끊기·+1왕복), 사이드바 두 줄에 배지와 잇는 선",
      running && /⇄ 2\/4/.test(bar) && /(\d+분|1분 미만)\/30분/.test(bar) && bar.includes("목표") && bar.includes("멈춤") && bar.includes("끊기") && bar.includes("+1왕복") && badges.filter((text) => text.includes("2/4")).length === 2 && lines === 1 && ticks === 2,
      `${bar.slice(0, 90)} · badges=${badges.join(",")} · lines=${lines} ticks=${ticks}`,
    );

    // ── it ends after the rounds, with a card in both conversations ───────────────────────────
    const ended = await until(async () => (await linkWith(starter.id))?.state === "ended", 30_000);
    const link = (await linkWith(starter.id))!;
    const mine = `[data-link-id="${link.id}"]`;
    await page.waitForSelector(`.linked-end${mine}`);
    const card = (await page.locator(`.linked-end${mine}`).innerText()).replace(/\s+/g, " ");
    const hopsSeen = await page.locator(`.turn-request .linked-hop${mine}`).count();
    const relayed = (await items(other.id)).filter((item) => item.kind === "user" && item.link?.linkId === link.id).length;
    const engineSaw = (await items(starter.id)).filter((item) => item.kind === "user" && item.link?.linkId === link.id && item.link.fromSessionId === other.id).length;
    await shot("03-ended.png");
    pass(
      "정한 2왕복(4번)을 마치고 끝, 양쪽 대화에 끝 카드·받은 답 표시",
      ended && link.reason === "rounds" && link.hops === 4 && card.includes("정한 왕복을 마침") && card.includes("2/2왕복") && relayed === 2 && engineSaw === 1 && hopsSeen === 2 && (await page.locator(".linked-bar").count()) === 0,
      `${card.slice(0, 80)} · relayed=${relayed} back=${engineSaw} marks=${hopsSeen}`,
    );
    await page.locator(".session-tab", { hasText: other.purpose }).click();
    await page.waitForTimeout(400);
    const otherCard = await page.locator(`.linked-end${mine}`).count();
    pass("상대 세션 대화에도 끝 카드", otherCard === 1);

    // ── "주고받은 내용": one column, saved as Markdown ─────────────────────────────────────────
    const records = join(worksDir, "pair", "세션 기록");
    const before = existsSync(records) ? readdirSync(records).length : 0;
    await page.locator(`.linked-end${mine} .link`, { hasText: "주고받은 내용" }).click();
    await page.waitForSelector(".linked-view .linked-turn:not(.goal)");
    await page.waitForTimeout(300);
    const turns = await page.locator(".linked-view .linked-turn:not(.goal) .linked-turn-who").allInnerTexts();
    const firstEngine = first === "claude" ? "Claude" : "Codex";
    const secondEngine = first === "claude" ? "Codex" : "Claude";
    const ordered = turns.length === 4 && [0, 2].every((index) => turns[index]!.includes(firstEngine)) && [1, 3].every((index) => turns[index]!.includes(secondEngine)) && turns.every((text, index) => text.trim().startsWith(String(index + 1)));
    await page.locator(".linked-view").screenshot({ path: join(outDir, `${first}-04-exchanged.png`) });
    await page.locator(".linked-view .text-button", { hasText: "작업 폴더에 저장" }).click();
    const saved = await until(async () => existsSync(records) && readdirSync(records).filter((name) => name.includes("세션 잇기")).length === before + 1, 5000);
    const toast = await page.locator(".toast").innerText().catch(() => "");
    pass("'주고받은 내용'은 두 세션의 차례를 순서대로 한 열에, 작업 폴더에 마크다운으로 저장", ordered && saved && toast.includes("세션 기록/"), `${turns.map((text) => text.replace(/\s+/g, " ").slice(0, 14)).join(" / ")} · ${toast.slice(0, 50)}`);
    await page.keyboard.press("Escape");
    await page.waitForSelector(".linked-view", { state: "detached" });
  } catch (error) {
    pass("실행", false, error instanceof Error ? error.message.split("\n")[0]! : String(error));
    await page.screenshot({ path: join(outDir, `${first}-99-failure.png`) }).catch(() => undefined);
  } finally {
    await page.close();
    await api("PUT", "/api/prefs", { prefs: { onboarding: "done", startScreen: "last" } });
  }
}

/** Three sessions linked by dragging; typing pauses, "이어 가기" goes on, "끊기" ends it. */
async function dragFlow() {
  const pass = (step: string, ok: boolean, detail = "") => check(`[세 세션] ${step}`, ok, detail);
  const page = await open(trioWork, c2);
  const shot = (name: string) => page.screenshot({ path: join(outDir, name) });
  try {
    // ── drag "구성" onto the middle of "자료" ──────────────────────────────────────────────────
    const from = (await row(page, c2.id).boundingBox())!;
    const to = (await row(page, x2.id).boundingBox())!;
    await page.mouse.move(from.x + 40, from.y + from.height / 2);
    await page.mouse.down();
    for (let step = 1; step <= 8; step += 1) await page.mouse.move(from.x + 40, from.y + from.height / 2 + ((to.y + to.height / 2 - from.y - from.height / 2) * step) / 8);
    await page.waitForTimeout(150);
    const highlighted = await row(page, x2.id).evaluate((element) => element.classList.contains("drop-link"));
    const ghost = await page.locator(".drag-ghost").innerText();
    await shot("05-drag.png");
    // The edge of a row still reorders (no link there).
    await page.mouse.move(from.x + 40, to.y + 3);
    await page.waitForTimeout(100);
    const edge = await row(page, x2.id).evaluate((element) => element.className);
    await page.mouse.move(from.x + 40, to.y + to.height / 2);
    await page.waitForTimeout(100);
    await page.mouse.up();
    await page.waitForSelector(".linked-dialog");
    const order = (await page.locator(".linked-order-chip").allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim());
    pass("세션 줄을 다른 세션 줄 가운데로 끌어 놓으면 두 세션이 골라진 잇기 창", highlighted && ghost.includes("⇄ 세션 잇기") && edge.includes("drop-before") && !edge.includes("drop-link") && order.length === 2 && order[0]!.includes("구성") && order[1]!.includes("자료"), `${ghost} · edge=${edge.replace("side-row row-session", "").trim()} · ${order.join(" → ")}`);
    await page.locator(".linked-candidate", { hasText: "편집" }).click();
    await page.locator(".linked-preset", { hasText: "가볍게" }).click();
    await page.locator("#linked-goal").fill("길게: 세 세션이 돌아가며 강의 순서를 다듬기");
    await page.locator(".linked-dialog-foot .button.primary").click();
    await page.waitForSelector(".linked-dialog", { state: "detached" });

    // ── three rows, three badges, one connector; a dot runs on each hand-over ─────────────────
    const second = await until(async () => (await linkWith(c2.id))?.hops === 2, 20_000);
    await page.waitForTimeout(200);
    const badges = await page.locator(".side-tree .linked-badge").allInnerTexts();
    const ticks = await page.locator(".side-tree .linked-line .linked-tick").count();
    const dot = await page.locator(".side-tree .linked-dot").count();
    await shot("06-three-running.png");
    await page.emulateMedia({ reducedMotion: "reduce" });
    const still = await page.locator(".side-tree .linked-dot").evaluate((element) => getComputedStyle(element).display).catch(() => "none");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    pass("세 줄에 ⇄ 2/3 배지, 세 줄을 잇는 선, 넘길 때 점 하나(움직임 줄이기면 없음)", second && badges.filter((text) => text.includes("2/3")).length === 3 && ticks === 3 && dot === 1 && still === "none", `badges=${badges.join(",")} ticks=${ticks} dot=${dot} reduced=${still}`);

    // ── typing into a participant pauses the link ───────────────────────────────────────────────
    await page.locator(".composer-input").fill("잠깐, 지금까지 나온 것을 표로 정리해 줘");
    await page.locator(".composer-input").press("Enter");
    const paused = await until(async () => (await linkWith(c2.id))?.state === "paused", 5000);
    await page.waitForSelector(".linked-bar.paused");
    const pausedBar = (await page.locator(".linked-bar").innerText()).replace(/\s+/g, " ");
    await shot("07-paused.png");
    // Codex finishes its turn; nothing goes on to the third session.
    const codexDone = await until(async () => (await session(x2.id)).status === "idle", 20_000);
    await page.waitForTimeout(500);
    const held = (await linkWith(c2.id))!;
    const thirdGot = (await items(c3.id)).filter((item) => item.kind === "user" && item.link).length;
    pass("참여 세션에 직접 쓰면 멈춤: 막대에 '직접 입력해서 멈춤'과 '이어 가기', 하던 답은 끝나도 넘기지 않음", paused && codexDone && held.state === "paused" && held.reason === "typed" && held.hops === 2 && thirdGot === 0 && pausedBar.includes("직접 입력해서 멈춤") && pausedBar.includes("이어 가기"), pausedBar.slice(0, 80));

    // ── "이어 가기": the latest answer of "자료" goes to "편집" ──────────────────────────────────
    await until(async () => (await session(c2.id)).status === "idle", 10_000);
    await page.locator(".linked-bar .link", { hasText: "이어 가기" }).click();
    const third = await until(async () => (await linkWith(c2.id))?.hops === 3 && (await session(c3.id)).status !== "idle", 8000);
    const handed = (await items(c3.id)).find((item): item is Extract<TranscriptItem, { kind: "user" }> => item.kind === "user" && Boolean(item.link));
    pass("'이어 가기'로 '자료'의 답이 '편집'에 넘어가 다시 진행", third && handed?.link?.fromSessionId === x2.id && (handed.text.includes("Codex의 2번째 의견") ?? false), handed?.text.slice(0, 40) ?? "");

    // ── "끊기": the link ends and the running turn stops ───────────────────────────────────────
    await page.locator(".linked-bar .link.danger", { hasText: "끊기" }).click();
    const cut = await until(async () => (await linkWith(c2.id))?.state === "ended", 5000);
    const stopped = await until(async () => (await items(c3.id)).some((item) => item.kind === "turnEnd" && item.status === "interrupted"), 10_000);
    const trio = (await linkWith(c2.id))!;
    await page.waitForSelector(`.linked-end[data-link-id="${trio.id}"]`);
    const card = (await page.locator(`.linked-end[data-link-id="${trio.id}"]`).innerText()).replace(/\s+/g, " ");
    await page.waitForTimeout(300);
    const left = await page.locator(".side-tree .linked-badge, .side-tree .linked-line").count();
    await shot("08-cut.png");
    pass("'끊기'로 끝나고 '편집'이 하던 답도 멈춤, 끝 카드 '끊음', 배지·선 사라짐", cut && stopped && (await linkWith(c2.id))?.reason === "stopped" && card.includes("끊음") && left === 0, card.slice(0, 60));
  } catch (error) {
    pass("실행", false, error instanceof Error ? error.message.split("\n")[0]! : String(error));
    await page.screenshot({ path: join(outDir, "trio-99-failure.png") }).catch(() => undefined);
  } finally {
    await page.close();
  }
}

/** Ctrl+K "세션 잇기…" and an exchange that ends on [[합의]]; a message from another Claude Code session. */
async function paletteAndPeer() {
  const pass = (step: string, ok: boolean, detail = "") => check(`[Ctrl+K·다른 세션] ${step}`, ok, detail);
  const page = await open(pairWork, codex);
  const shot = (name: string) => page.screenshot({ path: join(outDir, name) });
  try {
    await page.keyboard.press("Control+k");
    await page.waitForSelector(".palette input");
    await page.keyboard.type("> 세션 잇기");
    await page.waitForTimeout(200);
    await page.keyboard.press("Enter");
    await page.waitForSelector(".linked-dialog");
    const chosen = await page.locator(".linked-order-chip").allInnerTexts();
    await page.locator(".linked-candidate", { hasText: "검토" }).click();
    await page.locator("#linked-goal").fill("합의:2 두 엔진이 고칠 점 하나에 합의하기");
    await page.locator(".linked-dialog-foot .button.primary").click();
    const agreed = await until(async () => (await linkWith(codex.id))?.state === "ended", 15_000);
    const link = (await linkWith(codex.id))!;
    await page.waitForSelector(`.linked-end[data-link-id="${link.id}"]`);
    const card = (await page.locator(`.linked-end[data-link-id="${link.id}"]`).innerText()).replace(/\s+/g, " ");
    await shot("09-agreed.png");
    pass("Ctrl+K '세션 잇기…'에서 지금 세션이 골라진 창, [[합의]]로 2번째에 끝남", chosen.length === 1 && chosen[0]!.includes("초안") && agreed && link.reason === "agreed" && link.hops === 2 && card.includes("합의"), `${link.reason} ${link.hops} · ${card.slice(0, 40)}`);

    // A message another Claude Code session sends into the Claude session shows as such.
    await page.locator(".session-tab", { hasText: "검토" }).click();
    await page.waitForTimeout(300);
    await page.locator(".composer-input").fill("다른 세션 메시지가 오면 보여 줘");
    await page.locator(".composer-input").press("Enter");
    const answered = await until(async () => (await items(claude.id)).filter((item) => item.kind === "turnEnd").length >= 4 && (await session(claude.id)).status === "idle", 15_000);
    await page.waitForSelector(".peer-badge");
    const badge = await page.locator(".peer-badge").innerText();
    await page.locator(".peer-badge").scrollIntoViewIfNeeded();
    await shot("10-peer.png");
    pass("다른 Claude Code 세션이 보낸 메시지가 '다른 세션에서 온 메시지 · 이름'으로 보이고 그 답이 이어짐", answered && badge.includes("다른 세션에서 온 메시지 · 리서치 세션"), badge);
  } catch (error) {
    pass("실행", false, error instanceof Error ? error.message.split("\n")[0]! : String(error));
    await page.screenshot({ path: join(outDir, "palette-99-failure.png") }).catch(() => undefined);
  } finally {
    await page.close();
  }
}

try {
  await dialogFlow("claude");
  await dialogFlow("codex");
  await dragFlow();
  await paletteAndPeer();
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
