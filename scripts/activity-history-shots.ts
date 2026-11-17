/// <reference lib="dom" />
// Captures of 활동 › 기록 (activity-history brief): a test gateway built from this worktree with a throwaway data
// folder and the stand-in engines. Three days of mixed events are written into its store while it is stopped (the
// API stamps "now"; a history needs yesterday and the day before), then it starts again and one live approval is
// asked through the stand-in Codex (so 내가 확인할 것 has a line that really waits).
//   ux/run-isolated.sh node scripts/activity-history-shots.ts <outDir>   (needs apps/web/dist and apps/host/dist)
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Page } from "playwright-core";
import type { Artifact, Session, TranscriptItem, Work } from "@workbench/contracts";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../apps/host/src/store.ts";

const out = resolve(process.argv[2] ?? "activity-shots");
mkdirSync(out, { recursive: true });
const data = mkdtempSync("/var/tmp/wb-activity-shots-");
const works = join(data, "works");
const repo = resolve(import.meta.dirname, "..");

function start(): Promise<{ gateway: ChildProcess; url: string; token: string }> {
  const gateway = spawn(process.execPath, [join(repo, "apps/host/dist/host.mjs")], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, WORKBENCH_DATA_DIR: join(data, "state"),
    WORKBENCH_WEB_DIR: join(repo, "apps/web/dist"), WORKBENCH_HOST_LABEL: "노트북", WORKBENCH_IEUM_BOOTSTRAP: "0", WORKBENCH_PORT: "0", WORKBENCH_EDITORS_PORT: "0",
    WORKBENCH_UPDATE_SOURCE: "http://127.0.0.1:9/", WORKBENCH_CODEX_BIN: join(repo, "scripts/fixtures/fake-codex.mjs"), WORKBENCH_CLAUDE_BIN: join(repo, "scripts/fixtures/fake-claude.mjs") } });
  return new Promise((done, fail) => {
    gateway.once("exit", (code) => fail(Error(`gateway exited (${code})`)));
    createInterface({ input: gateway.stdout! }).on("line", (line) => { if (line.startsWith("WORKBENCH_READY ")) done({ gateway, ...JSON.parse(line.slice(16)) }); });
  });
}
const stop = (gateway: ChildProcess) => new Promise<void>((done) => { gateway.removeAllListeners("exit"); gateway.once("exit", () => done()); gateway.kill("SIGTERM"); });

// ── 1. the records the API makes (projects, conversations, documents) ────────────────────────────
let host = await start();
const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${host.url}${path}`, { method, headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return (await response.json()) as T;
};
const project = async (title: string, folder: string, files: Record<string, string>) => {
  const cwd = join(works, folder);
  mkdirSync(cwd, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(cwd, name), text);
  const created = await api<Work>("POST", "/api/works", { title, folderId: null, cwd });
  return api<Work>("PATCH", `/api/works/${created.id}`, { title });
};
const conversation = (work: Work, provider: "codex" | "claude", purpose: string) => api<Session>("POST", `/api/works/${work.id}/sessions`, { provider, purpose, access: "auto" });
const lecture = await project("3주차 강의 슬라이드", "lecture", { "강의안.md": "# 3주차 강의안\n\n질문으로 시작한다.\n" });
const meeting = await project("학과 회의록 정리", "meeting", { "회의록-11월.md": "# 11월 학과 회의\n" });
const review = await project("논문 리뷰 메모", "review", {});
const slides = await conversation(lecture, "codex", "슬라이드 정리");
const sources = await conversation(lecture, "claude", "자료 조사");
const minutes = await conversation(meeting, "codex", "회의록");
const memo = await conversation(meeting, "codex", "지난 회의 메모");
const reviewer = await conversation(review, "codex", "리뷰 정리");
const plan = await api<Artifact>("POST", `/api/works/${lecture.id}/artifacts`, { path: "강의안.md" });
const notes = await api<Artifact>("POST", `/api/works/${meeting.id}/artifacts`, { path: "회의록-11월.md" });
await stop(host.gateway);

// ── 2. three days of what happened, written into the stopped gateway's store ───────────────────────
const now = Date.now();
const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
// Today's lines are in the morning; a run before noon would put some in the future (they stay before now).
const today = (h: number, m = 0) => Math.min(midnight.getTime() + (h * 60 + m) * 60_000, now - 60_000 * (12 * 60 - h * 60 - m + 1));
const yesterday = (h: number, m = 0) => midnight.getTime() - 86_400_000 + (h * 60 + m) * 60_000;
const before = (h: number, m = 0) => midnight.getTime() - 2 * 86_400_000 + (h * 60 + m) * 60_000;
const store = new Store(join(data, "state", "state.sqlite"));
let n = 0;
const say = (session: Session, at: number, text: string, extra: Partial<Extract<TranscriptItem, { kind: "user" }>> = {}) => store.saveItem(session.id, { kind: "user", id: `fx-u${++n}`, text, at, ...extra });
const end = (session: Session, at: number, status: "completed" | "failed" | "interrupted", durationMs: number, extra: Partial<Extract<TranscriptItem, { kind: "turnEnd" }>> = {}) => {
  store.saveItem(session.id, { kind: "assistant", id: `fx-a${++n}`, text: "답입니다.", streaming: false, at: at - 1000 });
  store.saveItem(session.id, { kind: "turnEnd", id: `fx-e${++n}`, status, durationMs, at, ...extra });
};
const ask = (session: Session, at: number, title: string, decision: "accept" | "decline" | null, extra: Partial<Extract<TranscriptItem, { kind: "approval" }>> = {}) => store.saveItem(session.id, { kind: "approval", id: `fx-p${++n}`, title, detail: null, reason: null, decision, at, ...extra });
// Revision 1 is the one the API recorded (its file copy exists): only its time and author are set back.
const firsts: [string, number, string, string | null][] = [];
const revise = (artifact: Artifact, revision: number, at: number, author: "user" | "engine" | "external", sessionId: string | null = null) =>
  revision === 1 ? void firsts.push([artifact.id, at, author, sessionId]) : store.saveRevision({ artifactId: artifact.id, revision, sha256: "", size: 0, author, sessionId, baseRevision: revision - 1 || null, note: null, at });
const backdate = (session: Session, createdAt: number, archivedAt: number | null = null) => {
  const stored = store.sessions().find((entry) => entry.id === session.id)!;
  store.saveSession({ ...stored, createdAt, ...(archivedAt ? { archivedAt } : {}) });
};
backdate(slides, before(9)); backdate(sources, before(9, 5)); backdate(minutes, yesterday(13, 50)); backdate(memo, before(15), before(18)); backdate(reviewer, today(10, 30));
// The day before yesterday: the lecture plan made and revised; an old meeting memo, answered, then archived.
revise(plan, 1, before(9, 30), "user");
say(slides, before(10), "강의안 도입부를 질문 하나로 시작하게 고쳐 줘");
end(slides, before(10, 6), "completed", 360_000);
store.saveProposal({ id: "fx-prop-1", artifactId: plan.id, sessionId: slides.id, requestId: "r", baseRevision: 1, workingPath: "/var/tmp/none", status: "applied", added: 4, removed: 1, appliedRevision: 2, createdAt: before(10, 5), updatedAt: before(10, 8) });
revise(plan, 2, before(10, 8), "engine", slides.id);
say(memo, before(15, 10), "지난 회의에서 정한 것만 추려 줘");
end(memo, before(15, 14), "completed", 240_000);
store.saveProposal({ id: "fx-prop-2", artifactId: plan.id, sessionId: slides.id, requestId: "r2", baseRevision: 2, workingPath: "/var/tmp/none", status: "discarded", added: 2, removed: 9, appliedRevision: null, createdAt: before(16), updatedAt: before(16, 20) });
// Yesterday: the meeting conversation (handed over, a stop), a document made by the AI and renamed; a refused command.
say(minutes, yesterday(14), "회의록 초안을 이어서 정리해 줘", { from: { sessionId: memo.id, label: "지난 회의 메모" } });
end(minutes, yesterday(14, 7), "completed", 420_000);
revise(notes, 1, yesterday(14, 6), "engine", minutes.id);
say(minutes, yesterday(15), "안건별로 표로 바꿔 줘");
end(minutes, yesterday(15, 2), "interrupted", 120_000, { cause: "stop" });
const stored = store.artifacts().find((entry) => entry.id === notes.id)!;
store.saveArtifact({ ...stored, renamed: { from: join(works, "meeting", "회의 메모.md"), to: stored.path, at: yesterday(15, 30) } });
say(slides, yesterday(16), "폴더를 정리해 줘");
ask(slides, yesterday(16, 1), "rm -rf 이전판/", "decline");
end(slides, yesterday(16, 3), "completed", 180_000);
// Today: a scheduled morning run, a run of three requests in one conversation (folded), a phone request that waited
// in the line, a person's own edit, a failure.
say(minutes, today(7), "어제 회의록에서 할 일만 뽑아 줘", { scheduled: true });
end(minutes, today(7, 3), "completed", 180_000);
say(slides, today(9, 5), "3주차 슬라이드 목차를 질문 → 사례 → 실습 순서로 다시 짜 줘");
end(slides, today(9, 9), "completed", 252_000);
say(slides, today(9, 12), "사례를 두 개 더 넣어 줘");
end(slides, today(9, 15), "completed", 190_000);
say(slides, today(9, 20), "실습 안내는 한 장으로 줄여 줘");
end(slides, today(9, 24), "completed", 228_000);
say(sources, today(9, 30), "오늘 읽을 논문 세 편을 요약해 줘", { origin: { channel: "telegram", bindingId: "fixture" }, waitedMs: 72_000 });
end(sources, today(10, 1), "completed", 1_860_000);
revise(plan, 3, today(11), "user");
say(minutes, today(11, 30), "회의록을 한글 문서로 만들어 줘");
end(minutes, today(11, 31), "failed", 45_000);
store.close();
{
  const db = new DatabaseSync(join(data, "state", "state.sqlite"));
  for (const [id, at, author, sessionId] of firsts) db.prepare("UPDATE revisions SET json = json_set(json, '$.at', ?, '$.author', ?, '$.sessionId', ?) WHERE artifact_id = ? AND revision = 1").run(at, author, sessionId, id);
  db.close();
}

// ── 3. the gateway again; one live approval (the stand-in Codex asks before a command) ─────────────
host = await start();
const prefs = await api<{ prefs: Record<string, unknown> }>("GET", "/api/snapshot");
const setPrefs = (patch: Record<string, unknown>) => api("PUT", "/api/prefs", { prefs: { ...prefs.prefs, onboarding: "done", startScreen: "last", sidebar: true, ...patch } });
await setPrefs({ theme: "light", navigator: { rail: "activity" } });
await api("POST", `/api/sessions/${reviewer.id}/messages`, { requestId: `fx-live-${Date.now()}`, text: "명령 실행해 줘. 폴더에 무엇이 있는지 확인하고 싶어." });
for (let i = 0; i < 100; i += 1) {
  const snap = await api<{ sessions: Session[] }>("GET", "/api/snapshot");
  if (snap.sessions.find((entry) => entry.id === reviewer.id)?.status === "awaitingApproval") break;
  await new Promise((done) => setTimeout(done, 100));
}

// ── 4. the frames ───────────────────────────────────────────────────────────────────────────────
const frames: { file: string; label: string }[] = [];
const browser = await chromium.launch();
const errors: string[] = [];
const shot = async (page: Page, file: string, label: string) => { await page.waitForTimeout(400); await page.screenshot({ path: join(out, file) }); frames.push({ file, label }); console.log(`shot ${file}`); };
const open = async (theme: "light" | "dark", viewport: { width: number; height: number }, phone = false) => {
  await setPrefs({ theme, navigator: { rail: "activity" } });
  const page = await browser.newPage({ viewport, colorScheme: theme, ...(phone ? { hasTouch: true, isMobile: true } : {}) });
  page.on("pageerror", (error) => errors.push(`${theme} ${viewport.width}: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") errors.push(`${theme} ${viewport.width}: ${message.text().slice(0, 200)}`); });
  await page.goto(`${host.url}/?token=${encodeURIComponent(host.token)}`);
  await page.waitForSelector('[data-rail="activity"]', { state: "attached", timeout: 30_000 });
  await page.waitForTimeout(800);
  if (!(await page.locator(".sidebar").count())) { await page.click('.topbar-left [aria-label="사이드바 열기"]'); await page.waitForSelector(".sidebar"); await page.waitForTimeout(300); }
  if (!(await page.locator('.sidebar[data-rail="activity"]').count())) await page.click('.nav-rail [data-rail="activity"]');
  await page.waitForSelector('.nav-activity [data-activity-look="history"]', { timeout: 10_000 });
  return page;
};
const history = async (page: Page) => {
  await page.click('.nav-activity [data-activity-look="history"]');
  await page.waitForSelector(".nav-hist-line", { timeout: 10_000 });
};
try {
  for (const theme of ["light", "dark"] as const) {
    const page = await open(theme, { width: 1440, height: 900 });
    await shot(page, `1440-${theme}-0-today.png`, `1440×900 ${theme} · 현황 (as before, the default)`);
    await history(page);
    await page.mouse.move(1300, 850);
    await shot(page, `1440-${theme}-1-history.png`, `1440×900 ${theme} · 기록 · 전체`);
    await page.click('.nav-hist-line.folded');
    await shot(page, `1440-${theme}-2-fold-open.png`, `1440×900 ${theme} · a folded run opened`);
    await page.click('.nav-hist-chips button:has-text("내가 확인할 것")');
    await page.waitForSelector('.nav-hist-line[data-history-line="approval"]', { timeout: 10_000 });
    await shot(page, `1440-${theme}-3-attention.png`, `1440×900 ${theme} · 내가 확인할 것`);
    await page.click('.nav-hist-chips button:has-text("문제")');
    await page.waitForSelector('.nav-hist-line[data-history-line="failed"]', { timeout: 10_000 });
    await shot(page, `1440-${theme}-4-problem.png`, `1440×900 ${theme} · 문제`);
    if (theme === "light") {
      await page.click('.nav-hist-chips button:has-text("전체")');
      await page.click('.nav-hist-project');
      await page.click('[role="option"]:has-text("학과 회의록 정리")');
      await page.waitForTimeout(600);
      await shot(page, `1440-light-5-project.png`, "1440×900 light · 프로젝트: 학과 회의록 정리");
      await page.click('.nav-hist-project');
      await page.click('[role="option"]:has-text("모든 프로젝트")');
      await page.waitForTimeout(600);
      await page.click('.nav-hist-line[data-history-line="request"]:has-text("휴대폰에서")');
      await page.waitForTimeout(900);
      await shot(page, `1440-light-6-opened.png`, "1440×900 light · a line clicked: its conversation opens");
    }
    await page.close();
  }
  for (const [width, height, phone] of [[1000, 800, false], [390, 844, true]] as const) {
    const page = await open("light", { width, height }, phone);
    await history(page);
    await shot(page, `${width}-light-history.png`, `${width}×${height} light · 기록${phone ? " (phone)" : ""}`);
    await page.close();
  }
} finally {
  await browser.close();
  await stop(host.gateway);
  rmSync(data, { recursive: true, force: true });
}
writeFileSync(join(out, "index.html"), `<!doctype html><meta charset="utf-8"><title>활동 › 기록</title><style>body{font:14px system-ui;margin:24px}figure{margin:0 0 32px}img{max-width:100%;border:1px solid #ccc}</style><h1>활동 › 기록 (activity-history)</h1>
<p>Fixture: three projects, five conversations, two documents; three days of requests (PC, phone with a 72 s wait in the line, a schedule, a hand-over), answers, a failure, a stop, a refused command, one live approval (stand-in Codex), revisions, 수정안 applied and discarded, a rename, an archived conversation.</p>
${frames.map((frame) => `<figure><figcaption>${frame.label} — ${frame.file}</figcaption><img src="${frame.file}"></figure>`).join("\n")}
<h2>Console errors</h2><pre>${errors.join("\n") || "none"}</pre>`);
console.log(`errors: ${errors.length}`);
