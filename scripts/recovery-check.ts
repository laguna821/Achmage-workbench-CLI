/// <reference lib="dom" />
// Browser check of "끊기는 길" (design §8), for Codex and Claude alike, against a real gateway driving
// stand-in engines that can die in the middle of a turn ([[crash]]; no model):
// - a stopped turn's working copy stays as "중단된 턴의 일부 수정안", reviewed and applied;
// - when the engine dies: the turn ends ("엔진이 멈춰 끊김"), the request waiting for it is held (not
//   sent), the partial proposal survives and is applied, another session may edit the same document
//   (no 409), and the session shows under '오류·멈춤' on the home screen;
// - a request sent to another session whose engine died gets "다시 보내기" and is answered;
// - a link A→B→C hands C A's draft too; C's engine dying pauses the link ("응답이 끊겨 멈춤") and
//   "이어 가기" asks C again;
// - documents an engine writes through the shell stay searchable across revisions: Hangul (kordoc),
//   Word and PowerPoint (IeumOffice), whichever tool is installed here.
// Usage: node scripts/recovery-check.ts [outDir] [codex|claude]

import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Page } from "playwright-core";
import type { Artifact, Handoff, Proposal, Provider, SearchResult, Session, SessionLink, TranscriptItem, Work } from "@workbench/contracts";
import { findKordocRunner } from "../apps/host/src/kordoc.ts";
import { findIeumCli } from "../apps/host/src/ieumoffice.ts";

const outDir = process.argv[2] ?? join(tmpdir(), "wb-recovery");
const providers: Provider[] = process.argv[3] === "codex" || process.argv[3] === "claude" ? [process.argv[3]] : ["codex", "claude"];
mkdirSync(outDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "workbench-recovery-"));
const worksDir = mkdtempSync(join(tmpdir(), "workbench-recovery-works-"));
const fixtures = mkdtempSync(join(tmpdir(), "workbench-recovery-files-"));
// Where the stand-ins remember which requests already crashed once.
const engineState = mkdtempSync(join(tmpdir(), "workbench-recovery-state-"));
const claudeConfig = mkdtempSync(join(tmpdir(), "workbench-recovery-claude-"));
const results: { step: string; ok: boolean; detail: string }[] = [];
const check = (step: string, ok: boolean, detail = "") => {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`);
};

// ── documents an engine "writes": two revisions each, made with the tools installed here ──────
const kordocRunner = findKordocRunner();
const ieumCli = findIeumCli();
function hwpx(word: string) {
  const request = join(fixtures, `${word}.json`);
  writeFileSync(request, JSON.stringify({ schemaVersion: 1, mode: "generate", markdown: `# 계획서\n\n${word} 일정을 정리합니다.`, outputDir: join(fixtures, word) }));
  // The runner shipped with the app generates HWPX itself; an installed skill keeps that in its core.
  const core = join(dirname(kordocRunner!), "../core/scripts/run.mjs");
  const generated = JSON.parse(execFileSync(process.execPath, [existsSync(core) ? core : kordocRunner!, request], { encoding: "utf8" })) as { files: { path: string }[] };
  const file = join(fixtures, `${word}.hwpx`);
  copyFileSync(generated.files.find((entry) => entry.path.endsWith(".hwpx"))!.path, file);
  return file;
}
function docx(word: string) {
  const source = join(fixtures, `${word}.md`);
  writeFileSync(source, `# 수업 안내\n\n${word} 활동을 합니다.\n`);
  const file = join(fixtures, `${word}.docx`);
  execFileSync(ieumCli!, ["convert", source, "--to", "docx", "--out", file, "--json"], { env: { ...process.env, GENOFFICE_ALLOWED_ROOTS: fixtures, GENOFFICE_AUDIT_LOG: "off" }, stdio: "pipe" });
  return file;
}
const made = {
  hwpx: kordocRunner ? { first: hwpx("해바라기"), second: hwpx("코스모스"), before: "해바라기", after: "코스모스" } : null,
  docx: ieumCli ? { first: docx("진달래"), second: docx("개나리"), before: "진달래", after: "개나리" } : null,
  pptx: ieumCli ? { first: resolve("scripts/fixtures/cover.pptx"), word: "가을 특강" } : null,
};

const child = spawn(process.execPath, ["apps/host/src/main.ts"], {
  env: {
    ...process.env,
    WORKBENCH_DATA_DIR: dataDir,
    WORKBENCH_WEB_DIR: "apps/web/dist",
    WORKBENCH_HOST_LABEL: "노트북",
    WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"),
    WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"),
    FAKE_ENGINE_STATE: engineState,
    CLAUDE_CONFIG_DIR: claudeConfig,
  },
  stdio: ["ignore", "pipe", "inherit"],
});
const ready = await new Promise<{ url: string; token: string }>((done) => {
  createInterface({ input: child.stdout! }).on("line", (line) => {
    if (line.startsWith("WORKBENCH_READY ")) done(JSON.parse(line.slice(16)));
  });
});
const call = async <T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
  const response = await fetch(`${ready.url}${path}`, { method, headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: (await response.json().catch(() => null)) as T };
};
const api = async <T>(method: string, path: string, body?: unknown) => (await call<T>(method, path, body)).body;
const snapshot = () => api<{ sessions: Session[]; artifacts: Artifact[]; proposals: Proposal[]; handoffs: Handoff[]; links: SessionLink[] }>("GET", "/api/snapshot");
const session = async (id: string) => (await snapshot()).sessions.find((entry) => entry.id === id)!;
const items = async (id: string) => (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${id}/items`)).items;
const search = async (word: string) => (await api<SearchResult>("GET", `/api/search?q=${encodeURIComponent(word)}`)).documents.map((entry) => entry.artifactId);
const until = async (what: () => Promise<boolean>, timeout = 15_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await what()) return true;
    await new Promise((done) => setTimeout(done, 100));
  }
  return false;
};
let requests = 0;
const requestId = (tag: string) => `${tag}-${Date.now()}-${++requests}`;
await api("PUT", "/api/prefs", { prefs: { onboarding: "done", startScreen: "last" } });

const browser = await chromium.launch();
const logs: string[] = [];

async function flow(provider: Provider) {
  const label = provider === "codex" ? "Codex" : "Claude";
  const other: Provider = provider === "codex" ? "claude" : "codex";
  const cwd = join(worksDir, provider);
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "강의안.md"), "# 강의안\n\n도입 문단입니다.\n\n본문 문단입니다.\n");
  const work = await api<Work>("POST", "/api/works", { title: `${label} 끊김`, cwd });
  // Named by hand: the requests below name file paths, which the automatic title would take up.
  await api("PATCH", `/api/works/${work.id}`, { title: `${label} 끊김` });
  const doc = await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path: "강의안.md" });
  // Full access: no approval stands between a request and its crash.
  const writer = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider, purpose: "고치기", access: "full" });
  const helper = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider, purpose: "다른 세션", access: "full" });
  const show = (target: Session) => api("PATCH", `/api/works/${work.id}`, { activeSessionId: target.id });
  await show(writer);
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on("console", (message) => message.type() === "error" && logs.push(`[${label} error] ${message.text().slice(0, 200)}`));
  page.on("pageerror", (error) => logs.push(`[${label} pageerror] ${error.message.slice(0, 200)}`));
  const shot = (name: string, target: Page = page) => target.screenshot({ path: join(outDir, `${provider}-${name}`) });
  const pass = (step: string, ok: boolean, detail = "") => check(`[${label}] ${step}`, ok, detail);
  const idle = (id: string, timeout = 20_000) => until(async () => (await session(id)).status === "idle", timeout);
  const proposalOf = async (sessionId: string, status?: Proposal["status"]) => (await snapshot()).proposals.filter((entry) => entry.sessionId === sessionId && entry.artifactId === doc.id && (!status || entry.status === status)).at(-1);
  const docComposer = async (text: string) => {
    const input = page.locator(".doc-composer .composer-input");
    await input.fill(text);
    await input.press("Enter");
  };
  const openWork = async () => {
    await page.locator(`.sidebar [data-row-id="${work.id}"]`).click();
    await page.waitForSelector(".work-view .transcript");
  };
  const openDoc = async () => {
    await page.locator(".docs-button").click();
    await page.locator(".docs-menu .menu-item", { hasText: "강의안.md" }).click();
    await page.waitForSelector(".document-view .doc-composer");
  };
  try {
    await page.addInitScript((id) => localStorage.setItem("workbench.lastWork", id), work.id);
    await page.goto(`${ready.url}/?token=${ready.token}`);
    await page.waitForSelector(".work-view");
    await openDoc();

    // ── a stopped turn: what its working copy holds is a proposal to review ──────────────────────
    await docComposer("본문을 고쳐 줘 길게");
    await until(async () => (await proposalOf(writer.id, "running")) !== undefined && (await session(writer.id)).status === "running", 8000);
    await page.waitForTimeout(1200);
    await page.keyboard.press("Alt+1");
    await page.waitForSelector(".work-view .composer");
    await page.locator('.work-view .composer button[aria-label="중단"]').click();
    await idle(writer.id);
    const stopped = await proposalOf(writer.id);
    await page.waitForSelector(".proposal-card .partial-note", { timeout: 8000 }).catch(() => undefined);
    await page.locator(".proposal-card").last().scrollIntoViewIfNeeded();
    const card = await page.locator(".proposal-card").last().innerText().catch(() => "");
    await shot("01-stopped-proposal.png");
    await page.locator(".proposal-card").last().locator(".button", { hasText: "미리보기" }).click();
    await page.waitForSelector(".doc-compare .partial-note", { timeout: 8000 });
    const compareHead = (await page.locator(".doc-compare-head").innerText()).replace(/\s+/g, " ");
    const diff = await page.locator(".doc-compare").innerText();
    await shot("02-compare.png");
    await page.locator(".doc-compare-actions .button.primary", { hasText: "적용" }).click();
    const appliedStop = await until(async () => (await snapshot()).artifacts.find((entry) => entry.id === doc.id)?.revision === 2, 8000);
    const closedStop = (await snapshot()).proposals.find((entry) => entry.id === stopped?.id);
    pass(
      "멈춘 턴의 작업 사본이 '중단된 턴의 일부 수정안'으로 남고, 비교 화면에서 적용됨(r2)",
      stopped?.status === "pending" && stopped.interruptedBy === "stop" && card.includes("중단된 턴의 일부 수정안") && compareHead.includes("중단된 턴의 일부 수정안 · 멈춤") && diff.includes("고친 문단") && appliedStop && closedStop?.closedBy === "user",
      `${stopped?.status}/${stopped?.interruptedBy} → ${closedStop?.status}/${closedStop?.closedBy} · ${compareHead.replace(/\s+/g, " ").slice(0, 60)}`,
    );

    // ── the engine dies mid-turn: the waiting request stays, the edit survives ──────────────────
    await page.waitForSelector(".document-view .doc-composer");
    // The editor shows r2 before the next request pins it.
    await page.waitForFunction(() => document.querySelector(".doc-composer .ref-chip")?.textContent?.includes("r2"), undefined, { timeout: 8000 });
    await docComposer("다시 고쳐 줘 [[crash]]");
    await until(async () => (await session(writer.id)).status === "running", 8000);
    await page.waitForTimeout(400);
    // Written while it works (the document's input waits for the end of the turn).
    await docComposer("끝나면 이것도 정리해 줘");
    const queued = await until(async () => (await session(writer.id)).queued.some((entry) => entry.text === "끝나면 이것도 정리해 줘"), 5000);
    const crashed = await until(async () => (await items(writer.id)).some((item) => item.kind === "turnEnd" && item.cause === "crash"), 15_000);
    await idle(writer.id);
    await page.waitForTimeout(1500);
    const after = await session(writer.id);
    const list = await items(writer.id);
    const end = list.findLast((item) => item.kind === "turnEnd");
    const sentAnyway = list.some((item) => item.kind === "user" && item.text === "끝나면 이것도 정리해 줘");
    const heldNote = list.some((item) => item.kind === "notice" && item.text.includes("엔진이 멈춰 보낼 예정인 요청 1개"));
    await page.keyboard.press("Alt+1");
    await page.waitForSelector(".work-view .queued-list .queued-row.held", { timeout: 5000 }).catch(() => undefined);
    await page.locator(".turn-end").last().scrollIntoViewIfNeeded().catch(() => undefined);
    const endLine = await page.locator(".turn-end").last().innerText().catch(() => "");
    await shot("03-crash.png");
    pass(
      "엔진이 턴 중간에 멈추면 턴 끝 '엔진이 멈춰 끊김', 끝나면 보낼 요청은 보내지 않고 남김",
      queued && crashed && end?.kind === "turnEnd" && end.status === "failed" && end.cause === "crash" && endLine.includes("엔진이 멈춰 끊김") && !sentAnyway && after.queued.length === 1 && after.queued[0]!.held === true && heldNote && Boolean(after.lastError),
      `end=${end?.kind === "turnEnd" ? `${end.status}/${end.cause}` : "-"} queued=${after.queued.map((entry) => `${entry.text}${entry.held ? "(남김)" : ""}`).join("|")} lastError=${after.lastError?.slice(0, 50)}`,
    );
    const partial = await proposalOf(writer.id, "pending");
    // Another session may edit the same document now: the cut turn's proposal no longer blocks it.
    const edit = await call<{ delivery?: string; code?: string }>("POST", `/api/sessions/${helper.id}/messages`, {
      requestId: requestId("helper-edit"),
      text: "도입을 고쳐 줘",
      refs: [{ artifactId: doc.id, revision: 2, mode: "edit", selection: null }],
    });
    await idle(helper.id);
    const helperProposal = await proposalOf(helper.id, "pending");
    pass(
      "멈춘 턴의 수정안이 남고, 다른 세션이 같은 문서를 고칠 수 있음(409 아님)",
      partial?.interruptedBy === "crash" && edit.status === 202 && helperProposal !== undefined,
      `partial=${partial?.status}/${partial?.interruptedBy} · 다른 세션 ${edit.status}${edit.body?.code ? ` ${edit.body.code}` : ""} → 수정안 ${helperProposal?.status ?? "없음"}`,
    );
    if (helperProposal) await api("POST", `/api/proposals/${helperProposal.id}/discard`);

    // ── the home screen shows where it stopped ─────────────────────────────────────────────────
    await page.locator(".topbar .brand").click();
    await page.waitForSelector(".home-modes");
    if (!(await page.locator(".home-modes.mode-now").count())) await page.locator(".home-mode-bar button", { hasText: "지금" }).click();
    const trouble = await page.waitForSelector(".bucket-trouble .home-row", { timeout: 5000 }).then(() => page.locator(".bucket-trouble").innerText()).catch(() => "");
    await shot("04-home-trouble.png");
    pass("엔진이 멈춘 세션이 홈 '지금'의 '오류·멈춤'에 보임", trouble.includes("고치기"), trouble.replace(/\s+/g, " ").slice(0, 80));

    // ── the partial proposal is reviewed and applied; the held request goes by hand ──────────────
    await show(writer);
    await openWork();
    await openDoc();
    await page.waitForSelector(".doc-proposal .partial-note", { timeout: 5000 });
    const bar = (await page.locator(".doc-proposal", { has: page.locator(".partial-note") }).innerText()).replace(/\s+/g, " ");
    await page.locator(".doc-proposal", { has: page.locator(".partial-note") }).locator(".button.primary", { hasText: "적용" }).click();
    const appliedCrash = await until(async () => (await snapshot()).artifacts.find((entry) => entry.id === doc.id)?.revision === 3, 8000);
    const text = readFileSync(join(cwd, "강의안.md"), "utf8");
    await page.keyboard.press("Alt+1");
    await page.waitForSelector(".work-view .queued-list .queued-row");
    await page.locator(".queued-row .link", { hasText: "지금 보내기" }).click();
    const resent = await until(async () => (await items(writer.id)).some((item) => item.kind === "user" && item.text === "끝나면 이것도 정리해 줘"), 8000);
    await idle(writer.id);
    const answered = (await items(writer.id)).findLast((item) => item.kind === "turnEnd");
    pass(
      "멈춘 턴의 수정안을 문서에서 적용(r3), 남긴 요청은 '지금 보내기'로 보내 엔진이 다시 답함",
      bar.includes("중단된 턴의 일부 수정안 · 엔진이 멈춤") && appliedCrash && text.includes("끊기기 전에 고친 문단") && resent && answered?.kind === "turnEnd" && answered.status === "completed",
      `${bar.replace(/\s+/g, " ").slice(0, 70)} · r3=${appliedCrash}`,
    );

    // ── a request sent to another session whose engine died: "다시 보내기" ────────────────────
    const handoffId = requestId("handoff");
    await api("POST", "/api/handoffs", { requestId: handoffId, sourceSessionId: helper.id, targetSessionId: writer.id, text: "인용 근거를 확인해 줘 [[crash-once]]", refs: [] });
    const failed = await until(async () => (await snapshot()).handoffs.find((entry) => entry.id === handoffId)?.status === "failed", 15_000);
    await idle(writer.id);
    await show(helper);
    await page.waitForSelector(".handoff-card .handoff-resend", { timeout: 8000 });
    await page.locator(".handoff-card").last().scrollIntoViewIfNeeded();
    const failedCard = await page.locator(".handoff-card").last().innerText();
    await shot("05-handoff-failed.png");
    await page.locator(".handoff-card .handoff-resend").click();
    const again = await until(async () => {
      const handoffs = (await snapshot()).handoffs;
      const first = handoffs.find((entry) => entry.id === handoffId);
      return Boolean(first?.resentAs && handoffs.find((entry) => entry.id === first.resentAs)?.status === "answered");
    }, 15_000);
    // Sending goes to the other session's conversation (as any request to another session does): back to the source.
    await show(helper);
    await until(async () => (await page.locator(".handoff-card").count()) >= 2, 5000);
    await page.waitForTimeout(400);
    await page.locator(".handoff-card").last().scrollIntoViewIfNeeded();
    const cards = await page.locator(".handoff-card").allInnerTexts();
    await shot("06-handoff-resent.png");
    pass(
      "다른 세션에 보낸 요청이 엔진 멈춤으로 실패하면 '다시 보내기'로 같은 내용을 새 요청으로 보내 답을 받음",
      failed && failedCard.includes("엔진이 멈춰 응답이 끊겼습니다") && again && cards.length >= 2 && cards.some((entry) => entry.includes("다시 보냄")) && cards.at(-1)!.includes("답 도착"),
      `${failedCard.replace(/\s+/g, " ").slice(0, 60)} · cards=${cards.length}`,
    );

    // ── three sessions: C gets A's draft too; C's engine dies, the link pauses and goes on ─────────
    const la = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider, purpose: "초안", access: "full" });
    const lb = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: other, purpose: "검토", access: "full" });
    const lc = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider, purpose: "편집", access: "full" });
    const link = await api<SessionLink>("POST", "/api/links", { requestId: requestId("link"), participants: [la.id, lb.id, lc.id], goal: `${label} 강의 계획 다듬기 충돌:3`, maxRounds: 1, maxMinutes: 10 });
    const linkNow = async () => (await snapshot()).links.find((entry) => entry.id === link.id)!;
    const paused = await until(async () => (await linkNow()).state === "paused", 25_000);
    const held = await linkNow();
    const handed = (await items(lc.id)).find((item): item is Extract<TranscriptItem, { kind: "user" }> => item.kind === "user" && item.link?.hop === 3);
    const draftA = (await items(la.id)).findLast((item) => item.kind === "assistant")?.text ?? "";
    pass(
      "세 세션 잇기 A→B→C: C가 B의 답과 함께 A의 초안도 받음(말한 세션 이름을 붙여 차례대로)",
      Boolean(handed && draftA && handed.text.includes(draftA.split("\n")[0]!) && handed.text.includes("2번째 의견") && /\[.*초안의 답\][\s\S]*\[.*검토의 답\]/.test(handed.text) && handed.link?.from?.length === 2),
      handed?.text.replace(/\s+/g, " ").slice(0, 90) ?? "C가 받은 것 없음",
    );
    await show(lc);
    await page.waitForSelector(".linked-bar.paused", { timeout: 8000 });
    const pausedBar = await page.locator(".linked-bar").innerText();
    await shot("07-link-paused.png");
    // What C received: both answers, the badge naming both speakers.
    await page.locator(".transcript").first().evaluate((element) => (element.scrollTop = 0));
    await page.waitForTimeout(300);
    const badge = await page.locator(".linked-hop-from").first().innerText().catch(() => "");
    await shot("07b-link-received.png");
    await page.locator(".linked-bar-actions .link", { hasText: "이어 가기" }).click();
    const ended = await until(async () => (await linkNow()).state === "ended", 25_000);
    const finished = await linkNow();
    const askedAgain = (await items(lc.id)).filter((item) => item.kind === "user" && item.link?.hop === 3).length;
    await page.waitForSelector(".linked-end", { timeout: 5000 }).catch(() => undefined);
    await page.waitForTimeout(400);
    await shot("08-link-ended.png");
    pass(
      "C의 엔진이 멈추면 잇기는 끝나지 않고 '응답이 끊겨 멈춤', '이어 가기'로 C에게 다시 물어 끝까지 감",
      paused && held.reason === "cut" && pausedBar.includes("응답이 끊겨 멈춤") && pausedBar.includes("이어 가기") && badge.includes("초안, ") && badge.includes("검토의 답") && ended && finished.reason === "rounds" && finished.hops === 3 && askedAgain === 2,
      `${held.state}/${held.reason} → ${finished.state}/${finished.reason} ${finished.hops} · C에게 ${askedAgain}번 · ${badge.replace(/\s+/g, " ")}`,
    );

    // ── documents an engine writes stay searchable across revisions ─────────────────────────────
    await show(writer);
    const writeDoc = async (from: string, to: string, ask: string) => {
      await api("POST", `/api/sessions/${writer.id}/messages`, { requestId: requestId("write"), text: `[[cp ${from} ${to}]] ${ask}` });
      await until(async () => (await session(writer.id)).status !== "idle", 3000);
      await idle(writer.id);
    };
    const artifactNamed = async (name: string) => (await snapshot()).artifacts.find((entry) => entry.workId === work.id && entry.name === name);
    const searchable = async (name: string, files: { first: string; second: string; before: string; after: string }) => {
      await writeDoc(files.first, name, `${name}을(를) 만들어 줘`);
      const artifact = await artifactNamed(name);
      const first = await until(async () => Boolean(artifact) && (await search(files.before)).includes(artifact!.id), 15_000);
      await writeDoc(files.second, name, `${name}을(를) 새 내용으로 바꿔 줘`);
      // Until the new text is ready the document is still found (by its old words), never dropped.
      let gaps = 0;
      const second = await until(async () => {
        // The old words first: an entry switching in between is then found by one or the other.
        const old = (await search(files.before)).includes(artifact!.id);
        if ((await search(files.after)).includes(artifact!.id)) return true;
        if (!old) gaps += 1;
        return false;
      }, 15_000);
      const stale = (await search(files.before)).includes(artifact!.id);
      const revisions = (await snapshot()).artifacts.find((entry) => entry.id === artifact?.id)?.revision;
      return { ok: first && second && !stale && gaps === 0 && revisions === 2, detail: `${name} r${revisions} · '${files.before}' ${first} → '${files.after}' ${second} · 빈틈 ${gaps} · 옛 글 남음 ${stale}` };
    };
    if (made.hwpx) {
      const hangul = await searchable("계획서.hwpx", made.hwpx);
      pass("엔진이 셸로 만든 한글 문서(HWPX)가 새 판이 생겨도 찾아짐(kordoc, 새 글이 준비될 때까지 이전 항목 유지)", hangul.ok, hangul.detail);
    } else {
      pass("한글 문서 색인(kordoc 없음: 건너뜀)", true, "kordoc이 설치되어 있지 않음");
    }
    if (made.docx && made.pptx) {
      const word = await searchable("안내문.docx", made.docx);
      await writeDoc(made.pptx.first, "발표.pptx", "발표 자료를 만들어 줘");
      const slides = await artifactNamed("발표.pptx");
      const found = await until(async () => Boolean(slides) && (await search(made.pptx!.word)).includes(slides!.id), 15_000);
      pass("엔진이 만든 워드(DOCX)·PPT(PPTX)도 찾아짐(이음오피스 글 보기, 새 판에서도)", word.ok && found, `${word.detail} · 발표.pptx '${made.pptx.word}' ${found}`);
    } else {
      pass("오피스 문서 색인(이음오피스 없음: 건너뜀)", true, "이음오피스가 설치되어 있지 않음");
    }
    if (made.hwpx) {
      await page.keyboard.press("Escape");
      await page.locator(".transcript").first().click({ position: { x: 5, y: 5 } }).catch(() => undefined);
      await page.keyboard.press("Control+k");
      await page.waitForSelector(".palette");
      await page.locator(".palette-input input").fill(made.hwpx.after);
      const entry = await page.waitForSelector(".palette-entry.kind-doc", { timeout: 8000 }).then(() => page.locator(".palette-entry.kind-doc", { hasText: "계획서.hwpx" }).first().innerText()).catch(() => "");
      await page.waitForTimeout(300);
      await shot("09-search.png");
      await page.keyboard.press("Escape");
      pass("Ctrl+K에서 엔진이 만든 한글 문서가 새 판의 글로 찾아짐", entry.includes("계획서.hwpx") && entry.includes(made.hwpx.after), entry.replace(/\s+/g, " ").slice(0, 80));
    }
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
  for (const dir of [dataDir, worksDir, fixtures, engineState, claudeConfig]) rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((result) => !result.ok).length;
  console.log(`${results.length - failed}/${results.length} passed · console: ${logs.length ? logs.slice(0, 6).join(" | ") : "clean"}`);
  process.exitCode = failed ? 1 : 0;
}
