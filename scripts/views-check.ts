/// <reference lib="dom" />
// Browser check of the view modes, for Codex and Claude alike, against a real gateway driving
// stand-in engines (no model), on a store seeded with 120 sessions:
// - home: 지금 · 프로젝트 · 흐름 · 문서 by click and by keys 1–4 (not while typing), the FLIP
//   move (sessions in 지금's rows slide into the chips of the project cards), the mind map, the
//   projects' table (sorting) and kanban (a card dragged to a stage writes it), the mode kept in
//   the preferences, "모두 읽음" on 지금's 새 답, how long a switch takes with 100+ sessions;
// - the work screen while a document is open: 검토 opens the proposal a "고쳐" request made,
//   대화 ↔ 문서 keep where each was read, 나란히 has one input that follows the clicked side and a
//   divider that resizes, 읽기 pages through the document and Esc returns; 나란히 is not restored
//   after a reload;
// - "새 창으로 떼어 내기": a window with that one session (no sidebar, no tabs) that sends and receives.
// Usage: node scripts/views-check.ts [outDir] [codex|claude]

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Page } from "playwright-core";
import type { Artifact, Proposal, Provider, Session, TranscriptItem, UiPrefs, Work } from "@workbench/contracts";
import { seedViews } from "./seed-views.ts";

const outDir = process.argv[2] ?? join(tmpdir(), "wb-views");
const providers: Provider[] = process.argv[3] === "codex" || process.argv[3] === "claude" ? [process.argv[3]] : ["codex", "claude"];
mkdirSync(outDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "workbench-views-"));
const worksDir = mkdtempSync(join(tmpdir(), "workbench-views-works-"));
const results: { step: string; ok: boolean; detail: string }[] = [];
const check = (step: string, ok: boolean, detail = "") => {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`);
};
const numbers: string[] = [];

const seeded = seedViews(dataDir, worksDir);

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
type Snapshot = { sessions: Session[]; prefs: UiPrefs; proposals: Proposal[]; artifacts: Artifact[] };
const snapshot = () => api<Snapshot>("GET", "/api/snapshot");
const session = async (id: string) => (await snapshot()).sessions.find((entry) => entry.id === id)!;
const items = async (id: string) => (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${id}/items`)).items;
const until = async (what: () => Promise<boolean>, timeout = 15_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await what()) return true;
    await new Promise((done) => setTimeout(done, 100));
  }
  return false;
};
const send = (id: string, text: string) => api("POST", `/api/sessions/${id}/messages`, { requestId: crypto.randomUUID(), text });
// The view modes at the width they were written for: the navigator's "한 칸" layout (navigator-check
// and groups-check cover the two-pane default and a board wider than the centre).
await api("PUT", "/api/prefs", { prefs: { onboarding: "done", startScreen: "last", navigator: { layout: "tree" } } });

const browser = await chromium.launch();
const logs: string[] = [];
const watch = (page: Page, label: string) => {
  page.on("console", (message) => message.type() === "error" && logs.push(`[${label} error] ${message.text().slice(0, 200)}`));
  page.on("pageerror", (error) => logs.push(`[${label} pageerror] ${error.message.slice(0, 200)}`));
};

/** A long Markdown page, so reading takes several pages and scrolling has room. */
const longDoc = () =>
  ["# 7주차 강의안", "", "질문에서 시작하는 수업입니다.", ""]
    .concat(Array.from({ length: 24 }, (_, part) => [`## ${part + 1}. 활동`, "", `${part + 1}번째 활동은 조별로 질문을 고르고 근거를 정리한 뒤 3분 동안 발표하는 순서로 진행합니다. 학생은 자료에서 찾은 문장을 인용하고, 그 문장이 왜 근거가 되는지 한 줄로 설명합니다.`, "", "- 질문 고르기", "- 근거 정리 표", "- 3분 발표", ""]).flat())
    .join("\n");

/** A small PDF of `count` pages (one line of text each), written by hand: no tool needed. */
function smallPdf(count: number) {
  const objects: string[] = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${Array.from({ length: count }, (_, index) => `${4 + index * 2} 0 R`).join(" ")}] /Count ${count} >>`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  for (let index = 0; index < count; index += 1) {
    const text = `BT /F1 40 Tf 72 700 Td (Page ${index + 1}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${5 + index * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`, `<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
  }
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const at = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return at;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return body;
}

/** Boxes that are still moving, or that ended away from where they belong. */
const settled = (page: Page, box: string, holder: string) =>
  page.evaluate(
    ({ box, holder }) => {
      const moving = Array.from(document.querySelectorAll("[data-flip]")).reduce((sum, element) => sum + element.getAnimations().filter((animation) => animation.playState === "running").length, 0);
      let outside = 0;
      let transformed = 0;
      for (const element of Array.from(document.querySelectorAll<HTMLElement>(box))) {
        const parent = element.closest<HTMLElement>(holder);
        if (getComputedStyle(element).transform !== "none") transformed += 1;
        if (!parent) continue;
        const inner = element.getBoundingClientRect();
        const outer = parent.getBoundingClientRect();
        if (inner.left < outer.left - 1 || inner.right > outer.right + 1) outside += 1;
      }
      return { moving, outside, transformed };
    },
    { box, holder },
  );

/** Boxes of the home modes that are moving now (FLIP), not the app's own spinners. */
const flipping = (page: Page) => page.evaluate(() => Array.from(document.querySelectorAll("[data-flip]")).reduce((sum, element) => sum + element.getAnimations().length, 0));

/** Keys go to the page, not to the input that took focus. */
const blur = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

/** Click a home mode and measure until the next painted frame, and how many boxes started to move. */
const switchHome = (page: Page, label: string) =>
  page.evaluate(async (label) => {
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>(".home-mode-bar button")).find((entry) => entry.textContent === label)!;
    const start = performance.now();
    button.click();
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    const moving = Array.from(document.querySelectorAll("[data-flip]")).reduce((sum, element) => sum + element.getAnimations().length, 0);
    return { ms: Math.round(performance.now() - start), moving, nodes: document.querySelector(".home-modes")?.querySelectorAll("*").length ?? 0 };
  }, label);

async function flow(provider: Provider) {
  const label = provider === "codex" ? "Codex" : "Claude";
  const pass = (step: string, ok: boolean, detail = "") => check(`[${label}] ${step}`, ok, detail);
  const cwd = join(worksDir, `${provider}-modes`);
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "강의안.md"), longDoc());
  writeFileSync(join(cwd, "자료.pdf"), smallPdf(3));
  const created = await api<Work>("POST", "/api/works", { title: `${label} 보기 모드`, cwd });
  // Named by hand, so the automatic title (from the requests) leaves it as it is.
  const work = await api<Work>("PATCH", `/api/works/${created.id}`, { title: `${label} 보기 모드` });
  // A few replies not looked at yet, whatever an earlier run marked read.
  for (const id of ["vs1-1", "vs4-2", "vs9-0"]) await api("PATCH", `/api/sessions/${id}`, { seen: false });
  const asking = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider, purpose: "확인 받기", access: "ask" });
  const working = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider, purpose: "긴 답" });
  const doc = await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path: "강의안.md" });
  await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path: "자료.pdf" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  watch(page, label);
  const shot = (name: string, target: Page = page) => target.screenshot({ path: join(outDir, `${provider}-${name}`) });
  const idle = (id: string) => until(async () => (await session(id)).status === "idle", 25_000);
  try {
    await page.addInitScript((id) => localStorage.setItem("workbench.lastWork", id), work.id);
    await page.goto(`${ready.url}/?token=${ready.token}`);
    await page.waitForSelector(".work-view");

    // ── home: 지금 ────────────────────────────────────────────────────────────────────
    await send(asking.id, "명령 실행해 줘");
    await until(async () => (await session(asking.id)).status === "awaitingApproval");
    await send(working.id, "길게 설명해줘");
    await until(async () => (await session(working.id)).status === "running");
    await page.locator(".topbar .brand").click();
    await page.waitForSelector(".home-modes");
    if (!(await page.locator(".home-modes.mode-now").count())) await switchHome(page, "지금");
    await page.waitForSelector(".home-modes.mode-now .bucket-attention");
    const labels = await page.locator(".home-modes .home-section .section-label").allInnerTexts();
    const attention = await page.locator(".bucket-attention .home-session", { hasText: work.title }).count();
    const running = await page.locator(".bucket-running .home-session", { hasText: work.title }).count();
    const order = ["확인 필요", "오류·멈춤", "새 답", "진행"].map((name) => labels.findIndex((text) => text.startsWith(name)));
    pass("지금: 확인 필요 › 오류·멈춤 › 새 답 › 진행 순서, 이 엔진의 승인 대기와 진행 세션", attention === 1 && running === 1 && order.every((index, at) => index >= 0 && (at === 0 || index > order[at - 1]!)), labels.map((text) => text.replace(/\s+/g, " ")).join(" | "));
    const row = page.locator(".bucket-attention .home-row", { hasText: work.title });
    await row.locator(".home-row-toggle").click();
    await page.waitForSelector(".bucket-attention .home-reply-approval", { timeout: 5000 });
    const unseenRow = page.locator('.bucket-unseen .home-row[data-flip^="s:vs"]').first();
    await unseenRow.locator(".home-row-toggle").click();
    await unseenRow.locator(".home-reply-answer").waitFor({ timeout: 5000 });
    const folded = await unseenRow.locator(".home-reply-answer").innerText();
    await shot("01-home-now.png");
    pass("지금: 줄을 펴면 기다리는 승인과 마지막 답(접은 것)", folded.includes("정리했습니다") && folded.includes("답 전체"), `${folded.length}자 · ${folded.split("\n").slice(0, 2).join(" / ")}`);

    // Keys 1–5: not while typing in the input, and they do switch once focus is elsewhere.
    await page.locator(".start-view .composer-input").focus();
    await page.keyboard.press("2");
    const typed = await page.locator(".start-view .composer-input").inputValue();
    const stayed = await page.locator(".home-modes.mode-now").count();
    await page.locator(".start-view .composer-input").fill("");
    await page.locator(".home-modes .home-board").click({ position: { x: 4, y: 4 } });
    await page.keyboard.press("2");
    const moved = await flipping(page);
    await page.waitForSelector(".home-modes.mode-projects");
    pass("숫자 키: 입력창에서는 글자로 들어가고, 바깥에서 2를 누르면 프로젝트로", typed === "2" && stayed === 1, `typed=${JSON.stringify(typed)} 움직인 상자 ${moved}`);

    // ── 프로젝트 (key 2): cards (folders › projects), the mind map, the table, the kanban ────
    if (!(await page.locator(".projects-layouts button.on", { hasText: "카드" }).count())) await page.locator(".projects-layouts button", { hasText: "카드" }).click();
    await page.waitForSelector(".home-modes.mode-projects .map-section");
    await page.waitForTimeout(450);
    const map = await settled(page, ".work-chip", ".work-card");
    const sections = await page.locator(".map-section").count();
    const chips = await page.locator(`.work-card:has-text("${work.title}") .work-chip`).count();
    const stagePills = await page.locator(".work-card .projects-stage").count();
    await shot("02-home-projects.png");
    pass("프로젝트(키 2): 폴더 › 프로젝트 카드(단계 표시), 카드 안에 세션·문서 칩, 지금에서 온 세션이 칩으로 미끄러짐", sections >= 6 && chips === 4 && stagePills > 0 && moved > 0 && map.moving === 0 && map.outside === 0, `폴더 ${sections} · 칩 ${chips} · 단계 ${stagePills} · 움직임 ${moved} · ${JSON.stringify(map)}`);
    await page.locator(".map .segmented button", { hasText: "마인드맵" }).click();
    await page.waitForSelector(".map-mind .pele svg", { timeout: 10_000 });
    await page.waitForTimeout(300);
    await shot("03-home-mindmap.png");
    const mindNodes = await page.locator(".map-mind .pele svg text").count();
    pass("프로젝트 카드: 마인드맵(Pele)", mindNodes > 20, `글자 ${mindNodes}개`);
    await page.locator(".map .segmented button", { hasText: "카드" }).click();
    // The table: one row per project, sorted by a click on a heading.
    await page.locator(".projects-layouts button", { hasText: "표" }).click();
    await page.waitForSelector(".projects-table tbody tr");
    const tableRows = await page.locator(".projects-table tbody tr").count();
    await page.locator(".projects-table th button", { hasText: "세션" }).click();
    // The sort is kept in the view now: a run before may have left it on 세션, so a click turns it round.
    if ((await page.locator('.projects-table th[aria-sort="descending"] button', { hasText: "세션" }).count()) === 0) await page.locator(".projects-table th button", { hasText: "세션" }).click();
    const counts = (await page.locator(".projects-table tbody tr td.num:nth-of-type(4)").allInnerTexts()).map(Number);
    const sortedDown = counts.every((value, index) => index === 0 || counts[index - 1]! >= value);
    await shot("03b-home-projects-table.png");
    pass("프로젝트 표: 프로젝트마다 한 줄, 머리를 누르면 그 열로 정렬", tableRows >= 6 && sortedDown, `${tableRows}줄 · 세션 ${counts.slice(0, 5).join(",")}…`);
    // The kanban (now the view "단계", a board by stage): a card dragged from "값 없음" to "진행중" writes that stage into its note.
    await page.locator(".projects-layouts button", { hasText: "단계" }).click();
    await page.waitForSelector('.kanban-column[data-stage-column=""] .kanban-card');
    const card = page.locator('.kanban-column[data-stage-column=""] .kanban-card').first();
    const movedWork = await card.getAttribute("data-work");
    const from = (await card.boundingBox())!;
    const target = (await page.locator('.kanban-column[data-stage-column="진행중"]').boundingBox())!;
    await page.mouse.move(from.x + 20, from.y + 12);
    await page.mouse.down();
    await page.mouse.move(from.x + 60, from.y + 30, { steps: 4 });
    await page.mouse.move(target.x + target.width / 2, target.y + 40, { steps: 8 });
    await page.mouse.up();
    const staged = await until(async () => (await api<{ workId: string; stage: string | null }[]>("GET", "/api/projects/")).some((entry) => entry.workId === movedWork && entry.stage === "진행중"), 8000);
    const inColumn = await until(async () => (await page.locator(`.kanban-column[data-stage-column="진행중"] .kanban-card[data-work="${movedWork}"]`).count()) === 1, 5000);
    await shot("03c-home-projects-kanban.png");
    pass("프로젝트 칸반: 카드를 '진행중'으로 끌면 그 프로젝트 노트에 단계가 써지고 그 열로", staged && inColumn, String(movedWork));
    await page.locator(".toast button", { hasText: "되돌리기" }).click();
    await until(async () => (await api<{ workId: string; stage: string | null }[]>("GET", "/api/projects/")).some((entry) => entry.workId === movedWork && entry.stage === null), 8000);
    // The graph: a point per project; a point opens that project's page.
    await page.locator(".projects-layouts button", { hasText: "그래프" }).click();
    await page.waitForSelector(".graph-node.project");
    const projectNodes = await page.locator(".graph-node.project").count();
    await shot("03d-home-projects-graph.png");
    const node = page.locator(".graph-node.project").first();
    const nodeLabel = await node.getAttribute("aria-label");
    await node.click();
    const openedTitle = await page.waitForSelector(".project-view .project-title", { timeout: 8000 }).then(() => page.locator(".project-title").innerText(), () => "");
    pass("프로젝트 그래프: 프로젝트마다 점, 점을 누르면 그 프로젝트 페이지", projectNodes >= 6 && openedTitle === nodeLabel, `${projectNodes}점 · ${nodeLabel}`);
    await page.locator(".topbar .brand").click();
    await page.waitForSelector(".home-modes.mode-projects");
    await page.locator(".projects-layouts button", { hasText: "카드" }).click();

    // ── 흐름 (key 3): a calendar — this month's days with their works, today with this work's turn ──
    await blur(page);
    await page.keyboard.press("3");
    await page.waitForSelector(".home-modes.mode-flow .flow-cal");
    await page.locator(".flow-views button", { hasText: "달" }).click();
    await until(async () => (await page.locator(".flow-month .flow-line.work").count()) > 20, 8000);
    const monthLines = await page.locator(".flow-month .flow-line.work").count();
    const revisionsInMonth = Number(/판 (\d+)/.exec(await page.locator(".flow-sum").innerText())?.[1] ?? 0);
    await shot("05-home-flow.png");
    await page.locator(".flow-views button", { hasText: "하루" }).click();
    await page.locator(".flow-today").click();
    await until(async () => (await page.locator(`.flow-col[data-work="${work.id}"] .flow-block`).count()) > 0, 8000);
    const todayBlocks = await page.locator(`.flow-col[data-work="${work.id}"] .flow-block`).count();
    pass("흐름(키 3): 달 보기에 날마다 작업 줄과 판 수, 하루 보기에 이 작업의 진행 중 턴", monthLines > 20 && revisionsInMonth > 5 && todayBlocks >= 1, `작업 줄 ${monthLines} · 판 ${revisionsInMonth} · 오늘 ${todayBlocks}`);
    await page.locator(".flow-views button", { hasText: "주" }).click();

    // ── 문서 (key 4) ─────────────────────────────────────────────────────────────────
    await blur(page);
    await page.keyboard.press("4");
    await page.waitForSelector(".home-modes.mode-docs .doc-tile");
    await until(async () => (await page.locator(".doc-thumb-text").count()) >= 6, 8000);
    const pdfThumb = await until(async () => (await page.locator('.doc-tile:has-text("자료.pdf") .doc-thumb img').count()) > 0, 10_000);
    const tiles = await page.locator(".doc-tile").count();
    const badges = await page.locator(".doc-tile-badge").allInnerTexts();
    // Projects' own notes (made by the kanban step) are not documents here.
    const docs = (await snapshot()).artifacts.filter((artifact) => artifact.role !== "project-note").length;
    await shot("06-home-docs.png");
    pass("문서(키 4): 문서마다 첫 쪽 썸네일(PDF는 쪽 그림, 글은 첫 줄들), 대기 중인 수정안 수", tiles === docs && pdfThumb && badges.filter((text) => text.startsWith("수정안")).length >= 5, `문서 ${tiles}/${docs} · PDF ${pdfThumb} · ${badges.slice(0, 3).join(", ")}`);

    // Remembered: the gateway keeps the mode; a reload opens home on it again.
    await until(async () => (await snapshot()).prefs.homeMode === "docs", 3000);
    await page.reload();
    await page.waitForSelector(".work-view");
    await page.locator(".topbar .brand").click();
    await page.waitForSelector(".home-modes");
    pass("모드는 화면 설정에 남아 다시 열어도 '문서'", (await page.locator(".home-modes.mode-docs").count()) === 1 && (await snapshot()).prefs.homeMode === "docs");

    // Fast with 100+ sessions: each switch to the next painted frame.
    const timings: string[] = [];
    let slowest = 0;
    for (const name of ["지금", "프로젝트", "흐름", "문서"]) {
      const result = await switchHome(page, name);
      await page.waitForTimeout(400);
      slowest = Math.max(slowest, result.ms);
      timings.push(`${name} ${result.ms}ms/${result.nodes}`);
    }
    const sessionCount = (await snapshot()).sessions.length;
    numbers.push(`[${label}] 세션 ${sessionCount} · 전환(다음 화면까지/요소 수) ${timings.join(", ")}`);
    pass("세션 100개 넘게: 모드 전환이 다음 화면까지 400ms 안", sessionCount >= 120 && slowest < 400, timings.join(", "));

    // "모두 읽음" on 지금's 새 답 (it was on the former board's column).
    await blur(page);
    await page.keyboard.press("1");
    await page.waitForSelector(".bucket-unseen .home-row");
    const unseenBefore = await page.locator(".bucket-unseen .home-row").count();
    await page.locator(".bucket-unseen .board-action").click();
    const cleared = await until(async () => (await page.locator(".bucket-unseen .home-row").count()) === 0, 8000);
    pass("지금 '새 답'의 '모두 읽음'", unseenBefore > 0 && cleared, `${unseenBefore} → ${await page.locator(".bucket-unseen .home-row").count()}`);
    await api("POST", `/api/sessions/${asking.id}/approvals/${encodeURIComponent((await items(asking.id)).find((item) => item.kind === "approval" && item.decision === null)!.id)}`, { decision: "accept" });
    await idle(asking.id);
    await idle(working.id);

    // ── work screen modes ────────────────────────────────────────────────────────────
    await page.locator(`.sidebar [data-row-id="${work.id}"]`).click();
    await page.waitForSelector(".work-view .transcript");
    await page.locator(".docs-button").click();
    await page.locator(".docs-menu .menu-item", { hasText: "강의안.md" }).click();
    await page.waitForSelector(".document-view .work-mode-bar");
    const modeLabels = await page.locator(".work-mode-bar button").allInnerTexts();
    const active = await page.locator(".work-mode-bar button.active").innerText();
    pass("문서를 열면 입력창 위에 모드 막대(대화·문서·검토·나란히·읽기), 지금은 '문서'", modeLabels.join(",") === "대화,문서,검토,나란히,읽기" && active === "문서");

    // A proposal from a "고쳐" request, then 검토 (Alt+3) opens its compare view directly.
    const input = page.locator(".doc-composer .composer-input");
    await input.fill("도입부를 고쳐 줘");
    await input.press("Enter");
    // The work's last created session is the one on screen ("긴 답"): the request goes there.
    const proposed = await until(async () => (await snapshot()).proposals.some((entry) => entry.artifactId === doc.id && entry.status === "pending"), 25_000);
    await idle(working.id);
    await page.keyboard.press("Alt+3");
    await page.waitForSelector(".doc-compare", { timeout: 8000 });
    await page.waitForTimeout(300);
    const reviewActive = await page.locator(".work-mode-bar button.active").innerText();
    const diff = await page.locator(".doc-compare").innerText();
    await shot("07-review.png");
    await page.locator(".doc-compare-actions .button", { hasText: "닫기" }).click();
    await page.waitForSelector(".doc-compare", { state: "detached" });
    await page.waitForFunction(() => document.querySelector(".work-mode-bar button.active")?.textContent === "문서", null, { timeout: 3000 }).catch(() => undefined);
    const backToDoc = await page.locator(".work-mode-bar button.active").innerText();
    pass("검토(Alt+3): 이 문서의 수정안 비교가 바로 열리고, 닫으면 '문서'", proposed && reviewActive === "검토" && diff.includes("고친 문단") && backToDoc === "문서", `${reviewActive} → ${backToDoc}`);

    // 대화 ↔ 문서: each keeps where it was read.
    await page.waitForSelector(".document-view .cm-scroller");
    await page.locator(".document-view .cm-scroller").evaluate((element) => (element.scrollTop = 900));
    await page.waitForTimeout(200);
    await page.keyboard.press("Alt+1");
    await page.waitForSelector(".work-view .transcript");
    await page.waitForTimeout(300);
    await page.locator(".work-view .transcript").evaluate((element) => (element.scrollTop = 40));
    await page.waitForTimeout(300);
    const chatTop = await page.locator(".work-view .transcript").evaluate((element) => element.scrollTop);
    await page.keyboard.press("Alt+2");
    await page.waitForSelector(".document-view .cm-scroller");
    await until(async () => (await page.locator(".document-view .cm-scroller").evaluate((element) => element.scrollTop)) > 800, 4000);
    const docTop = await page.locator(".document-view .cm-scroller").evaluate((element) => element.scrollTop);
    await page.keyboard.press("Alt+1");
    await page.waitForSelector(".work-view .transcript");
    await page.waitForTimeout(300);
    const chatAgain = await page.locator(".work-view .transcript").evaluate((element) => element.scrollTop);
    pass("대화(Alt+1)·문서(Alt+2)를 오가도 각자 읽던 자리", Math.abs(docTop - 900) < 40 && Math.abs(chatAgain - chatTop) < 3, `문서 ${Math.round(docTop)} · 대화 ${chatTop} → ${chatAgain}`);

    // 나란히 (Alt+4): conversation | document, one input that follows the clicked side.
    await page.keyboard.press("Alt+4");
    await page.waitForSelector(".split-host.split .split-chat .work-view");
    await page.waitForSelector(".split-host.split .split-doc .document-view");
    const inputs = await page.locator(".composer").count();
    const inBar = await page.locator(".split-input .composer").count();
    await page.locator(".split-input .composer-input").fill("나란히 초안");
    await page.locator(".split-doc .doc-header").click({ position: { x: 4, y: 4 } });
    await page.waitForSelector(".split-input .doc-chips .ref-chip");
    const docTarget = await page.locator(".split-input .composer-header").innerText();
    const carried = await page.locator(".split-input .composer-input").inputValue();
    await page.locator(".split-chat .transcript").click({ position: { x: 20, y: 60 } });
    await page.waitForFunction(() => !document.querySelector(".split-input .doc-chips"));
    await shot("08-split.png");
    pass("나란히(Alt+4): 대화|문서 두 칸, 입력창은 하나, 누른 쪽으로 향하고 쓰던 글은 그대로", inputs === 1 && inBar === 1 && docTarget.includes("현재 문서") && carried === "나란히 초안", `입력창 ${inputs} · ${docTarget.split("\n")[0]}`);
    const before = await page.locator(".split-chat").boundingBox();
    const divider = (await page.locator(".split-divider").boundingBox())!;
    await page.mouse.move(divider.x + divider.width / 2, divider.y + 200);
    await page.mouse.down();
    await page.mouse.move(divider.x + 120, divider.y + 220, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const after = await page.locator(".split-chat").boundingBox();
    const ratio = await until(async () => Number((await snapshot()).prefs.splitRatio) > 0.5, 3000);
    pass("나란히: 가운데 막대를 끌어 너비 조절(기억됨)", Boolean(before && after && after.width > before.width + 80) && ratio, `${Math.round(before?.width ?? 0)} → ${Math.round(after?.width ?? 0)}px`);
    const turnsBefore = (await items(working.id)).filter((item) => item.kind === "turnEnd").length;
    const split = page.locator(".split-input .composer-input");
    await split.fill("나란히에서 보낸 요청");
    await split.press("Enter");
    const answered = await until(async () => (await items(working.id)).filter((item) => item.kind === "turnEnd").length > turnsBefore, 20_000);
    // The transcript may draw the turn a moment after the gateway records it (a loaded machine).
    const leftShown = await until(async () => (await page.locator(".split-chat .turn-request", { hasText: "나란히에서 보낸 요청" }).count()) === 1, 5000);
    pass("나란히: 대화 쪽으로 보낸 요청의 답이 왼쪽 대화에", answered && leftShown, `${answered ? "답 기록됨" : "답 없음(20초)"} · 왼쪽 대화에 ${leftShown ? "보임" : "안 보임"}`);

    // 읽기 (Alt+5): the document a page at a time; Esc returns to 나란히.
    await page.keyboard.press("Alt+5");
    await page.waitForSelector(".reader .reader-flow");
    await page.waitForTimeout(500);
    const first = await page.locator(".reader-count").innerText();
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(200);
    const second = await page.locator(".reader-count").innerText();
    await shot("09-read.png");
    await page.keyboard.press("Escape");
    await page.waitForSelector(".reader", { state: "detached" });
    const back = await page.locator(".split-host.split").count();
    const pages = Number(first.split("/")[1]);
    // It opens at the page the document was scrolled to, and → turns one page.
    const startPage = Number(first.split("/")[0]);
    pass("읽기(Alt+5): 화면 가득 쪽 넘기기(읽던 쪽에서 시작), Esc로 나란히로 돌아옴", pages >= 3 && Number(second.split("/")[0]) === startPage + 1 && back === 1, `${first} → ${second}`);

    // A PDF reads as its real pages.
    await page.locator(".split-chat .docs-button").click();
    await page.locator(".docs-menu .menu-item", { hasText: "자료.pdf" }).click();
    await page.waitForSelector(".document-view .pdf-page canvas");
    await page.keyboard.press("Alt+5");
    await page.waitForSelector(".reader img.reader-page", { timeout: 10_000 });
    const pdfFirst = await page.locator(".reader-count").innerText();
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => document.querySelector(".reader-count")?.textContent?.startsWith("2"));
    await page.waitForSelector(".reader img.reader-page");
    await shot("09b-read-pdf.png");
    await page.keyboard.press("Escape");
    await page.waitForSelector(".reader", { state: "detached" });
    pass("읽기: PDF는 실제 쪽 그림으로 한 쪽씩", pdfFirst === "1 / 3" && (await page.locator(".document-view .pdf-view").count()) === 1, pdfFirst);

    // Not restored: after a reload the conversation is back alone.
    await page.reload();
    await page.waitForSelector(".work-view .transcript");
    await page.waitForTimeout(400);
    pass("나란히는 다시 열 때 복원하지 않음", (await page.locator(".split-host").count()) === 0);

    // ── a session in its own window ──────────────────────────────────────────────────
    await page.locator(`.sidebar [data-row-id="${asking.id}"]`).click({ button: "right" });
    const [popup] = await Promise.all([page.waitForEvent("popup"), page.locator(".context-menu .context-menu-item", { hasText: "새 창으로 떼어 내기" }).click()]);
    watch(popup, `${label} 창`);
    await popup.setViewportSize({ width: 760, height: 860 });
    await popup.waitForSelector(".work-view .transcript");
    await popup.waitForTimeout(400);
    const lone = { sidebar: await popup.locator(".sidebar").count(), tabs: await popup.locator(".session-tabs").count(), title: await popup.title() };
    const popupTurns = (await items(asking.id)).filter((item) => item.kind === "turnEnd").length;
    const popupInput = popup.locator(".composer-input");
    await popupInput.fill("새 창에서 보냄");
    await popupInput.press("Enter");
    const replied = await until(async () => (await items(asking.id)).filter((item) => item.kind === "turnEnd").length > popupTurns, 20_000);
    await popup.waitForTimeout(600);
    const seen = await popup.locator(".turn-request", { hasText: "새 창에서 보냄" }).count();
    await shot("10-window.png", popup);
    pass("새 창으로 떼어 내기: 그 세션만(사이드바·탭 없음), 보내고 답 받기", lone.sidebar === 0 && lone.tabs === 0 && lone.title.startsWith("확인 받기") && replied && seen === 1, JSON.stringify(lone));
    await popup.close();
  } catch (error) {
    pass("실행", false, error instanceof Error ? error.message.split("\n")[0]! : String(error));
    await page.screenshot({ path: join(outDir, `${provider}-99-failure.png`) }).catch(() => undefined);
  } finally {
    await page.close();
  }
}

/** With reduced motion nothing moves, but the switch happens. */
async function reduced() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  watch(page, "reduced");
  try {
    await page.goto(`${ready.url}/?token=${ready.token}`);
    await page.waitForSelector(".topbar .brand");
    await page.locator(".topbar .brand").click();
    await page.waitForSelector(".home-modes");
    const result = await switchHome(page, "프로젝트");
    await page.waitForSelector(".home-modes.mode-projects");
    check("움직임 줄이기: 전환은 되고 아무것도 움직이지 않음", result.moving === 0, `animations=${result.moving}`);
  } finally {
    await context.close();
  }
}

try {
  check("세션 120개를 심은 저장소", seeded.sessions.length === 120 && seeded.artifacts.length === 20);
  for (const provider of providers) await flow(provider);
  await reduced();
} finally {
  writeFileSync(join(outDir, "console.log"), logs.join("\n"));
  writeFileSync(join(outDir, "results.json"), JSON.stringify({ results, numbers }, null, 2));
  for (const line of numbers) console.log(line);
  await browser.close();
  child.kill();
  await new Promise((done) => (child.exitCode === null && child.signalCode === null ? child.once("exit", done) : done(null)));
  for (const dir of [dataDir, worksDir]) rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((result) => !result.ok).length;
  console.log(`${results.length - failed}/${results.length} passed · console: ${logs.length ? logs.slice(0, 6).join(" | ") : "clean"}`);
  process.exitCode = failed ? 1 : 0;
}
