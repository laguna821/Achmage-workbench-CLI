/// <reference lib="dom" />
// Browser check of the sidebar of many sessions against a real gateway, with conversations seeded
// straight into its store (no engine is asked): the tree (folders › works › sessions), "새 답",
// right-click menus, Markdown export, Ctrl+K search over message bodies (jumping to the message),
// archive and restore, moving a work into a folder by dragging, keyboard moves, requests shown
// as Markdown. Usage: node scripts/meta-session-check.ts [outDir]

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Page } from "playwright-core";
import type { Folder, Session, Work } from "@workbench/contracts";
import { seedMetaSessions } from "./seed-meta-sessions.ts";

const outDir = process.argv[2] ?? join(tmpdir(), "wb-meta-session");
mkdirSync(outDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "workbench-meta-"));
const worksDir = mkdtempSync(join(tmpdir(), "workbench-meta-works-"));
const results: { step: string; ok: boolean; detail: string }[] = [];
const check = (step: string, ok: boolean, detail = "") => {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`);
};

// ── seed: two folders, four works, five sessions with Korean conversations ─────────────────
const now = Date.now();
const { works } = seedMetaSessions(dataDir, worksDir, now);

// ── the gateway on that store ───────────────────────────────────────────────────────────────
const child = spawn(process.execPath, ["apps/host/src/main.ts"], {
  env: { ...process.env, WORKBENCH_DATA_DIR: dataDir, WORKBENCH_WEB_DIR: "apps/web/dist", WORKBENCH_HOST_LABEL: "노트북" },
  stdio: ["ignore", "pipe", "inherit"],
});
const ready = await new Promise<{ url: string; token: string }>((resolve) => {
  createInterface({ input: child.stdout! }).on("line", (line) => {
    if (line.startsWith("WORKBENCH_READY ")) resolve(JSON.parse(line.slice(16)));
  });
});
const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${ready.url}${path}`, { method, headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return (await response.json()) as T;
};
const snapshot = () => api<{ works: Work[]; sessions: Session[]; folders: Folder[] }>("GET", "/api/snapshot");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
const logs: string[] = [];
page.on("console", (message) => message.type() === "error" && logs.push(`[error] ${message.text().slice(0, 200)}`));
page.on("pageerror", (error) => logs.push(`[pageerror] ${error.message.slice(0, 200)}`));
const row = (p: Page, id: string) => p.locator(`.sidebar [data-row-id="${id}"]`);
const shot = (name: string) => page.screenshot({ path: join(outDir, name) });

try {
  await page.addInitScript(() => localStorage.setItem("workbench.lastWork", "w7"));
  await page.goto(`${ready.url}/?token=${ready.token}`);
  await page.waitForSelector(".sidebar .side-tree");
  await page.waitForTimeout(500);
  await shot("01-sidebar.png");
  const tree = await page.locator(".sidebar .side-tree [data-row-id]").evaluateAll((elements) => elements.map((element) => (element as HTMLElement).dataset.rowId));
  check(
    "사이드바가 기본으로 열리고 폴더 › 작업 › 세션 트리를 보임",
    ["f-lecture", "f-term", "w7", "s-edit", "s-review", "w8", "f-research"].every((id) => tree.includes(id)),
    tree.join(" "),
  );
  const unseenRow = await page.locator(".side-now .now-unseen").innerText().catch(() => "");
  check("지금 › 새 답에 읽지 않은 답이 있는 세션", unseenRow.includes("자료 검토"), unseenRow.replace(/\s+/g, " "));
  const bubble = await page.locator(".turn-request .user-bubble").first().innerHTML();
  check("요청도 마크다운으로 보임(굵게·목록·줄바꿈)", bubble.includes("<strong>두 문단</strong>") && bubble.includes("<li>"), bubble.slice(0, 120));

  // Opening the session with the new reply marks it read (kept by the gateway).
  await row(page, "s-review").click();
  // The screen drops "새 답" at once; the gateway records it a moment later.
  let seen: Session | undefined;
  for (let tries = 0; tries < 40; tries += 1) {
    seen = (await snapshot()).sessions.find((entry) => entry.id === "s-review");
    if (seen?.seenAt && seen.seenAt >= now) break;
    await page.waitForTimeout(125);
  }
  check("열어 본 세션은 게이트웨이에서 읽음 처리", Boolean(seen?.seenAt && seen.seenAt >= now) && !seen?.unread);

  // Right-click menu on a session.
  await row(page, "s-edit").click({ button: "right" });
  await page.waitForSelector(".context-menu");
  await shot("02-context-menu.png");
  const menuText = await page.locator(".context-menu").first().innerText();
  check("세션 오른쪽 클릭 메뉴", ["이름 바꾸기", "고정", "읽지 않음으로 표시", "마크다운으로 내보내기", "작업 폴더", "보관"].every((label) => menuText.includes(label)), menuText.replace(/\s+/g, " ").slice(0, 160));
  await page.locator(".context-menu-item", { hasText: "마크다운으로 내보내기" }).hover();
  await page.waitForSelector(".context-menu >> nth=1");
  await shot("03-export-submenu.png");
  await page.locator(".context-menu").nth(1).locator(".context-menu-item", { hasText: "작업 폴더에 저장" }).click();
  await page.waitForSelector(".toast");
  const exported = join(works[0]!.cwd, "세션 기록");
  const files = existsSync(exported) ? (await import("node:fs")).readdirSync(exported) : [];
  const markdown = files[0] ? readFileSync(join(exported, files[0]), "utf8") : "";
  check(
    "마크다운으로 내보내기 → 작업 폴더/세션 기록/에 .md",
    files.length === 1 && markdown.includes("# 문서 수정") && markdown.includes("## 2. 자료 찾기 다음에 근거 정리 단계를") && markdown.includes("### 도입부"),
    files.join(", "),
  );
  writeFileSync(join(outDir, "export.md"), markdown);

  // Ctrl+K: message bodies, then Enter jumps to the message.
  await page.keyboard.press("Escape");
  await page.locator(".transcript").first().click({ position: { x: 5, y: 5 } }).catch(() => undefined);
  await page.keyboard.press("Control+k");
  await page.waitForSelector(".palette");
  await page.locator(".palette-input input").fill('"근거 정리"');
  await page.waitForSelector(".palette-entry.kind-hit");
  await page.waitForTimeout(200);
  await shot("04-search.png");
  const hits = await page.locator(".palette-entry.kind-hit").count();
  const marked = await page.locator(".palette-entry.kind-hit mark").first().innerText();
  check("Ctrl+K로 대화 본문 찾기(한국어, 구절, 강조)", hits >= 2 && marked === "근거 정리", `hits=${hits} mark=${marked}`);
  await page.locator(".palette-entry.kind-hit").first().click();
  await page.waitForSelector("[data-item-id].flash", { timeout: 10_000 });
  const flashed = await page.locator("[data-item-id].flash").first().getAttribute("data-item-id");
  await shot("05-jump.png");
  check("찾은 메시지로 이동해 표시", Boolean(flashed), String(flashed));

  // Two-letter words (LIKE) and archived things.
  const two = await api<{ sessions: unknown[] }>("GET", "/api/search?q=%EA%B7%BC%EA%B1%B0");
  check("두 글자 말도 찾음", two.sessions.length >= 3, `sessions=${two.sessions.length}`);

  // Archive from the menu; it leaves the tree, the archive restores it.
  await row(page, "s-review").click({ button: "right" });
  await page.locator(".context-menu-item", { hasText: /^보관/ }).first().click();
  await page.waitForFunction(() => !document.querySelector('.sidebar [data-row-id="s-review"]'), undefined, { timeout: 10_000 }).catch(() => undefined);
  const archived = (await snapshot()).sessions.find((entry) => entry.id === "s-review")!;
  check("오른쪽 클릭 → 보관(트리에서 빠짐)", Boolean(archived.archivedAt) && (await row(page, "s-review").count()) === 0);
  const twoAfter = await api<{ sessions: { sessionId: string }[] }>("GET", "/api/search?q=%EA%B7%BC%EA%B1%B0");
  check("보관한 대화는 찾기에서 빠짐(보관 포함일 때만)", !twoAfter.sessions.some((entry) => entry.sessionId === "s-review"));
  await page.locator(".side-foot .side-row", { hasText: "보관함" }).click();
  await page.waitForSelector(".archive-view .archive-row");
  await shot("06-archive.png");
  await page.locator(".archive-row", { hasText: "자료 검토" }).getByRole("button", { name: /되돌리기/ }).click();
  await page.waitForFunction(() => !document.querySelector(".archive-row"), undefined, { timeout: 10_000 }).catch(() => undefined);
  check("보관함에서 되돌리기", !(await snapshot()).sessions.find((entry) => entry.id === "s-review")!.archivedAt);

  // Drag "보고서 초안" (no folder) into "연구".
  await page.locator(".archive-head .icon-button").click().catch(() => undefined);
  const from = await row(page, "wloose").boundingBox();
  const to = await row(page, "f-research").boundingBox();
  if (from && to) {
    await page.mouse.move(from.x + 40, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 60, from.y + from.height / 2 - 10, { steps: 4 });
    await page.mouse.move(to.x + 60, to.y + to.height / 2, { steps: 8 });
    await page.waitForTimeout(100);
    await shot("07-drag.png");
    await page.mouse.up();
  }
  await page.waitForTimeout(600);
  check("작업을 폴더로 끌어 옮기기", (await snapshot()).works.find((entry) => entry.id === "wloose")!.folderId === "f-research");

  // Keyboard: F2 rename, Alt+↓ reorder.
  await row(page, "w8").focus();
  await page.keyboard.press("F2");
  await page.locator(".sidebar .side-rename").fill("8주차 자료");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  check("F2로 이름 바꾸기", (await snapshot()).works.find((entry) => entry.id === "w8")!.title === "8주차 자료");
  await row(page, "w7").focus();
  await page.keyboard.press("Alt+ArrowDown");
  await page.waitForTimeout(500);
  const order = (await snapshot()).works.filter((entry) => entry.folderId === "f-term").sort((a, b) => a.sort - b.sort).map((entry) => entry.id);
  check("Alt+↓로 순서 바꾸기", order.join(",") === "w8,w7", order.join(","));
  // Home: the logo opens it; what is going on across works, and a session opens from it.
  await page.locator(".topbar .brand").click();
  await page.waitForSelector(".home-board");
  await page.waitForTimeout(800);
  await shot("08-home.png");
  const sections = await page.locator(".home-section .section-label").allInnerTexts();
  const homeRow = await page.locator(".sidebar .side-home.current").count();
  check("로고를 누르면 홈(지금·이어서 하기·작업)과 사이드바 '홈' 표시", sections.includes("이어서 하기") && sections.includes("작업") && homeRow === 1, sections.join(", "));
  await page.locator(".home-session", { hasText: "자료 검토" }).first().click();
  await page.waitForSelector(".work-view .transcript");
  check("홈에서 세션을 누르면 그 세션이 열림", (await page.locator(".topbar").innerText()).includes("7주차 강의 자료"));

  // The sort menu opens above the tree (it used to be drawn under the rows).
  await page.locator('.sidebar button[title="정렬"]').click();
  await page.waitForSelector(".context-menu");
  const covered = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll<HTMLElement>(".context-menu .context-menu-item"));
    return items.map((item) => {
      const box = item.getBoundingClientRect();
      const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return Boolean(top && item.contains(top));
    });
  });
  await shot("09-sort-menu.png");
  // Three orders, then "다른 곳의 대화 가져오기…".
  check("사이드바 정렬 메뉴가 트리에 가려지지 않음", covered.length === 4 && covered.every(Boolean), covered.join(","));
  await page.keyboard.press("Escape");

  // Notion's "+": a page in the work folder, opened at once and listed in the tree.
  await row(page, "w8").hover();
  await row(page, "w8").locator(".row-add").click();
  await page.waitForSelector(".document-view, .doc-view, [data-artifact-id]", { timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(600);
  const pageFile = join(works[1]!.cwd, "제목 없음.md");
  const listed = await page.locator(".sidebar .side-row", { hasText: "제목 없음.md" }).count();
  await shot("10-new-page.png");
  check("작업 줄의 + 로 새 페이지(.md)를 만들고 바로 엶", existsSync(pageFile) && readFileSync(pageFile, "utf8").startsWith("# 제목 없음") && listed >= 1, `file=${existsSync(pageFile)} listed=${listed}`);
  await shot("11-final.png");
} catch (error) {
  check("실행", false, error instanceof Error ? error.message.split("\n")[0]! : String(error));
  await page.screenshot({ path: join(outDir, "99-failure.png") }).catch(() => undefined);
} finally {
  writeFileSync(join(outDir, "console.log"), logs.join("\n"));
  writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
  await browser.close();
  child.kill();
  await new Promise((resolve) => (child.exitCode === null && child.signalCode === null ? child.once("exit", resolve) : resolve(null)));
  for (const dir of [dataDir, worksDir]) rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((result) => !result.ok).length;
  console.log(`${results.length - failed}/${results.length} passed · console: ${logs.length ? logs.slice(0, 6).join(" | ") : "clean"}`);
  process.exitCode = failed ? 1 : 0;
}
