/// <reference lib="dom" />
// Browser check of "찾는 길" (one index for people and engines), against a real gateway driving the
// stand-in engines (no model) with a seeded store and a fixture vault in temporary folders (the
// user's vault is never touched):
//   한국어 — a two-syllable word, a longer one, a word with a particle ("기준을"), spaced and joined
//   ("채점 기준" ↔ "채점기준"); 순위 — a work title above a body match; 중복 — a document and the reply
//   that made it are one row, conversation records are left out; 볼트 — notes are found, a folder
//   hidden in Notebook Navigator never is.
//   화면 (Codex and Claude alike) — Ctrl+K scope chips switched with Tab, totals and "더 보기", a
//   work's "N건 더", "보기로 저장" (a saved view opens with the same results), Ctrl+Shift+F opens the
//   box for contents, Shift+Enter on a work falls back to opening it.
//   엔진 — each engine runs `workbench-find` from its own process ("찾아 줘: …"; Codex's under its
//   workspace-write sandbox: the data folder is outside /tmp, so only the turn's writable root lets
//   it write the request) and answers with provenance lines; no approval card under 자동 or 묻기;
//   --all reaches the vault but not its hidden folder.
// Usage: node scripts/search-check.ts [outDir] [codex|claude]

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Page } from "playwright-core";
import type { Artifact, PkmState, Provider, SearchPage, Session, TranscriptItem, Work } from "@workbench/contracts";
import { Store } from "../apps/host/src/store.ts";
import { put } from "../apps/host/src/vault-fixture.ts";

const outDir = process.argv[2] ?? join(tmpdir(), "wb-search-check");
const providers: Provider[] = process.argv[3] === "codex" || process.argv[3] === "claude" ? [process.argv[3]] : ["codex", "claude"];
mkdirSync(outDir, { recursive: true });
// Outside /tmp and $TMPDIR: a Codex turn (workspace-write) may only write here through its writable roots.
const dataDir = mkdtempSync("/var/tmp/workbench-search-");
const worksDir = mkdtempSync(join(tmpdir(), "workbench-search-works-"));
const vault = mkdtempSync(join(tmpdir(), "workbench-search-vault-"));
const results: { step: string; ok: boolean; detail: string }[] = [];
const check = (step: string, ok: boolean, detail = "") => {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`);
};

// ── the fixture vault: notes, and a folder hidden in Notebook Navigator ──────────────────────
put(vault, ".obsidian/app.json", "{}");
put(vault, ".obsidian/plugins/notebook-navigator/data.json", JSON.stringify({ vaultProfile: "default", vaultProfiles: [{ id: "default", hiddenFolders: ["/비밀*"], hiddenFileNames: [] }] }));
put(vault, "20. Information (I)/형성평가 메모.md", ["---", "title: 형성평가 메모", "aliases: [퀴즈 메모]", "tags: [평가]", '"DIKM_단계:": 🔵 I', "---", "형성평가는 수업 중간에 짧게 본다. 채점 기준은 루브릭으로 공개한다."].join("\n"));
put(vault, "비밀/일기.md", "형성평가 이야기와 비밀단어 하나.");
put(vault, "비밀/깊은 곳/메모.md", "비밀단어 둘");
put(vault, "홈.md", "볼트 첫 화면");
function listing(root: string) {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(`${relative(root, full)}:${statSync(full).size}:${statSync(full).mtimeMs}`);
    }
  };
  walk(root);
  return out.sort().join("\n");
}
const vaultBefore = listing(vault);

// ── the store: works, sessions, a plan, an attachment and a document made by a reply ─────────
const now = Date.now();
const store = new Store(join(dataDir, "state.sqlite"));
const workOf = (id: string, title: string): Work => {
  const cwd = join(worksDir, id);
  mkdirSync(cwd, { recursive: true });
  return { id, title, titleSource: "user", folderId: null, cwd, cwdManaged: false, activeSessionId: null, pinned: false, sort: 0, archivedAt: null, createdAt: now - 86_400_000, updatedAt: now - 3_600_000 };
};
const sessionOf = (id: string, workId: string, provider: Provider, purpose: string): Session => ({
  id, workId, provider, hostId: "h", nativeSessionId: null, purpose, purposeSource: "user", model: null, effort: null, engineModel: null, engineEffort: null,
  preview: null, previewAt: now - 3_600_000, status: "idle", activity: null, lastError: null, pinned: false, sort: 0, archivedAt: null, seenAt: now, unread: false,
  queued: [], access: null, context: null, createdAt: now - 7_200_000, updatedAt: now - 3_600_000,
});
const hello = workOf("w-hello", "안녕");
hello.activeSessionId = "s-grade";
const rubric = workOf("w-rubric", "채점 루브릭 연구");
const meetings = Array.from({ length: 12 }, (_, index) => workOf(`w-meet-${index + 1}`, `주간 모임 ${index + 1}`));
for (const work of [hello, rubric, ...meetings]) store.saveWork(work);
const sessions = [sessionOf("s-grade", hello.id, "codex", "과제 채점 기준표"), sessionOf("s-slides", hello.id, "claude", "3주차 슬라이드"), sessionOf("s-rubric", rubric.id, "claude", "자료 모으기")];
sessions.push(...meetings.map((work, index) => sessionOf(`s-meet-${index + 1}`, work.id, index % 2 ? "claude" : "codex", `모임 ${index + 1}`)));
for (const session of sessions) store.saveSession(session);
let at = now - 7_000_000;
const say = (sessionId: string, ...items: TranscriptItem[]) => {
  for (const item of items) store.saveItem(sessionId, { ...item, at: (at += 30_000) } as TranscriptItem);
};
const user = (id: string, text: string): TranscriptItem => ({ kind: "user", id, text, at: 0 });
const reply = (id: string, text: string): TranscriptItem => ({ kind: "assistant", id, text, streaming: false, at: 0 });
const end = (id: string): TranscriptItem => ({ kind: "turnEnd", id, status: "completed", durationMs: 30_000, at: 0 });
say("s-grade", user("u-grade-1", "채점 기준을 세 단계로 나눠 줘"), reply("a-grade-1", "채점기준표를 만들었습니다. 이해·적용·설명 세 단계이고, 루브릭은 다음 주에 다듬겠습니다."), end("e-grade-1"));
say("s-grade", user("u-grade-2", "발표 일정 정리해 줘"), reply("a-grade-2", "발표 일정은 11월 3일과 10일입니다."), end("e-grade-2"));
say("s-grade", { kind: "user", id: "u-grade-3", text: "첨부한 계획서 확인해 줘", attachments: [{ id: "a1b2.pdf", name: "강의계획서_2026.pdf", mime: "application/pdf", size: 1024 }], at: 0 }, reply("a-grade-3", "확인했습니다."), end("e-grade-3"));
say("s-rubric", user("u-rubric-1", "자료를 모아 줘"), reply("a-rubric-1", "모았습니다."), end("e-rubric-1"));
// Claude's plan waiting for the go-ahead (its text is the plan).
say("s-slides", user("u-slides-0", "슬라이드 구성을 계획해 줘"), { kind: "approval", id: "approval:plan-1", title: "이 계획대로 진행할까요?", detail: "1. 설문 문항을 고친다\n2. 표본을 늘린다", reason: null, decision: "accept", plan: true, at: 0 });
// A document the Claude session made in a turn, and that turn's reply: one row in the results.
const report = "# 보고서\n\n예산 집행 계획을 정리했습니다. 항목별 집행률은 표로 붙였고, 채점 기준표는 부록에 두었습니다.\n";
const reportPath = join(hello.cwd, "보고서.md");
writeFileSync(reportPath, report);
const sha = createHash("sha256").update(report).digest("hex");
const artifact: Artifact = { id: "doc-report", workId: hello.id, path: reportPath, name: "보고서.md", format: "markdown", revision: 1, sha256: sha, size: Buffer.byteLength(report), diskState: "same", readBy: {}, createdAt: now - 5_000_000, updatedAt: now - 5_000_000 };
mkdirSync(join(dataDir, "artifacts", artifact.id), { recursive: true });
writeFileSync(join(dataDir, "artifacts", artifact.id, "r1.md"), report);
store.saveArtifact(artifact);
store.saveRevision({ artifactId: artifact.id, revision: 1, sha256: sha, size: artifact.size, author: "engine", sessionId: "s-slides", baseRevision: null, note: null, at: now - 5_000_000 });
say("s-slides", user("u-slides-1", "보고서 초안을 써 줘"), { kind: "artifact", id: "artifact:report", artifactId: artifact.id, revision: 1, change: "created", at: 0 }, reply("a-slides-1", "보고서.md에 예산 집행 계획을 정리해 두었습니다."), end("e-slides-1"));
meetings.forEach((_, index) => say(`s-meet-${index + 1}`, user(`u-meet-${index + 1}`, `이번 주 회의록 정리해 줘 (${index + 1})`), reply(`a-meet-${index + 1}`, `회의록을 정리했습니다. 안건 ${index + 2}개입니다.`), end(`e-meet-${index + 1}`)));
// The first meeting has three turns: more hits than a group shows at first ("이 작업에서 N건 더").
for (const turn of [2, 3]) say("s-meet-1", user(`u-meet-1-${turn}`, `${turn}차 회의록도 정리해 줘`), reply(`a-meet-1-${turn}`, `${turn}차 회의록을 정리했습니다.`), end(`e-meet-1-${turn}`));
store.setMeta("ui.prefs", JSON.stringify({ onboarding: "done", startScreen: "last" }));
store.close();

// ── the gateway ────────────────────────────────────────────────────────────────────────────
const child = spawn(process.execPath, ["apps/host/src/main.ts"], {
  env: {
    ...process.env,
    WORKBENCH_DATA_DIR: dataDir,
    WORKBENCH_WEB_DIR: "apps/web/dist",
    WORKBENCH_HOST_LABEL: "노트북",
    WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"),
    WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"),
    WORKBENCH_VAULT_SUGGEST: "",
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
const search = (q: string, extra: Record<string, string> = {}) => api<SearchPage>("GET", `/api/search?${new URLSearchParams({ q, legacy: "0", limit: "50", per: "20", ...extra })}`);
const hits = (page: SearchPage) => page.groups.flatMap((group) => group.hits);
const until = async (what: () => Promise<boolean>, timeout = 15_000) => {
  const stop = Date.now() + timeout;
  while (Date.now() < stop) {
    if (await what()) return true;
    await new Promise((done) => setTimeout(done, 100));
  }
  return false;
};
const items = async (id: string) => (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${id}/items`)).items;
const session = async (id: string) => (await api<{ sessions: Session[] }>("GET", "/api/snapshot")).sessions.find((entry) => entry.id === id)!;

await api("PUT", "/api/pkm/vault", { path: vault });
const vaultReady = await until(async () => (await search("형성평가", { scope: "vault" })).total > 0, 10_000);

// ── the index, through the API ─────────────────────────────────────────────────────────────
{
  const pass = (step: string, ok: boolean, detail = "") => check(`[색인] ${step}`, ok, detail);
  const keys = (page: SearchPage) => hits(page).map((hit) => hit.key);
  const two = await search("기준");
  pass("두 글자 말 '기준': 요청과 답을 찾고 bm25 순위가 붙음", keys(two).includes("item:s-grade:u-grade-1") && keys(two).includes("item:s-grade:a-grade-1") && hits(two).every((hit) => hit.score > 0), `${two.total}건`);
  const long = await search("채점기준표");
  pass("세 글자 이상 '채점기준표'", keys(long).includes("item:s-grade:a-grade-1"), `${long.total}건`);
  const particle = await search("기준을");
  pass("조사 붙은 말 '기준을' → '기준'으로", particle.terms.join() === "기준" && particle.total === two.total, `terms=${particle.terms.join()} · ${particle.total}건`);
  const spaced = await search("채점 기준");
  const joined = await search("채점기준");
  const both = (page: SearchPage) => keys(page).includes("item:s-grade:u-grade-1") && keys(page).includes("item:s-grade:a-grade-1");
  pass("띄어 쓴 말과 붙여 쓴 말을 함께 찾음('채점 기준' ↔ '채점기준')", both(spaced) && both(joined), `${spaced.total}건 / ${joined.total}건`);
  const ranked = await search("루브릭");
  pass("순위: 이름이 맞은 작업이 본문보다 위", hits(ranked)[0]?.kind === "work" && hits(ranked)[0]?.workId === rubric.id && hits(ranked).some((hit) => hit.kind === "assistant"), hits(ranked).map((hit) => `${hit.kind}:${hit.title}`).slice(0, 3).join(" > "));
  const joinedRow = await search("예산 집행");
  const row = hits(joinedRow)[0];
  pass("문서와 그 문서를 만든 답이 한 줄", joinedRow.total === 1 && row?.kind === "document" && row.answer?.matched === true && row.answer.itemId === "a-slides-1" && row.provider === "claude", `${joinedRow.total}건 · ${row?.kind} · 답 ${row?.answer?.itemId}`);
  const exported = await api<{ artifactId: string | null }>("POST", "/api/sessions/s-grade/export", { target: "work" });
  const afterExport = await search("채점기준표");
  pass("내보낸 세션 기록은 숨김", Boolean(exported.artifactId) && !hits(afterExport).some((hit) => hit.artifactId === exported.artifactId), `기록 문서 ${exported.artifactId?.slice(0, 8)} · ${afterExport.counts.document}건`);
  const plan = await search("표본");
  const files = await search("강의계획서");
  pass("계획 원문과 첨부 파일 이름", hits(plan)[0]?.kind === "plan" && hits(files)[0]?.kind === "attachment", `${hits(plan)[0]?.kind} · ${hits(files)[0]?.kind}`);
  const notes = await search("형성평가", { scope: "vault" });
  const hidden = await search("비밀단어");
  pass("볼트 노트를 찾고, NN에서 숨긴 폴더의 노트는 찾지 않음", vaultReady && hits(notes).map((hit) => hit.path).join() === "20. Information (I)/형성평가 메모.md" && hidden.total === 0, `${hits(notes).map((hit) => hit.path).join()} · 숨김 ${hidden.total}건`);
  const paged = await search("회의록", { limit: "5", per: "1" });
  pass("총수와 쪽: 작업 12곳 중 5곳, 나머지는 offset으로", paged.groupsTotal === 12 && paged.groups.length === 5 && paged.total === 28, `${paged.total}건 · ${paged.groups.length}/${paged.groupsTotal}곳`);
}

const browser = await chromium.launch();
const logs: string[] = [];

async function flow(provider: Provider) {
  const label = provider === "codex" ? "Codex" : "Claude";
  const page: Page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  page.on("console", (message) => message.type() === "error" && logs.push(`[${label} error] ${message.text().slice(0, 200)}`));
  page.on("pageerror", (error) => logs.push(`[${label} pageerror] ${error.message.slice(0, 200)}`));
  const shot = (name: string) => page.screenshot({ path: join(outDir, `${provider}-${name}`) });
  const pass = (step: string, ok: boolean, detail = "") => check(`[${label}] ${step}`, ok, detail);
  const palette = async (keys: string, query: string) => {
    // A box left open (or inside one work's results) closes first.
    for (let tries = 0; tries < 5 && (await page.locator(".palette").count()); tries += 1) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
    }
    await page.keyboard.press(keys);
    await page.waitForSelector(".palette");
    await page.locator(".palette-input input").fill(query);
    await page.waitForFunction((text) => document.querySelector(".palette .search-summary") !== null && !document.querySelector(".palette .spinner") && (document.querySelector(".palette-input input") as HTMLInputElement | null)?.value === text, query, { timeout: 8000 });
    await page.waitForTimeout(250);
  };
  const scopeOn = () => page.locator(".search-scope.on").innerText();
  try {
    await page.addInitScript(() => localStorage.setItem("workbench.lastWork", "w-hello"));
    await page.goto(`${ready.url}/?token=${ready.token}`);
    await page.waitForSelector(".composer-input");
    await page.waitForTimeout(300);

    // ── Ctrl+K: chips with counts, groups by work, totals ─────────────────────────────────────
    await palette("Control+k", "채점 기준");
    const chips = await page.locator(".search-scope").allInnerTexts();
    const summary = await page.locator(".search-summary .search-total").innerText();
    const groups = await page.locator(".search-group").count();
    const marks = await page.locator(".palette-entry mark").count();
    await shot("01-palette.png");
    pass("Ctrl+K: 범위 칩 여섯 개(개수), 작업별 묶음, 총수, 강조", chips.length === 6 && chips[0]!.startsWith("전체") && /총 \d+건/.test(summary) && groups >= 1 && marks >= 2, `${chips.map((chip) => chip.replace(/\s+/g, "")).join(" ")} | ${summary} | 묶음 ${groups}`);

    // ── Tab switches the scope ─────────────────────────────────────────────────────────────────
    await palette("Control+k", "채점");
    await page.keyboard.press("Tab");
    await page.waitForFunction(() => document.querySelector(".search-scope.on")?.textContent?.startsWith("프로젝트"), undefined, { timeout: 4000 });
    await page.waitForTimeout(400);
    const projectRows = await page.locator(".palette-entry.kind-work").count();
    const projectOther = await page.locator(".palette-entry.kind-hit, .palette-entry.kind-doc").count();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.waitForFunction(() => document.querySelector(".search-scope.on")?.textContent?.startsWith("문서"), undefined, { timeout: 4000 });
    await page.waitForTimeout(400);
    const documentScope = await scopeOn();
    const documentRows = await page.locator(".palette-entry.kind-doc").count();
    await shot("02-scope-document.png");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    await page.waitForFunction(() => document.querySelector(".search-scope.on")?.textContent?.startsWith("전체"), undefined, { timeout: 4000 });
    pass("Tab으로 범위 칩을 바꿈(프로젝트 → 문서 → Shift+Tab으로 전체)", projectRows >= 1 && projectOther === 0 && documentScope.startsWith("문서") && documentRows === 1, `프로젝트 줄 ${projectRows} · 다른 줄 ${projectOther} · ${documentScope.replace(/\s+/g, "")} · 문서 줄 ${documentRows}`);

    // ── 더 보기, and one work's "N건 더" ─────────────────────────────────────────────────────────
    await palette("Control+k", "회의록");
    const before = await page.locator(".search-group").count();
    const moreLabel = await page.locator(".palette-entry.kind-more", { hasText: "더 보기" }).innerText();
    const total = await page.locator(".search-summary .search-total").innerText();
    await shot("03-more.png");
    await page.locator(".palette-entry.kind-more", { hasText: "더 보기" }).click();
    await page.waitForFunction((count) => document.querySelectorAll(".search-group").length > count, before, { timeout: 5000 });
    const after = await page.locator(".search-group").count();
    await page.locator(".palette-entry.kind-more", { hasText: "건 더" }).first().click();
    await page.locator(".palette-entry.kind-more", { hasText: "모든 결과로" }).waitFor({ timeout: 5000 });
    await page.waitForTimeout(400);
    const inGroup = await page.locator(".palette-entry.kind-hit").count();
    await shot("04-group.png");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelectorAll(".search-group").length === 8 && !document.querySelector(".palette .spinner"), undefined, { timeout: 5000 }).catch(() => undefined);
    const back = await page.locator(".search-group").count();
    pass("총수와 '더 보기'(말없이 자르지 않음), 작업 하나의 'N건 더'와 Esc로 돌아가기", total.includes("28건") && total.includes("12곳") && moreLabel.includes("4곳 더") && before === 8 && after === 12 && inGroup === 6 && back === 8, `${total} · ${moreLabel} · ${before}→${after} · 묶음 안 ${inGroup} · Esc ${back}`);

    // ── 보기로 저장 ────────────────────────────────────────────────────────────────────────────
    await palette("Control+k", "채점 기준");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.waitForFunction(() => document.querySelector(".search-scope.on")?.textContent?.startsWith("세션"), undefined, { timeout: 4000 });
    await page.waitForTimeout(400);
    const sessionTotal = Number(/(\d+)건/.exec(await page.locator(".search-summary .search-total").innerText())?.[1] ?? 0);
    await page.locator(".search-save").click();
    await page.waitForFunction(() => document.querySelector(".pkm-view .pkm-title")?.textContent === "채점 기준" && Boolean(document.querySelector(".pkm-card")), undefined, { timeout: 8000 });
    const cards = await page.locator(".pkm-card .pkm-card-name").allInnerTexts();
    const state = await api<PkmState>("GET", "/api/pkm/state");
    const view = state.views.find((entry) => entry.name === "채점 기준");
    await shot("05-saved-view.png");
    pass("'보기로 저장': 보기 API에 'kind:session 채점 기준'으로 저장되고 같은 결과의 카드가 열림", view?.query === "kind:session 채점 기준" && cards.includes("과제 채점 기준표") && sessionTotal > 0, `${view?.query} · 카드 ${cards.join(", ")}`);

    // ── Ctrl+Shift+F: the same box for contents; a vault note opens read-only ───────────────────
    await palette("Control+Shift+F", "형성평가");
    const contentMode = await page.locator(".palette.search-content .search-mode").innerText().catch(() => "");
    const noteRow = await page.locator(".palette-entry.kind-note").count();
    const commandsShown = await page.locator(".palette-group-label", { hasText: "명령" }).count();
    await shot("06-content.png");
    await page.locator(".palette-entry.kind-note").first().click();
    const noteOpened = await page.waitForSelector(".pkm-note-view .pkm-note-body", { timeout: 6000 }).then(() => true).catch(() => false);
    await shot("07-note.png");
    pass("Ctrl+Shift+F는 같은 상자를 '내용'으로 열고(명령 없음), 볼트 노트를 열어 봄(숨긴 폴더 없음)", contentMode === "내용" && noteRow === 1 && commandsShown === 0 && noteOpened, `${contentMode} · 노트 ${noteRow} · 명령 ${commandsShown}`);

    // ── Shift+Enter on a work: without a project page it opens the work as Enter does ───────────
    await palette("Control+k", "루브릭");
    const firstRow = await page.locator(".palette-entry").first().getAttribute("class");
    await page.keyboard.press("Shift+Enter");
    const opened = await page.waitForFunction(() => document.querySelector(".topbar")?.textContent?.includes("채점 루브릭 연구"), undefined, { timeout: 6000 }).then(() => true).catch(() => false);
    await shot("08-shift-enter.png");
    pass("작업 결과에서 Shift+Enter: 프로젝트 화면이 없으면 작업을 엶", Boolean(firstRow?.includes("kind-work")) && opened, String(firstRow));

    // ── the engine finds Workbench's records itself (자동, then 묻기) ─────────────────────────────
    const engine = await api<Session>("POST", `/api/works/${hello.id}/sessions`, { provider, purpose: `${label} 찾기`, access: "auto" });
    await page.evaluate(() => localStorage.setItem("workbench.lastWork", "w-hello"));
    await page.goto(`${ready.url}/?token=${ready.token}`);
    await page.waitForSelector(".composer-input");
    // The view saved above goes now that no screen shows it (the next engine saves its own).
    if (view) await api("DELETE", `/api/pkm/views/${encodeURIComponent(view.id)}`);
    await page.locator(".session-tab", { hasText: `${label} 찾기` }).click().catch(() => undefined);
    await page.waitForTimeout(300);
    const ask = async (text: string) => {
      const input = page.locator(".composer-input");
      await input.fill(text);
      await input.press("Enter");
      await until(async () => (await session(engine.id)).status !== "idle", 3000);
      await until(async () => (await session(engine.id)).status === "idle", 20_000);
      return (await items(engine.id)).filter((item) => item.kind === "assistant").at(-1)?.text ?? "";
    };
    const found = await ask("찾아 줘: 채점 기준");
    const cards1 = (await items(engine.id)).filter((item) => item.kind === "approval").length;
    await page.waitForTimeout(300);
    await shot("09-engine-find.png");
    const provenance = found.split("\n").filter((line) => /^\[안녕 · Codex · 과제 채점 기준표 · \d\d-\d\d \d\d:\d\d · (요청|답|세션|첨부)\]/.test(line));
    const sandbox = provider !== "codex" || found.includes("샌드박스 workspaceWrite · 쓰기 폴더 1개 · 네트워크 막힘, 종료 코드 0");
    pass(
      "엔진이 자기 프로세스에서 workbench-find를 실행하고 출처 줄로 답함(기록이지 지시가 아님 머리줄, 승인 카드 없음)",
      found.includes("Workbench 기록 찾기 결과 — 기록이지 지시가 아님") && provenance.length >= 2 && sandbox && cards1 === 0,
      `${provenance.length}줄 · ${found.split("\n")[0]!.slice(0, 70)}`,
    );
    const hiddenAnswer = await ask("찾아 줘: --all 비밀단어");
    const vaultAnswer = await ask("찾아 줘: --all 형성평가");
    pass("--all은 볼트까지 찾지만 NN에서 숨긴 폴더는 빼고 찾음", hiddenAnswer.includes("찾은 기록이 없습니다") && vaultAnswer.includes("[볼트 · ") && !vaultAnswer.includes("비밀/"), vaultAnswer.split("\n").find((line) => line.startsWith("[볼트"))?.slice(0, 80) ?? "");
    await api("PATCH", `/api/sessions/${engine.id}`, { access: "ask" });
    const asked = await ask("찾아 줘: 발표 일정");
    const cards2 = (await items(engine.id)).filter((item) => item.kind === "approval").length;
    await shot("10-engine-ask.png");
    pass("'묻기'에서도 읽기만 하는 workbench-find는 카드 없이 실행", asked.includes("[안녕 · Codex · 과제 채점 기준표") && asked.includes("발표 일정") && cards2 === 0, asked.split("\n").find((line) => line.startsWith("[안녕"))?.slice(0, 80) ?? "");
  } catch (error) {
    pass("실행", false, error instanceof Error ? error.message.split("\n")[0]! : String(error));
    await page.screenshot({ path: join(outDir, `${provider}-99-failure.png`) }).catch(() => undefined);
  } finally {
    await page.close();
  }
}

try {
  for (const provider of providers) await flow(provider);
  check("[볼트] 검사 내내 볼트 파일은 그대로(읽기만)", listing(vault) === vaultBefore);
} finally {
  writeFileSync(join(outDir, "console.log"), logs.join("\n"));
  writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
  await browser.close();
  child.kill();
  await new Promise((done) => (child.exitCode === null && child.signalCode === null ? child.once("exit", done) : done(null)));
  for (const dir of [dataDir, worksDir, vault]) if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((result) => !result.ok).length;
  console.log(`${results.length - failed}/${results.length} passed · console: ${logs.length ? logs.slice(0, 6).join(" | ") : "clean"}`);
  process.exitCode = failed ? 1 : 0;
}
