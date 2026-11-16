// Captures of 설정 › 정보 › 업데이트 in each state (app-update brief): a test gateway built from this worktree with a
// throwaway data folder; the update route answers FIXTURE states (page.route), so no installer is fetched.
//   node scripts/update-shots.ts <outDir>        (through ux/run-isolated.sh; needs apps/web/dist and apps/host/dist)
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium } from "playwright-core";
import type { AppUpdateStatus } from "@workbench/contracts";

const out = resolve(process.argv[2] ?? "update-shots");
mkdirSync(out, { recursive: true });
const data = mkdtempSync("/var/tmp/wb-update-shots-");
const repo = resolve(import.meta.dirname, "..");
const gateway = spawn(process.execPath, [join(repo, "apps/host/dist/host.mjs")], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, WORKBENCH_DATA_DIR: data,
  WORKBENCH_WEB_DIR: join(repo, "apps/web/dist"), WORKBENCH_HOST_LABEL: "노트북", WORKBENCH_IEUM_BOOTSTRAP: "0", WORKBENCH_PORT: "0", WORKBENCH_EDITORS_PORT: "0",
  // No outside host: the quiet check would go to a closed local port.
  WORKBENCH_UPDATE_SOURCE: "http://127.0.0.1:9/", WORKBENCH_CODEX_BIN: join(repo, "scripts/fixtures/fake-codex.mjs"), WORKBENCH_CLAUDE_BIN: join(repo, "scripts/fixtures/fake-claude.mjs") } });
const ready = await new Promise<{ url: string; token: string }>((done, fail) => {
  gateway.once("exit", code => fail(Error(`gateway exited (${code})`)));
  createInterface({ input: gateway.stdout! }).on("line", line => { if (line.startsWith("WORKBENCH_READY ")) done(JSON.parse(line.slice(16))); });
});
const prefs = await (await fetch(`${ready.url}/api/snapshot`, { headers: { authorization: `Bearer ${ready.token}` } })).json() as { prefs: Record<string, unknown> };
await fetch(`${ready.url}/api/prefs`, { method: "PUT", headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, body: JSON.stringify({ prefs: { ...prefs.prefs, onboarding: "done", theme: "light", settingsSection: "about" } }) });

const base: AppUpdateStatus = { state: "idle", installed: "0.5.2", kind: "user-folder", installable: true, available: null, progress: null, blockers: [], saved: null, message: null, autoCheck: true, lastCheckedAt: null, lastResult: null };
const next = { version: "0.5.3", published: "2026-11-20T00:00:00Z", notes: "", releaseUrl: "https://github.com/laguna821/Achmage-workbench-CLI/releases/tag/v0.5.3" };
const states: [string, Partial<AppUpdateStatus>][] = [
  ["01-latest", { state: "latest", lastCheckedAt: Date.now() }],
  ["02-available", { state: "available", available: next }],
  ["03-downloading", { state: "downloading", available: next, progress: 62 }],
  ["04-blocked", { state: "blocked", available: next, blockers: [{ kind: "task", id: "r1", label: "학기 계획서 초안 대화" }, { kind: "office", id: "v1", label: "저장하지 않은 문서 회의록.docx" }] }],
  ["05-failed", { state: "failed", available: next, message: "내려받은 파일이 게시된 것과 다릅니다. 설치하지 않았습니다." }],
  ["06-updated", { state: "idle", installed: "0.5.3", lastResult: { ok: true, message: "0.5.3으로 업데이트했습니다.", at: Date.now() } }],
  ["07-saved", { state: "saved", kind: "dmg", installable: false, available: next, saved: { path: "/Users/교수/Downloads/Achmage.Workbench_0.5.3_aarch64.dmg", instruction: "앱이 있는 폴더에 쓸 수 없습니다. 내려받은 파일을 열고 Achmage Workbench를 지금 앱이 있는 폴더로 끌어다 놓아 주세요. 대화와 문서는 그대로 남습니다." } }],
  ["08-installing", { state: "installing", available: next }],
];
const browser = await chromium.launch();
try {
  for (const [name, patch] of states) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
    await page.route("**/api/host/app-update", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...base, ...patch }) }));
    await page.goto(`${ready.url}/?token=${encodeURIComponent(ready.token)}`);
    await page.waitForSelector('[data-rail="settings"]', { timeout: 30_000 });
    await page.waitForTimeout(800);
    if (name === "02-available") await page.screenshot({ path: join(out, "00-rail-mark.png") });
    await page.click('[data-rail="settings"]');
    await page.click('.settings-nav [data-section="about"]');
    await page.waitForSelector(".update-row", { timeout: 10_000 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(out, `${name}.png`) });
    console.log(`shot ${name}`);
    await page.close();
  }
} finally {
  await browser.close();
  gateway.kill();
  await new Promise(r => setTimeout(r, 1000));
  rmSync(data, { recursive: true, force: true });
}
