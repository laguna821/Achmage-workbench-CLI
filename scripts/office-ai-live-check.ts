/// <reference lib="dom" />
// Rig check of brief office-ai-live (0.5.3): every editor while its 문서 AI works, and how the result arrives.
// The built gateway and UI in Chromium, a STAND-IN model (a local OpenAI-compatible endpoint: no real model,
// credential or outside host) and a stand-in app binary that hands the independent executor's page address to
// this script, which opens it in a second page (as scripts/hwp-ai-check.ts --executor does).
//   hold (Word, PowerPoint, Excel, PDF, Markdown, HTML): an executor turn (the desktop app's path for a hidden or
//     forced turn): the hold line with 중단 on the editor; looking works (no inert page, wheel scroll / look keys
//     not refused, ribbon tab headers); typing and a changing ribbon control refused; released at the end.
//   result (Word, PowerPoint): an executor turn that edits — "0.5.2" (the page reopened) against "in place";
//     time from the turn's end (the model's last byte) to the result visible; same iframe element and same
//     editor page (a probe on its window) before and after; the view position kept (Word: scrollTop).
//   live (Word, PowerPoint): a turn sent while the editor is on screen runs in it: the edit is visible BEFORE
//     the turn ends, no executor started, same frame; a live turn whose tab is hidden mid-turn finishes.
// With the REAL app binary as the executor (scripts/real-executor-check.ts drives this): WB_CHECK_APP_BIN is the binary
// (or its wrapper), WB_CHECK_EXECUTOR_LOG the wrapper's log (one "start … --office-executor" line per executor),
// WB_CHECK_GATEWAY_ENV a JSON object merged into the gateway's environment (null removes a name); `--hold-only` runs
// only the hold part (one executor turn per editor).
// Usage (through ux/run-isolated.sh): node scripts/office-ai-live-check.ts <outDir> [--only=docx,pptx,...] [--hold-only]
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Browser, type Frame, type Page } from "playwright-core";
import { editorFirst } from "./fixtures/editor-first.ts";
import JSZip from "jszip";

const args = process.argv.slice(2);
const out = resolve(args.find((arg) => !arg.startsWith("--")) ?? join(tmpdir(), "wb-office-ai-live")); mkdirSync(out, { recursive: true });
const only = args.find((arg) => arg.startsWith("--only="))?.slice(7).split(",");
const FORMATS = ["docx", "pptx", "xlsx", "pdf", "md", "html"].filter((format) => !only || only.includes(format));
const dir = mkdtempSync(join(tmpdir(), "wb-office-ai-live-"));
const results: { name: string; ok: boolean; detail?: string }[] = [];
const numbers: Record<string, unknown> = {};
const check = (name: string, ok: boolean, detail?: string) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
const waitFor = async (what: () => Promise<boolean>, ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { if (await what().catch(() => false)) return true; await wait(50); } return false; };

/** A plain PDF of `pages` letter pages, each saying "Page N" (and `mark` on page 1). */
function simplePdf(pages: number, mark: string): Buffer {
  const objects: string[] = [];
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages} >>`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (let i = 0; i < pages; i++) {
    const text = `BT /F1 36 Tf 72 700 Td (Page ${i + 1}${i === 0 && mark ? ` ${mark}` : ""}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
  }
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => { offsets.push(body.length); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

// ---- the stand-in model ---------------------------------------------------------------------------
// Instruction markers: [ANSWER] streams an answer over ~5 s; [EDIT-<fmt>-<n>] calls the editor's own edit
// tool, then holds the final answer until the script releases it (release time = the turn's end, t0).
const released = new Map<string, () => void>();
const endedAt = new Map<string, number>();
type Message = { role: string; content?: unknown };
const TOOL: Record<string, (marker: string, messages: Message[]) => { name: string; args: unknown } | null> = {
  docx: (marker) => ({ name: "insert_content", args: { html: `<p>${marker}</p>`, afterBlockIndex: -1 } }),
  pptx: () => ({ name: "apply_ops", args: { ops: [{ op: "addBlankSlide", target: { slide: 0 } }] } }),
  // office-leftovers point 2: one real edit per kind, made by the editor's own tool in the executor.
  md: (marker) => ({ name: "apply_ops", args: { ops: [{ op: "insertContent", after: 0, markdown: marker }] } }),
  html: (marker) => ({ name: "apply_ops", args: { ops: [{ op: "str_replace", old: "<h1>소개</h1>", new: `<h1>소개</h1><p>${marker}</p>` }] } }),
  pdf: () => ({ name: "insert_blank_page", args: { after_page: 6 } }),
  // Excel needs its sheet's id first: the workbook context, then the cell (A2) set to the marker.
  xlsx: (marker, messages) => {
    const tools = messages.filter((message) => message.role === "tool");
    if (tools.length === 0) return { name: "get_workbook_context", args: {} };
    if (tools.length === 1) {
      const id = /id=([\w-]+)/.exec(JSON.stringify(tools[0]!.content ?? ""))?.[1];
      return { name: "propose_operations", args: { operations: [{ op: "set_cell", sheetId: id, address: "A2", value: marker }], summary: marker } };
    }
    return null;
  },
};
const server = createServer(async (req, res: ServerResponse) => {
  let raw = ""; for await (const part of req) raw += String(part);
  if (req.url === "/v1/models") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "live-fixture" }] })); return; }
  if (req.url !== "/v1/chat/completions") { res.statusCode = 404; res.end(); return; }
  const body = JSON.parse(raw);
  const lastUser = JSON.stringify(body.messages.filter((message: { role: string }) => message.role === "user").at(-1)?.content ?? "");
  const marker = /\[(EDIT-[a-z]+-\d+)\]/.exec(lastUser)?.[1] ?? (lastUser.includes("[ANSWER]") ? "ANSWER" : "OTHER");
  res.setHeader("content-type", "text/event-stream");
  const send = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: marker, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  const done = () => { res.end("data: [DONE]\n\n"); endedAt.set(marker, Date.now()); };
  if (marker === "ANSWER" || marker === "OTHER") {
    for (const piece of "이 문서는 검사용 문서입니다. 요약하면 짧은 본문 하나가 있습니다.".match(/.{1,4}/gsu)!) { send({ content: piece }); await wait(300); }
    send({}, "stop"); done(); return;
  }
  const format = marker.split("-")[1]!;
  const tool = TOOL[format]!(marker, body.messages);
  if (body.messages.at(-1)?.role === "tool" && (format !== "xlsx" || tool === null)) {
    send({ role: "assistant", content: `${marker} 고쳤습니다.` });
    await new Promise<void>((go) => released.set(marker, go));
    send({}, "stop"); done(); return;
  }
  if (!tool) { send({}, "stop"); done(); return; }
  send({ tool_calls: [{ index: 0, id: `call-${marker}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] });
  send({}, "tool_calls"); res.end("data: [DONE]\n\n");
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address(); if (!address || typeof address === "string") throw Error("no fixture port");

// ---- the stand-in app binary (the executor) -------------------------------------------------------
const executorFile = join(dir, "executor-urls.txt"), fakeBin = join(dir, "fake-app.mjs");
writeFileSync(fakeBin, `#!${process.execPath}\nimport { appendFileSync } from "node:fs";\nif (process.argv.includes("--office-executor")) { appendFileSync(${JSON.stringify(executorFile)}, process.pid + " " + process.env.WORKBENCH_OFFICE_EXECUTOR_URL + "\\n"); process.stdin.resume(); process.stdin.on("end", () => process.exit(0)); }\n`);
chmodSync(fakeBin, 0o755);
const realBin = process.env.WB_CHECK_APP_BIN || null, realLog = process.env.WB_CHECK_EXECUTOR_LOG || null;
const gatewayEnv = (base: NodeJS.ProcessEnv) => {
  const env = { ...base };
  for (const [name, value] of Object.entries(JSON.parse(process.env.WB_CHECK_GATEWAY_ENV || "{}") as Record<string, string | null>)) if (value === null) delete env[name]; else env[name] = value;
  delete env.WB_CHECK_GATEWAY_ENV; delete env.WB_CHECK_APP_BIN; delete env.WB_CHECK_EXECUTOR_LOG;
  return env;
};
const executorCount = () => realBin && realLog ? (existsSync(realLog) ? readFileSync(realLog, "utf8").split("\n").filter((line) => line.startsWith("start ") && line.endsWith("--office-executor")).length : 0) : existsSync(executorFile) ? readFileSync(executorFile, "utf8").trim().split("\n").filter(Boolean).length : 0;

let child: ChildProcess | null = null, browser: Browser | null = null, page: Page | null = null;
const errors: string[] = [];
let dumpApi: ((path: string, method?: string, body?: unknown) => Promise<any>) | null = null;
try {
  child = spawn(process.execPath, ["apps/host/dist/host.mjs"], { env: gatewayEnv({ ...process.env,
    WORKBENCH_DATA_DIR: dir, WORKBENCH_HOST_ID: "fixture", WORKBENCH_IEUM_BOOTSTRAP: "0", WORKBENCH_WEB_DIR: resolve(process.env.OFFICE_LIVE_WEB_DIR ?? "apps/web/dist"),
    WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"), WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"), WORKBENCH_VAULT_SUGGEST: "",
    WORKBENCH_APP_BIN: realBin ?? fakeBin,
  }), stdio: ["pipe", "pipe", "pipe"] });
  child.stderr!.on("data", (data) => writeFileSync(join(out, "host.log"), data, { flag: "a" }));
  const ready = await new Promise<{ url: string; token: string }>((done, fail) => {
    const timer = setTimeout(() => fail(Error("gateway start timeout")), 30_000);
    child!.once("exit", (code) => { clearTimeout(timer); fail(Error(`gateway exited: ${code}`)); });
    createInterface({ input: child!.stdout! }).on("line", (line) => { if (line.startsWith("WORKBENCH_READY ")) { clearTimeout(timer); done(JSON.parse(line.slice(16))); } });
  });
  const api = async (path: string, method = "GET", body?: unknown) => {
    const r = await fetch(`${ready.url}${path}`, { method, headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await r.json(); if (!r.ok) throw Error(`${path}: ${r.status} ${result.message}`); return result;
  };
  dumpApi = api;
  const work = await api("/api/works", "POST", { title: "문서 AI 실시간 검사", cwd: null });
  const main = await api(`/api/works/${work.id}/sessions`, "POST", { provider: "codex", purpose: "메인 채팅" });
  // A Word document long enough to scroll.
  const zip = await JSZip.loadAsync(readFileSync(resolve("vendor/ieumoffice/apps/docs/tests/pagination-corpus/docx/simple.docx")));
  const xml = await zip.file("word/document.xml")!.async("string");
  const lines = Array.from({ length: 120 }, (_, i) => `<w:p><w:r><w:t>검사 문단 ${i + 1}. 스크롤이 되는지 보는 줄입니다.</w:t></w:r></w:p>`).join("");
  zip.file("word/document.xml", xml.replace(/<w:sectPr/, `${lines}<w:sectPr`));
  writeFileSync(join(work.cwd, "긴 문서.docx"), await zip.generateAsync({ type: "nodebuffer" }));
  copyFileSync(resolve("scripts/fixtures/cover.pptx"), join(work.cwd, "표지.pptx"));
  copyFileSync(resolve("scripts/fixtures/supplies.xlsx"), join(work.cwd, "물품.xlsx"));
  // A PDF of several pages (the place must be able to scroll): drawn here, plain PDF objects.
  writeFileSync(join(work.cwd, "스캔.pdf"), simplePdf(6, ""));
  writeFileSync(join(work.cwd, "메모.md"), `# 메모\n\n${Array.from({ length: 80 }, (_, i) => `검사 줄 ${i + 1}.`).join("\n\n")}\n`);
  writeFileSync(join(work.cwd, "소개.html"), `<!doctype html><html><head><meta charset="utf-8"><title>소개</title></head><body><h1>소개</h1>${Array.from({ length: 60 }, (_, i) => `<p>검사 문단 ${i + 1}.</p>`).join("")}</body></html>`);
  const files: Record<string, string> = { docx: "긴 문서.docx", pptx: "표지.pptx", xlsx: "물품.xlsx", pdf: "스캔.pdf", md: "메모.md", html: "소개.html" };
  const docs: Record<string, { id: string }> = {};
  for (const format of FORMATS) docs[format] = await api(`/api/works/${work.id}/artifacts`, "POST", { path: join(work.cwd, files[format]!) });
  const config = await api("/api/office-ai/settings");
  config.settings.provider = "custom"; config.settings.subscriptionNoticeSeen = true; config.settings.customEndpoint = "fixture";
  config.settings.customEndpoints = [{ id: "fixture", name: "Local fixture", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "", model: "live-fixture", kind: "local", modelProfiles: { "live-fixture": { tools: true, toolsSource: "user", contextLength: 1000000, contextSource: "user" } } }];
  mkdirSync(join(dir, "office"), { recursive: true }); writeFileSync(join(dir, "office/ai-settings.json"), JSON.stringify(config.settings));
  await api(`/api/works/${work.id}`, "PATCH", { activeSessionId: main.id });
  const tabs = [...FORMATS.map((format) => ({ id: `doc-${format}`, workId: work.id, sessionId: null, view: { kind: "document", artifactId: docs[format]!.id, proposalId: null } })),
    { id: "main", workId: work.id, sessionId: main.id, view: { kind: "work" } }];
  await api("/api/layouts/global", "PUT", { expectedRevision: 0, layout: { version: 2, focus: "test-pane", panes: [{ ...tabs[0], id: "test-pane", tabs, activeTabId: tabs[0]!.id, recentTabIds: [tabs[0]!.id] }] } });
  await api("/api/prefs", "PUT", { prefs: { onboarding: "done", layoutScope: "global", startScreen: "last", sidebar: true } });

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript((id) => localStorage.setItem("workbench.lastWork", id), work.id);
  await editorFirst(context);
  await context.addInitScript(() => { if (window.top !== window) return; (window as unknown as { __viewPositions: unknown[] }).__viewPositions = []; window.addEventListener("message", (event) => { const data = event.data as { type?: string; position?: unknown }; if (data?.type === "office:view-position") (window as unknown as { __viewPositions: unknown[] }).__viewPositions.push(data.position); }); });
  page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  // The executor pages (the stand-in binary's addresses), opened as they appear.
  let executorSeen = 0;
  const executorPages: Page[] = [];
  const follow = setInterval(async () => {
    if (!existsSync(executorFile)) return;
    const urls = readFileSync(executorFile, "utf8").trim().split("\n");
    for (; executorSeen < urls.length; executorSeen++) {
      const executor = await context.newPage(); executorPages.push(executor);
      executor.on("pageerror", (error) => errors.push(`executor: ${error.message}`));
      if (args.includes("--trace-exceptions")) {
        // Where an exception the executor reports by message only comes from (DevTools: pause on exceptions, log, resume).
        const cdp = await context.newCDPSession(executor);
        await cdp.send("Debugger.enable"); await cdp.send("Debugger.setPauseOnExceptions", { state: "all" });
        cdp.on("Debugger.paused", (event) => {
          const description = (event as { data?: { description?: string } }).data?.description ?? "";
          if (/redi|Expect \d+ dependency/.test(description)) console.log("TRACE exception", description.split("\n").slice(0, 14).join(" | ").slice(0, 2500));
          void cdp.send("Debugger.resume").catch(() => {});
        });
      }
      if (args.includes("--trace")) executor.on("response", (response) => { if (response.url().includes("/api/")) console.log("TRACE executor http", response.status(), response.request().method(), response.url().replace(/^https?:\/\/[^/]+/, "").slice(0, 120)); });
      if (args.includes("--trace")) executor.on("console", (message) => console.log("executor console", message.type(), message.text().slice(0, 200)));
      void executor.goto(urls[executorSeen]!.split(" ").slice(1).join(" ")).catch(() => {});
    }
  }, 200);
  await page.goto(`${ready.url}/?token=${ready.token}`);
  const activePane = () => page!.locator('.pane[data-pane-active="true"]');
  const activate = async (id: string) => {
    const onStrip = page!.locator(`.pane[data-pane-active="true"] .group-tab[data-tab-id="${id}"] [role="tab"]`);
    if (await onStrip.waitFor({ timeout: 5_000 }).then(() => true, () => false)) await onStrip.click();
    else {
      await page!.locator('.pane[data-pane-active="true"] .group-tab-more').click();
      await page!.locator('.group-tab-list [role^="menuitem"]:not([aria-disabled="true"])').filter({ hasText: id === "main" ? "메인 채팅" : files[id.slice(4)]! }).first().click();
    }
    if (id !== "main") await page!.locator(`.pane[data-pane-active="true"][data-tab="${id}"]`).waitFor();
    else await wait(1000);
  };
  const frameHandle = async () => (await activePane().locator("iframe.office-frame").elementHandle({ timeout: 60_000 }))!;
  const frame = async (): Promise<Frame> => (await (await frameHandle()).contentFrame())!;
  const headKey = () => activePane().locator(".doc-header-right .doc-agent-toggle");
  const readySelector: Record<string, string> = { docx: '.tiptap[contenteditable="true"]', pptx: ".slide-list .thumb-num", xlsx: "#univer-container canvas", pdf: ".app-content canvas, .app-content .page", md: ".app-content .tiptap, .app-content .ProseMirror", html: ".app-content" };
  const openPanel = async (format: string) => {
    const f = await frame();
    await f.waitForSelector(readySelector[format]!, { timeout: 90_000 });
    await f.waitForSelector(".ai-dock, .copilot", { timeout: 30_000 });
    await wait(800);
    if ((await headKey().getAttribute("aria-expanded")) !== "true") await headKey().click();
    await f.waitForSelector(".ai-dock:not(.collapsed) textarea, .copilot:not(.collapsed) textarea", { timeout: 20_000 });
    await wait(500);
  };
  const sendTurn = async (text: string) => {
    const f = await frame();
    const box = f.locator(".ai-dock:not(.collapsed) textarea, .copilot:not(.collapsed) textarea").first();
    await box.fill(text); await box.press("Enter");
  };
  const knob = async (value: string | null) => (await frame()).evaluate((v) => { if (v) localStorage.setItem("workbench.check.office-ai", v); else localStorage.removeItem("workbench.check.office-ai"); }, value);
  const holdLine = async () => (await frame()).evaluate(() => { const line = document.querySelector<HTMLElement>(".wb-ai-hold:not(.wb-ai-applied)"); return line && !line.hidden ? line.textContent ?? "" : ""; }).catch(() => "");
  /** Mark the frame element and its page, to tell later whether either was recreated. */
  const probe = async () => { await (await frameHandle()).evaluate((el) => { (el as HTMLElement).dataset.probe = "same"; }); await (await frame()).evaluate(() => { (window as unknown as { __probe: number }).__probe = 1; }); };
  const sameFrame = async () => {
    const element = await activePane().locator("iframe.office-frame").getAttribute("data-probe").catch(() => null);
    const editor = await (await frame()).evaluate(() => (window as unknown as { __probe?: number }).__probe === 1).catch(() => false);
    return { element: element === "same", editor };
  };
  const surface: Record<string, string> = { docx: ".editor-scroll", pptx: ".stage-wrap", xlsx: "#univer-container", pdf: ".app-content", md: ".app-content", html: ".app-content" };
  const scrollerOf: Record<string, string> = { docx: ".editor-scroll", pptx: ".slide-list", xlsx: "", pdf: "", md: "", html: "" };

  /** Inside the editor during the hold: what is refused and what is free. */
  const holdProbe = async (format: string) => (await frame()).evaluate(([sel]) => {
    const target = document.querySelector<HTMLElement>(sel!) ?? document.querySelector<HTMLElement>(".app-content")!;
    // Refused by the hold = the hold line flashes (an editor may cancel a key or a ribbon mousedown for its own reasons).
    const line = document.querySelector<HTMLElement>(".wb-ai-hold:not(.wb-ai-applied)");
    const refusedBy = (fire: () => void) => { line?.removeAttribute("data-flash"); fire(); return Boolean(line?.hasAttribute("data-flash")); };
    const key = (init: KeyboardEventInit, on: Element = target) => refusedBy(() => on.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })));
    const press = (on: Element) => refusedBy(() => on.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })));
    const inert = [...document.querySelectorAll<HTMLElement>(".app-content, .ribbon, #univer-container, .sheet-main, .excel-header, .formula-bar")].some((el) => el.inert || el.closest("[inert]"));
    const tab = document.querySelector(".ribbon-tab:not(.ribbon-tab-file), [role=tab]");
    const change = [...document.querySelectorAll(".ribbon button:not(.ribbon-tab), .excel-header button, .ribbon [role=button]")].find((el) => /굵게|삽입|붙여넣기|새 슬라이드|정렬|글꼴/.test((el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "")));
    return {
      inert, typed: key({ key: "가" }), backspace: key({ key: "Backspace" }), pageDown: key({ key: "PageDown" }), copy: key({ key: "c", ctrlKey: true }),
      tab: tab ? press(tab) : null, change: change ? press(change) : null, changeLabel: change ? (change.getAttribute("aria-label") || change.getAttribute("title") || change.textContent || "").trim().slice(0, 20) : null,
    };
  }, [surface[format]] as const);
  /** A real wheel over the document: true when its scroller moved (looking is never held). */
  const wheelScrolls = async (format: string) => {
    const f = await frame(), sel = scrollerOf[format];
    const found = await f.evaluate((s) => {
      const el = (s ? document.querySelector<HTMLElement>(s) : null) ?? [...document.querySelectorAll<HTMLElement>(".app-content *, #univer-container *")].find((e) => e.scrollHeight > e.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(e).overflowY) && e.clientHeight > 100);
      if (!el || el.scrollHeight <= el.clientHeight + 10) return null;
      el.setAttribute("data-wb-scroller", ""); el.scrollTop = 0; return true;
    }, sel);
    if (!found) return { moved: null as boolean | null, detail: "no scrollable area" };
    const box = await (await f.$("[data-wb-scroller]"))!.boundingBox();
    const frameBox = await (await frameHandle()).boundingBox();
    await page!.mouse.move((box!.x) + box!.width / 2 + (frameBox?.x ?? 0) * 0, box!.y + Math.min(200, box!.height / 2));
    await page!.mouse.wheel(0, 400); await wait(400);
    const after = await f.evaluate(() => document.querySelector<HTMLElement>("[data-wb-scroller]")!.scrollTop);
    return { moved: after > 0, detail: `0 → ${after}` };
  };
  const shot = (name: string) => page!.screenshot({ path: join(out, `${name}.png`) });

  // ---- hold: every editor ------------------------------------------------------------------------
  for (const format of FORMATS) {
    await activate(`doc-${format}`);
    await openPanel(format);
    await knob("executor");
    const before = executorCount();
    await probe();
    await sendTurn("[ANSWER] 이 문서를 요약해 줘");
    const line = await waitFor(async () => (await holdLine()).includes("중단"), 15_000);
    check(`${format} hold: the line with 중단 on the editor`, line, await holdLine());
    const probeNow = await holdProbe(format);
    check(`${format} hold: nothing inert; typing and Backspace refused; PageDown, Ctrl+C free`, !probeNow.inert && probeNow.typed && probeNow.backspace && !probeNow.pageDown && !probeNow.copy, JSON.stringify(probeNow));
    check(`${format} hold: a ribbon tab header free, a changing ribbon control refused`, (probeNow.tab === null || probeNow.tab === false) && (probeNow.change === null || probeNow.change === true), `tab ${probeNow.tab} · ${probeNow.changeLabel} ${probeNow.change}`);
    const scroll = await wheelScrolls(format);
    if (scroll.moved !== null) check(`${format} hold: wheel scroll moves the document`, scroll.moved, scroll.detail);
    else console.log(`note ${format}: ${scroll.detail}`);
    await shot(`${format}-hold`);
    check(`${format} hold: the turn ran in the executor`, await waitFor(async () => executorCount() > before, 10_000));
    if (args.includes("--trace")) {
      await wait(15_000);
      for (const executor of executorPages.slice(-1)) for (const child of executor.frames()) {
        if (child.url().includes("sheets.html")) console.log("TRACE sheets probe", await child.evaluate(() => {
          const out: Record<string, string> = { globals: Object.keys(window).filter((k) => /univer|wb|lazy/i.test(k)).join(",") };
          const api = (window as any).univerAPI ?? (window as any).__univerAPI;
          if (api) {
            const sheet = api.getActiveWorkbook()?.getActiveSheet();
            for (const [name, run] of [["activate", () => sheet.getRange(0, 0, 1, 1).activate()], ["scroll", () => sheet.scrollToCell(0, 0)], ["setActive", () => api.getActiveWorkbook().setActiveSheet(sheet)]] as const) {
              try { run(); out[name] = "ok"; } catch (error) { out[name] = String((error as Error).message).slice(0, 120); }
            }
          }
          return JSON.stringify(out);
        }).catch((e) => String(e)));
        console.log("TRACE executor frame", child.url().slice(0, 120), await child.evaluate(() => JSON.stringify({ title: document.title, ready: (document.querySelector(".app") as HTMLElement | null)?.className, pm: Boolean(document.querySelector(".ProseMirror")), dock: Boolean(document.querySelector(".ai-dock")), body: document.body?.innerText.slice(0, 200), html: document.body?.innerHTML.slice(0, 400), api: Boolean((window as any).markdownApi), vis: document.visibilityState })).catch((e) => String(e)));
      }
    }
    const releasedOk = await waitFor(async () => !(await holdLine()), 90_000);
    check(`${format} hold: released at the end`, releasedOk);
    {
      const id = (await api("/api/snapshot")).sessions.find((s: { documentAgent?: { artifactId?: string } }) => s.documentAgent?.artifactId === docs[format]!.id)?.id;
      const items = id ? (await api(`/api/sessions/${id}/items`)).items as { kind: string; status?: string; text?: string }[] : [];
      const end = items.filter((item) => item.kind === "turnEnd").at(-1);
      check(`${format} hold: the executor turn completed`, end?.status === "completed", `${end?.status} ${end?.status === "completed" ? "" : items.filter((item) => item.kind === "notice").at(-1)?.text ?? ""}`.slice(0, 160));
    }
    const free = await waitFor(async () => (await holdProbe(format).catch(() => null))?.typed === false, 15_000);
    check(`${format} hold: typing free again`, free);
    const same = await sameFrame();
    numbers[`${format}-answer-only-frame-kept`] = same;
    await knob(null);
    await shot(`${format}-released`);
    // An answer-only turn in the visible editor (the live path): it completes.
    {
      const sessionOf = async () => (await api("/api/snapshot")).sessions.find((s: { documentAgent?: { artifactId?: string } }) => s.documentAgent?.artifactId === docs[format]!.id)?.id as string | undefined;
      const endsOf = async () => { const id = await sessionOf(); return id ? (await api(`/api/sessions/${id}/items`)).items.filter((item: { kind: string }) => item.kind === "turnEnd") as { status: string }[] : []; };
      const before = (await endsOf()).length;
      await sendTurn("[ANSWER] 이 문서를 요약해 줘");
      const ended = await waitFor(async () => (await endsOf()).length > before, 60_000);
      const last = (await endsOf()).at(-1);
      const notice = (await api(`/api/sessions/${await sessionOf()}/items`)).items.filter((item: { kind: string }) => item.kind === "notice").at(-1)?.text;
      check(`${format} live answer-only turn completes`, ended && last?.status === "completed", `${last?.status} ${last?.status === "completed" ? "" : notice ?? ""}`.slice(0, 160));
    }
  }

  if (!args.includes("--hold-only")) {
  // ---- office-leftovers point 2: Excel, PDF, Markdown, HTML take a hidden tab's new revision IN PLACE ----------
  // The tab is hidden (the main conversation in front), a new revision arrives the way an executor turn's result does
  // (the gateway's revision event → the window's openLatest → office:replace), then the tab is shown again: the same
  // iframe element and editor page, the page says it took the revision in place, the content is the new one, the place
  // (scroll / cell) is where it was. Unsaved edits are covered by OfficeEditor.inplace.test.tsx (the conflict path).
  {
    let inPlaceCount = 0;
    const placeOf: Record<string, (f: Frame) => Promise<unknown>> = {
      xlsx: (f) => f.evaluate(() => (window as unknown as { __workbenchUniverAPI?: { getActiveWorkbook(): { getActiveRange(): { getA1Notation(): string } | null } | null } }).__workbenchUniverAPI?.getActiveWorkbook()?.getActiveRange()?.getA1Notation() ?? null),
      pdf: (f) => f.evaluate(() => { const el = [...document.querySelectorAll<HTMLElement>("body *")].filter((e) => e.scrollHeight - e.clientHeight > 8 && /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.querySelector("canvas")).sort((a, b) => b.clientHeight * b.clientWidth - a.clientHeight * a.clientWidth)[0]; return el ? Math.round(el.scrollTop) : null; }),
      md: (f) => f.evaluate(() => { const el = [...document.querySelectorAll<HTMLElement>("body *")].filter((e) => e.scrollHeight - e.clientHeight > 8 && /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.querySelector(".ProseMirror, [contenteditable]")).sort((a, b) => b.clientHeight * b.clientWidth - a.clientHeight * a.clientWidth)[0]; return el ? Math.round(el.scrollTop) : null; }),
      // The HTML editor shows its page in a preview frame (sandboxed): its own scroll is the place (the editor keeps it across reloads).
      html: async () => { const preview = page!.frames().find((f) => /\/preview\//.test(f.url())); return preview ? preview.evaluate(() => Math.round(window.scrollY)).catch(() => null) : null; },
    };
    const setPlace: Record<string, (f: Frame) => Promise<unknown>> = {
      xlsx: (f) => f.evaluate(() => { const wb = (window as unknown as { __workbenchUniverAPI?: { getActiveWorkbook(): { getActiveSheet(): { getRange(a: string): { activate(): unknown } } } } }).__workbenchUniverAPI?.getActiveWorkbook(); wb?.getActiveSheet().getRange("C3").activate(); return true; }),
      pdf: (f) => f.evaluate(() => { const el = [...document.querySelectorAll<HTMLElement>("body *")].filter((e) => e.scrollHeight - e.clientHeight > 8 && /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.querySelector("canvas")).sort((a, b) => b.clientHeight * b.clientWidth - a.clientHeight * a.clientWidth)[0]; if (el) el.scrollTop = 900; return true; }),
      md: (f) => f.evaluate(() => { const el = [...document.querySelectorAll<HTMLElement>("body *")].filter((e) => e.scrollHeight - e.clientHeight > 8 && /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.querySelector(".ProseMirror, [contenteditable]")).sort((a, b) => b.clientHeight * b.clientWidth - a.clientHeight * a.clientWidth)[0]; if (el) el.scrollTop = 600; return true; }),
      html: async () => { const preview = page!.frames().find((f) => /\/preview\//.test(f.url())); return preview ? preview.evaluate(() => { window.scrollTo(0, 300); return true; }) : null; },
    };
    const shows: Record<string, (f: Frame, mark: string) => Promise<boolean>> = {
      xlsx: (f, mark) => f.evaluate((m) => String((window as unknown as { __workbenchUniverAPI?: { getActiveWorkbook(): { getActiveSheet(): { getRange(a: string): { getValue(): unknown } } } } }).__workbenchUniverAPI?.getActiveWorkbook()?.getActiveSheet().getRange("A2").getValue() ?? "").includes(m), mark),
      pdf: async () => true,
      md: (f, mark) => f.evaluate((m) => (document.querySelector(".ProseMirror")?.textContent ?? "").includes(m), mark),
      // (PDF: the executor's blank page; HTML: the source is drawn in a virtual list — both read as "the page took the revision".)
      html: async () => true,
    };
    for (const format of FORMATS.filter((f) => ["xlsx", "pdf", "md", "html"].includes(f))) {
      const mark = `EDIT-${format}-${100 + ++inPlaceCount}`;
      await activate(`doc-${format}`);
      await openPanel(format);
      const f0 = await frame();
      await wait(format === "xlsx" ? 3000 : 1500);
      await setPlace[format]!(f0); await wait(1200);
      const placeBefore = await placeOf[format]!(f0);
      await probe();
      // The desktop app's path for a turn from a hidden tab: the independent executor (the rig's knob forces it here).
      await knob("executor");
      const revisionOf = async () => { const snap = await api("/api/snapshot") as { artifacts: Record<string, { id: string; revision: number }> | { id: string; revision: number }[] }; return (Array.isArray(snap.artifacts) ? snap.artifacts : Object.values(snap.artifacts)).find((entry) => entry.id === docs[format]!.id)!.revision; };
      const before = { revision: await revisionOf() };
      await sendTurn(`[${mark}] 고쳐 줘`);
      const edited = await waitFor(async () => released.has(mark), 90_000);
      await activate("main"); await wait(800);
      released.get(mark)?.();
      await waitFor(async () => endedAt.has(mark), 10_000);
      let revision: number | null = null, problem = edited ? "" : "the executor's edit never came";
      await waitFor(async () => { const now = await revisionOf(); if (now > before.revision) { revision = now; return true; } return false; }, 60_000);
      if (!revision) problem ||= "no new revision";
      await wait(2500);
      await activate(`doc-${format}`); await wait(1500);
      const f1 = await frame();
      const took = await waitFor(async () => (await f1.evaluate(() => (window as unknown as { __workbenchReplaced?: number }).__workbenchReplaced ?? null).catch(() => null)) === revision, 30_000);
      await wait(1500);
      const same = await sameFrame();
      const shown = await waitFor(() => shows[format]!(f1, mark), 10_000);
      const film: unknown[] = [];
      for (let i = 0; i < 8; i++) { film.push(await placeOf[format]!(f1)); await wait(400); }
      numbers[`${format}-place-film`] = { film, previews: await Promise.all(page!.frames().filter((f) => /\/preview\//.test(f.url())).map((f) => f.evaluate(() => [location.pathname.slice(-30), Math.round(window.scrollY), document.documentElement.scrollHeight, innerHeight]).catch((e) => String(e).slice(0, 80)))), said: await page!.evaluate(() => (window as unknown as { __viewPositions?: unknown[] }).__viewPositions?.slice(-6) ?? []) };
      const placeAfter = await placeOf[format]!(f1);
      const placeKept = typeof placeBefore === "number" ? typeof placeAfter === "number" && Math.abs(placeAfter - placeBefore) <= 4 : placeAfter === placeBefore;
      const saveState = await activePane().locator(".save-state").first().innerText().catch(() => "");
      numbers[`${format}-hidden-in-place`] = { revision, took, ...same, shown, placeBefore, placeAfter, saveState, problem };
      check(`${format} hidden tab → in place: same iframe element and editor page, the page took the revision`, Boolean(revision) && took && same.element && same.editor, JSON.stringify(numbers[`${format}-hidden-in-place`]));
      check(`${format} hidden tab → in place: the new content is shown and nothing reads as unsaved`, shown && !/저장 안 됨/.test(saveState), JSON.stringify({ shown, saveState }));
      check(`${format} hidden tab → in place: the place is kept`, placeKept && placeBefore !== null, `${JSON.stringify(placeBefore)} → ${JSON.stringify(placeAfter)}`);
      await shot(`${format}-hidden-in-place`);
      await knob(null);
    }
  }

  // ---- result and live: Word and PowerPoint ----------------------------------------------------------
  const visible: Record<string, (marker: string, count: number) => Promise<boolean>> = {
    docx: async (marker) => (await frame()).evaluate((m) => (document.querySelector(".tiptap")?.textContent ?? "").includes(m), marker).catch(() => false),
    pptx: async (_marker, count) => (await frame()).evaluate((c) => document.querySelectorAll(".slide-list .thumb-num").length > c, count).catch(() => false),
  };
  const slideCount = async () => (await frame()).evaluate(() => document.querySelectorAll(".slide-list .thumb-num").length).catch(() => 0);
  let n = 0;
  for (const format of FORMATS.filter((f) => f === "docx" || f === "pptx")) {
    await activate(`doc-${format}`);
    await openPanel(format);
    for (const mode of ["0.5.2", "executor", "live"] as const) {
      await knob(mode === "live" ? null : mode);
      const marker = `EDIT-${format}-${++n}`;
      const count = await slideCount();
      // Word: the view is somewhere in the middle of the document.
      const scroller = scrollerOf[format]!;
      const top = await (await frame()).evaluate((s) => { const el = document.querySelector<HTMLElement>(s); if (!el) return null; el.scrollTop = Math.min(900, el.scrollHeight - el.clientHeight); return el.scrollTop; }, scroller);
      // PowerPoint: the view is on the last slide.
      const activeIndex = async () => (await frame()).evaluate(() => [...document.querySelectorAll(".slide-list .thumb")].findIndex((thumb) => thumb.classList.contains("active"))).catch(() => null);
      if (format === "pptx") { await (await frame()).evaluate(() => { const all = document.querySelectorAll<HTMLElement>(".slide-list .thumb"); all[all.length - 1]?.click(); }); await wait(400); }
      const activeBefore = format === "pptx" ? await activeIndex() : null;
      await probe();
      const executorsBefore = executorCount();
      await sendTurn(`[${marker}] 고쳐 줘`);
      await waitFor(async () => released.has(marker), 60_000);
      const seenBeforeEnd = mode === "live" ? await waitFor(() => visible[format]!(marker, count), 10_000) : await visible[format]!(marker, count);
      const midLine = await holdLine();
      if (mode === "live") check(`${format} live: mid-turn the hold line says the AI is changing the document, with 중단`, /고치는 중/.test(midLine) && midLine.includes("중단"), midLine);
      await shot(`${format}-${mode}-mid-turn`);
      released.get(marker)?.();
      const end = await waitFor(async () => endedAt.has(marker), 10_000) ? endedAt.get(marker)! : Date.now();
      const shown = await waitFor(() => visible[format]!(marker, count), 30_000);
      const ms = Date.now() - end;
      if (!shown) console.log("debug", JSON.stringify(await (await frame()).evaluate(() => ({ tail: (document.querySelector(".tiptap")?.textContent ?? "").slice(-120), blocks: document.querySelector(".tiptap")?.childElementCount }))), await activePane().locator("iframe.office-frame").getAttribute("data-revision"));
      await wait(1500);
      const same = await sameFrame();
      const topAfter = await (await frame()).evaluate((s) => document.querySelector<HTMLElement>(s)?.scrollTop ?? null, scroller).catch(() => null);
      const activeAfter = format === "pptx" ? await activeIndex() : null;
      numbers[`${format}-${mode}`] = { activeSlide: [activeBefore, activeAfter], endToVisibleMs: seenBeforeEnd ? `visible before the end` : ms, frameElementKept: same.element, editorPageKept: same.editor, scrollTop: [top, topAfter], executorStarted: executorCount() > executorsBefore };
      check(`${format} ${mode}: the result is in the open editor`, shown, `${seenBeforeEnd ? "visible before the turn ended" : `${ms} ms after the turn ended`}`);
      if (mode === "0.5.2") check(`${format} 0.5.2 (before): the page was reopened`, !same.editor, JSON.stringify(same));
      if (mode === "executor") {
        check(`${format} executor → in place: same iframe element and same editor page`, same.element && same.editor, JSON.stringify(same));
        if (format === "pptx") check(`pptx executor → in place: the slide on screen kept`, activeBefore !== null && activeBefore > 0 && activeAfter === activeBefore, `${activeBefore} → ${activeAfter}`);
        if (format === "docx") check(`docx executor → in place: the view position kept`, top !== null && topAfter !== null && Math.abs(topAfter - top) <= 2, `${top} → ${topAfter}`);
        if (format === "docx") check(`docx executor → in place: the 반영했습니다 · 되돌리기 line`, await (await frame()).evaluate(() => /반영했습니다/.test(document.querySelector(".wb-ai-applied")?.textContent ?? "")).catch(() => false));
      }
      if (mode === "live") {
        check(`${format} live: the edit appears while the turn runs (before its end)`, seenBeforeEnd);
        check(`${format} live: no executor, same frame and editor page`, !(executorCount() > executorsBefore) && same.element && same.editor, JSON.stringify({ ...same, executor: executorCount() > executorsBefore }));
      }
      await shot(`${format}-${mode}-after`);
      await wait(800);
    }
    // A live turn whose tab is hidden mid-turn finishes correctly.
    await knob(null);
    const marker = `EDIT-${format}-${++n}`, count = await slideCount();
    await probe();
    await sendTurn(`[${marker}] 고쳐 줘`);
    await waitFor(async () => released.has(marker), 60_000);
    await activate("main"); await wait(1500);
    released.get(marker)?.();
    await waitFor(async () => endedAt.has(marker), 10_000); await wait(2500);
    await activate(`doc-${format}`); await wait(1000);
    const shown = await waitFor(() => visible[format]!(marker, count), 20_000);
    const same = await sameFrame();
    check(`${format} live, tab hidden mid-turn: the turn finished and its result is in the same editor`, shown && same.element && same.editor, JSON.stringify(same));
    const saved = await api(`/api/artifacts/${docs[format]!.id}`).catch(() => null) as { revision?: number } | null;
    numbers[`${format}-hidden-mid-turn`] = { shown, ...same, revision: saved?.revision };
    await shot(`${format}-hidden-mid-turn-after`);

    // ---- the tab closed during a live turn (coordinator's gate 1): the editor is kept off screen until the turn
    // ends, the turn completes and saves its revision, then the kept editor is released; Word also opens the
    // document again from its row while the turn runs: the same tab and the same editor come back.
    {
      const marker = `EDIT-${format}-${++n}`, count = await slideCount();
      const tabId = `doc-${format}`;
      const file = join(work.cwd, files[format]!);
      await probe();
      const executorsBefore = executorCount();
      await sendTurn(`[${marker}] 고쳐 줘`);
      await waitFor(async () => released.has(marker), 60_000);
      await page!.locator(`.pane[data-pane-active="true"] .group-tab[data-tab-id="${tabId}"] .group-tab-close`).first().click();
      await wait(1500);
      const keptSection = page!.locator(`section[data-tab-kept="closed"][data-tab="${tabId}"]`);
      const keptNow = await keptSection.count() === 1 && await page!.locator(`.group-tab[data-tab-id="${tabId}"]`).count() === 0;
      const keptSame = await keptSection.locator("iframe.office-frame").getAttribute("data-probe").catch(() => null) === "same";
      check(`${format} tab closed mid-turn: the tab is gone, its editor kept off screen (same frame)`, keptNow && keptSame, JSON.stringify({ keptNow, keptSame }));
      // The row says the document's AI is at work.
      if (!await page!.locator(`.sidebar [data-row-id="${docs[format]!.id}"]`).count()) await page!.locator(`.sidebar [data-row-id="${work.id}"]`).click().catch(() => {});
      const row = page!.locator(`.sidebar [data-row-id="${docs[format]!.id}"]`);
      const mark = await waitFor(async () => /진행 중/.test(await row.locator(".row-doc-ai").innerText().catch(() => "")), 10_000);
      check(`${format} tab closed mid-turn: its row shows 진행 중`, mark, await row.locator(".row-doc-ai").innerText().catch(() => ""));
      if (format === "docx") {
        await row.click();
        await page!.locator(`.pane[data-pane-active="true"][data-tab="${tabId}"]`).waitFor({ timeout: 15_000 }).catch(() => {});
        const same = await sameFrame();
        const second = await page!.locator(`iframe.office-frame`).evaluateAll((frames) => frames.length);
        check("docx opened again from its row mid-turn: the same tab and editor (no second editor)", same.element && same.editor && await keptSection.count() === 0, JSON.stringify({ ...same, frames: second }));
        await page!.locator(`.pane[data-pane-active="true"] .group-tab[data-tab-id="${tabId}"] .group-tab-close`).first().click();
        await wait(1000);
        check("docx closed again mid-turn: kept again", await keptSection.count() === 1);
      }
      const bytesBefore = readFileSync(file);
      released.get(marker)?.();
      await waitFor(async () => endedAt.has(marker), 10_000);
      const gone = await waitFor(async () => await keptSection.count() === 0, 30_000);
      const saved = await waitFor(async () => {
        const zip = await JSZip.loadAsync(readFileSync(file)).catch(() => null);
        if (!zip) return false;
        if (format === "docx") return (await zip.file("word/document.xml")!.async("string")).includes(marker);
        return Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length > count;
      }, 20_000);
      check(`${format} tab closed mid-turn: the turn completed and its revision is saved`, saved, `file ${bytesBefore.length} → ${readFileSync(file).length} bytes`);
      check(`${format} tab closed mid-turn: the kept editor is released after the end (no leak)`, gone && await page!.locator(`[data-tab-kept]`).count() === 0);
      check(`${format} tab closed mid-turn: no executor took it over`, executorCount() === executorsBefore);
      const ends = (await api(`/api/sessions/${(await api("/api/snapshot")).sessions.find((s: { documentAgent?: { artifactId?: string } }) => s.documentAgent?.artifactId === docs[format]!.id).id}/items`)).items.filter((item: { kind: string }) => item.kind === "turnEnd");
      check(`${format} tab closed mid-turn: recorded as completed`, ends.at(-1)?.status === "completed", ends.at(-1)?.status);
      await shot(`${format}-closed-mid-turn-after`);
    }
  }

  // ---- a real quit during a live turn: the turn is recorded interrupted, the document not half-saved ----------
  if (FORMATS.includes("docx")) {
    // Open Word again from its row (the tab was closed above).
    await page!.locator(`.sidebar [data-row-id="${docs.docx!.id}"]`).click();
    await page!.locator('.pane[data-pane-active="true"][data-tab]').waitFor();
    await openPanel("docx");
    const marker = `EDIT-docx-${++n}`;
    const file = join(work.cwd, files.docx!);
    await sendTurn(`[${marker}] 고쳐 줘`);
    await waitFor(async () => released.has(marker), 60_000);
    const before = readFileSync(file);
    await page!.close();
    const sessionId = (await api("/api/snapshot")).sessions.find((s: { documentAgent?: { artifactId?: string } }) => s.documentAgent?.artifactId === docs.docx!.id).id;
    const interrupted = await waitFor(async () => (await api(`/api/sessions/${sessionId}/items`)).items.filter((item: { kind: string }) => item.kind === "turnEnd").at(-1)?.status === "interrupted"
      && (await api("/api/snapshot")).sessions.find((s: { id: string }) => s.id === sessionId)?.status !== "running", 60_000);
    released.get(marker)?.();
    const after = readFileSync(file);
    const zip = await JSZip.loadAsync(after).catch(() => null);
    const whole = Boolean(zip && await zip.file("word/document.xml")?.async("string"));
    check("docx quit mid-turn: the turn is recorded interrupted", interrupted, (await api(`/api/sessions/${sessionId}/items`)).items.filter((item: { kind: string }) => item.kind === "turnEnd").at(-1)?.status);
    check("docx quit mid-turn: the document is the revision before the turn, whole (not half-saved)", before.equals(after) && whole, `${before.length} → ${after.length} bytes, readable ${whole}`);
  }
  }
  clearInterval(follow);
} catch (error) {
  check("rig ran to the end", false, error instanceof Error ? error.stack?.slice(0, 600) : String(error));
} finally {
  try {
    const api = dumpApi!;
    // OFFICE_LIVE_WAIT_MS: let executor turns still running end before their transcripts are read.
    await wait(Number(process.env.OFFICE_LIVE_WAIT_MS ?? 0));
    // The document AIs' transcripts (tool lines and notices), for reading a failure.
  const snap = await api("/api/snapshot") as { sessions?: Record<string, { id: string; documentAgent?: unknown }> | { id: string; documentAgent?: unknown }[] };
  const sessions = Array.isArray(snap.sessions) ? snap.sessions : Object.values(snap.sessions ?? {});
  const transcripts: Record<string, unknown> = {};
  for (const session of sessions.filter((s) => s.documentAgent)) transcripts[session.id] = ((await api(`/api/sessions/${session.id}/items`)).items as { kind: string; text?: string; title?: string; status?: string; output?: string }[]).map((item) => [item.kind, item.title ?? item.text?.slice(0, 80), item.status, item.output?.slice(0, 160)]);
  writeFileSync(join(out, "transcripts.json"), JSON.stringify(transcripts, null, 1));
  } catch { /* nothing to read */ }
  writeFileSync(join(out, "results.json"), JSON.stringify({ results, numbers, errors: errors.slice(0, 40) }, null, 2));
  console.log(`${results.filter((r) => r.ok).length}/${results.length} passed; page errors: ${errors.length}`);
  console.log(JSON.stringify(numbers, null, 1));
  await browser?.close().catch(() => {});
  child?.stdin?.end(); child?.kill(); server.close();
  setTimeout(() => process.exit(results.every((r) => r.ok) ? 0 : 1), 300);
}
