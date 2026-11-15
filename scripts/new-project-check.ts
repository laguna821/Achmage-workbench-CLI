/// <reference lib="dom" />
// "새 프로젝트…" in the list's 새로 만들기 menu makes a project at once (real built UI and gateway, a
// temporary data folder; no model, no user data): it is listed, it opens, its row waits for a name.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Browser, type Page } from "playwright-core";

const out = resolve(process.argv[2]!); mkdirSync(out, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), "wb-new-project-"));
const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`); };
const until = async (what: () => Promise<boolean>, timeout = 15_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await what()) return; await new Promise(done => setTimeout(done, 80)); }
  throw Error("condition timed out");
};
let child: ChildProcess | null = null, browser: Browser | null = null, page: Page | null = null;
const errors: string[] = [];
try {
  child = spawn(process.execPath, ["apps/host/dist/host.mjs"], { env: { ...process.env,
    WORKBENCH_DATA_DIR: dir, WORKBENCH_HOST_ID: "fixture", WORKBENCH_IEUM_BOOTSTRAP: "0",
    WORKBENCH_WEB_DIR: resolve("apps/web/dist"),
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
  const works = async () => (await api("/api/snapshot")).works as { id: string; title: string }[];
  await api("/api/works", "POST", { title: "먼저 있던 프로젝트", cwd: null });
  await api("/api/prefs", "PUT", { prefs: { onboarding: "done", layoutScope: "global", sidebar: true } });
  browser = await chromium.launch(); page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${ready.url}/?token=${ready.token}`);
  // The rail's 프로젝트, the list of all projects, its 새로 만들기 key — as in the owner's screenshot.
  await page.getByRole("button", { name: "프로젝트", exact: true }).first().click();
  await page.getByRole("button", { name: /새로 만들기/ }).first().click();
  await page.getByRole("menuitem", { name: "새 프로젝트…" }).click();
  await until(async () => (await works()).length === 2);
  check("a project is made at once", true);
  const made = (await works()).find(work => work.title !== "먼저 있던 프로젝트")!;
  await until(async () => await page!.locator(`[data-tab-project="${made.id}"]`).count() > 0);
  check("it opens: its tab is on the strip", true);
  const field = page.locator('input:focus, [contenteditable="true"]:focus');
  await until(async () => await field.count() === 1);
  check("its row in the list waits for a name", true);
  await page.screenshot({ path: join(out, "1-naming.png") });
  await page.keyboard.press("Control+a"); await page.keyboard.type("가을 특강 준비"); await page.keyboard.press("Enter");
  await until(async () => (await works()).some(work => work.id === made.id && work.title === "가을 특강 준비"));
  check("the typed name is the project's name", true);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(out, "2-named.png") });
  check("the list shows it by that name", await page.getByText("가을 특강 준비").first().isVisible());
  check("no browser exceptions", errors.length === 0, errors.join("; "));
} catch (error) {
  check("new project scenario", false, String(error));
  if (page) await page.screenshot({ path: join(out, "failure.png") }).catch(() => undefined);
} finally {
  await browser?.close();
  if (child && child.exitCode === null) { const exited = new Promise<void>(done => child!.once("exit", () => done())); child.kill("SIGTERM"); await exited; }
  writeFileSync(join(out, "results.json"), JSON.stringify({ results, errors }, null, 2));
  console.log(`${results.filter(r => r.ok).length}/${results.length} passed`);
  if (results.some(r => !r.ok)) process.exitCode = 1;
}
