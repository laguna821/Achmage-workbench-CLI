/// <reference lib="dom" />
// One 문서 AI per document, each on its own and in parallel (unit one-doc-ai), measured with the real built UI,
// gateway and Word editor; a local model fixture (OpenAI-compatible, the editor panel's "custom endpoint") holds
// each document's answer until the check releases it. No paid model, no user data, a temporary data folder.
//   1. Document A: the head's 문서 AI opens the editor's own panel (named 문서 AI; no column beside it); a turn starts.
//   2. Document B (another tab): the same; its turn starts while A's is still running.
//   3. A project conversation is started and runs at the same time (not blocked by either).
//   4. The left list shows both document rows working (the conversation rows' marks).
//   5. Another project is put on screen; with the sleep time shortened to seconds, the two document tabs are NOT put
//      to sleep while their turns run (their editor frames stay mounted).
//   6. Both turns are released and finish; each result is in its own .docx; then (turns over) the tabs may sleep.
//   7. Back in the project, document A's row shows its unseen answer; a click on it opens A with 문서 AI on screen,
//      showing A's answer.
// Usage: node scripts/doc-ai-parallel-check.ts <out folder>   (through ux/run-isolated.sh)
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Browser, type FrameLocator, type Page } from "playwright-core";
import { editorFirst } from "./fixtures/editor-first.ts";
import JSZip from "jszip";

const out = resolve(process.argv[2] ?? "doc-ai-parallel"); mkdirSync(out, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), "wb-doc-ai-parallel-"));
const SLEEP_MS = 3_000;
const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`); };
const until = async (what: () => Promise<boolean>, timeout = 30_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await what()) return; await new Promise(done => setTimeout(done, 100)); }
  throw Error("condition timed out");
};
const wait = (ms: number) => new Promise(done => setTimeout(done, ms));
const MARKERS = ["DOC_AI_PARALLEL_A", "DOC_AI_PARALLEL_B"] as const;
const pending = new Map<string, { res: ServerResponse; finish(): void }>();
let cancelled = 0;
const server = createServer(async (req, res) => {
  let raw = ""; for await (const part of req) raw += String(part);
  if (req.url === "/v1/models") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "doc-ai-fixture" }] })); return; }
  if (req.url !== "/v1/chat/completions") { res.statusCode = 404; res.end(); return; }
  const body = JSON.parse(raw), marker = raw.includes(MARKERS[0]) ? MARKERS[0] : MARKERS[1];
  res.setHeader("content-type", "text/event-stream");
  const send = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: marker, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  if (body.messages.some((message: { role: string }) => message.role === "tool")) {
    send({ role: "assistant", content: `${marker} 문서 편집 완료` }); send({}, "stop"); res.end("data: [DONE]\n\n"); return;
  }
  send({ role: "assistant", content: `${marker} 편집을 준비합니다.` });
  pending.set(marker, { res, finish() {
    send({ tool_calls: [{ index: 0, id: `edit-${marker}`, type: "function", function: { name: "insert_content", arguments: JSON.stringify({ html: `<p>${marker}</p>`, afterBlockIndex: -1 }) } }] });
    send({}, "tool_calls"); res.end("data: [DONE]\n\n");
  } });
  res.once("close", () => { if (!res.writableEnded) cancelled++; });
});
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
const address = server.address(); if (!address || typeof address === "string") throw Error("No fixture port");
let child: ChildProcess | null = null, browser: Browser | null = null, page: Page | null = null;
const errors: string[] = [];
try {
  child = spawn(process.execPath, ["apps/host/dist/host.mjs"], { env: { ...process.env,
    WORKBENCH_DATA_DIR: dir, WORKBENCH_HOST_ID: "fixture", WORKBENCH_IEUM_BOOTSTRAP: "0",
    WORKBENCH_WEB_DIR: resolve(process.env.DOC_AI_WEB_DIR ?? "apps/web/dist"),
    WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"), WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"), WORKBENCH_VAULT_SUGGEST: "",
  }, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr!.on("data", data => writeFileSync(join(out, "host.log"), data, { flag: "a" }));
  const ready = await new Promise<{ url: string; token: string }>((done, fail) => {
    const timer = setTimeout(() => fail(Error("gateway start timeout")), 30_000);
    child!.once("exit", code => { clearTimeout(timer); fail(Error(`gateway exited: ${code}`)); });
    createInterface({ input: child!.stdout! }).on("line", line => { if (line.startsWith("WORKBENCH_READY ")) { clearTimeout(timer); done(JSON.parse(line.slice(16))); } });
  });
  const api = async (path: string, method = "GET", body?: unknown) => {
    const r = await fetch(`${ready.url}${path}`, { method, headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await r.json(); if (!r.ok) throw Error(`${path}: ${r.status} ${result.message}`); return result;
  };
  const snapshot = () => api("/api/snapshot"), items = async (id: string) => (await api(`/api/sessions/${id}/items`)).items;
  const work = await api("/api/works", "POST", { title: "문서 AI 병렬 검사", cwd: null });
  const main = await api(`/api/works/${work.id}/sessions`, "POST", { provider: "codex", purpose: "메인 채팅" });
  const other = await api("/api/works", "POST", { title: "다른 프로젝트", cwd: null });
  const otherMain = await api(`/api/works/${other.id}/sessions`, "POST", { provider: "codex", purpose: "다른 대화" });
  const docs: { id: string; name: string; path: string }[] = [];
  for (const label of ["A", "B"]) {
    const file = join(work.cwd, `문서 ${label}.docx`);
    copyFileSync(resolve("vendor/ieumoffice/apps/docs/tests/pagination-corpus/docx/simple.docx"), file);
    docs.push(await api(`/api/works/${work.id}/artifacts`, "POST", { path: file }));
  }
  const config = await api("/api/office-ai/settings");
  config.settings.provider = "custom"; config.settings.subscriptionNoticeSeen = true; config.settings.customEndpoint = "fixture";
  config.settings.customEndpoints = [{ id: "fixture", name: "Local fixture", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "", model: "doc-ai-fixture", kind: "local", modelProfiles: { "doc-ai-fixture": { tools: true, toolsSource: "user", contextLength: 1000000, contextSource: "user" } } }];
  mkdirSync(join(dir, "office"), { recursive: true }); writeFileSync(join(dir, "office/ai-settings.json"), JSON.stringify(config.settings));
  await api(`/api/works/${work.id}`, "PATCH", { activeSessionId: main.id });
  const tabs = [
    { id: "doc-a", workId: work.id, sessionId: null, view: { kind: "document", artifactId: docs[0]!.id, proposalId: null } },
    { id: "doc-b", workId: work.id, sessionId: null, view: { kind: "document", artifactId: docs[1]!.id, proposalId: null } },
    { id: "main", workId: work.id, sessionId: main.id, view: { kind: "work" } },
    { id: "other", workId: other.id, sessionId: otherMain.id, view: { kind: "work" } },
  ];
  await api("/api/layouts/global", "PUT", { expectedRevision: 0, layout: { version: 2, focus: "test-pane", panes: [{ ...tabs[0], id: "test-pane", tabs, activeTabId: "doc-a", recentTabIds: ["doc-a"] }] } });
  await api("/api/prefs", "PUT", { prefs: { onboarding: "done", layoutScope: "global", startScreen: "last", sidebar: true } });
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(ms => { (window as unknown as { __workbenchTabSleepMs: number }).__workbenchTabSleepMs = ms; }, SLEEP_MS);
  await context.addInitScript(id => localStorage.setItem("workbench.lastWork", id), work.id);
  await editorFirst(context);
  page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${ready.url}/?token=${ready.token}`);
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const named = (title: string) => new RegExp(`(^| · )${escape(title)}$`);
  const listName: Record<string, RegExp> = { "doc-a": named("문서 A.docx"), "doc-b": named("문서 B.docx"), main: named(main.purpose), other: new RegExp(`^${escape(other.title)} · `) };
  const activePane = () => page!.locator('.pane[data-pane-active="true"]');
  const activate = async (id: string) => {
    const onStrip = page!.locator(`.pane[data-pane-active="true"] .group-tab[data-tab-id="${id}"] [role="tab"]`);
    if (await onStrip.waitFor({ timeout: 5_000 }).then(() => true, () => false)) await onStrip.click();
    else {
      await page!.locator('.pane[data-pane-active="true"] .group-tab-more').click();
      await page!.locator('.group-tab-list [role^="menuitem"]:not([aria-disabled="true"])').filter({ hasText: listName[id] ?? id }).first().click();
    }
    await page!.locator(`.pane[data-pane-active="true"][data-tab="${id}"]`).waitFor();
  };
  const editorFrame = async (): Promise<FrameLocator> => {
    const frame = activePane().frameLocator("iframe.office-frame");
    await frame.locator('.tiptap[contenteditable="true"]').waitFor({ timeout: 60_000 });
    return frame;
  };
  const headKey = () => activePane().locator(".doc-header-right .doc-agent-toggle");
  const officeFrames = () => page!.evaluate(() => document.querySelectorAll("iframe.office-frame").length);

  // 1–2: each document's 문서 AI is its editor's own panel, opened from the head; one turn each.
  for (const [index, id] of (["doc-a", "doc-b"] as const).entries()) {
    const marker = MARKERS[index]!;
    await activate(id);
    const frame = await editorFrame();
    await frame.locator(".ai-dock").waitFor({ timeout: 30_000 });
    // The editors remember the panel as last left (A's opened panel opens B's too): pressed only while closed.
    await wait(1_000);
    const wasOpen = (await headKey().getAttribute("aria-expanded")) === "true";
    if (!wasOpen) await headKey().click();
    await frame.locator(".ai-dock:not(.collapsed) .ai-panel textarea").waitFor({ timeout: 15_000 });
    await until(async () => (await headKey().getAttribute("aria-expanded")) === "true", 10_000);
    const title = (await frame.locator(".ai-dock .ai-panel-title").innerText()).trim();
    const column = await activePane().locator(".agent-column").count();
    check(`${id}: the head's 문서 AI opens the editor's own panel, named 문서 AI, with no column beside it`, title === "문서 AI" && column === 0, `title "${title}", columns ${column}${wasOpen ? ", drawn open as last left (the head key shows it pressed)" : ""}`);
    if (index === 0) await page.screenshot({ path: join(out, "panel-open-a.png") });
    await frame.locator(".ai-panel textarea").fill(`문서에 ${marker} 문단을 넣어 주세요.`);
    await frame.locator(".ai-send-btn:not(.ai-stop-btn)").click();
    await until(async () => pending.has(marker));
  }
  const agents = (await snapshot()).sessions.filter((s: { documentAgent?: unknown }) => s.documentAgent);
  const agentOf = (index: number) => agents.find((s: { documentAgent: { artifactId: string } }) => s.documentAgent.artifactId === docs[index]!.id);
  check("each document has its own 문서 AI session, apart from the project conversation", agents.length === 2 && agents.every((s: { id: string }) => s.id !== main.id));

  // 3: a project conversation runs at the same time.
  await activate("main");
  await activePane().locator(".composer-input").fill("길게 문서 AI와 함께 도는 대화");
  await activePane().getByRole("button", { name: "보내기", exact: true }).click();
  await until(async () => (await snapshot()).sessions.find((s: { id: string }) => s.id === main.id)?.status === "running");
  const running = (await snapshot()).sessions.filter((s: { id: string }) => [main.id, ...agents.map((a: { id: string }) => a.id)].includes(s.id));
  check("both documents' turns and the project conversation run at the same time", running.length === 3 && running.every((s: { status: string }) => s.status === "running") && pending.size === 2, running.map((s: { purpose: string; status: string }) => `${s.purpose}: ${s.status}`).join(", "));

  // 4: the left list shows both documents working.
  // The list at the project's level (its conversations, documents, web): entered from the project's row if the list shows projects.
  const intoProject = async () => {
    if (await page!.locator(`.sidebar [data-row-id="${docs[0]!.id}"]`).count()) return;
    await page!.locator(`.sidebar [data-row-id="${work.id}"]`).click();
    await page!.locator(`.sidebar [data-row-id="${docs[0]!.id}"]`).waitFor({ timeout: 10_000 });
  };
  await intoProject();
  const rowMark = async (index: number) => (await page!.locator(`.sidebar [data-row-id="${docs[index]!.id}"] .row-doc-ai`).innerText().catch(() => "")).trim();
  await until(async () => (await rowMark(0)) !== "" && (await rowMark(1)) !== "", 10_000).catch(() => undefined);
  const marks = [await rowMark(0), await rowMark(1)];
  check("the left list shows both documents' 문서 AI at work, with a conversation row's mark", marks.every(mark => mark.includes("진행 중")), JSON.stringify(marks));
  await page.screenshot({ path: join(out, "list-two-working.png") });

  // 5: another project on screen; the document tabs are not put to sleep while their turns run.
  await activate("other");
  await wait(SLEEP_MS * 3 + 2_000);
  const mountedWhileRunning = await officeFrames();
  check("tabs with a running 문서 AI turn stay awake (not put to sleep) while another project is on screen", mountedWhileRunning === 2, `${mountedWhileRunning} editor frames mounted after ${SLEEP_MS * 3 + 2_000} ms with a ${SLEEP_MS} ms sleep time`);

  // 6: both finish, each in its own document.
  for (const run of pending.values()) run.finish();
  await until(async () => (await Promise.all(agents.map((s: { id: string }) => items(s.id)))).every(rows => rows.some((i: { kind: string }) => i.kind === "turnEnd")), 60_000);
  for (const [index, marker] of MARKERS.entries()) {
    const agent = agentOf(index), rows = await items(agent.id);
    const xml = await (await JSZip.loadAsync(readFileSync(docs[index]!.path))).file("word/document.xml")!.async("string");
    const otherMarker = MARKERS[1 - index]!;
    check(`document ${"AB"[index]}: its turn completed and its .docx holds its own edit only`, rows.some((i: { kind: string; status?: string }) => i.kind === "turnEnd" && i.status === "completed") && xml.includes(marker) && !xml.includes(otherMarker));
    writeFileSync(join(out, `document-${"ab"[index]}-items.json`), JSON.stringify(rows, null, 2));
  }
  await until(async () => (await items(main.id)).some((i: { kind: string; status?: string }) => i.kind === "turnEnd" && i.status === "completed"), 60_000);
  check("the project conversation finished too (not blocked by the documents' turns)", true);
  await wait(SLEEP_MS * 3 + 2_000);
  check("with their turns over, the tabs behind another project may sleep again (nothing else keeps them)", await officeFrames() === 0, `${await officeFrames()} editor frames`);

  // 7: back in the project: A's row says its answer is new; a click opens A with 문서 AI on screen and the answer in it.
  await activate("main");
  await intoProject();
  await until(async () => (await rowMark(0)) !== "", 10_000).catch(() => undefined);
  const unseen = await rowMark(0);
  check("document A's row shows its new answer (새 답) while it is unseen", unseen.includes("새 답"), unseen);
  await page.screenshot({ path: join(out, "list-unseen.png") });
  await page.locator(`.sidebar [data-row-id="${docs[0]!.id}"]`).click();
  await page.locator('.pane[data-pane-active="true"][data-tab="doc-a"]').waitFor();
  const frame = await editorFrame();
  await frame.locator(".ai-dock:not(.collapsed) .ai-panel").waitFor({ timeout: 20_000 });
  await until(async () => (await frame.locator(".ai-dock .ai-panel").innerText()).includes(`${MARKERS[0]} 문서 편집 완료`), 20_000).catch(() => undefined);
  const panelText = await frame.locator(".ai-dock .ai-panel").innerText();
  const body = await frame.locator(".tiptap").innerText();
  check("a click on A's row opens A with its 문서 AI on screen, showing A's answer, and A's edit in the page", panelText.includes(`${MARKERS[0]} 문서 편집 완료`) && body.includes(MARKERS[0]) && await activePane().locator(".agent-column").count() === 0, `answer shown ${panelText.includes(MARKERS[0])}, edit in page ${body.includes(MARKERS[0])}`);
  await page.screenshot({ path: join(out, "row-click-a.png") });
  check("no browser exceptions and no cancelled model streams", errors.length === 0 && cancelled === 0, `${errors.join("; ")} cancelled ${cancelled}`);
} catch (error) {
  check("document AI parallel scenario", false, String(error));
  if (page) { await page.screenshot({ path: join(out, "failure.png") }).catch(() => undefined); writeFileSync(join(out, "failure.txt"), await page.locator("body").innerText().catch(() => "")); }
} finally {
  await browser?.close();
  for (const run of pending.values()) if (!run.res.writableEnded) run.res.end();
  await new Promise<void>(done => server.close(() => done()));
  if (child && child.exitCode === null) { const exited = new Promise<void>(done => child!.once("exit", () => done())); child.kill("SIGTERM"); await exited; }
  writeFileSync(join(out, "results.json"), JSON.stringify({ dir, results, errors }, null, 2));
  console.log(`${results.filter(r => r.ok).length}/${results.length} passed`);
  if (results.some(r => !r.ok)) process.exitCode = 1;
}
