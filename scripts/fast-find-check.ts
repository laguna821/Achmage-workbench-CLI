/// <reference lib="dom" />
// The built web UI + real host + native Fast Find worker, using disposable synthetic records.
// Usage: WORKBENCH_SEARCH_WORKER_BIN=... BROWSER_BIN=... node scripts/fast-find-check.ts <evidence>
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Browser, type Page } from "playwright-core";
import { Store } from "../apps/host/src/store.ts";
import type { Work, Session, Artifact, SearchPage } from "@workbench/contracts";
import { put } from "../apps/host/src/vault-fixture.ts";

const out = resolve(process.argv[2]!); mkdirSync(out, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), "wb-fast-find-ui-")), vault = join(dir, "vault");
// Optional fixed synthetic corpus from fast-find-bench. Copy it into this check's private
// fixture so external edit/rename checks never modify the benchmark's originals.
if (process.argv[3]) cpSync(resolve(process.argv[3]), vault, { recursive: true });
const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`); };
const store = new Store(join(dir, "state.sqlite"));
const now = Date.now();
const work: Work = { id: "w-fast-find", title: "검색 검사 프로젝트", titleSource: "user", folderId: null,
  cwd: join(dir, "works"), cwdManaged: false, activeSessionId: "s-fast-find", pinned: false, sort: 0,
  archivedAt: null, createdAt: now, updatedAt: now };
mkdirSync(work.cwd, { recursive: true }); store.saveWork(work);
const session: Session = { id: "s-fast-find", workId: work.id, provider: "codex", hostId: "fixture", nativeSessionId: null,
  purpose: "일반 대화", purposeSource: "user", model: null, effort: null, engineModel: null, engineEffort: null,
  preview: "별빛해설의 첫 번째 답입니다.", previewAt: now - 2000, status: "idle", activity: null, lastError: null,
  pinned: false, sort: 0, archivedAt: null, seenAt: now, unread: false, queued: [], access: null, context: null,
  createdAt: now - 5000, updatedAt: now };
store.saveSession(session);
store.saveItem(session.id, { kind: "user", id: "exact-request", text: "별빛해설을 정리해 줘", at: now - 3000 });
store.saveItem(session.id, { kind: "assistant", id: "exact-answer", text: "별빛해설의 첫 번째 답입니다.", streaming: false, at: now - 2000 });
store.saveItem(session.id, { kind: "turnEnd", id: "end", status: "completed", durationMs: 1000, at: now - 1000 });
const original = '---\ntitle: 가을 연구 메모\naliases: [발표자료]\n"단계:": A\ntags: [연구]\n---\n# 연구 배경\n\n' + Array.from({ length: 80 }, (_, i) => `문단 ${i + 1}의 일반 배경입니다.\n\n`).join("") + '## 📝 해바라기 분석\n\n나비정원 검토를 끝냈습니다.\n';
put(vault, ".obsidian/app.json", "{}");
put(vault, ".obsidian/plugins/notebook-navigator/data.json", JSON.stringify({ vaultProfile: "default", vaultProfiles: [{ id: "default", hiddenFolders: ["비밀"] }] }));
put(vault, "연구/가을.md", original);
put(vault, "연구/가을 사본.md", '---\ntitle: 가을 연구 메모\n"단계:": B\n---\n봄 노트 사본');
put(vault, "비밀/숨김.md", '---\ntitle: 가을 연구 메모\n---\n숨김고유표식');
// Conversation-first regression: enough title-heavy projects to exceed the first group page,
// duplicate document/vault titles, and original replies that also made matching documents.
const sourcePrompt = "방금 이 앱을 새로 설치했는데 간단한 마크다운 문서를 하나 만들어봐 mermaid 그림이랑 테이블도 같이 포함해서";
for (let n = 0; n < 12; n++) {
  const conversation = n >= 10;
  const project: Work = { ...work, id: `w-priority-${n}`, cwd: join(dir, `priority-${n}`),
    title: conversation ? `원문 프로젝트 ${n}` : "mermaid 마크다운 문서", activeSessionId: conversation ? `s-priority-${n}` : null };
  mkdirSync(project.cwd, { recursive: true }); store.saveWork(project);
  const body = "# mermaid 마크다운 문서\n\n| 항목 | 값 |\n| --- | --- |\n| A | B |\n\n```mermaid\nflowchart LR\nA-->B\n```\n";
  const artifact: Artifact = { id: `doc-priority-${n}`, workId: project.id, path: join(project.cwd, "자료.md"), name: "자료.md", format: "markdown", revision: 1,
    sha256: createHash("sha256").update(body).digest("hex"), size: Buffer.byteLength(body), diskState: "same", readBy: {}, createdAt: now, updatedAt: now };
  writeFileSync(artifact.path, body);
  mkdirSync(join(dir, "artifacts", artifact.id), { recursive: true });
  writeFileSync(join(dir, "artifacts", artifact.id, "r1.md"), body);
  store.saveArtifact(artifact);
  store.saveRevision({ artifactId: artifact.id, revision: 1, sha256: artifact.sha256, size: artifact.size, author: conversation ? "engine" : "user",
    sessionId: project.activeSessionId, baseRevision: null, note: null, at: now });
  if (conversation) {
    const original: Session = { ...session, id: project.activeSessionId!, workId: project.id, purpose: `원문 대화 ${n}`, provider: n === 10 ? "codex" : "claude" };
    store.saveSession(original);
    store.saveItem(original.id, { kind: "user", id: `priority-request-${n}`, text: sourcePrompt, at: now - 6000 });
    store.saveItem(original.id, { kind: "artifact", id: `priority-artifact-${n}`, artifactId: artifact.id, revision: 1, change: "created", at: now - 5000 });
    store.saveItem(original.id, { kind: "assistant", id: `priority-answer-${n}`, text: "mermaid 그림과 테이블을 포함한 마크다운 문서를 만들었습니다.", streaming: false, at: now - 4000 });
    store.saveItem(original.id, { kind: "approval", id: `priority-plan-${n}`, title: "계획", detail: "마크다운 문서의 표와 mermaid 그림을 확인한다", reason: null, decision: "accept", plan: true, at: now - 3000 });
    store.saveItem(original.id, { kind: "assistant", id: `priority-followup-${n}`, text: "추가 답변: 마크다운 문서 확인을 완료했습니다.", streaming: false, at: now - 2000 });
    store.saveItem(original.id, { kind: "turnEnd", id: `priority-end-${n}`, status: "completed", durationMs: 1000, at: now - 1000 });
  }
}
for (let n = 0; n < 3; n++) put(vault, `중복${n}/자료.md`, "---\ntitle: mermaid 마크다운 문서\n---\n테이블과 그림 노트입니다.");
put(vault, "비밀/중복.md", "# mermaid 마크다운 문서\n숨김대화충돌");
store.setMeta("pkm.vault", vault);
store.setMeta("ui.prefs", JSON.stringify({ onboarding: "done", startScreen: "last" }));
store.close();

let child: ChildProcess | null = null, browser: Browser | null = null, page: Page | null = null;
const errors: string[] = [], requests: string[] = [];
try {
  child = spawn(process.execPath, ["apps/host/dist/host.mjs"], { env: { ...process.env, WORKBENCH_DATA_DIR: dir,
    WORKBENCH_WEB_DIR: resolve("apps/web/dist"), WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"),
    WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"), WORKBENCH_VAULT_SUGGEST: "" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr!.on("data", data => writeFileSync(join(out, "host.log"), data, { flag: "a" }));
  const ready = await new Promise<{ url: string; token: string }>((done, fail) => {
    const timeout = setTimeout(() => fail(Error("gateway start timeout")), 30_000);
    child!.once("exit", code => { clearTimeout(timeout); fail(Error(`gateway exited: ${code}`)); });
    createInterface({ input: child!.stdout! }).on("line", line => { if (line.startsWith("WORKBENCH_READY ")) { clearTimeout(timeout); done(JSON.parse(line.slice(16))); } });
  });
  const api = async (path: string) => { const r = await fetch(`${ready.url}${path}`, { headers: { authorization: `Bearer ${ready.token}` } }); if (!r.ok) throw Error(`${path}: ${r.status}`); return r.json(); };
  browser = await chromium.launch({ ...(process.env.BROWSER_BIN ? { executablePath: process.env.BROWSER_BIN } : {}) });
  page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (request.url().includes("/api/search")) requests.push(request.url().split("/api/")[1]!); });
  await page.goto(`${ready.url}/?token=${ready.token}`);
  await page.waitForSelector(".sidebar", { timeout: 30_000 });
  const palette = async (query: string) => {
    if (!(await page!.locator(".palette").count())) await page!.keyboard.press("Control+k");
    await page!.getByRole("textbox", { name: "찾을 말" }).fill(query);
    await page!.waitForFunction(q => document.querySelector<HTMLElement>(".search-summary")?.dataset.searchQuery === q && document.querySelector(".palette-list")?.getAttribute("aria-busy") === "false", query);
  };
  if (process.argv[3]) {
    const queries = ["data engineering", "alias9876", "자료707", "#교육", "채점 기준"];
    // Warm the complete corpus through the same strict API; measurements below are actual
    // input events to the first painted matching result list, including HTTP and React.
    await api("/api/search?q=alias9876&legacy=0");
    await palette("benchmark warmup");
    const samples: Record<string, number[]> = Object.fromEntries(queries.map(query => [query, []]));
    for (let round = 0; round < 18; round++) for (const query of queries) {
      await page.evaluate(q => {
        const state = window as unknown as { ffMeasure: { done: boolean; elapsed: number } };
        state.ffMeasure = { done: false, elapsed: 0 };
        const input = document.querySelector<HTMLInputElement>('.palette-input input')!;
        input.addEventListener("input", () => {
          const start = performance.now();
          const observer = new MutationObserver(() => {
            if (document.querySelector<HTMLElement>(".search-summary")?.dataset.searchQuery !== q || document.querySelector(".palette-list")?.getAttribute("aria-busy") !== "false") return;
            observer.disconnect();
            requestAnimationFrame(() => requestAnimationFrame(() => { state.ffMeasure = { done: true, elapsed: performance.now() - start }; }));
          });
          observer.observe(document.querySelector(".palette")!, { childList: true, subtree: true, attributes: true });
        }, { once: true });
      }, query);
      await page.getByRole("textbox", { name: "찾을 말" }).fill(query);
      await page.waitForFunction(() => (window as any).ffMeasure.done);
      const elapsed = await page.evaluate(() => (window as any).ffMeasure.elapsed as number);
      if (round >= 2) samples[query]!.push(elapsed);
    }
    const measurements = queries.map(query => {
      const times = samples[query]!.sort((a, b) => a - b);
      return { query, samples: times.length, inputToPaintP50Ms: times[Math.ceil(times.length * .5) - 1], inputToPaintP95Ms: times[Math.ceil(times.length * .95) - 1] };
    });
    writeFileSync(join(out, "input-to-paint.json"), JSON.stringify({ corpus: resolve(process.argv[3]), browser: await browser.version(), measurements }, null, 2));
    console.log("INPUT_TO_PAINT", JSON.stringify(measurements));
  }
  await palette("나비정원");
  await page.locator('.search-source:has-text("나비정원")').waitFor();
  check("native default results and bounded source preview", (await api("/api/search?q=나비정원")).engine === "fast-find" && await page.locator(".search-source mark").count() > 0);
  check("title-related source is shown without hidden neighbour", (await page.locator(".search-related").innerText()).includes("가을 연구 메모") && !(await page.locator(".search-related").innerText()).includes("숨김"));
  await page.screenshot({ path: join(out, "search-preview.png") });
  await page.locator(".palette-entry.kind-note").first().click();
  await page.locator(".pkm-note-body .search-open-target").waitFor();
  check("opens the matching note paragraph", (await page.locator(".pkm-note-body .search-open-target").innerText()).includes("나비정원"));
  await palette("별빛해설");
  await page.locator(".palette-entry.kind-hit").first().click();
  await page.locator('[data-item-id="exact-request"], [data-item-id="exact-answer"]').first().waitFor();
  check("opens the exact matched transcript item", await page.locator('[data-item-id="exact-request"].flash, [data-item-id="exact-answer"].flash').count() > 0);
  await palette("가을");
  await page.getByText("속성 조건", { exact: true }).click();
  await page.getByRole("textbox", { name: "정확한 속성 키" }).fill("단계:");
  await page.getByRole("textbox", { name: "속성 값", exact: true }).fill("A");
  await page.getByRole("button", { name: "적용", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".palette-entry.kind-note").length === 1 && !document.querySelector(".palette .spinner"));
  check("exact colon property UI filters results", await page.locator(".palette-entry.kind-note").count() === 1);
  await page.getByRole("button", { name: "해제", exact: true }).click();
  await page.getByText("속성 조건", { exact: true }).click();
  const input = page.getByRole("textbox", { name: "찾을 말" });
  await input.dispatchEvent("compositionstart");
  await input.fill("ㅎ");
  await input.dispatchEvent("keydown", { key: "Escape", isComposing: true });
  check("Korean composition does not close the palette", await page.locator(".palette").count() === 1);
  await input.fill("해바라기"); await input.dispatchEvent("compositionend");
  await page.locator('.palette-entry.kind-note:has-text("해바라기")').waitFor();
  await page.setViewportSize({ width: 600, height: 850 });
  await page.getByRole("button", { name: "본문 미리보기", exact: true }).click();
  check("narrow window can switch to full preview", await page.locator(".palette-preview").isVisible() && !(await page.locator(".palette-list").isVisible()));
  await page.screenshot({ path: join(out, "search-narrow.png") });
  await page.getByRole("button", { name: "결과 목록", exact: true }).click(); await page.setViewportSize({ width: 1440, height: 1050 });
  writeFileSync(join(vault, "연구/가을.md"), original + "\n새로운달맞이 확인\n");
  await palette("새로운달맞이");
  await page.locator('.palette-entry.kind-note:has-text("새로운달맞이")').waitFor({ timeout: 10_000 });
  renameSync(join(vault, "연구/가을.md"), join(vault, "연구/이름변경.md"));
  await page.waitForFunction(async () => {
    const response = await fetch("/api/search?q=새로운달맞이&scope=vault", { headers: { authorization: `Bearer ${new URL(location.href).searchParams.get("token")}` } });
    const value = await response.json(); return value.groups?.some((g: any) => g.hits.some((h: any) => h.path === "연구/이름변경.md"));
  });
  check("external edit and rename update the same engine", true);
  await palette("마크다운 문서");
  const priority: SearchPage = await api(`/api/search?${new URLSearchParams({ q: "마크다운 문서", legacy: "0", limit: "100", per: "20" })}`);
  const small: SearchPage = await api(`/api/search?${new URLSearchParams({ q: "마크다운 문서", legacy: "0", limit: "1", per: "1" })}`);
  writeFileSync(join(out, "conversation-priority.json"), JSON.stringify({ priority, small }, null, 2));
  check("conversation priority precedes global group paging with exact totals", small.groups[0]?.hits[0]?.kind === "user" && priority.total === 33 && priority.worksTotal === 12 && priority.groupsTotal === 15 && priority.groups.slice(0, 2).every(group => group.section === "conversation"));
  check("conversation and other-source sections are visible", await page.locator('[data-search-section="conversation"] .search-section-label').count() === 1 && await page.locator('[data-search-section="other"] .search-section-label').count() === 1);
  await page.screenshot({ path: join(out, "conversation-priority.png") });
  const firstOriginal = priority.groups[0]?.hits[0];
  await page.keyboard.press("Enter");
  const openedOriginal = firstOriginal?.kind === "user" && await page.locator(`[data-item-id="${firstOriginal.itemId}"].flash`).waitFor({ timeout: 5000 }).then(() => true, () => false);
  check("Enter opens the first original prompt at its exact transcript item", openedOriginal === true);
  await palette("마크다운 문서");
  await page.locator('[data-search-section="conversation"] .palette-entry.kind-more').first().click();
  await page.waitForFunction(() => document.querySelector(".palette-entry.kind-back") || document.querySelector(".palette-entry.kind-more")?.textContent?.includes("모든 결과로"));
  await page.waitForFunction(() => document.querySelector(".palette-list")?.getAttribute("aria-busy") === "false" && document.querySelectorAll(".palette-entry.kind-hit").length === 4);
  check("expanded conversation preserves prompt, reply and plan without files", await page.locator(".palette-entry.kind-hit").count() === 4 && await page.locator(".palette-entry.kind-doc, .palette-entry.kind-note").count() === 0);
  // The first row is Back; keyboard navigation continues into the original message rows.
  await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
  check("keyboard selection in an expanded group opens a source message", await page.locator('[data-item-id^="priority-request-"].flash').waitFor({ timeout: 5000 }).then(() => true, () => false));
  await palette("마크다운 문서");
  const shownBefore = await page.locator(".search-group").count();
  await page.getByRole("option", { name: /^더 보기/ }).click();
  await page.waitForFunction(() => document.querySelectorAll(".search-group").length === 15);
  check("more groups retains section order and reaches all projects and vault", shownBefore === 8 && await page.locator(".search-group").count() === 15);
  await page.getByRole("tab", { name: /^문서/ }).click();
  await page.waitForFunction(() => document.querySelector('.palette [role="tab"][aria-selected="true"]')?.textContent?.startsWith("문서") && document.querySelector(".palette-list")?.getAttribute("aria-busy") === "false");
  check("explicit document scope retains linked replies without conversation rows", await page.locator(".palette-entry.kind-hit").count() === 0 && (await api("/api/search?q=마크다운%20문서&scope=document&limit=100&per=20")).total === 12 && priority.groups.flatMap(group => group.hits).some(hit => hit.kind === "document" && hit.answer?.matched));
  check("hidden duplicate vault note stays excluded and unchanged", (await api("/api/search?q=숨김대화충돌")).total === 0 && readFileSync(join(vault, "비밀/중복.md"), "utf8") === "# mermaid 마크다운 문서\n숨김대화충돌");
  check("default typing never invokes AI reranking", !requests.some(url => url.includes("rerank=1")));
  check("original source unchanged except explicit fixture edit and rename", readFileSync(join(vault, "연구/이름변경.md"), "utf8") === original + "\n새로운달맞이 확인\n");
  check("no browser exceptions", errors.length === 0, errors.join(" | "));
} catch (error) {
  check("browser scenario", false, error instanceof Error ? error.stack : String(error));
  await page?.screenshot({ path: join(out, "failure.png") }).catch(() => {});
  if (page) writeFileSync(join(out, "failure.txt"), await page.locator("body").innerText().catch(() => ""));
} finally {
  await browser?.close();
  if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await new Promise(done => child!.once("exit", done)); }
  writeFileSync(join(out, "results.json"), JSON.stringify({ fixture: dir, results, errors, requests }, null, 2));
  console.log(`${results.filter(r => r.ok).length}/${results.length} passed`);
  process.exitCode = results.some(r => !r.ok) ? 1 : 0;
}
