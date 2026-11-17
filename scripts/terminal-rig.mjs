// Terminal rig (0.5.3 G2/G4): the built gateway (apps/host/dist) and window (apps/web/dist) of this checkout, headless
// Chromium (NOT the real WebKitGTK window), fixture data in a temp folder. Opens COUNT terminals with a stand-in shell
// command that writes 3,000 lines each, shows each tab once, leaves them hidden, shows three again (checks that their
// screen came back), closes all; records gateway RSS (+ its workers and shells), window RSS and JS heap, mounted
// terminal views and canvases, and the database size, after each step. Pattern: ux/perf/heavy/heavy-scene.mjs.
// Usage (from the checkout, through ux/run-isolated.sh): node scripts/terminal-rig.mjs <out.json> [count=40]
// RIG_PTY_BIN: the PTY worker (the desktop binary, run only as `--pty-worker`); default: the stand-in
// scripts/fixtures/fake-pty-worker.mjs (pipes, no PTY).
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

const HERE = resolve(process.cwd());
const { chromium } = await import(join(HERE, "node_modules/playwright-core/index.mjs"));
const outFile = resolve(process.argv[2]); mkdirSync(dirname(outFile), { recursive: true });
const COUNT = Number(process.argv[3] ?? 40), LINES = 3000, SLEEP_WAIT_MS = Number(process.env.RIG_SLEEP_WAIT_MS ?? 13_000);
const dir = mkdtempSync(join(tmpdir(), "wb-term-rig-"));
const pty = process.env.RIG_PTY_BIN || join(HERE, "scripts/fixtures/fake-pty-worker.mjs");
const pause = ms => new Promise(done => setTimeout(done, ms));
const until = async (what, timeout = 30_000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await what()) return true; await pause(100); } throw Error("condition timed out"); };
const result = { rig: "headless Chromium + built gateway (not WebKitGTK)", checkout: HERE, ptyWorker: pty.includes("fake-pty-worker") ? "stand-in (pipes)" : "desktop binary --pty-worker", count: COUNT, linesPerTerminal: LINES, steps: [], refused: [], restored: [], notes: [] };
const save = () => writeFileSync(outFile, JSON.stringify(result, null, 2));

function procTable() {
  const rows = new Map();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const status = readFileSync(`/proc/${entry}/status`, "utf8");
      rows.set(Number(entry), { pid: Number(entry), ppid: Number(/^PPid:\s+(\d+)/m.exec(status)?.[1] ?? 0), rssKb: Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0) });
    } catch { /* gone */ }
  }
  return rows;
}
function tree(root, rows) {
  const under = pid => { for (let at = pid, hops = 0; at > 1 && hops < 50; at = rows.get(at)?.ppid ?? 0, hops++) if (at === root) return true; return false; };
  return [...rows.values()].filter(row => under(row.pid));
}
const mb = kb => Math.round(kb / 1024);
/** Proportional set size: shared library pages divided among the processes that map them (RSS counts them in each). */
const pssKb = pid => { try { return Number(/^Pss:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, "utf8"))?.[1] ?? 0); } catch { return 0; } };
const dbSize = () => { let total = 0; for (const name of ["state.sqlite", "state.sqlite-wal"]) { try { total += statSync(join(dir, "data", name)).size; } catch { /* none */ } } return Math.round(total / 1024 / 102.4) / 10; };

let child = null, browser = null, ready = null, inspectorUrl = null;
const env = { ...process.env, WORKBENCH_DATA_DIR: join(dir, "data"), WORKBENCH_HOST_ID: "fixture", WORKBENCH_IEUM_BOOTSTRAP: "0", WORKBENCH_WEB_DIR: join(HERE, "apps/web/dist"),
  WORKBENCH_PTY_BIN: pty, WORKBENCH_CODEX_BIN: join(HERE, "scripts/fixtures/fake-codex.mjs"), WORKBENCH_CLAUDE_BIN: join(HERE, "scripts/fixtures/fake-claude.mjs"), WORKBENCH_VAULT_SUGGEST: "" };
async function startGateway() {
  child = spawn(process.execPath, ["--inspect=127.0.0.1:0", join(HERE, "apps/host/dist/host.mjs")], { env, stdio: ["ignore", "pipe", "pipe"], cwd: HERE });
  child.stderr.on("data", data => { const m = /ws:\/\/[^\s]+/.exec(String(data)); if (m && !inspectorUrl) inspectorUrl = m[0]; });
  return await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(Error("gateway start timeout")), 60_000);
    child.once("exit", code => { clearTimeout(timer); fail(Error(`gateway exited: ${code}`)); });
    createInterface({ input: child.stdout }).on("line", line => { if (line.startsWith("WORKBENCH_READY ")) { clearTimeout(timer); done(JSON.parse(line.slice(16))); } });
  });
}
async function gwHeapMb() {
  if (!inspectorUrl) return null;
  const ws = new WebSocket(inspectorUrl);
  await new Promise((done, fail) => { ws.onopen = done; ws.onerror = fail; });
  const call = (id, method, params) => new Promise(done => { const on = ev => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener("message", on); done(m.result); } }; ws.addEventListener("message", on); ws.send(JSON.stringify({ id, method, params })); });
  await call(1, "HeapProfiler.collectGarbage", {});
  const r = await call(2, "Runtime.evaluate", { expression: "process.memoryUsage().heapUsed", returnByValue: true });
  ws.close();
  return Math.round(r.result.value / 1048576);
}
const api = async (path, method = "GET", body) => {
  const r = await fetch(`${ready.url}${path}`, { method, headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await r.json(); if (!r.ok) throw Object.assign(Error(`${path}: ${r.status} ${value.message}`), { status: r.status, body: value }); return value;
};

try {
  ready = await startGateway();
  const cwd = join(dir, "project"); mkdirSync(cwd);
  const work = await api("/api/works", "POST", { title: "터미널 40개", cwd });
  const workspaceId = work.defaultWorkspaceId;
  await api("/api/prefs", "PUT", { prefs: { onboarding: "done", layoutScope: "global", sidebar: true } });
  browser = await chromium.launch({ args: ["--js-flags=--expose-gc"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  const browserPid = Number(execFileSync("pgrep", ["-P", String(process.pid), "-f", "headless"]).toString().trim().split("\n")[0]);
  const measure = async (label, extra = {}) => {
    await pause(1500);
    await cdp.send("HeapProfiler.collectGarbage"); await pause(400);
    const m = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(x => [x.name, x.value]));
    const dom = await page.evaluate(() => ({ terminalViews: document.querySelectorAll("section.terminal-view").length, xterms: document.querySelectorAll(".xterm").length, canvases: document.querySelectorAll(".xterm canvas").length, asleep: document.querySelectorAll('section.terminal-view[data-terminal-asleep="true"]').length }));
    const rows = procTable(), gw = rows.get(child.pid), kids = tree(child.pid, rows).filter(row => row.pid !== child.pid), br = tree(browserPid, rows);
    const row = { step: label, gatewayRssMb: mb(gw?.rssKb ?? 0), gatewayHeapMb: await gwHeapMb(), workersAndShells: kids.length, workersAndShellsRssMb: mb(kids.reduce((s, r) => s + r.rssKb, 0)), workersAndShellsPssMb: mb(kids.reduce((s, r) => s + pssKb(r.pid), 0)),
      windowRssMb: mb(br.reduce((s, r) => s + r.rssKb, 0)), windowHeapMb: Math.round(m.JSHeapUsedSize / 1048576 * 10) / 10, dbMb: dbSize(), ...dom, ...extra };
    result.steps.push(row); save(); console.log(JSON.stringify(row)); return row;
  };
  await page.goto(`${ready.url}/?token=${ready.token}`);
  await until(async () => await page.locator("section.pane").count() > 0, 60_000);
  await measure("window open, no terminal");

  // ── open COUNT terminals with the stand-in shell command ──
  const opened = [];
  for (let n = 0; n < COUNT; n++) {
    const script = `i=0; while [ $i -lt ${LINES} ]; do echo "터미널 ${n} 줄 $i — 빌드 로그처럼 긴 출력 한 줄입니다 abcdefghijklmnopqrstuvwxyz"; i=$((i+1)); done; echo "END-${n}"; exec cat`;
    try { opened.push(await api(`/api/workspaces/${workspaceId}/terminals`, "POST", { requestId: `rig-${n}`, label: `터미널 ${n}`, shell: "/bin/sh", args: ["-c", script] })); }
    catch (error) { result.refused.push({ n, status: error.status, message: error.body?.message ?? String(error) }); }
  }
  save();
  await until(async () => (await Promise.all(opened.map(t => api(`/api/terminals/${t.id}/replay`)))).every(r => r.terminal.outputEnd > LINES * 60), 120_000).catch(() => result.notes.push("not every terminal finished its output in 120 s"));
  await measure(`${opened.length} terminals running (gateway only, no tab yet)`);

  // ── each one shown once in the window (as opening them from the list does), then all hidden but the last ──
  const tabs = opened.map(t => ({ id: `tab-${t.id}`, view: { kind: "terminal", terminalId: t.id, workspaceId, label: t.label }, workId: work.id, sessionId: null }));
  const layout = await api("/api/layouts/global");
  await api("/api/layouts/global", "PUT", { expectedRevision: layout.record?.revision ?? 0, layout: { version: 2, focus: "a", panes: [{ ...tabs[0], id: "a", tabs, activeTabId: tabs[0].id, recentTabIds: [tabs[0].id] }] } });
  await page.reload();
  await until(async () => await page.locator("section.pane").count() > 0, 60_000);
  // Tabs past the strip's width sit in its ⌄ list (data-overflowed); a click on the tab's own button activates it either way.
  const strip = { nth: (n) => ({ click: () => page.evaluate((id) => { document.querySelector(`[data-tab-id="${CSS.escape(id)}"] [role="tab"]`)?.click(); }, tabs[n].id) }) };
  const t0 = Date.now();
  for (let n = 0; n < tabs.length; n++) {
    await strip.nth(n).click();
    await until(async () => await page.locator(`section.terminal-view[data-terminal-id="${opened[n].id}"][data-terminal-ready="true"]`).count() > 0, 30_000).catch(() => result.notes.push(`tab ${n} did not report ready`));
  }
  result.showEachOnceMs = Date.now() - t0;
  await measure(`each of the ${tabs.length} tabs shown once, the last one in front`);
  await pause(SLEEP_WAIT_MS);
  await measure(`${SLEEP_WAIT_MS / 1000} s later (hidden ones may have released their views)`);

  // ── three shown again: their screen must come back ──
  for (const n of [0, Math.floor(tabs.length / 2), tabs.length - 2].filter(n => n >= 0 && n < tabs.length)) {
    const t1 = Date.now();
    await strip.nth(n).click();
    const view = page.locator(`section.terminal-view[data-terminal-id="${opened[n].id}"]`);
    const screen = () => page.evaluate((id) => { const root = document.querySelector(`section.terminal-view[data-terminal-id="${id}"]`); return root?.querySelector(".xterm-accessibility-tree")?.textContent || root?.querySelector(".xterm-rows")?.textContent || ""; }, opened[n].id);
    await until(async () => (await view.getAttribute("data-terminal-ready")) === "true" && (await screen()).includes(`END-${n}`), 15_000).catch(() => undefined);
    const text = await screen();
    result.restored.push({ n, ms: Date.now() - t1, endLineOnScreen: text.includes(`END-${n}`), lastLineOnScreen: text.includes(`터미널 ${n} 줄 ${LINES - 1} `) });
  }
  await measure("three tabs shown again");

  // ── close every terminal ──
  for (const t of opened) await api(`/api/terminals/${t.id}`, "DELETE").catch(error => result.notes.push(`close ${t.id}: ${error.message}`));
  await pause(2000);
  await measure("all terminals closed");
  result.pageErrors = errors.slice(0, 20);
  save();
} finally {
  await browser?.close().catch(() => undefined);
  if (child && child.exitCode === null) { const exited = new Promise(done => child.once("exit", done)); child.kill("SIGTERM"); await Promise.race([exited, pause(15_000)]); }
  result.dbMbAfterGatewayStopped = dbSize(); save();
  rmSync(dir, { recursive: true, force: true });
}
