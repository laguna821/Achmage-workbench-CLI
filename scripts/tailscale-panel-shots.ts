/// <reference lib="dom" />
// Frames of 설정 › 휴대폰과 다른 기기 › 테일스케일로 연결, one per state, light and dark, from a real gateway
// driving the STAND-IN `tailscale` CLI (scripts/fixtures/fake-tailscale.mjs). Nothing outside this
// machine is contacted; the gateway gets temp folders for its data and both engines' configuration.
// Usage: node scripts/tailscale-panel-shots.ts [outDir] [--width=1000 --height=800]
// Build first (web + host). Run through ux/run-isolated.sh.

import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Page } from "playwright-core";

const args = process.argv.slice(2);
const outDir = resolve(args.find((arg) => !arg.startsWith("--")) ?? join(tmpdir(), "wb-tailscale-panel"));
const option = (name: string) => args.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
const width = Number(option("width") ?? 1000), height = Number(option("height") ?? 800);
mkdirSync(outDir, { recursive: true });
const temp = mkdtempSync(join(tmpdir(), "workbench-tailscale-shots-"));
for (const dir of ["data", "claude", "codex", "work"]) mkdirSync(join(temp, dir));
const FAKE = resolve("scripts/fixtures/fake-tailscale.mjs");
chmodSync(FAKE, 0o755);
const link = join(temp, "tailscale"), stateFile = join(temp, "state.json");
const NAME = "desk.tail1a2b.ts.net";
const base = { daemon: true, backend: "Running", dnsName: NAME + ".", hostName: "desk", tailnet: "kim@example.com", magicDNS: true, certDomains: [NAME], serve: {} as Record<string, unknown> };
const stand = (patch: Record<string, unknown> = {}) => writeFileSync(stateFile, JSON.stringify({ ...base, ...patch }, null, 2));
const installed = (yes: boolean) => { if (yes && !existsSync(link)) symlinkSync(FAKE, link); if (!yes && existsSync(link)) unlinkSync(link); };

let child: ChildProcess | null = null;
const ready = await new Promise<{ url: string; token: string }>((done, reject) => {
  stand(); installed(true);
  child = spawn(process.execPath, [process.env.TS_SHOTS_HOST_ENTRY ?? "apps/host/dist/host.mjs"], {
    env: { ...process.env, WORKBENCH_DATA_DIR: join(temp, "data"), WORKBENCH_WEB_DIR: process.env.TS_SHOTS_WEB_DIR ?? "apps/web/dist",
      WORKBENCH_HOST_ID: "tailscale-shots", WORKBENCH_HOST_LABEL: "연구실 PC",
      WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"), WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"),
      WORKBENCH_SECRET_BIN: resolve("scripts/fixtures/fake-secret.mjs"), CLAUDE_CONFIG_DIR: join(temp, "claude"), CODEX_HOME: join(temp, "codex"),
      WORKBENCH_TAILSCALE_BIN: link, FAKE_TAILSCALE_STATE: stateFile },
    stdio: ["ignore", "pipe", "inherit"],
  });
  child.once("exit", (code) => reject(new Error(`gateway exited (${code})`)));
  createInterface({ input: child.stdout! }).on("line", (line) => { if (line.startsWith("WORKBENCH_READY ")) done(JSON.parse(line.slice(16))); });
});
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${ready.url}${path}`, { method, headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return response.json() as Promise<Record<string, unknown>>;
};
await api("POST", "/api/works", { title: "강의 자료", folderId: null, cwd: join(temp, "work") });

type Scene = { name: string; prepare(page: Page): Promise<void> };
const recheck = async (page: Page) => {
  await page.locator(".tailscale-panel button", { hasText: /다시 확인/ }).first().click();
  await page.waitForFunction(() => !document.querySelector(".tailscale-panel [aria-busy=true]"));
  await page.waitForTimeout(250);
};
const taken = { TCP: { 443: { HTTPS: true } }, Web: { [NAME + ":443"]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } } };
const scenes: Scene[] = [
  { name: "1-missing", prepare: async (page) => { installed(false); await recheck(page); } },
  { name: "2-stopped", prepare: async (page) => { installed(true); stand({ daemon: false }); await recheck(page); } },
  { name: "3-needs-login", prepare: async (page) => { stand({ backend: "NeedsLogin" }); await recheck(page); } },
  { name: "4-no-magicdns", prepare: async (page) => { stand({ magicDNS: false }); await recheck(page); } },
  { name: "5-no-https", prepare: async (page) => { stand({ certDomains: [] }); await recheck(page); } },
  { name: "6-taken", prepare: async (page) => { stand({ serve: taken }); await recheck(page); } },
  { name: "7-funnel", prepare: async (page) => { stand({ serve: { ...taken, Web: { [NAME + ":443"]: { Handlers: { "/": { Proxy: "http://127.0.0.1:1" } } } }, AllowFunnel: { [NAME + ":443"]: true } } }); await recheck(page); } },
  { name: "8-failed", prepare: async (page) => { stand({ failServe: "access denied: run `sudo tailscale set --operator=$USER` (stand-in)" }); await recheck(page); await page.locator(".tailscale-panel").getByRole("button", { name: "켜기", exact: true }).click(); await page.waitForSelector(".tailscale-panel [role=alert]"); } },
  { name: "9-ready", prepare: async (page) => { stand(); await recheck(page); } },
  { name: "10-on", prepare: async (page) => { await page.locator(".tailscale-panel").getByRole("button", { name: "켜기", exact: true }).click(); await page.waitForSelector(".tailscale-panel[data-state=on]"); await page.locator(".tailscale-panel").getByRole("button", { name: "휴대폰으로 찍을 QR 만들기" }).click(); await page.waitForSelector(".tailscale-panel .host-connection-qr"); } },
  { name: "11-road-gone", prepare: async (page) => { const serve = JSON.parse(readFileSync(stateFile, "utf8")).serve; stand({ backend: "Stopped", serve }); await recheck(page); } },
];

const browser = await chromium.launch();
const shotsTaken: string[] = [];
try {
  for (const theme of ["light", "dark"] as const) {
    await api("PUT", "/api/prefs", { prefs: { onboarding: "done", startScreen: "last", theme } });
    // Each theme starts from the beginning: remote access off, Serve free.
    const state = await api("GET", "/api/devices/tailscale");
    if (state.state === "on" || state.ours) { stand(); await api("POST", "/api/devices/tailscale/off"); }
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.goto(`${ready.url}/?token=${ready.token}`);
    await page.waitForSelector(".shell, .app-shell, main", { timeout: 20_000 });
    await page.waitForTimeout(800);
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", ctrlKey: true, bubbles: true, cancelable: true })));
    await page.waitForSelector(".settings-dialog[open]");
    await page.click(".settings-nav [data-section=devices]");
    await page.waitForSelector(".settings-dialog[open] .tailscale-panel");
    for (const scene of scenes) {
      await scene.prepare(page);
      const panel = page.locator(".tailscale-panel");
      await panel.scrollIntoViewIfNeeded();
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      const file = join(outDir, `${theme}-${scene.name}.png`);
      await panel.screenshot({ path: file });
      shotsTaken.push(file);
      if (scene.name === "9-ready" || scene.name === "10-on") await page.screenshot({ path: join(outDir, `${theme}-${scene.name}-settings-${width}.png`) });
    }
    await page.close();
  }
} finally {
  await browser.close();
  await new Promise<void>((done) => { if (!child || child.exitCode !== null) return done(); child.once("exit", () => done()); child.kill("SIGTERM"); });
  rmSync(temp, { recursive: true, force: true });
}
console.log(`${shotsTaken.length} frames → ${outDir}`);
