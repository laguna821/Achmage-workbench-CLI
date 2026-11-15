/// <reference lib="dom" />
// 메모리 표시 (0.5.1): frames of the window's bottom-right corner — light and dark, with and without the
// usage line — and the numbers `GET /api/memory` answers beside what ps and smaps_rollup say for the same
// processes. A test gateway on a fresh data folder with the repository's stand-in engines; the "window"
// is this script's headless browser (a copy of its program under this run's folder), which the gateway
// finds as it finds the app: by its program's path (WORKBENCH_APP_BIN) and parent chains.
//
// Usage (from the repository, through ux/run-isolated.sh): node scripts/memline-shots.ts <outDir>
//   Build the web UI and the host bundle first (apps/web/dist, apps/host/dist/host.mjs).

import { execFileSync, spawn } from "node:child_process";
import { constants, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium } from "playwright-core";
import type { AppMemory } from "@workbench/contracts";

const outDir = resolve(process.argv[2] ?? join(tmpdir(), "wb-memline-shots"));
mkdirSync(outDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "workbench-memline-"));

const children = () => execFileSync("ps", ["-o", "pid=", "--ppid", String(process.pid)], { encoding: "utf8" }).split("\n").map((line) => Number(line.trim())).filter(Boolean);
const programOf = (pid: number) => { try { return readlinkSync(`/proc/${pid}/exe`); } catch { return ""; } };
async function launch(executablePath?: string) {
  const before = new Set(children());
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const pid = children().find((id) => !before.has(id) && /chrom|headless/i.test(programOf(id)));
  if (!pid) throw new Error("the browser's process was not found");
  return { browser, pid, program: programOf(pid) };
}
// The "app": the browser's program under a folder of this run (a copy of the program, links to what sits
// beside it), so that no other browser on this machine — another capture running now — has its path.
const probe = await launch();
await probe.browser.close();
const programDir = join(dataDir, "window");
mkdirSync(programDir);
for (const entry of readdirSync(dirname(probe.program))) {
  if (entry === basename(probe.program)) copyFileSync(probe.program, join(programDir, entry), constants.COPYFILE_FICLONE);
  else symlinkSync(join(dirname(probe.program), entry), join(programDir, entry));
}
const { browser, pid: browserPid, program: browserBin } = await launch(join(programDir, basename(probe.program)));
if (dirname(browserBin) !== programDir) throw new Error(`the browser runs from ${browserBin}`);

const child = spawn(process.execPath, [process.env.DESIGN_SHOTS_HOST_ENTRY ?? "apps/host/dist/host.mjs"], {
  env: {
    ...process.env,
    WORKBENCH_DATA_DIR: dataDir,
    WORKBENCH_WEB_DIR: "apps/web/dist",
    WORKBENCH_HOST_LABEL: "노트북",
    WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"),
    WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"),
    WORKBENCH_SECRET_BIN: resolve("scripts/fixtures/fake-secret.mjs"),
    WORKBENCH_APP_BIN: browserBin,
  },
  stdio: ["ignore", "pipe", "inherit"],
});
const ready = await new Promise<{ url: string; token: string }>((done, reject) => {
  child.once("error", reject);
  child.once("exit", (code) => reject(new Error(`gateway exited before readiness (${code})`)));
  createInterface({ input: child.stdout! }).on("line", (line) => { if (line.startsWith("WORKBENCH_READY ")) done(JSON.parse(line.slice(16))); });
});
console.log(`gateway pid ${child.pid}, browser pid ${browserPid}`);
const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${ready.url}${path}`, { method, headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return (await response.json()) as T;
};
const setPrefs = async (change: Record<string, unknown>) => {
  const prefs = (await api<{ prefs: Record<string, unknown> }>("GET", "/api/snapshot")).prefs;
  await api("PUT", "/api/prefs", { prefs: { ...prefs, onboarding: "done", startScreen: "last", sidebar: true, ...change } });
};

/** What ps and smaps_rollup say for a process and everything under it (KiB): the same processes the gateway sums. */
function measured(root: number, without: ReadonlySet<number> = new Set()) {
  const table = execFileSync("ps", ["-eo", "pid=,ppid=,rss="], { encoding: "utf8" }).split("\n").map((line) => line.trim().split(/\s+/).map(Number)).filter((row) => row.length === 3);
  const pids: number[] = [];
  const queue = [root];
  while (queue.length) {
    const pid = queue.pop()!;
    if (without.has(pid) || pids.includes(pid)) continue;
    pids.push(pid);
    queue.push(...table.filter((row) => row[1] === pid).map((row) => row[0]!));
  }
  let rssKb = 0, pssKb = 0;
  for (const pid of pids) {
    rssKb += table.find((row) => row[0] === pid)?.[2] ?? 0;
    try { pssKb += Number(/^Pss:\s+(\d+) kB/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, "utf8"))?.[1] ?? 0); } catch { /* gone, or not readable */ }
  }
  return { pids, rssKb, pssKb };
}

const results: Record<string, unknown> = {};
let code = 1;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const corner = { x: 1440 - 520, y: 900 - 240, width: 520, height: 240 };
  for (const theme of ["light", "dark"] as const) {
    for (const usagePlace of ["bottom", "list"] as const) {
      await setPrefs({ theme, usagePlace, memoryShown: true });
      await page.goto(`${ready.url}/?token=${ready.token}`);
      await page.waitForSelector(".memory-readout-text", { timeout: 30_000 });
      await page.mouse.move(400, 300);
      await page.waitForTimeout(600);
      const name = `${theme}-${usagePlace === "bottom" ? "with-usage-line" : "memory-only"}`;
      await page.screenshot({ path: join(outDir, `${name}-window.png`) });
      await page.screenshot({ path: join(outDir, `${name}-corner.png`), clip: corner });
      await page.hover(".memory-readout-text");
      await page.waitForSelector(".memory-pop");
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(outDir, `${name}-corner-hover.png`), clip: corner });
      results[name] = { line: await page.locator(".usage-line").evaluate((line) => ({ text: line.textContent, height: line.getBoundingClientRect().height, lines: document.querySelectorAll(".usage-line").length })),
        popover: await page.locator(".memory-pop").innerText() };
    }
  }

  // The numbers: the gateway's answer, then ps / smaps_rollup for the same processes, read right after it.
  // (The gateway keeps an answer 30 s: wait it out so both are read within the same second.)
  await page.waitForTimeout(31_000);
  const answer = await api<AppMemory>("GET", "/api/memory");
  const gatewayTree = measured(child.pid!);
  const gatewayOnly = measured(child.pid!, new Set(gatewayTree.pids.filter((pid) => pid !== child.pid)));
  const windowTree = measured(browserPid);
  const kb = (bytes: number) => Math.round(bytes / 1024);
  results.memory = {
    api: answer.known ? { measure: answer.measure, totalKb: kb(answer.totalBytes), windowKb: kb(answer.windowBytes), toolsKb: kb(answer.toolsBytes), gatewayKb: kb(answer.gatewayBytes) } : answer,
    system: {
      window: { processes: windowTree.pids.length, pssKb: windowTree.pssKb, rssKb: windowTree.rssKb },
      tools: { processes: gatewayTree.pids.length - 1, pssKb: gatewayTree.pssKb - gatewayOnly.pssKb, rssKb: gatewayTree.rssKb - gatewayOnly.rssKb },
      gateway: { processes: 1, pssKb: gatewayOnly.pssKb, rssKb: gatewayOnly.rssKb },
      totalPssKb: windowTree.pssKb + gatewayTree.pssKb, totalRssKb: windowTree.rssKb + gatewayTree.rssKb,
    },
    readout: await page.locator(".memory-readout-text").innerText(),
  };

  // 끄기: the readout goes; with the usage limits elsewhere the line goes with it.
  await setPrefs({ theme: "light", usagePlace: "list", memoryShown: false });
  await page.goto(`${ready.url}/?token=${ready.token}`);
  await page.waitForSelector(".side-foot, .sidebar", { timeout: 30_000 });
  await page.waitForTimeout(1500);
  results.off = { readouts: await page.locator(".memory-readout").count(), lines: await page.locator(".usage-line").count() };
  await page.screenshot({ path: join(outDir, "light-off-corner.png"), clip: corner });

  // 설정 › 화면 › 메모리 표시.
  await setPrefs({ theme: "light", usagePlace: "bottom", memoryShown: true });
  await page.goto(`${ready.url}/?token=${ready.token}`);
  await page.waitForSelector(".memory-readout-text", { timeout: 30_000 });
  await page.keyboard.press("Control+,");
  await page.locator(".settings-nav [data-section=screen]").click();
  const row = page.getByRole("radiogroup", { name: "메모리 표시" });
  await row.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(outDir, "setting-screen.png") });
  results.setting = { options: await row.getByRole("radio").allInnerTexts(), chosen: await row.locator("[aria-checked=true]").innerText() };

  writeFileSync(join(outDir, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results, null, 2));
  code = 0;
} finally {
  await browser.close();
  child.kill();
  await new Promise((done) => child.once("exit", done));
  rmSync(dataDir, { recursive: true, force: true });
}
process.exit(code);
