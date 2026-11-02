/// <reference lib="dom" />
// Real built UI, host, Office tools and saved DOCX files; a local model fixture
// holds two responses until navigation has finished. No paid model or user data.
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Browser, type Page } from "playwright-core";
import JSZip from "jszip";

const out = resolve(process.argv[2]!); mkdirSync(out, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), "wb-urgent-parallel-"));
const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`); };
const until = async (what: () => Promise<boolean>, timeout = 30_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await what()) return; await new Promise(done => setTimeout(done, 80)); }
  throw Error("condition timed out");
};
const pending = new Map<string, { res: ServerResponse; finish(): void }>();
let cancelled = 0;
const server = createServer(async (req, res) => {
  let raw = ""; for await (const part of req) raw += String(part);
  if (req.url === "/v1/models") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "parallel-fixture" }] })); return; }
  if (req.url !== "/v1/chat/completions") { res.statusCode = 404; res.end(); return; }
  const body = JSON.parse(raw), marker = raw.includes("PARALLEL_DOC_A") ? "PARALLEL_DOC_A" : "PARALLEL_DOC_B";
  res.setHeader("content-type", "text/event-stream");
  const send = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: marker, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  if (body.messages.some((message: any) => message.role === "tool")) {
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
const errors: string[] = [], calls: { method: string; path: string }[] = [];
try {
  child = spawn(process.execPath, ["apps/host/dist/host.mjs"], { env: { ...process.env,
    WORKBENCH_DATA_DIR: dir, WORKBENCH_HOST_ID: "fixture", WORKBENCH_IEUM_BOOTSTRAP: "0",
    WORKBENCH_WEB_DIR: resolve(process.env.URGENT_WEB_DIR ?? "apps/web/dist"),
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
  const work = await api("/api/works", "POST", { title: "병렬 편집 검사", cwd: null });
  const main = await api(`/api/works/${work.id}/sessions`, "POST", { provider: "codex", purpose: "메인 채팅" });
  const second = await api(`/api/works/${work.id}/sessions`, "POST", { provider: "codex", purpose: "다른 메인 채팅" });
  const other = await api("/api/works", "POST", { title: "다른 프로젝트", cwd: null });
  const otherMain = await api(`/api/works/${other.id}/sessions`, "POST", { provider: "codex" });
  const docs: any[] = [];
  for (const label of ["A", "B"]) {
    const file = join(work.cwd, `문서 ${label}.docx`);
    copyFileSync(resolve("vendor/ieumoffice/apps/docs/tests/pagination-corpus/docx/simple.docx"), file);
    docs.push(await api(`/api/works/${work.id}/artifacts`, "POST", { path: file }));
  }
  const config = await api("/api/office-ai/settings");
  config.settings.provider = "custom"; config.settings.subscriptionNoticeSeen = true; config.settings.customEndpoint = "parallel";
  config.settings.customEndpoints = [{ id: "parallel", name: "Local fixture", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "", model: "parallel-fixture", kind: "local", modelProfiles: { "parallel-fixture": { tools: true, toolsSource: "user", contextLength: 1000000, contextSource: "user" } } }];
  mkdirSync(join(dir, "office"), { recursive: true }); writeFileSync(join(dir, "office/ai-settings.json"), JSON.stringify(config.settings));
  await api(`/api/works/${work.id}`, "PATCH", { activeSessionId: main.id });
  const tabs = [
    { id: "doc-a", workId: work.id, sessionId: null, view: { kind: "document", artifactId: docs[0].id, proposalId: null } },
    { id: "doc-b", workId: work.id, sessionId: null, view: { kind: "document", artifactId: docs[1].id, proposalId: null } },
    { id: "main", workId: work.id, sessionId: main.id, view: { kind: "work" } },
    { id: "second", workId: work.id, sessionId: second.id, view: { kind: "work" } },
    { id: "other", workId: other.id, sessionId: otherMain.id, view: { kind: "work" } },
  ];
  await api("/api/layouts/global", "PUT", { expectedRevision: 0, layout: { version: 2, focus: "test-pane", panes: [{ ...tabs[0], id: "test-pane", tabs, activeTabId: "doc-a", recentTabIds: ["doc-a"] }] } });
  await api("/api/prefs", "PUT", { prefs: { onboarding: "done", layoutScope: "global", startScreen: "last", sidebar: true } });
  browser = await chromium.launch(); page = await browser.newPage({ viewport: { width: 1600, height: 1050 } });
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { const path = new URL(request.url()).pathname; if (path.startsWith("/api/")) calls.push({ method: request.method(), path }); });
  await page.addInitScript(id => localStorage.setItem("workbench.lastWork", id), work.id);
  await page.goto(`${ready.url}/?token=${ready.token}`);
  const activate = async (id: string, editor = false) => {
    await page!.locator(`.pane[data-pane-active="true"] .group-tab[data-tab-id="${id}"] [role="tab"]`).click();
    const pane = page!.locator(`.pane[data-pane-active="true"][data-tab="${id}"]`); await pane.waitFor();
    if (editor) { const frame = pane.frameLocator("iframe.office-frame"); await frame.locator('.tiptap[contenteditable="true"]').waitFor({ timeout: 60_000 }); await frame.locator(".ai-panel textarea").waitFor(); return frame; }
  };
  for (const [id, marker] of [["doc-a", "PARALLEL_DOC_A"], ["doc-b", "PARALLEL_DOC_B"]]) {
    const frame = (await activate(id!, true))!;
    await frame.locator(".ai-panel textarea").fill(`문서에 ${marker} 문단을 넣어 주세요.`);
    await frame.locator(".ai-send-btn:not(.ai-stop-btn)").click();
    await until(async () => pending.has(marker!));
  }
  const agents = (await snapshot()).sessions.filter((s: any) => s.documentAgent);
  check("two document agents and main have independent sessions", agents.length === 2 && agents.every((s: any) => s.id !== main.id && s.documentAgent.parentSessionId === main.id));
  const before = (await api("/api/document-views")).views.map((v: any) => ({ viewId: v.viewId, artifactId: v.artifactId, sessionId: v.sessionId }));
  const navigationStart = calls.length;
  await activate("second");
  await api(`/api/works/${work.id}`, "PATCH", { activeSessionId: second.id });
  await activate("other");
  await activate("main");
  await page.locator('.pane[data-pane-active="true"] .composer-input').fill("길게 독립 메인 채팅 동작 확인");
  await page.locator('.pane[data-pane-active="true"]').getByRole("button", { name: "보내기", exact: true }).click();
  await until(async () => (await snapshot()).sessions.find((s: any) => s.id === main.id)?.status === "running");
  check("two hidden document jobs and main chat run concurrently", agents.every((s: any) => pending.has(s.documentAgent.artifactId === docs[0].id ? "PARALLEL_DOC_A" : "PARALLEL_DOC_B")) && (await snapshot()).sessions.filter((s: any) => [main.id, ...agents.map((a: any) => a.id)].includes(s.id)).every((s: any) => s.status === "running"));
  await activate("other");
  // Cross one host-side writer check and heartbeat while both document iframes are hidden.
  await new Promise(done => setTimeout(done, 11_000));
  const after = (await api("/api/document-views")).views.map((v: any) => ({ viewId: v.viewId, artifactId: v.artifactId, sessionId: v.sessionId }));
  check("tab and main selection changes preserve writer registrations", JSON.stringify(before) === JSON.stringify(after) && !calls.slice(navigationStart).some(c => c.method === "DELETE" && c.path.startsWith("/api/document-views/")) && cancelled === 0);
  for (const run of pending.values()) run.finish();
  await until(async () => (await Promise.all(agents.map((s: any) => items(s.id)))).every(rows => rows.some((i: any) => i.kind === "turnEnd")), 45_000);
  for (const [index, marker] of ["PARALLEL_DOC_A", "PARALLEL_DOC_B"].entries()) {
    const agent = agents.find((s: any) => s.documentAgent.artifactId === docs[index].id), rows = await items(agent.id);
    const xml = await (await JSZip.loadAsync(readFileSync(docs[index].path))).file("word/document.xml")!.async("string");
    check(`hidden document ${index + 1} completes tool execution and saves DOCX`, rows.some((i: any) => i.kind === "turnEnd" && i.status === "completed") && xml.includes(marker));
    writeFileSync(join(out, `document-${index + 1}-items.json`), JSON.stringify(rows, null, 2));
  }
  const mainRows = await items(main.id);
  check("main receives both document reports without child prompts", docs.every(doc => mainRows.some((i: any) => i.kind === "notice" && i.text.includes(doc.name))) && !mainRows.some((i: any) => i.kind === "user" && i.text.includes("PARALLEL_DOC")) && mainRows.some((i: any) => i.kind === "turnEnd" && i.status === "completed"));
  const announcement = await page.locator('.toast').innerText().catch(() => "");
  check("foreground completion is announced", announcement.includes("답변 완료"), announcement);
  await activate("doc-a", true); await page.screenshot({ path: join(out, "parallel-completed.png") });
  await activate("other");
  const refreshBefore = calls.filter(c => c.path === "/api/providers/refresh").length;
  await page.locator('.pane[data-pane-active="true"]').getByRole("button", { name: "Fake", exact: true }).click();
  await until(async () => calls.filter(c => c.path === "/api/providers/refresh").length > refreshBefore);
  check("model chooser asks the engine for a fresh catalog", true); await page.keyboard.press("Escape");
  const source = join(work.cwd, "문서 A.docx"), bytes = readFileSync(source);
  await page.locator(`.sidebar [data-row-id="${work.id}"]`).click({ button: "right" });
  await page.getByRole("menuitem", { name: "프로젝트 삭제…", exact: true }).click();
  check("project deletion explains document preservation", await page.getByRole("dialog", { name: "프로젝트 삭제", exact: true }).getByText("문서 파일과 작업 폴더는 그대로 보존합니다.").isVisible());
  await page.getByRole("dialog", { name: "프로젝트 삭제", exact: true }).getByRole("button", { name: "프로젝트 삭제", exact: true }).click();
  await until(async () => !(await snapshot()).works.some((w: any) => w.id === work.id));
  check("project menu deletes records, closes tabs, preserves files and other project", readFileSync(source).equals(bytes) && (await snapshot()).works.some((w: any) => w.id === other.id) && await page.locator('.group-tab[data-tab-id="doc-a"]').count() === 0);
  check("no browser exceptions or cancelled provider streams", errors.length === 0 && cancelled === 0, errors.join("; "));
} catch (error) {
  check("urgent parallel UI scenario", false, String(error));
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
