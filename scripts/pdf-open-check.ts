/// <reference lib="dom" />
// PDFs open in the PDF editor after the IeumOffice v0.13.0 pin (unit ieum-pin): v0.13.0 reads the file in 8 MiB slices
// (pdf:read-file-chunk) and asks the session's own decryptor about a protected file (pdf:decrypt). Real built UI and
// gateway, Chromium: a small PDF, one over 8 MiB (two slices and more), and a password-protected one (IeumOffice's
// own fixture, password of four spaces) that must ask, then open (editable since unit pdf-tools).
// Usage: node scripts/pdf-open-check.ts <out folder>   (through ux/run-isolated.sh, after the web, office and host builds)
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Browser, type FrameLocator, type Page } from "playwright-core";
import { editorFirst } from "./fixtures/editor-first.ts";

const require = createRequire(new URL("../vendor/ieumoffice/package.json", import.meta.url));
const { PDFDocument, StandardFonts } = require("pdf-lib");
const out = resolve(process.argv[2] ?? "pdf-open"); mkdirSync(out, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), "wb-pdf-open-"));
const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`); };
const until = async (what: () => Promise<boolean>, timeout = 60_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await what().catch(() => false)) return true; await new Promise(done => setTimeout(done, 200)); }
  return false;
};

async function makePdf(pages: number, padBytes = 0) {
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) doc.addPage([595, 842]).drawText(`Page ${i + 1}`, { x: 72, y: 760, size: 48, font });
  // Incompressible bytes in an object of their own: the file is large, the pages stay simple.
  if (padBytes) doc.context.register(doc.context.stream(randomBytes(padBytes)));
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

let child: ChildProcess | null = null, browser: Browser | null = null, page: Page | null = null;
const errors: string[] = [];
try {
  child = spawn(process.execPath, ["apps/host/dist/host.mjs"], { env: { ...process.env,
    WORKBENCH_DATA_DIR: dir, WORKBENCH_HOST_ID: "fixture", WORKBENCH_IEUM_BOOTSTRAP: "0", WORKBENCH_WEB_DIR: resolve("apps/web/dist"),
    WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"), WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"), WORKBENCH_VAULT_SUGGEST: "",
  }, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr!.on("data", data => writeFileSync(join(out, "host.log"), data, { flag: "a" }));
  const ready = await new Promise<{ url: string; token: string }>((done, fail) => {
    const timer = setTimeout(() => fail(Error("gateway start timeout")), 60_000);
    child!.once("exit", code => { clearTimeout(timer); fail(Error(`gateway exited: ${code}`)); });
    createInterface({ input: child!.stdout! }).on("line", line => { if (line.startsWith("WORKBENCH_READY ")) { clearTimeout(timer); done(JSON.parse(line.slice(16))); } });
  });
  const api = async (path: string, method = "GET", body?: unknown) => {
    const r = await fetch(`${ready.url}${path}`, { method, headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await r.json(); if (!r.ok) throw Error(`${path}: ${r.status} ${result.message}`); return result;
  };
  const work = await api("/api/works", "POST", { title: "PDF 열기 검사", cwd: null });
  const main = await api(`/api/works/${work.id}/sessions`, "POST", { provider: "codex", purpose: "메인 채팅" });
  const write = (name: string, bytes: Buffer) => { const file = join(work.cwd, name); writeFileSync(file, bytes); return file; };
  const small = write("작은.pdf", await makePdf(3));
  const big = write("큰.pdf", await makePdf(12, 10 * 1024 * 1024));
  const locked = join(work.cwd, "암호.pdf"); copyFileSync(resolve("vendor/ieumoffice/apps/shell/tests/fixtures/testPassword4Spaces.pdf"), locked);
  check("the large PDF is over 8 MiB (more than one slice)", statSync(big).size > 8 * 1024 * 1024, `${(statSync(big).size / 1048576).toFixed(1)} MiB`);
  const artifacts: Record<string, { id: string }> = {};
  for (const [key, path] of [["small", small], ["big", big], ["locked", locked]] as const) artifacts[key] = await api(`/api/works/${work.id}/artifacts`, "POST", { path });
  const tabs = [
    ...Object.entries(artifacts).map(([key, artifact]) => ({ id: key, workId: work.id, sessionId: null, view: { kind: "document", artifactId: artifact.id, proposalId: null } })),
    { id: "main", workId: work.id, sessionId: main.id, view: { kind: "work" } },
  ];
  await api(`/api/works/${work.id}`, "PATCH", { activeSessionId: main.id });
  await api("/api/layouts/global", "PUT", { expectedRevision: 0, layout: { version: 2, focus: "test-pane", panes: [{ ...tabs[0], id: "test-pane", tabs, activeTabId: "main", recentTabIds: ["main"] }] } });
  await api("/api/prefs", "PUT", { prefs: { onboarding: "done", layoutScope: "global", startScreen: "last", sidebar: false } });
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(id => localStorage.setItem("workbench.lastWork", id), work.id);
  await editorFirst(context);
  page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${ready.url}/?token=${ready.token}`);
  const activate = async (id: string) => {
    await page!.locator(`.pane[data-pane-active="true"] .group-tab[data-tab-id="${id}"] [role="tab"]`).click();
    await page!.locator(`.pane[data-pane-active="true"][data-tab="${id}"]`).waitFor();
  };
  const frame = (): FrameLocator => page!.frameLocator('.pane[data-pane-active="true"] iframe.office-frame, .editor-pool iframe.office-frame[data-pool-shown="true"][data-pane-active="true"]');
  const pageShown = () => frame().locator('.pdf-page[data-page="0"] canvas').first().isVisible();
  const total = (n: number) => frame().locator("body").evaluate((body, count) => (body as HTMLElement).innerText.includes(`전체 ${count}쪽`), n);

  for (const [key, pages] of [["small", 3], ["big", 12]] as const) {
    const started = Date.now();
    await activate(key);
    const shown = await until(pageShown, 90_000);
    check(`${key}: the first page is drawn`, shown, `${Date.now() - started} ms`);
    check(`${key}: all ${pages} pages are counted`, await until(() => total(pages), 20_000));
    await page.screenshot({ path: join(out, `${key}.png`) });
  }
  await activate("locked");
  const asked = await until(() => frame().locator('.pdf-pwd-dialog input[type="password"]').isVisible(), 60_000);
  check("locked: the password is asked for", asked);
  await page.screenshot({ path: join(out, "locked-asks.png") });
  if (asked) {
    await frame().locator('.pdf-pwd-dialog input[type="password"]').fill("    ");
    await frame().locator(".pdf-pwd-dialog .primary").click();
    check("locked: it opens after the password", await until(pageShown, 60_000));
    // Since unit pdf-tools: v0.13.0's own decryptor (pdf:decrypt) is answered by the gateway, so the session that knows
    // the password edits the file; saves keep its protection (scripts/pdf-tools-check.ts saves one).
    check("locked: editable after the password (not read-only)", await until(() => frame().locator("body").evaluate((body) => !/(보기|읽기) 전용/.test((body as HTMLElement).innerText)), 15_000));
    await page.screenshot({ path: join(out, "locked-open.png") });
  }
} catch (error) {
  check("rig ran to the end", false, error instanceof Error ? error.stack : String(error));
} finally {
  await browser?.close().catch(() => {});
  child?.kill();
}
writeFileSync(join(out, "results.json"), JSON.stringify({ results, errors }, null, 1));
console.log(`${results.filter(r => r.ok).length}/${results.length} passed; page errors: ${errors.length}`);
for (const error of errors) console.log(`page error: ${error}`);
process.exit(results.every(r => r.ok) ? 0 : 1);
