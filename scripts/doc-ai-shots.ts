/// <reference lib="dom" />
// Frames of the one 문서 AI per document (unit one-doc-ai), fixture data only: for Word, PowerPoint, Excel and PDF the
// head's 문서 AI pressed (the editor's own panel, no column); an Excel turn at work in its panel; Word in 글 보기 with
// the conversation column, its AI waiting for an approval; the left list with one document's AI working and one
// waiting; and one frame in the dark theme. The panel's model is a local fixture that holds its answer.
// Usage: node scripts/doc-ai-shots.ts <out folder> [--dark]   (through ux/run-isolated.sh)
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Browser, type Page } from "playwright-core";

const out = resolve(process.argv[2] ?? "doc-ai-shots"); mkdirSync(out, { recursive: true });
const dark = process.argv.includes("--dark");
const dir = mkdtempSync(join(tmpdir(), "wb-doc-ai-shots-"));
const notes: string[] = [];
const note = (text: string) => { notes.push(text); console.log(text); };
const wait = (ms: number) => new Promise(done => setTimeout(done, ms));
const until = async (what: () => Promise<boolean>, timeout = 30_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await what()) return; await wait(100); }
  throw Error("condition timed out");
};
// The fixture says it is working on the request and holds the rest (the frame shows a turn at work).
const server = createServer(async (req, res) => {
  let raw = ""; for await (const part of req) raw += String(part);
  if (req.url === "/v1/models") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "shots-fixture" }] })); return; }
  if (req.url !== "/v1/chat/completions") { res.statusCode = 404; res.end(); return; }
  res.setHeader("content-type", "text/event-stream");
  res.write(`data: ${JSON.stringify({ id: "shots", choices: [{ index: 0, delta: { role: "assistant", content: "표의 합계 행을 넣고 있습니다." }, finish_reason: null }] })}\n\n`);
});
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
const address = server.address(); if (!address || typeof address === "string") throw Error("No fixture port");
let child: ChildProcess | null = null, browser: Browser | null = null, page: Page | null = null;
try {
  child = spawn(process.execPath, ["apps/host/dist/host.mjs"], { env: { ...process.env,
    WORKBENCH_DATA_DIR: dir, WORKBENCH_HOST_ID: "fixture", WORKBENCH_IEUM_BOOTSTRAP: "0", WORKBENCH_WEB_DIR: resolve("apps/web/dist"),
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
  const work = await api("/api/works", "POST", { title: "2학기 강의", cwd: null });
  const main = await api(`/api/works/${work.id}/sessions`, "POST", { provider: "codex", purpose: "강의 준비" });
  const add = async (from: string, name: string) => { const file = join(work.cwd, name); copyFileSync(resolve(from), file); return api(`/api/works/${work.id}/artifacts`, "POST", { path: file }); };
  const docs = {
    docx: await add("scripts/fixtures/hello.docx", "강의 계획서.docx"),
    pptx: await add("scripts/fixtures/cover.pptx", "1주차 발표.pptx"),
    xlsx: await add("scripts/fixtures/supplies.xlsx", "성적표.xlsx"),
    pdf: await add("scripts/fixtures/opendataloader/text.pdf", "읽을거리.pdf"),
  };
  const config = await api("/api/office-ai/settings");
  config.settings.provider = "custom"; config.settings.subscriptionNoticeSeen = true; config.settings.customEndpoint = "fixture";
  config.settings.customEndpoints = [{ id: "fixture", name: "Local fixture", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "", model: "shots-fixture", kind: "local", modelProfiles: { "shots-fixture": { tools: true, toolsSource: "user", contextLength: 1000000, contextSource: "user" } } }];
  mkdirSync(join(dir, "office"), { recursive: true }); writeFileSync(join(dir, "office/ai-settings.json"), JSON.stringify(config.settings));
  await api(`/api/works/${work.id}`, "PATCH", { activeSessionId: main.id });
  const tabs = (["docx", "pptx", "xlsx", "pdf"] as const).map((format) => ({ id: format, workId: work.id, sessionId: null, view: { kind: "document", artifactId: docs[format].id, proposalId: null } }));
  await api("/api/layouts/global", "PUT", { expectedRevision: 0, layout: { version: 2, focus: "test-pane", panes: [{ ...tabs[0], id: "test-pane", tabs, activeTabId: "docx", recentTabIds: ["docx"] }] } });
  await api("/api/prefs", "PUT", { prefs: { onboarding: "done", layoutScope: "global", startScreen: "last", sidebar: true, theme: dark ? "dark" : "light" } });
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: dark ? "dark" : "light" });
  await context.addInitScript(id => localStorage.setItem("workbench.lastWork", id), work.id);
  page = await context.newPage();
  await page.goto(`${ready.url}/?token=${ready.token}`);
  const activePane = () => page!.locator('.pane[data-pane-active="true"]');
  const activate = async (id: string) => {
    await page!.locator(`.pane[data-pane-active="true"] .group-tab[data-tab-id="${id}"] [role="tab"]`).click();
    await page!.locator(`.pane[data-pane-active="true"][data-tab="${id}"]`).waitFor();
  };
  const frame = () => activePane().frameLocator("iframe.office-frame");
  const headKey = () => activePane().locator(".doc-header-right .doc-agent-toggle");
  const shot = async (name: string) => { await wait(1_200); await page!.screenshot({ path: join(out, `${name}${dark ? "-dark" : ""}.png`) }); };

  for (const format of (dark ? ["pptx"] : ["docx", "pptx", "xlsx", "pdf"]) as Array<keyof typeof docs>) {
    await activate(format);
    await frame().locator(".ai-dock, .copilot").first().waitFor({ timeout: 60_000 });
    await wait(1_500);
    if ((await headKey().getAttribute("aria-expanded")) !== "true") await headKey().click();
    await until(async () => (await headKey().getAttribute("aria-expanded")) === "true", 15_000);
    const columns = await activePane().locator(".agent-column").count();
    note(`${format}: head 문서 AI pressed → panel open, columns beside it: ${columns}`);
    await shot(`${format}-panel`);
  }
  if (!dark) {
    // Excel: a request at work in its panel (the fixture holds the answer); its row says 진행 중.
    await activate("xlsx");
    const box = frame().locator(".copilot textarea, .ai-dock:not(.collapsed) textarea").first();
    await box.fill("합계 행을 넣어 주세요");
    await box.press("Enter");
    await wait(2_000);
    await shot("xlsx-turn-at-work");
    // Word in 글 보기: 문서 AI is the conversation column (수정안 on a copy); a request there waits for an approval.
    await activate("docx");
    await activePane().getByRole("radio", { name: "글 보기" }).click();
    await wait(1_500);
    if ((await headKey().getAttribute("aria-expanded")) !== "true") await headKey().click();
    await activePane().locator(".agent-column").waitFor({ timeout: 15_000 });
    await activePane().locator(".agent-column textarea").fill("명령으로 폴더를 보여 줘");
    await activePane().locator(".agent-column textarea").press("Enter");
    await until(async () => (await api("/api/snapshot")).sessions.some((s: { status: string; documentAgent?: { artifactId: string } }) => s.documentAgent?.artifactId === docs.docx.id && s.status === "awaitingApproval"), 30_000)
      .then(() => note("docx 글 보기: the column's 문서 AI waits for an approval"), () => note("docx 글 보기: no approval came (the frame shows the column only)"));
    await shot("docx-read-view-column");
    // The list is beside a conversation (an editor in front takes the whole window): the project's conversation, its list level.
    await page.locator('.pane[data-pane-active="true"] .group-tab [role="tab"]').filter({ hasText: "강의 준비" }).first().click();
    await wait(800);
    if (!(await page.locator(`.sidebar [data-row-id="${docs.docx.id}"]`).count())) await page.locator(`.sidebar [data-row-id="${work.id}"]`).click();
    await page.locator(`.sidebar [data-row-id="${docs.docx.id}"]`).waitFor({ timeout: 10_000 });
    await page.mouse.move(800, 500); // a hovered row shows its ⋯ in place of its mark
    await wait(500);
    note(`list: docx row "${(await page.locator(`.sidebar [data-row-id="${docs.docx.id}"]`).innerText()).replace(/\s+/g, " ")}", xlsx row "${(await page.locator(`.sidebar [data-row-id="${docs.xlsx.id}"]`).innerText()).replace(/\s+/g, " ")}"`);
    await shot("list-working-and-waiting");
  }
} catch (error) {
  note(`FAILED: ${String(error)}`);
  if (page) await page.screenshot({ path: join(out, "failure.png") }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.closeAllConnections?.();
  await new Promise<void>(done => server.close(() => done()));
  if (child && child.exitCode === null) { const exited = new Promise<void>(done => child!.once("exit", () => done())); child.kill("SIGTERM"); await exited; }
  writeFileSync(join(out, `notes${dark ? "-dark" : ""}.txt`), notes.join("\n"));
}
