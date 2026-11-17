/// <reference lib="dom" />
// Frames and a rig check of unit promised-small, fixture data only: 문서 이름 바꾸기 from the document head (the dialog,
// the result with its 되돌리기, a refused name), the editor's write lease kept across the rename; the search palette's
// excerpt without Markdown marks; the picture viewer (fitted, zoomed, next). Light at 1440×900; `--dark` for one dark set.
// Usage: node scripts/promised-shots.ts <out folder> [--dark]   (through ux/run-isolated.sh, after the web and host builds)
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Browser, type Page } from "playwright-core";
import { editorFirst } from "./fixtures/editor-first.ts";

const out = resolve(process.argv[2] ?? "promised-shots"); mkdirSync(out, { recursive: true });
const dark = process.argv.includes("--dark");
const dir = mkdtempSync(join(tmpdir(), "wb-promised-shots-"));
const notes: string[] = [];
const note = (text: string) => { notes.push(text); console.log(text); };
const wait = (ms: number) => new Promise(done => setTimeout(done, ms));
let child: ChildProcess | null = null, browser: Browser | null = null, page: Page | null = null;
let failed = 0;
const check = (ok: boolean, what: string) => { note(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failed++; };
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
  mkdirSync(work.cwd, { recursive: true });
  const write = async (name: string, text: string) => { const file = join(work.cwd, name); writeFileSync(file, text); return api(`/api/works/${work.id}/artifacts`, "POST", { path: file }); };
  const plan = await write("강의안.md", "# 3주차 강의안\n\n이번 주는 **중간고사** 대비 정리입니다. 과제는 `npm run build`로 확인하고 [강의 계획서](계획서.pdf)를 봅니다.\n\n- [ ] 출석 확인\n");
  await write("기존.md", "다른 문서\n");
  const docx = join(work.cwd, "강의 계획서.docx"); copyFileSync(resolve("scripts/fixtures/hello.docx"), docx);
  const word = await api(`/api/works/${work.id}/artifacts`, "POST", { path: docx });
  // Two pictures sent with a request (the viewer's 이전 / 다음).
  const upload = async (name: string) => {
    const r = await fetch(`${ready.url}/api/attachments`, { method: "POST", headers: { authorization: `Bearer ${ready.token}`, "content-type": "image/png", "x-file-name": encodeURIComponent(name), "x-workbench-work": work.id }, body: Buffer.concat([readFileSync(resolve("apps/web/public/workbench-icon.png")), Buffer.from(name)]) }); // distinct bytes (trailing data after IEND is ignored)
    return r.json();
  };
  const pictures = [await upload("판서 1.png"), await upload("판서 2.png")];
  await api(`/api/sessions/${main.id}/messages`, "POST", { requestId: "shots-1", text: "판서 두 장을 정리해 주세요", refs: [], create: null, mode: "auto", attachments: pictures });
  await api(`/api/works/${work.id}`, "PATCH", { activeSessionId: main.id });
  const tabs = [
    { id: "md", workId: work.id, sessionId: null, view: { kind: "document", artifactId: plan.id, proposalId: null } },
    { id: "chat", workId: work.id, sessionId: main.id, view: { kind: "work" } },
  ];
  await api("/api/layouts/global", "PUT", { expectedRevision: 0, layout: { version: 2, focus: "test-pane", panes: [{ ...tabs[0], id: "test-pane", tabs, activeTabId: "md", recentTabIds: ["md"] }] } });
  await api("/api/prefs", "PUT", { prefs: { onboarding: "done", layoutScope: "global", startScreen: "last", sidebar: true, theme: dark ? "dark" : "light" } });
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: dark ? "dark" : "light" });
  await context.addInitScript(id => localStorage.setItem("workbench.lastWork", id), work.id);
  await editorFirst(context);
  page = await context.newPage();
  page.on("pageerror", error => note(`page error: ${error.message}`));
  await page.goto(`${ready.url}/?token=${ready.token}`);
  const pane = () => page!.locator('.pane[data-pane-active="true"]');
  const shot = async (name: string) => { await wait(900); await page!.screenshot({ path: join(out, `${name}${dark ? "-dark" : ""}.png`) }); };
  await page.locator(".group-tab").filter({ hasText: "강의안.md" }).first().waitFor({ timeout: 30_000 });
  await page.locator(".group-tab").filter({ hasText: "강의안.md" }).first().locator('[role="tab"]').click();
  await pane().locator(".doc-header .doc-name").waitFor({ timeout: 30_000 });
  await wait(2_000);
  const access = async () => pane().locator("main.document-view").getAttribute("data-editor-access");
  note(`markdown tab before: name "${await pane().locator(".doc-header .doc-name").innerText()}", editor access ${await access()}`);

  // 1. 이름 바꾸기 from the head's ⋯.
  await pane().getByRole("button", { name: "문서 메뉴" }).click();
  await page.getByRole("menuitem", { name: "이름 바꾸기" }).click();
  const field = page.getByRole("textbox", { name: "이름" });
  await field.fill("3주차 강의안");
  await shot("1-rename-dialog");
  await page.getByRole("button", { name: "바꾸기" }).click();
  await page.getByRole("dialog", { name: "문서 이름 바꾸기" }).waitFor({ state: "detached", timeout: 10_000 });
  await shot("1-renamed");
  const after = (await api("/api/snapshot")).artifacts.find((entry: { id: string }) => entry.id === plan.id);
  check(after.name === "3주차 강의안.md" && existsSync(join(work.cwd, "3주차 강의안.md")) && !existsSync(join(work.cwd, "강의안.md")), `file renamed on disk and record follows (${after.path})`);
  check((await pane().locator(".doc-header .doc-name").innerText()) === "3주차 강의안.md", "the head shows the new name");
  check(await page.locator(".group-tab").filter({ hasText: "3주차 강의안" }).count() > 0, "the tab shows the new name");
  await wait(11_000); // one editor heartbeat (10 s) after the rename
  check((await access()) === "write", `the open editor keeps its write lease after the rename (data-editor-access=${await access()})`);
  // A name that exists: refused in the dialog, nothing moves.
  await pane().locator(".doc-header .doc-name").dblclick();
  await page.getByRole("textbox", { name: "이름" }).fill("기존");
  await page.getByRole("button", { name: "바꾸기" }).click();
  const refusal = page.getByRole("dialog", { name: "문서 이름 바꾸기" }).getByRole("alert");
  await refusal.waitFor({ timeout: 10_000 });
  note(`refused: "${await refusal.innerText()}"`);
  await shot("1-rename-exists");
  await page.getByRole("button", { name: "취소" }).click();
  // Undo through the API the notice's 되돌리기 uses: renaming back.
  await api(`/api/artifacts/${plan.id}/rename`, "POST", { name: "강의안" });
  check(existsSync(join(work.cwd, "강의안.md")), "renaming back restores the old name");
  // Word: the rename while its editor is open (frame of the head).
  const wordRenamed = await api(`/api/artifacts/${word.id}/rename`, "POST", { name: "최종 강의 계획서" });
  check(wordRenamed.artifact.path.endsWith("최종 강의 계획서.docx"), "docx renamed with its extension kept");

  // 2. Search excerpt without Markdown marks.
  await page.keyboard.press("Control+k");
  await page.keyboard.type("중간고사");
  await wait(1_500);
  const snippet = await page.locator(".palette-snippet").first().innerText().catch(() => "");
  note(`search excerpt: "${snippet}"`);
  if (await page.getByText("Rust 검색 실행기가 없습니다").count()) note("search: this rig has no Fast Find worker (WORKBENCH_SEARCH_WORKER_BIN); the excerpt is covered by unit tests only");
  else check(Boolean(snippet) && !/\*\*|`|\]\(/.test(snippet), "the excerpt shows no ** ` or link syntax");
  await shot("2-search-excerpt");
  await page.keyboard.press("Escape");

  // 5. Pictures: the request's thumbnails open the viewer.
  await page.locator(".group-tab").filter({ hasText: "강의 준비" }).first().locator('[role="tab"]').click();
  const thumb = page.getByRole("button", { name: "판서 1.png 크게 보기" });
  await thumb.waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => !document.querySelector('[aria-label="판서 1.png 크게 보기"]')?.hasAttribute("disabled"), undefined, { timeout: 20_000 });
  await thumb.click();
  await page.getByRole("dialog", { name: "판서 1.png" }).waitFor();
  await shot("5-viewer-fitted");
  await page.keyboard.press("+"); await page.keyboard.press("+");
  await shot("5-viewer-zoomed");
  await page.keyboard.press("0");
  await page.getByRole("button", { name: "다음 그림" }).click();
  check(await page.getByRole("dialog", { name: "판서 2.png" }).count() === 1, "다음 그림 goes to the next picture");
  await shot("5-viewer-next");
  await page.keyboard.press("Escape");
  check(await page.getByRole("dialog").count() === 0, "Esc closes the viewer");
} catch (error) {
  note(`FAILED: ${String(error)}`); failed++;
  if (page) await page.screenshot({ path: join(out, `failure${dark ? "-dark" : ""}.png`) }).catch(() => undefined);
} finally {
  process.exitCode = failed ? 1 : 0;
  await browser?.close();
  if (child && child.exitCode === null) { const exited = new Promise<void>(done => child!.once("exit", () => done())); child.kill("SIGTERM"); await exited; }
  writeFileSync(join(out, `notes${dark ? "-dark" : ""}.txt`), notes.join("\n"));
}
