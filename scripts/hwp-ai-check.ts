/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// Rig check of the Hangul editor's document AI (unit ux/hwp-ai): the built gateway and UI in
// Chromium, an .hwpx document, its own AI dock, and a STAND-IN engine (a local OpenAI-compatible
// endpoint — no real model, credential or outside host). Turns: one that only answers; one that
// edits; one that calls 한글 문서 만들기 (the bundled hallym-kordoc runner really runs); `general` (0.5.5): one
// whose request is a general one (kind "general": the model's Markdown through the 기본 template); one whose
// engine dies; one that never answers; `fill` (doc-default): 한글 문서 만들기 in an EMPTY new document fills it in place. Asserts: scrolling works during the turn, the hold line and
// 중단, the hold released in each case, the made document opened in its own tab. Frames → outDir.
// `--executor`: every turn runs in the independent executor (as in the desktop app): a stand-in app
// binary hands the executor page's address to this script, which opens it in a second page.
// With the REAL app binary instead of the stand-in (scripts/real-executor-check.ts drives this): WB_CHECK_APP_BIN
// is the binary (or a wrapper), WB_CHECK_GATEWAY_ENV a JSON object merged into the gateway's environment
// (null removes a name), WB_CHECK_HOST another gateway bundle (to show the base commit fails). Scenario
// `noscreen`: no display anywhere — the turn must end with the one true sentence, nothing held.
// Usage (through ux/run-isolated.sh): node scripts/hwp-ai-check.ts <outDir> [--executor] [--only=a,b]
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Frame, type Page } from "playwright-core";
import { editorFirst } from "./fixtures/editor-first.ts";

const args = process.argv.slice(2);
const outDir = resolve(args.find((arg) => !arg.startsWith("--")) ?? join(tmpdir(), "wb-hwp-ai"));
const executorMode = args.includes("--executor");
const only = args.find((arg) => arg.startsWith("--only="))?.slice(7).split(",");
const want = (name: string) => !only || only.includes(name);
mkdirSync(outDir, { recursive: true });
const tag = executorMode ? "executor" : "local";
const results: { step: string; ok: boolean; detail: string }[] = [];
const check = (step: string, ok: boolean, detail = "") => {
  results.push({ step: `[${tag}] ${step}`, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} [${tag}] ${step}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

// ---- the stand-in engine ------------------------------------------------------------------------
type Msg = { role: string; content?: unknown; tool_calls?: unknown[] };
const textOf = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (part as { text?: string }).text ?? "").join("") : "";
const requests: { scenario: string; step: number; tools: string[] }[] = [];
const held: ServerResponse[] = [];
/** The tool's answers the stand-in engine got in the general scenario. */
const generalOutputs: string[] = [];
const SECTIONS = { "추진 배경": "정기 시설 점검 시기가 되었습니다.", "현황과 문제": "노후 설비 점검이 필요합니다.", "제안 내용": "다음 주에 점검을 진행합니다.", "추진 일정": "- 일시: 미정 (확인 필요)", "기대효과": "안전한 시설 이용" };
const provider = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  let input = ""; for await (const part of req) input += String(part);
  const body = JSON.parse(input || "{}") as { messages?: Msg[]; tools?: { function?: { name: string } }[] };
  const messages = body.messages ?? [];
  const lastUser = messages.map((m, i) => [m, i] as const).filter(([m]) => m.role === "user").at(-1);
  const instruction = lastUser ? textOf(lastUser[0].content) : "";
  const step = lastUser ? messages.slice(lastUser[1] + 1).filter((m) => m.role === "tool").length : 0;
  const scenario = /\[무응답\]/.test(instruction) ? "silent" : /\[엔진종료\]/.test(instruction) ? "dies" : /\[일반\]/.test(instruction) ? "general" : /공문서/.test(instruction) ? "make" : /\[고치기\]/.test(instruction) ? "edit" : "answer";
  requests.push({ scenario, step, tools: (body.tools ?? []).map((tool) => tool.function?.name ?? "") });
  if (args.includes("--trace")) console.log("TRACE provider", new Date().toISOString().slice(11, 23), scenario, step);
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (delta: Record<string, unknown>, finish: string | null = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  const done = () => { res.write("data: [DONE]\n\n"); res.end(); };
  const call = (name: string, args: unknown) => { send({ tool_calls: [{ index: 0, id: `call_${scenario}_${step}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }); send({}, "tool_calls"); done(); };
  const answer = async (text: string, slow = 0) => { for (const piece of text.match(/.{1,6}/gsu) ?? []) { send({ content: piece }); if (slow) await sleep(slow); } send({}, "stop"); done(); };
  if (scenario === "silent") { held.push(res); return; }
  if (scenario === "dies") { await sleep(1500); res.socket?.destroy(); return; }
  if (scenario === "answer") return answer("이 문서는 강의계획서입니다. 수업 목표와 주차별 계획이 들어 있습니다.", 600);
  if (scenario === "edit") {
    if (step === 0) return call("insert_paragraphs", { where: "end", paragraphs: ["문서 AI가 덧붙인 문단입니다."] });
    await sleep(7000); return answer("문서 끝에 문단 하나를 덧붙였습니다.");
  }
  // general (0.5.5, kind "general"): the model writes Markdown, the gateway makes it through the 기본 template.
  if (scenario === "general") {
    if (step === 0) { await sleep(800); return call("make_hangul_document", { prompt: "수업 안내문 만들어줘", kind: "general", title: "수업 안내", markdown: "# 수업 안내\n\n다음 주 수업은 쉽니다.\n\n| 주 | 내용 |\n| --- | --- |\n| 11 | 휴강 |\n" }); }
    generalOutputs.push(textOf(messages.filter((m) => m.role === "tool").at(-1)?.content));
    return answer("기본 서식으로 '수업 안내.hwpx'를 만들어 새 탭에 열었습니다.");
  }
  // make: form → document → answer
  if (step === 0) { await sleep(800); return call("make_hangul_document", { prompt: "공문서 하나 만들어줘" }); }
  // [채우기] (doc-default, point 2): the same request in an empty new document, under another title.
  const title = /\[채우기\]/.test(instruction) ? "점검 결과 보고" : "시설 점검 안내";
  if (step === 1) { await sleep(800); return call("make_hangul_document", { prompt: "공문서 하나 만들어줘", title, values: { purpose: "시설 점검 일정 안내" }, sections: SECTIONS }); }
  return answer(title === "시설 점검 안내" ? "hallym-kordoc으로 '시설 점검 안내.hwpx'를 만들어 새 탭에 열었습니다. 공식 양식 미적용 초안이며 제출 부서는 비어 있습니다." : "hallym-kordoc으로 만든 공문서를 이 빈 문서에 채웠습니다. 공식 양식 미적용 초안입니다.");
});
await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
const providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`;

// ---- the gateway ----------------------------------------------------------------------------------
const dataDir = mkdtempSync(join(tmpdir(), "wb-hwp-ai-data-"));
const project = mkdtempSync(join(tmpdir(), "wb-hwp-ai-project-"));
mkdirSync(join(dataDir, "office"));
writeFileSync(join(dataDir, "office", "ai-settings.json"), JSON.stringify({ provider: "custom", providers: { custom: { model: "fixture-model", apiKey: "fixture-only-key", baseUrl: providerUrl } } }), { mode: 0o600 });
copyFileSync(resolve("apps/host/src/channels/fixtures/강의계획서.hwpx"), join(project, "강의계획서.hwpx"));
// The executor stand-in: the app binary's --office-executor hands its page address over; it lives
// until its stdin closes (the gateway's stop) or this script kills it (the executor dies).
const executorFile = join(dataDir, "executor-urls.txt");
const fakeBin = join(dataDir, "fake-app.mjs");
writeFileSync(fakeBin, `#!${process.execPath}\nimport { appendFileSync } from "node:fs";\nif (process.argv.includes("--office-executor")) { appendFileSync(${JSON.stringify(executorFile)}, process.pid + " " + process.env.WORKBENCH_OFFICE_EXECUTOR_URL + "\\n"); process.stdin.resume(); process.stdin.on("end", () => process.exit(0)); }\n`);
chmodSync(fakeBin, 0o755);
const realBin = executorMode ? process.env.WB_CHECK_APP_BIN || null : null;
const gatewayEnv = (base: NodeJS.ProcessEnv) => {
  const out = { ...base };
  for (const [name, value] of Object.entries(JSON.parse(process.env.WB_CHECK_GATEWAY_ENV || "{}") as Record<string, string | null>)) if (value === null) delete out[name]; else out[name] = value;
  delete out.WB_CHECK_GATEWAY_ENV; delete out.WB_CHECK_APP_BIN; delete out.WB_CHECK_HOST;
  return out;
};
const gateway = spawn(process.execPath, [resolve(process.env.WB_CHECK_HOST || "apps/host/dist/host.mjs")], {
  env: gatewayEnv({ ...process.env, WORKBENCH_DATA_DIR: dataDir, WORKBENCH_WEB_DIR: resolve("apps/web/dist"), WORKBENCH_PORT: "0", WORKBENCH_EDITORS_PORT: "0", WORKBENCH_EXIT_ON_STDIN_CLOSE: "1",
    WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"), WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"), WORKBENCH_HOST_LABEL: "노트북",
    ...(executorMode ? { WORKBENCH_APP_BIN: realBin ?? fakeBin } : {}) }),
  stdio: ["pipe", "pipe", "pipe"],
});
let gatewayLog = ""; gateway.stderr.on("data", (data: Buffer) => { gatewayLog += data.toString(); });
const ready = await new Promise<{ url: string; token: string }>((done, reject) => {
  const timer = setTimeout(() => reject(new Error(`gateway not ready\n${gatewayLog.slice(-2000)}`)), 30_000);
  createInterface({ input: gateway.stdout }).on("line", (line) => { if (line.startsWith("WORKBENCH_READY ")) { clearTimeout(timer); done(JSON.parse(line.slice(16))); } });
});
const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${ready.url}${path}`, { method, headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await response.json() as T & { message?: string };
  if (!response.ok) throw new Error(`${method} ${path}: ${json.message}`);
  return json;
};
const { prefs } = await api<{ prefs: Record<string, unknown> }>("GET", "/api/snapshot");
await api("PUT", "/api/prefs", { prefs: { ...prefs, onboarding: "done", startScreen: "last", theme: "light", sidebar: true, navigator: { rail: "projects", level: "projects" } } });
const work = await api<{ id: string }>("POST", "/api/works", { title: "한글 문서 AI 검사", folderId: null, cwd: project });
await api("PATCH", `/api/works/${work.id}`, { title: "한글 문서 AI 검사" });
const artifact = await api<{ id: string }>("POST", `/api/works/${work.id}/artifacts`, { path: "강의계획서.hwpx" });

// ---- the browser ----------------------------------------------------------------------------------
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await editorFirst(context);
const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
if (args.includes("--trace")) page.on("response", (response) => { if (response.url().includes("office-skills")) void response.text().then((text) => console.log("TRACE office-skills", new Date().toISOString().slice(11, 23), response.request().postData()?.replace(/"token":"[^"]*"/, '"token":"…"').slice(0, 160), response.status(), text.slice(0, 200))).catch(() => {}); });
const executors: Page[] = [];
let executorSeen = 0;
const followExecutors = setInterval(async () => {
  if (!existsSync(executorFile)) return;
  const lines = readFileSync(executorFile, "utf8").trim().split("\n");
  for (; executorSeen < lines.length; executorSeen++) {
    const url = lines[executorSeen]!.split(" ").slice(1).join(" ");
    const executor = await context.newPage(); executors.push(executor);
    executor.on("pageerror", (error) => errors.push(`executor: ${error.message}`));
    void executor.goto(url).catch(() => {});
  }
}, 300);
const shot = async (name: string) => { const path = join(outDir, `${tag}-${name}.png`); await page.screenshot({ path }); return path; };
await page.goto(`${ready.url}/?token=${ready.token}`);
await page.waitForSelector(".topbar-left", { timeout: 30_000 });
const click = (selector: string, text?: string) => page.evaluate(([selector, text]) => {
  const found = [...document.querySelectorAll<HTMLElement>(selector!)].find((e) => !text || e.textContent?.includes(text));
  found?.click(); return Boolean(found);
}, [selector, text ?? ""] as const);
if (await page.$(".topbar-right button:has-text('작업공간 보기')")) await click(".topbar-right button", "작업공간 보기");
if (!await page.$(".sidebar")) await click('.topbar-left [aria-label="사이드바 열기"]');
await page.waitForSelector(".nav-rail [data-rail=docs]", { timeout: 15_000 });
await click(".nav-rail [data-rail=docs]");
await page.waitForSelector(`.nav-docs [data-row-id="${artifact.id}"]`, { timeout: 15_000 });
await click(`.nav-docs [data-row-id="${artifact.id}"]`);
await page.waitForSelector(".document-view .doc-header", { timeout: 15_000 });
await page.evaluate(() => { const r = [...document.querySelectorAll<HTMLElement>(".document-view .doc-header [role=radio]")].find((e) => /편집/.test(e.textContent ?? "")); if (r && r.getAttribute("aria-checked") !== "true") r.click(); });
const outerHandle = await page.waitForSelector("iframe.office-frame", { timeout: 30_000 });
let outer = (await outerHandle.contentFrame())!;
/** The editor's frame now: an executor turn's end reloads the view (office:execution-refresh). */
const ofr = async (): Promise<Frame> => {
  if (!outer.isDetached()) return outer;
  // The editor on screen (another tab's editor may stay mounted, hidden).
  const handle = await page.waitForSelector(".document-view iframe.office-frame:visible", { timeout: 30_000 });
  outer = (await handle.contentFrame())!;
  await outer.waitForSelector('.hwp-app[data-phase="ready"]', { timeout: 90_000 }).catch(() => {});
  await outer.waitForSelector(".hwp-app .ai-dock:not(.collapsed) .ai-input-box textarea", { timeout: 20_000 }).catch(() => {});
  return outer;
};
const safe = async <T>(work: (frame: Frame) => Promise<T>, fallback: T): Promise<T> => { try { return await work(await ofr()); } catch { await sleep(300); try { return await work(await ofr()); } catch { return fallback; } } };
// evaluate in the editor's frame, through a reload
const oev = <R, A = undefined>(fn: (arg: A) => R, arg?: A) => safe((frame) => frame.evaluate(fn as never, arg as never) as Promise<Awaited<R>>, undefined as unknown as Awaited<R>);
await outer.waitForSelector('.hwp-app[data-phase="ready"]', { timeout: 90_000 });
const studio = async (): Promise<Frame> => (await (await (await ofr()).waitForSelector(".hwp-editor-host iframe", { timeout: 30_000 })).contentFrame())!;
await (await studio()).waitForSelector(".document-page-canvas, canvas", { timeout: 60_000 });
await page.evaluate(() => { const toggle = document.querySelector<HTMLElement>(".document-view .doc-agent-toggle"); if (toggle?.getAttribute("aria-expanded") !== "true") toggle?.click(); });
await outer.waitForSelector(".hwp-app .ai-dock:not(.collapsed) .ai-input-box textarea", { timeout: 20_000 });
await sleep(1500);

// ---- helpers over the editor --------------------------------------------------------------------
const holdLine = () => oev(() => { const line = document.querySelector<HTMLElement>(".wb-hwp-hold"); return line && !line.hidden ? line.textContent ?? "" : ""; });
const dockStatus = () => oev(() => { const s = document.querySelector<HTMLElement>(".ai-dock .wb-hwp-ai-status"); return s && !s.hidden ? s.textContent ?? "" : ""; });
/** The dock's conversation, last lines (an executor turn's end reloads the view: its error is then in the history). */
const lastChat = () => oev(() => [...document.querySelectorAll(".ai-dock .ai-msg")].slice(-2).map((e) => e.textContent ?? "").join(" / "));
const busy = () => oev(() => Boolean(document.querySelector(".ai-dock .ai-msg-streaming") || document.documentElement.hasAttribute("data-wb-ai-hold")));
/** Scroll the studio's page view by the wheel; true when it moved (looking is never held). */
const scrolls = async () => {
  const frame = await studio();
  const before = await frame.evaluate(() => { const el = [...document.querySelectorAll<HTMLElement>("*")].find((e) => e.scrollHeight > e.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(e).overflowY)); if (!el) return null; el.setAttribute("data-wb-scroller", ""); return el.scrollTop; });
  if (before === null) return { moved: false, detail: "no scroll container" };
  const box = await (await frame.$("[data-wb-scroller]"))!.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + Math.min(300, box!.height / 2));
  await page.mouse.wheel(0, 500); await sleep(500);
  const after = await frame.evaluate(() => document.querySelector<HTMLElement>("[data-wb-scroller]")!.scrollTop);
  await page.mouse.wheel(0, -500); await sleep(200);
  return { moved: after !== before, detail: `${before} → ${after}` };
};
/** A key typed into the page while held: refused, and the line flashes. */
const typedIsHeld = async () => {
  const frame = await studio();
  return frame.evaluate(() => { const e = new KeyboardEvent("keydown", { key: "가", bubbles: true, cancelable: true }); (document.activeElement ?? document.body).dispatchEvent(e); return e.defaultPrevented; });
};
const send = async (text: string) => {
  const box = (await ofr()).locator(".hwp-app .ai-dock .ai-input-box textarea");
  await box.fill(text); await box.press("Enter");
};
const waitFor = async (what: () => Promise<boolean>, ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { if (await what()) return true; await sleep(250); } return false; };
/** The turn started (seen working), then ended with nothing held. */
const ended = async () => (await waitFor(() => oev(() => Boolean((window as any).workbenchHwpHold?.state.view().working)), 5000) || true) && waitFor(async () => {
  if (args.includes("--trace")) console.log("TRACE", new Date().toISOString().slice(11, 23), JSON.stringify(await oev(() => (window as any).workbenchHwpHold?.state.view())).slice(0, 200));
  return !await busy() && !await holdLine() && !await oev(() => Boolean((window as any).workbenchHwpHold?.state.view().working));
}, 45_000);
/** Whether the page holds typing now (without typing into the document). */
const holding = () => oev(() => Boolean((window as unknown as { workbenchHwpHold?: { held(): boolean } }).workbenchHwpHold?.held()));

// ---- 0. the chip row: hallym-kordoc on by default ------------------------------------------------
const chip = await waitFor(() => oev(() => /hallym-kordoc/.test(document.querySelector(".ai-dock .ai-input-box")?.parentElement?.textContent ?? "")), 15_000);
check("hallym-kordoc 칩이 기본으로 켜져 있음", chip);
await shot("01-chip-default");

// ---- 1. a turn that only answers: nothing held, working seen within 2 s --------------------------
if (want("answer")) {
  const t0 = Date.now();
  await send("이 문서가 무엇인지 알려 줘");
  const seen = await waitFor(async () => (await dockStatus()).includes("작업") || (await dockStatus()).includes("중"), 2000);
  check("보낸 뒤 2초 안에 작업 중 표시", seen, `${Date.now() - t0} ms · ${await dockStatus()}`);
  await sleep(1200);
  check("답만 하는 요청은 입력을 붙잡지 않음", !executorMode ? !await holdLine() && !await holding() : true, executorMode ? "실행기 경로는 보낸 때부터 입력을 붙잡음(설계)" : await holdLine());
  const scroll = await scrolls(); check("작업 중에도 문서 스크롤", scroll.moved, scroll.detail);
  await shot("02-answer-working");
  check("답 요청 끝 · 붙잡음 풀림", await ended());
  if (realBin) { const chat = await lastChat(); check("실행기의 답이 대화에 남음(실제 앱 실행기)", /강의계획서입니다/.test(chat ?? ""), chat); }
}

// ---- 1b. no display anywhere: the turn ends with the one true sentence, within its bound, nothing held ----
if (only?.includes("noscreen")) {
  const t0 = Date.now();
  await send("이 문서가 무엇인지 알려 줘");
  const said = await waitFor(async () => /화면에 연결할 수 없어/.test(`${await dockStatus()} ${await lastChat()}`), 60_000);
  const text = `${await dockStatus()} | ${await lastChat()}`;
  check("화면이 없으면 한 문장으로 끝남(기다림 한도 안)", said, `${Math.round((Date.now() - t0) / 1000)} s · ${text}`);
  check("\"같은 요청을 자동 재실행하지 않았습니다\"만 남지 않음", !/자동 재실행/.test(text), text);
  check("화면 없음 · 붙잡음 풀림", await waitFor(async () => !await busy() && !await holdLine(), 20_000));
  await shot("10-noscreen");
}

// ---- 2. a turn that edits: held from the first edit, the line and 중단, scrolling still works ------
if (want("edit")) {
  await send("[고치기] 문서 끝에 문단 하나 덧붙여 줘");
  const line = await waitFor(async () => (await holdLine()).includes(executorMode ? "문서 AI" : "고치는 중"), 20_000);
  check("편집 중 한 줄 안내와 중단", line && (await holdLine()).includes("중단"), await holdLine());
  check("편집 중 입력은 기다림(키가 거절되고 줄이 깜박임)", await typedIsHeld());
  const scroll = await scrolls(); check("편집 중에도 문서 스크롤", scroll.moved, scroll.detail);
  await shot("03-edit-held");
  check("편집 요청 끝 · 붙잡음 풀림", await ended());
  check("풀린 뒤 입력 가능", !await holding());
  await shot("04-released");
}

// ---- 4. the engine dies: an error line, the hold released -----------------------------------------
if (want("dies")) {
  await send("[엔진종료] 표를 하나 넣어 줘");
  if (executorMode) {
    await waitFor(async () => executors.length > 0, 10_000); await sleep(1500);
    const last = readFileSync(executorFile, "utf8").trim().split("\n").at(-1)!.split(" ")[0]!;
    try { process.kill(Number(last), "SIGKILL"); } catch { /* already gone */ }
  }
  if (args.includes("--debug")) for (let i = 0; i < 12; i++) { await sleep(3000); console.log("DEBUG", JSON.stringify(await oev(() => ({ view: (window as any).workbenchHwpHold?.state.view(), chat: document.querySelector(".ai-dock .ai-msg:last-child")?.textContent?.slice(0, 120) })))); }
  const released = await ended();
  const status = await dockStatus() || await lastChat();
  check("엔진이 죽으면 붙잡음이 풀리고 읽을 수 있는 줄이 남음", released && /문제|종료|실패|중단|연결/.test(status), status);
  await shot("07-engine-died");
}

// ---- 4b. the answer never comes: 응답이 없습니다 · 중단 / 계속 기다리기, then 중단 releases -------------
if (want("silent")) {
  await send("[무응답] 요약해 줘");
  // Either the page's bound (90 s, no sign of life → 응답이 없습니다 · 중단 / 계속 기다리기) or the engine's
  // own first-answer timeout comes first; both must end in a line the person can read and no hold.
  const said = await waitFor(async () => /응답이 없습니다|시간 초과/.test(await dockStatus()) || /시간 초과/.test(await lastChat() ?? ""), 120_000);
  const pageBound = (await dockStatus()).includes("응답이 없습니다");
  check("답이 오지 않으면 읽을 수 있는 줄(응답이 없습니다 또는 엔진의 시간 초과)", said, `${await dockStatus()} | ${await lastChat()}`);
  await shot("08-silent");
  if (pageBound) await oev(() => { const b = [...document.querySelectorAll<HTMLButtonElement>(".ai-dock .wb-hwp-ai-status button")].find((e) => e.textContent === "중단" && !e.hidden); b?.click(); });
  const released = await waitFor(async () => !await busy() && !await holdLine(), 20_000);
  check(pageBound ? "중단으로 끝나고 붙잡음이 풀림" : "엔진의 시간 초과로 끝나고 붙잡음이 풀림", released, await dockStatus());
  for (const res of held.splice(0)) res.end();
  await shot("09-stopped");
}

// ---- 5. (last: it opens another tab) 한글 문서 만들기: the bundled runner really runs; the made document opens in its own tab -------
if (want("make")) {
  const before = new Set(readdirSync(project));
  await send("hallym-kordoc 스킬스로 공문서 하나 만들어줘");
  const step = await waitFor(async () => /한글 문서 만드는 중|스킬|작업/.test(await dockStatus()), 5000);
  check("만드는 동안 단계가 보임", step, await dockStatus());
  await shot("05-make-working");
  check("만들기 요청 끝", await ended());
  const made = readdirSync(project).filter((name) => !before.has(name));
  check("새 HWPX가 같은 폴더에 생김(열린 문서는 그대로)", made.includes("시설 점검 안내.hwpx") && readFileSync(join(project, "시설 점검 안내.hwpx")).subarray(0, 2).toString() === "PK", made.join(", "));
  const tool = requests.filter((r) => r.scenario === "make");
  check("요청에 한글 문서 만들기 도구가 있었음(칩을 고르지 않음)", tool.length > 0 && tool.every((r) => r.tools.includes("make_hangul_document")), JSON.stringify(tool.map((r) => r.tools.length)));
  if (args.includes("--trace")) console.log("TRACE open-made", JSON.stringify(await safe((frame) => frame.evaluate(() => (window as any).workbenchOfficeAi.openMade(null).then((v: unknown) => v, (e: Error) => "ERR " + e.message)), "no frame")));
  const opened = await waitFor(() => page.evaluate(() => [...document.querySelectorAll(".group-tab, [role=tab]")].some((tab) => tab.textContent?.includes("시설 점검 안내"))), 20_000);
  check("만든 문서가 자기 탭으로 열림", opened);
  await sleep(4000);
  await shot("06-made-open");
}

// ---- 5b. (0.5.5) a general request: kind "general", the model's Markdown through the 기본 template (hangul-convert) ----
if (want("general")) {
  // Back to the lecture plan's tab (the make case opened its made document in a tab of its own).
  await page.evaluate(() => { const tab = [...document.querySelectorAll<HTMLElement>(".group-tab [role=tab], [role=tab]")].find((e) => /강의계획서/.test(e.textContent ?? "")); tab?.click(); });
  await (await ofr()).waitForSelector(".hwp-app .ai-dock:not(.collapsed) .ai-input-box textarea", { state: "visible", timeout: 30_000 }).catch(() => {});
  await sleep(1500);
  const before = new Set(readdirSync(project));
  await send("[일반] 수업 안내문 만들어줘");
  check("일반 요청 끝", await ended());
  const made = readdirSync(project).filter((name) => !before.has(name));
  check("일반 요청은 기본 서식으로 새 HWPX를 만듦(열린 문서는 그대로)", made.includes("수업 안내.hwpx") && readFileSync(join(project, "수업 안내.hwpx")).subarray(0, 2).toString() === "PK", made.join(", "));
  const output = generalOutputs.at(-1) ?? "";
  check("도구의 답: kind general, 기본 서식(compose를 거치지 않음)", /"kind":"general"/.test(output) && /"template":"기본"/.test(output) && !/familyId/.test(output), output.slice(0, 200));
  const opened = await waitFor(() => page.evaluate(() => [...document.querySelectorAll(".group-tab, [role=tab]")].some((tab) => tab.textContent?.includes("수업 안내"))), 20_000);
  check("일반 요청으로 만든 문서가 자기 탭으로 열림", opened);
  await sleep(3000);
  await shot("06b-general-open");
}

// ---- 6. (doc-default, 0.5.2's leftover 4d) 한글 문서 만들기 in an EMPTY untouched new document: it fills THIS document --
// One new revision, the tab stays (no new tab, no file beside it), the default name 「새 한글」 follows the made title.
if (want("fill")) {
  const blank = await api<{ id: string; name: string }>("POST", `/api/works/${work.id}/office-documents`, { format: "hwpx" });
  const doc = async () => (await api<{ artifacts: { id: string; name: string; revision: number }[] }>("GET", "/api/snapshot")).artifacts.find((entry) => entry.id === blank.id)!;
  const tabs = () => page.evaluate(() => document.querySelectorAll(".group-tab, [role=tab]").length);
  // The list column is laid away while a document is edited: bring it back (the top bar's key), then the documents list.
  if (!await page.$(".nav-docs")) await click('.topbar-left [aria-label="사이드바 열기"], .topbar-left [aria-label="목록 열기"]');
  await sleep(500);
  if (!await page.$(".nav-docs")) await click(".nav-rail [data-rail=docs]");
  await page.waitForSelector(`.nav-docs [data-row-id="${blank.id}"]`, { timeout: 15_000 });
  await click(`.nav-docs [data-row-id="${blank.id}"]`);
  await page.waitForFunction((name) => [...document.querySelectorAll(".document-view:not([hidden]) .doc-header")].some((h) => h.textContent?.includes(name)), blank.name.replace(/\.hwpx$/, ""), { timeout: 15_000 });
  // This document's editor (the first tab's editor stays mounted, hidden).
  const handle = await page.waitForSelector(`iframe.office-frame[title$="· ${blank.name}"]`, { state: "visible", timeout: 30_000 });
  outer = (await handle.contentFrame())!;
  await outer.waitForSelector('.hwp-app[data-phase="ready"]', { timeout: 90_000 });
  await (await studio()).waitForSelector(".document-page-canvas, canvas", { timeout: 60_000 });
  await page.evaluate(() => { const toggle = document.querySelector<HTMLElement>(".document-view:not([hidden]) .doc-agent-toggle"); if (toggle?.getAttribute("aria-expanded") !== "true") toggle?.click(); });
  await outer.waitForSelector(".hwp-app .ai-dock:not(.collapsed) .ai-input-box textarea", { timeout: 20_000 });
  await sleep(1500);
  const before = new Set(readdirSync(project)), tabsBefore = await tabs();
  await shot("11-fill-before");
  await send("[채우기] 공문서 하나 만들어줘");
  check("빈 문서 채우기 요청 끝", await ended());
  const filled = await waitFor(async () => (await doc()).revision === 2, 20_000), after = await doc();
  check("빈 새 문서가 만든 문서로 채워짐(새 판 하나)", filled, `r${after.revision}`);
  check("이름이 만든 문서의 제목을 따름(새 문서가 준 이름이었음)", after.name === "점검 결과 보고.hwpx", after.name);
  const added = readdirSync(project).filter((name) => !before.has(name));
  check("옆에 새 파일이 생기지 않음(바뀐 이름만)", added.every((name) => name === "점검 결과 보고.hwpx") && !readdirSync(project).includes(blank.name), added.join(", "));
  check("새 탭이 열리지 않음(탭은 그대로)", await tabs() === tabsBefore, `${tabsBefore} → ${await tabs()}`);
  const shown = await waitFor(async () => { try { const frame = await studio(); return await frame.evaluate(() => document.querySelectorAll("canvas").length > 0); } catch { return false; } }, 60_000);
  await sleep(3000);
  check("채운 문서가 같은 탭의 편집기에 보임", shown);
  await shot("12-fill-after");
}

clearInterval(followExecutors);
writeFileSync(join(outDir, `${tag}-results.json`), JSON.stringify({ results, requests, errors: errors.slice(0, 50) }, null, 2));
if (realBin) writeFileSync(join(outDir, `${tag}-gateway.log`), gatewayLog.slice(-20_000));
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed; page errors: ${errors.length}`);
await browser.close();
gateway.stdin.end(); provider.close();
setTimeout(() => process.exit(results.every((r) => r.ok) ? 0 : 1), 500);
