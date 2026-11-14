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
  if (process.argv.includes("--completion-only")) {
    await page.setViewportSize({ width: 1280, height: 900 });
    // Nothing a notice draws may lie over a visible control outside it (the faded-out title it replaces is not one).
    const covers = (selector: string) => page!.evaluate((selector) => {
      const notice = document.querySelector(selector)!, box = notice.getBoundingClientRect();
      const hits = (r: DOMRect) => r.width > 0 && r.height > 0 && r.left < box.right && box.left < r.right && r.top < box.bottom && box.top < r.bottom;
      return Array.from(document.querySelectorAll("button, a[href], input, textarea, select, [role=tab], [tabindex]"))
        .filter(element => !notice.contains(element) && !element.contains(notice) && getComputedStyle(element).visibility !== "hidden" && getComputedStyle(element).opacity !== "0" && hits(element.getBoundingClientRect()))
        .map(element => element.getAttribute("aria-label") || element.textContent?.trim().slice(0, 20) || element.tagName);
    }, selector);
    // Every control in the top bar's side clusters, by position: none may move while a notice comes and goes.
    // Compared with the notice present and taken out of layout, so the bell's own unread count (which a
    // completion also raises) is not mistaken for movement.
    const clusters = () => page!.evaluate(() => Array.from(document.querySelectorAll(".topbar-left > *, .topbar-right > *")).map(element => { const r = element.getBoundingClientRect(); return `${Math.round(r.left)}:${Math.round(r.width)}`; }).join(" "));
    const stillWithout = async () => {
      const shown = await clusters();
      await page!.evaluate(() => document.querySelector<HTMLElement>(".topbar > .top-notice")!.style.display = "none");
      const without = await clusters();
      await page!.evaluate(() => document.querySelector<HTMLElement>(".topbar > .top-notice")!.style.display = "");
      return shown === without ? "same" : `${without} → ${shown}`;
    };
    const textWidth = async () => Math.round((await page!.locator(".topbar > .top-notice .top-notice-text").boundingBox())?.width ?? 0);
    // On screen: the answer arrives with nothing laid over the conversation.
    const composer = page.locator('.pane[data-pane-active="true"] .composer-input');
    const send = async (text: string) => { await composer.fill(text); await page!.locator('.pane[data-pane-active="true"]').getByRole("button", { name: "보내기", exact: true }).click(); };
    const ends = async () => (await items(main.id)).filter((i: any) => i.kind === "turnEnd" && i.status === "completed").length;
    await activate("main");
    await send("완료 알림 확인");
    await until(async () => await ends() === 1);
    await new Promise(done => setTimeout(done, 1_000));
    const box = await composer.boundingBox();
    const onTop = box ? await page.evaluate(([x, y]) => Boolean(document.elementFromPoint(x!, y!)?.closest(".composer")), [box.x + box.width / 2, box.y + box.height / 2]) : false;
    check("visible completion raises no notice and nothing over the composer", await page.locator(".top-notice").count() === 0 && onTop);
    await page.screenshot({ path: join(out, "visible-completed.png") });
    // Off screen (a tab behind): announced on its tab, in the sidebar and by a capsule in the top bar that covers nothing.
    await send("길게 숨은 탭 완료 확인");
    await until(async () => (await snapshot()).sessions.find((s: any) => s.id === main.id)?.status === "running");
    await activate("second");
    const capsule = page.locator(".topbar > .top-notice[data-kind=completion][role=status]");
    await capsule.filter({ hasText: "답변 완료" }).waitFor({ timeout: 30_000 });
    await new Promise(done => setTimeout(done, 300));
    await page.screenshot({ path: join(out, "hidden-completed.png") });
    const announcement = await capsule.innerText(), during = await stillWithout(), covered = await covers(".top-notice"), readable = await textWidth();
    check("hidden completion is announced in the title's place, over no control", announcement.includes("답변 완료") && covered.length === 0, `${announcement.replace(/\s+/g, " ")} · covered ${JSON.stringify(covered)}`);
    check("its text is readable: at least 160px at 1280px with the sidebar open", readable >= 160, `${readable}px`);
    const tabDot = await page.locator('.pane[data-pane-active="true"] .group-tab[data-tab-id="main"] .badged > .new-badge').count();
    const rowDot = await page.locator(`.sidebar :is([data-row-id="${main.id}"], [data-row-id="${work.id}"]) .dot-new`).count();
    check("hidden completion marks its tab and sidebar row", tabDot === 1 && rowDot > 0, `tab ${tabDot} row ${rowDot}`);
    // Opening its tab directly (not 열기): the notice leaves at once and the badge clears.
    await activate("main");
    const gone = await capsule.count() === 0 || await capsule.waitFor({ state: "detached", timeout: 1_500 }).then(() => true, () => false);
    const cleared = await until(async () => await page!.locator('.group-tab[data-tab-id="main"] .new-badge').count() === 0, 5_000).then(() => true, () => false);
    check("looking at it withdraws the notice at once and clears the badge", gone && cleared, `notice gone ${gone} · badge cleared ${cleared}`);
    check("the side clusters do not move for a completion notice (1280px)", during === "same", during);
    // The user's own action, then an error: the same slot, over no control, no shadow, clusters still.
    const runCommand = async (label: string) => {
      await page!.keyboard.press("Control+k");
      await page!.locator(".palette").waitFor();
      await page!.locator(".palette").getByText(label, { exact: false }).first().click();
    };
    for (const [kind, role, file] of [["info", "status", "action-toast"], ["error", "alert", "error-toast"]] as const) {
      if (kind === "error") await page.evaluate(() => { const real = window.fetch; (window as any).__realFetch = real; window.fetch = () => Promise.reject(new TypeError("호스트에 연결하지 못했습니다.")); });
      await runCommand("지금 대화를 마크다운으로 복사");
      const slot = page.locator(`.topbar > .top-notice[data-kind=${kind}][role=${role}]`);
      await slot.waitFor({ timeout: 10_000 });
      await new Promise(done => setTimeout(done, 300));
      await page.screenshot({ path: join(out, `${file}.png`) });
      const hit = await covers(".top-notice"), shadow = await slot.evaluate(element => getComputedStyle(element).boxShadow), still = await stillWithout();
      check(`an ${kind} notice sits in the title's place over no control, without a shadow, clusters still`, hit.length === 0 && shadow === "none" && still === "same", `${(await slot.innerText()).replace(/\s+/g, " ")} · covered ${JSON.stringify(hit)} · shadow ${shadow} · clusters ${still}`);
      if (kind === "error") await page.evaluate(() => { window.fetch = (window as any).__realFetch; });
      await slot.getByRole("button", { name: "알림 닫기" }).click();
    }
    // Keyboard: while a notice shows, the faded title is out of the tab order and does nothing on Enter or Space.
    await runCommand("지금 대화를 마크다운으로 복사");
    const info = page.locator(".topbar > .top-notice[data-kind=info]");
    await info.waitFor({ timeout: 10_000 });
    const title = page.locator(".topbar .topbar-title");
    await page.locator(".topbar .brand").focus();
    let reached = false;
    for (let step = 0; step < 4; step++) { await page.keyboard.press("Tab"); if (await title.evaluate(element => element === document.activeElement)) reached = true; }
    await title.evaluate(element => (element as HTMLElement).focus());
    const focusable = await title.evaluate(element => element === document.activeElement);
    await page.keyboard.press("Enter"); await page.keyboard.press("Space");
    const opened = await page.locator(".topbar-title-edit").count();
    check("the faded title cannot be reached by Tab, focused or activated", !reached && !focusable && opened === 0, `tab ${reached} · focus ${focusable} · rename opened ${opened}`);
    await info.getByRole("button", { name: "알림 닫기" }).click();
    // A rename in progress is never hidden: a completion arriving meanwhile waits for it to commit.
    const finished = await ends();
    await send("길게 이름 바꾸는 동안 끝나는 답");
    await until(async () => (await snapshot()).sessions.find((s: any) => s.id === main.id)?.status === "running");
    await activate("second");
    await title.click();
    const editor = page.locator(".topbar .topbar-title-edit");
    await editor.waitFor();
    await until(async () => await ends() > finished, 30_000);
    await new Promise(done => setTimeout(done, 800));
    const editorShown = await editor.evaluate(element => element === document.activeElement && getComputedStyle(element).opacity === "1");
    const heldBack = await page.locator(".topbar > .top-notice").count() === 0;
    await editor.fill("완료 알림 · 이름 바꿈");
    await page.keyboard.press("Enter");
    const after = await page.locator(".topbar > .top-notice[data-kind=completion]").waitFor({ timeout: 5_000 }).then(() => true, () => false);
    check("a completion during a rename waits, the input stays visible and focused, and it shows after commit", editorShown && heldBack && after, `input shown ${editorShown} · held ${heldBack} · shown after commit ${after}`);
    await page.screenshot({ path: join(out, "after-rename.png") });
  } else {
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
  // Main finished behind the "other" tab: announced in the top bar.
  const announcement = await page.locator(".topbar > .top-notice").innerText().catch(() => "");
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
  check("project deletion explains document preservation", await page.getByRole("dialog", { name: /프로젝트를 삭제할까요\?$/ }).getByText("문서 파일과 작업 폴더는 그대로 보존합니다.").isVisible());
  await page.getByRole("dialog", { name: /프로젝트를 삭제할까요\?$/ }).getByRole("button", { name: "프로젝트 삭제", exact: true }).click();
  await until(async () => !(await snapshot()).works.some((w: any) => w.id === work.id));
  check("project menu deletes records, closes tabs, preserves files and other project", readFileSync(source).equals(bytes) && (await snapshot()).works.some((w: any) => w.id === other.id) && await page.locator('.group-tab[data-tab-id="doc-a"]').count() === 0);
  check("no browser exceptions or cancelled provider streams", errors.length === 0 && cancelled === 0, errors.join("; "));
  }
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
