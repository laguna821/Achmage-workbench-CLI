/// <reference lib="dom" />
// Browser check of "프로젝트 = 노트 한 장", for Codex and Claude alike, against a real gateway driving
// stand-in engines (no model), in temporary folders (the user's files are never touched):
//   the project page from the conversation's header; the stage written into a real note file and
//   undone (the file goes again); a tag; "결정으로" on a reply puts a line with its source into the
//   note; a person's edit of a document and the new decision are put before the next request (a line
//   left out stays out); an engine's write to the note is shown and put back; the archive stage
//   archives the project and undo restores it; the context card shows the decisions; stage names
//   change in the settings.
// Usage: node scripts/project-check.ts [outDir] [codex|claude]

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Page } from "playwright-core";
import type { Artifact, Provider, Session, TranscriptItem, Work } from "@workbench/contracts";

const outDir = process.argv[2] ?? join(tmpdir(), "wb-project");
const providers: Provider[] = process.argv[3] === "codex" || process.argv[3] === "claude" ? [process.argv[3]] : ["codex", "claude"];
mkdirSync(outDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "workbench-project-"));
const foldersDir = mkdtempSync(join(tmpdir(), "workbench-project-folders-"));
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
const until = async (what: () => Promise<boolean> | boolean, timeout = 15_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await what()) return true;
    await new Promise((done) => setTimeout(done, 100));
  }
  return false;
};
const answered = (id: string, needle: string) => until(async () => (await items(id)).some((item) => item.kind === "assistant" && !item.streaming && item.text.includes(needle)), 20_000);
await api("PUT", "/api/prefs", { prefs: { onboarding: "done", startScreen: "last" } });

const browser = await chromium.launch();
const logs: string[] = [];

async function menuPick(page: Page, label: string) {
  await page.locator(".context-menu .context-menu-item", { hasText: label }).first().click();
}

async function flow(provider: Provider) {
  const label = provider === "codex" ? "Codex" : "Claude";
  const folder = join(foldersDir, provider);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "강의계획.md"), "# 강의계획\n\n1주차: 소개\n");
  const title = `${label} 안녕`;
  const work = await api<Work>("POST", "/api/works", { title, cwd: folder });
  const doc = await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path: "강의계획.md" });
  const session = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider, purpose: "슬라이드", access: "auto" });
  await api("POST", `/api/sessions/${session.id}/messages`, { requestId: `${provider}-r1`, text: "처음 요청입니다. 표지는 B안으로 하겠습니다." });
  await answered(session.id, "");
  // The work is named from the first request (automatic titles): where its note goes, as the gateway says.
  const named = (await snapshot()).works.find((entry) => entry.id === work.id)!.title;
  const notePath = (await api<{ note: { path: string } }>("GET", `/api/projects/${work.id}`)).note.path;
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("console", (message) => message.type() === "error" && logs.push(`[${label} error] ${message.text().slice(0, 200)}`));
  page.on("pageerror", (error) => logs.push(`[${label} pageerror] ${error.message.slice(0, 200)}`));
  const shot = (name: string) => page.screenshot({ path: join(outDir, `${provider}-${name}`) });
  const pass = (step: string, ok: boolean, detail = "") => check(`[${label}] ${step}`, ok, detail);
  try {
    await page.addInitScript((id) => localStorage.setItem("workbench.lastWork", id), work.id);
    await page.goto(`${ready.url}/?token=${ready.token}`);
    await page.waitForSelector(".composer-input");

    // ── the project page, from the conversation's header ─────────────────────────────────────
    await page.locator(".project-link").click();
    await page.waitForSelector(".project-view .project-title");
    const pageTitle = await page.locator(".project-title").innerText();
    await page.waitForSelector(".project-view .project-row");
    const rows = await page.locator(".project-view .project-row").allInnerTexts();
    await shot("01-project.png");
    pass("대화 머리의 프로젝트 이름 → 프로젝트 페이지(세션·파일, 노트는 아직 없음)", pageTitle === named && notePath === join(folder, `${named}.md`) && rows.some((row) => row.includes("슬라이드")) && rows.some((row) => row.includes("강의계획.md")) && !existsSync(notePath), rows.join(" | ").replace(/\s+/g, " "));

    // ── the stage, written into a real note, and undone ─────────────────────────────────────
    await page.locator(".project-stage").click();
    await menuPick(page, "진행중");
    const made = await until(() => existsSync(notePath) && readFileSync(notePath, "utf8").includes("단계: 진행중"));
    const madeText = made ? readFileSync(notePath, "utf8") : "";
    await page.locator(".toast button", { hasText: "되돌리기" }).click();
    const undone = await until(() => !existsSync(notePath));
    pass("단계를 고르면 노트 파일이 생기고(workbench_id·단계), 되돌리기로 파일까지 없어짐", made && madeText.includes(`workbench_id: ${work.id}`) && undone, madeText.replace(/\n/g, "⏎"));
    await page.locator(".project-stage").click();
    await menuPick(page, "진행중");
    await until(() => existsSync(notePath));
    // ── 속성: Obsidian-like, the template's fields from the start, each written in its kind ─────
    const keys = await page.locator(".properties-panel .prop-row .prop-key").allInnerTexts();
    pass("속성 칸: 템플릿의 단계·태그·종류·시작일·마감일·중요도·목표·관련이 처음부터 보임", keys.join("·") === "단계·태그·종류·시작일·마감일·중요도·목표·관련", keys.join("·"));
    await page.locator('.prop-row[data-key="tags"] .prop-add-value').click();
    await page.locator('.prop-row[data-key="tags"] .prop-input').fill("강의");
    await page.locator('.prop-row[data-key="tags"] .prop-input').press("Enter");
    const tagged = await until(() => existsSync(notePath) && readFileSync(notePath, "utf8").includes("tags:\n  - 강의"));
    pass("태그는 노트의 tags 목록으로(다른 줄은 그대로)", tagged && readFileSync(notePath, "utf8").includes("단계: 진행중"));
    await page.locator('.prop-row[data-key="시작일"] .prop-quick', { hasText: "오늘" }).click();
    const today = new Date();
    const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const dated = await until(() => readFileSync(notePath, "utf8").includes(`시작일: ${ymd}`));
    await page.locator(".prop-add", { hasText: "속성 추가" }).click();
    await page.locator(".prop-new .prop-input").fill("회차");
    await page.locator(".prop-new .prop-new-kind").selectOption("number");
    await page.locator(".prop-new .button", { hasText: "추가" }).click();
    await page.waitForSelector('.prop-row[data-key="회차"]');
    await page.locator('.prop-row[data-key="회차"] .prop-value').click();
    await page.locator('.prop-row[data-key="회차"] .prop-input').fill("3");
    await page.locator('.prop-row[data-key="회차"] .prop-input').press("Enter");
    const numbered = await until(() => readFileSync(notePath, "utf8").includes("회차: 3\n"));
    await shot("01b-properties.png");
    pass("날짜 '오늘'은 YYYY-MM-DD로, 새 속성 '회차'(숫자)는 따옴표 없이", dated && numbered, readFileSync(notePath, "utf8").split("---")[1]?.replace(/\n/g, "⏎") ?? "");

    // ── 속성 템플릿: from a Markdown file's front matter, then back to the default ─────────────
    const templateFile = join(folder, "내 템플릿.md");
    writeFileSync(templateFile, ["---", "tags: []", "학기: 2026-2", "마감: 2026-12-01", "공개: true", "---", "본문"].join("\n"));
    await page.locator(".properties-head .link", { hasText: "템플릿" }).click();
    await page.waitForSelector(".template-dialog .template-field");
    await page.locator('.template-dialog input[type="file"]').setInputFiles(templateFile);
    await page.waitForSelector(".template-dialog .notice");
    const imported = await page.locator(".template-dialog .template-key").evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));
    await page.locator(".template-dialog .button.primary", { hasText: "저장" }).click();
    await page.waitForSelector(".template-dialog", { state: "detached" });
    const after = await until(async () => (await page.locator(".properties-panel .prop-row .prop-key").allInnerTexts()).join("·").startsWith("단계·태그·학기·마감·공개"));
    await shot("01c-template.png");
    await page.locator(".properties-head .link", { hasText: "템플릿" }).click();
    await page.waitForSelector(".template-dialog .template-field");
    await page.locator(".template-dialog .button", { hasText: "기본값으로" }).click();
    await page.waitForSelector(".template-dialog", { state: "detached" });
    const reset = await until(async () => (await page.locator(".properties-panel .prop-row .prop-key").first().innerText()) === "단계" && (await page.locator('.prop-row[data-key="종류"]').count()) === 1);
    pass("속성 템플릿: MD 파일의 YAML로 바꾸면 모든 프로젝트 칸이 따르고, 기본값으로 되돌림", Boolean(after) && reset && imported.join("·") === "단계·tags·학기·마감·공개", imported.join("·"));
    await page.locator('button[aria-label="연결과 설정"]').click();
    await page.locator(".text-button", { hasText: "프로젝트 속성 템플릿…" }).click();
    const fromMenu = await page.waitForSelector(".template-dialog .template-field", { timeout: 5000 }).then(() => true, () => false);
    await page.locator('.template-dialog button[aria-label="닫기"]').click();
    pass("⋯ 설정 메뉴에서도 '프로젝트 속성 템플릿…'이 열림", fromMenu);

    // ── "결정으로" on a reply ────────────────────────────────────────────────────────────────
    await page.locator(".project-view .project-row", { hasText: "슬라이드" }).click();
    await page.waitForSelector(".message-keep");
    await page.locator(".message-keep", { hasText: "결정으로" }).first().click();
    const decided = await until(() => /## 결정\n- \d{4}-\d{2}-\d{2} .+ — .+ \(\[원문\]\(workbench:\/\/session\/.+\)\)/.test(readFileSync(notePath, "utf8")));
    pass("답의 '결정으로' → 노트의 ## 결정에 출처 링크와 함께 한 줄", decided, readFileSync(notePath, "utf8").split("## 결정")[1]?.trim().slice(0, 90) ?? "");

    // ── what changed, put before the next request ───────────────────────────────────────────
    await api("PUT", `/api/artifacts/${doc.id}/text`, { expectedRevision: 1, text: "# 강의계획\n\n1주차: 소개\n2주차: 실습\n" });
    await page.waitForSelector(".change-chip", { timeout: 10_000 });
    const chip = await page.locator(".change-chip").innerText();
    await page.locator(".change-chip").click();
    const lines = await page.locator(".change-list li").allInnerTexts();
    await shot("02-changes.png");
    // Leave the stage line out (if there is one), keep the rest.
    const stageLine = page.locator(".change-list li", { hasText: "프로젝트 단계" });
    if (await stageLine.count()) await stageLine.locator("input").uncheck();
    await page.locator(".composer-input").fill("받은 글 보여줘");
    await page.locator(".composer-input").press("Enter");
    const got = await answered(session.id, "받은 글:");
    const said = (await items(session.id)).filter((item): item is Extract<TranscriptItem, { kind: "assistant" }> => item.kind === "assistant").at(-1)?.text ?? "";
    pass(
      "사람이 고친 문서와 새 결정이 다음 요청 앞에 붙고, 뺀 줄은 빠짐",
      got && said.includes("[지난 요청 뒤 바뀐 것") && said.includes("강의계획.md r1→r2: 사람이 고침 (+1 −0)") && said.includes("결정 추가:") && !said.includes("프로젝트 단계"),
      `${chip.replace(/\s+/g, " ")} · ${lines.length}줄`,
    );

    // ── an engine writes into the note: shown, and put back ─────────────────────────────────
    await api("POST", `/api/sessions/${session.id}/messages`, { requestId: `${provider}-note`, text: `노트에 적어: ${notePath}` });
    await until(() => readFileSync(notePath, "utf8").includes("엔진이 적은 줄"));
    await page.locator(".project-link").click();
    const banner = await page.waitForSelector(".project-engine-edit", { timeout: 15_000 }).then(() => true, () => false);
    await shot("03-engine-edit.png");
    await page.locator(".project-engine-edit button", { hasText: "되돌리기" }).click();
    const reverted = await until(() => !readFileSync(notePath, "utf8").includes("엔진이 적은 줄"));
    pass("엔진이 노트를 고치면 페이지에 보이고 '되돌리기'로 그 전 판으로", banner && reverted);

    // ── the archive stage (once the session is done: a working session cannot be archived) ──
    await until(async () => (await snapshot()).sessions.find((entry) => entry.id === session.id)?.status === "idle");
    await page.locator(".project-stage").click();
    await menuPick(page, "아카이브");
    const archived = await until(async () => Boolean((await snapshot()).works.find((entry) => entry.id === work.id)?.archivedAt));
    await page.locator(".toast button", { hasText: "되돌리기" }).click();
    const restored = await until(async () => !(await snapshot()).works.find((entry) => entry.id === work.id)?.archivedAt && readFileSync(notePath, "utf8").includes("단계: 진행중"));
    pass("'아카이브' 단계는 프로젝트를 보관함으로, 되돌리기는 보관과 단계를 함께 되돌림", archived && restored);

    // ── what the engines are told, and the stages' names ───────────────────────────────────
    await page.locator(".project-card summary").click();
    const card = await page.locator(".project-card pre").innerText();
    pass("'엔진이 아는 것'에 노트 경로·단계·태그·최근 결정", card.includes(`프로젝트 노트: ${notePath}`) && card.includes("단계: 진행중 · 태그: #강의") && card.includes("최근 결정"));
    await page.locator(".project-stage").click();
    await menuPick(page, "단계 이름·색 바꾸기");
    await page.waitForSelector(".stage-dialog");
    await page.locator(".stage-name").first().fill("준비");
    await page.locator(".stage-dialog .button.primary", { hasText: "저장" }).click();
    await page.locator(".project-stage").click();
    const renamed = await page.locator(".context-menu-item", { hasText: "준비" }).count();
    await page.keyboard.press("Escape");
    await shot("04-stages.png");
    await api("PUT", "/api/projects/stages", { stages: [{ name: "할일", color: "#e5484d" }, { name: "진행중", color: "#3e63dd" }, { name: "완료", color: "#30a46c" }, { name: "보류", color: "#e2a400" }, { name: "아카이브", color: "#8e4ec6", archive: true }] });
    pass("단계 이름은 설정에서 바뀜(노트에 적힌 이름은 그대로)", renamed >= 1 && readFileSync(notePath, "utf8").includes("단계: 진행중"));
  } catch (error) {
    pass("실행", false, error instanceof Error ? error.message.split("\n")[0]! : String(error));
    await page.screenshot({ path: join(outDir, `${provider}-99-failure.png`) }).catch(() => undefined);
  } finally {
    await page.close();
  }
}

/** "연결": two projects joined by 관련 show each other; the link opens the other's page. */
async function connections() {
  const works = (await snapshot()).works.filter((work) => !work.archivedAt);
  if (works.length < 2) return;
  const [first, second] = works as [Work, Work];
  await api("PUT", `/api/projects/${first.id}/property`, { key: "관련", values: [`[[${second.title}]]`] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.addInitScript((id) => localStorage.setItem("workbench.lastWork", id), second.id);
    await page.goto(`${ready.url}/?token=${ready.token}`);
    await page.waitForSelector(".project-link");
    await page.locator(".project-link").click();
    await page.waitForSelector('.project-view section[aria-label="연결"] .project-row', { timeout: 10_000 });
    const listed = await page.locator('.project-view section[aria-label="연결"] .project-row').allInnerTexts();
    await page.locator('.project-view section[aria-label="연결"] .project-row').first().click();
    await page.waitForFunction((title) => document.querySelector(".project-view .project-title")?.textContent === title, first.title, { timeout: 8000 });
    await page.screenshot({ path: join(outDir, "05-connections.png") });
    check("연결: '관련'으로 이은 프로젝트가 서로의 페이지에 보이고, 누르면 그 페이지로", listed.some((row) => row.includes(first.title) && row.includes("관련")), listed.join(" | ").replace(/\s+/g, " "));
  } catch (error) {
    check("연결", false, error instanceof Error ? error.message.split("\n")[0]! : String(error));
  } finally {
    await page.close();
  }
}

try {
  for (const provider of providers) await flow(provider);
  await connections();
} finally {
  writeFileSync(join(outDir, "console.log"), logs.join("\n"));
  writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
  await browser.close();
  child.kill();
  await new Promise((done) => (child.exitCode === null && child.signalCode === null ? child.once("exit", done) : done(null)));
  for (const dir of [dataDir, foldersDir]) rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((result) => !result.ok).length;
  console.log(`${results.length - failed}/${results.length} passed · console: ${logs.length ? logs.slice(0, 6).join(" | ") : "clean"}`);
  process.exitCode = failed ? 1 : 0;
}
