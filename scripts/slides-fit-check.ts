/// <reference lib="dom" />
// The PowerPoint view after AI edits (unit one-doc-ai; the owner 2026-11-16: "PPTX탭에서 AI요청을 해서 뭘 만들어보니까 슬라이드 화면이
// 강제로 우측 하단으로 잘려서 이동하면서 중앙 정렬로 안보이는"). Real built UI, gateway and slides editor; the editor's 문서 AI runs on a
// local model fixture whose answers call the editor's own slide tool (apply_ops) — add a slide, duplicate one while the
// window is resized during the turn, replace the slide on screen. After each step the slide (.stage-rel) is measured
// against the stage (.stage-wrap's content box): centred within TOLERANCE px on both axes and fully inside.
// Word (the page centred) and Excel (the grid's origin) are measured once in the same way, panel closed and open.
// Usage: node scripts/slides-fit-check.ts <out folder>   (through ux/run-isolated.sh)
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Browser, type FrameLocator, type Page } from "playwright-core";

const out = resolve(process.argv[2] ?? "slides-fit"); mkdirSync(out, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), "wb-slides-fit-"));
const TOLERANCE = 4;
const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`); };
const until = async (what: () => Promise<boolean>, timeout = 30_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await what()) return; await new Promise(done => setTimeout(done, 100)); }
  throw Error("condition timed out");
};
const wait = (ms: number) => new Promise(done => setTimeout(done, ms));

/** What each request asks for (by its marker in the instruction): the ops of one apply_ops call. */
const TURNS: Record<string, unknown[]> = {
  FIT_ADD: [{ op: "addBlankSlide", target: { slide: 0 } }],
  FIT_DUPLICATE: [{ op: "duplicateSlide", target: { slide: 0 } }],
  FIT_REPLACE: [{ op: "addBlankSlide", target: { slide: 0 } }, { op: "deleteSlide", target: { slide: 0 } }],
  // A deck made in another page size (a template's 4:3), and back to 16:9 — what "making slides" can do to the deck.
  FIT_SIZE_43: [{ op: "setSlideSize", cx: 9144000, cy: 6858000 }],
  FIT_SIZE_169: [{ op: "setSlideSize", cx: 12192000, cy: 6858000 }],
};
const held = new Map<string, () => void>();
const server = createServer(async (req, res: ServerResponse) => {
  let raw = ""; for await (const part of req) raw += String(part);
  if (req.url === "/v1/models") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "fit-fixture" }] })); return; }
  if (req.url !== "/v1/chat/completions") { res.statusCode = 404; res.end(); return; }
  const body = JSON.parse(raw);
  // The request's own marker: the last user message's (earlier turns' markers are in the history too).
  const lastUser = JSON.stringify(body.messages.filter((message: { role: string }) => message.role === "user").at(-1)?.content ?? "");
  const marker = Object.keys(TURNS).filter((key) => lastUser.includes(key)).sort((a, b) => b.length - a.length)[0] ?? "FIT_ADD";
  res.setHeader("content-type", "text/event-stream");
  const send = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: marker, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  const last = body.messages.at(-1);
  if (last?.role === "tool") { send({ role: "assistant", content: `${marker} 끝났습니다.` }); send({}, "stop"); res.end("data: [DONE]\n\n"); return; }
  send({ role: "assistant", content: `${marker} 슬라이드를 고칩니다.` });
  held.set(marker, () => {
    send({ tool_calls: [{ index: 0, id: `ops-${marker}-${Date.now()}`, type: "function", function: { name: "apply_ops", arguments: JSON.stringify({ ops: TURNS[marker] }) } }] });
    send({}, "tool_calls"); res.end("data: [DONE]\n\n");
  });
});
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
const address = server.address(); if (!address || typeof address === "string") throw Error("No fixture port");
let child: ChildProcess | null = null, browser: Browser | null = null, page: Page | null = null;
const errors: string[] = [];
const measures: Record<string, unknown> = {};
try {
  child = spawn(process.execPath, ["apps/host/dist/host.mjs"], { env: { ...process.env,
    WORKBENCH_DATA_DIR: dir, WORKBENCH_HOST_ID: "fixture", WORKBENCH_IEUM_BOOTSTRAP: "0",
    WORKBENCH_WEB_DIR: resolve(process.env.FIT_WEB_DIR ?? "apps/web/dist"),
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
  const work = await api("/api/works", "POST", { title: "슬라이드 맞춤 검사", cwd: null });
  const main = await api(`/api/works/${work.id}/sessions`, "POST", { provider: "codex", purpose: "메인 채팅" });
  const add = async (from: string, name: string) => { const file = join(work.cwd, name); copyFileSync(resolve(from), file); return api(`/api/works/${work.id}/artifacts`, "POST", { path: file }); };
  const deck = await add("scripts/fixtures/cover.pptx", "표지.pptx");
  const word = await add("vendor/ieumoffice/apps/docs/tests/pagination-corpus/docx/simple.docx", "보고서.docx");
  const config = await api("/api/office-ai/settings");
  config.settings.provider = "custom"; config.settings.subscriptionNoticeSeen = true; config.settings.customEndpoint = "fixture";
  config.settings.customEndpoints = [{ id: "fixture", name: "Local fixture", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "", model: "fit-fixture", kind: "local", modelProfiles: { "fit-fixture": { tools: true, toolsSource: "user", contextLength: 1000000, contextSource: "user" } } }];
  mkdirSync(join(dir, "office"), { recursive: true }); writeFileSync(join(dir, "office/ai-settings.json"), JSON.stringify(config.settings));
  await api(`/api/works/${work.id}`, "PATCH", { activeSessionId: main.id });
  const tabs = [
    { id: "deck", workId: work.id, sessionId: null, view: { kind: "document", artifactId: deck.id, proposalId: null } },
    { id: "word", workId: work.id, sessionId: null, view: { kind: "document", artifactId: word.id, proposalId: null } },
    { id: "main", workId: work.id, sessionId: main.id, view: { kind: "work" } },
  ];
  await api("/api/layouts/global", "PUT", { expectedRevision: 0, layout: { version: 2, focus: "test-pane", panes: [{ ...tabs[0], id: "test-pane", tabs, activeTabId: "deck", recentTabIds: ["deck"] }] } });
  await api("/api/prefs", "PUT", { prefs: { onboarding: "done", layoutScope: "global", startScreen: "last", sidebar: false } });
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(id => localStorage.setItem("workbench.lastWork", id), work.id);
  page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${ready.url}/?token=${ready.token}`);
  const activePane = () => page!.locator('.pane[data-pane-active="true"]');
  const activate = async (id: string) => {
    await page!.locator(`.pane[data-pane-active="true"] .group-tab[data-tab-id="${id}"] [role="tab"]`).click();
    await page!.locator(`.pane[data-pane-active="true"][data-tab="${id}"]`).waitFor();
  };
  const frameOf = (): FrameLocator => activePane().frameLocator("iframe.office-frame");
  const headKey = () => activePane().locator(".doc-header-right .doc-agent-toggle");
  const panel = async (open: boolean) => {
    if (((await headKey().getAttribute("aria-expanded")) === "true") !== open) await headKey().click();
    await until(async () => ((await headKey().getAttribute("aria-expanded")) === "true") === open, 15_000);
    await wait(800);
  };
  /** The slide's box against the stage's content box, in the editor frame. */
  const slideFit = () => frameOf().locator("body").evaluate(() => {
    const wrap = document.querySelector<HTMLElement>(".stage-wrap"), rel = document.querySelector<HTMLElement>(".stage-rel");
    if (!wrap || !rel) return null;
    const w = wrap.getBoundingClientRect(), r = rel.getBoundingClientRect(), style = getComputedStyle(wrap);
    const left = w.left + parseFloat(style.paddingLeft), right = w.left + wrap.clientWidth - parseFloat(style.paddingRight);
    const top = w.top + parseFloat(style.paddingTop), bottom = w.top + wrap.clientHeight - parseFloat(style.paddingBottom);
    const box = document.querySelector<HTMLElement>(".stage-zoom-box")!.getBoundingClientRect(), scale = document.querySelector<HTMLElement>(".stage-scale")!;
    return {
      dx: Math.round(((r.left + r.right) / 2 - (left + right) / 2) * 10) / 10, dy: Math.round(((r.top + r.bottom) / 2 - (top + bottom) / 2) * 10) / 10,
      inside: r.left >= w.left - 0.5 && r.right <= w.left + wrap.clientWidth + 0.5 && r.top >= w.top - 0.5 && r.bottom <= w.top + wrap.clientHeight + 0.5,
      slide: [Math.round(r.left - w.left), Math.round(r.top - w.top), Math.round(r.width), Math.round(r.height)], stage: [Math.round(wrap.clientWidth), Math.round(wrap.clientHeight)],
      scroll: [wrap.scrollLeft, wrap.scrollTop], zoomBox: [Math.round(box.width), Math.round(box.height)], scaleLayout: [scale.offsetWidth, scale.offsetHeight], fits: wrap.classList.contains("stage-fits-viewport"),
    };
  });
  const fitCheck = async (label: string) => {
    await wait(600);
    const fit = await slideFit();
    measures[label] = fit;
    const ok = Boolean(fit && Math.abs(fit.dx) <= TOLERANCE && Math.abs(fit.dy) <= TOLERANCE && fit.inside);
    check(`PowerPoint ${label}: the current slide is centred and fully inside the stage`, ok, JSON.stringify(fit));
    await page!.screenshot({ path: join(out, `pptx-${label.replace(/[^a-z0-9]+/gi, "-")}.png`) });
    return ok;
  };
  const turn = async (marker: string, during?: () => Promise<void>) => {
    const frame = frameOf();
    await frame.locator(".ai-dock:not(.collapsed) textarea").first().fill(`슬라이드를 고쳐 주세요 ${marker}`);
    await frame.locator(".ai-send-btn:not(.ai-stop-btn)").first().click();
    await until(async () => held.has(marker), 30_000);
    if (during) await during();
    held.get(marker)!(); held.delete(marker);
    await until(async () => (await frame.locator(".ai-dock .ai-panel").innerText()).includes(`${marker} 끝났습니다.`), 45_000);
    await wait(1_500);
  };

  // PowerPoint.
  await activate("deck");
  await frameOf().locator(".stage-rel").waitFor({ timeout: 60_000 });
  await frameOf().locator(".ai-dock").waitFor({ timeout: 30_000 });
  await fitCheck("1440 opened");
  await panel(true); await fitCheck("1440 panel open");
  await panel(false); await fitCheck("1440 panel closed");
  await panel(true);
  await turn("FIT_ADD"); await fitCheck("1440 after an AI turn that adds a slide");
  await turn("FIT_DUPLICATE", async () => { await page!.setViewportSize({ width: 1180, height: 860 }); await wait(500); });
  await fitCheck("1180 after an AI turn with the window resized during it");
  await page.setViewportSize({ width: 1440, height: 900 });
  await turn("FIT_REPLACE"); await fitCheck("1440 after an AI turn that replaces the slide on screen");
  await panel(false); await fitCheck("1440 panel closed after the AI edits");
  await page.setViewportSize({ width: 1000, height: 800 });
  await fitCheck("1000 narrower window");
  await panel(true); await fitCheck("1000 panel open");
  await turn("FIT_ADD"); await fitCheck("1000 after an AI turn that adds a slide");
  await panel(false); await fitCheck("1000 panel closed after the AI edit");
  await page.setViewportSize({ width: 1440, height: 900 });
  await panel(true);
  await turn("FIT_SIZE_43"); await fitCheck("1440 after an AI turn that makes the deck 4:3");
  await turn("FIT_SIZE_169"); await fitCheck("1440 after an AI turn that makes the deck 16:9 again");
  await page.setViewportSize({ width: 1000, height: 800 });
  await turn("FIT_SIZE_43"); await fitCheck("1000 after an AI turn that makes the deck 4:3");
  await panel(false); await fitCheck("1000 panel closed after the page-size edit");
  await page.setViewportSize({ width: 1440, height: 900 });

  // Word: the page centred in its view, panel closed and open (reported; fixed only if broken).
  await page.setViewportSize({ width: 1440, height: 900 });
  await activate("word");
  await frameOf().locator('.tiptap[contenteditable="true"]').waitFor({ timeout: 60_000 });
  for (const open of [false, true]) {
    await panel(open);
    const page_ = await frameOf().locator("body").evaluate(() => {
      const sheet = document.querySelector<HTMLElement>(".page, .doc-page, .paged-page, .ProseMirror")!, host = sheet.closest<HTMLElement>(".doc-scroll, .editor-scroll, .page-scroll, .editor-area, main") ?? sheet.parentElement!;
      const s = sheet.getBoundingClientRect(), h = host.getBoundingClientRect();
      return { sheet: sheet.className, host: host.className, dx: Math.round(((s.left + s.right) / 2 - (h.left + host.clientWidth / 2)) * 10) / 10, sheetLeft: Math.round(s.left - h.left), sheetRight: Math.round(h.left + host.clientWidth - s.right) };
    });
    measures[`word panel ${open ? "open" : "closed"}`] = page_;
    check(`Word panel ${open ? "open" : "closed"}: the page is centred in its view`, Math.abs(page_.dx) <= TOLERANCE * 2, JSON.stringify(page_));
    await page.screenshot({ path: join(out, `word-panel-${open ? "open" : "closed"}.png`) });
  }
  check("no browser exceptions", errors.length === 0, errors.join("; "));
} catch (error) {
  check("PowerPoint fit scenario", false, String(error));
  if (page) { await page.screenshot({ path: join(out, "failure.png") }).catch(() => undefined); writeFileSync(join(out, "failure.txt"), await page.locator("body").innerText().catch(() => "")); }
} finally {
  await browser?.close();
  for (const release of held.values()) release();
  await new Promise<void>(done => server.close(() => done()));
  if (child && child.exitCode === null) { const exited = new Promise<void>(done => child!.once("exit", () => done())); child.kill("SIGTERM"); await exited; }
  writeFileSync(join(out, "results.json"), JSON.stringify({ dir, results, measures, errors }, null, 2));
  console.log(`${results.filter(r => r.ok).length}/${results.length} passed`);
  if (results.some(r => !r.ok)) process.exitCode = 1;
}
