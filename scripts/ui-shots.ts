// Drive the real UI against a real host and capture screenshots for visual review.
// Usage: node scripts/ui-shots.ts <outDir>

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Page } from "playwright-core";

const outDir = process.argv[2] ?? join(tmpdir(), "wb-shots");
mkdirSync(outDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "workbench-ui-"));

const child = spawn(process.execPath, ["apps/host/src/main.ts"], {
  env: {
    ...process.env,
    WORKBENCH_DATA_DIR: dataDir,
    WORKBENCH_WEB_DIR: "apps/web/dist",
    WORKBENCH_CODEX_APPROVAL: "untrusted",
    WORKBENCH_HOST_LABEL: "노트북",
  },
  stdio: ["ignore", "pipe", "inherit"],
});

const ready = await new Promise<{ url: string; token: string }>((resolve) => {
  createInterface({ input: child.stdout! }).on("line", (line) => {
    if (line.startsWith("WORKBENCH_READY ")) resolve(JSON.parse(line.slice(16)));
  });
});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
let shot = 0;
const capture = async (name: string) => {
  shot += 1;
  const file = join(outDir, `${String(shot).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file });
  console.log(file);
};
const waitIdle = async (p: Page) => {
  await p.waitForSelector(".dot-active", { state: "detached", timeout: 240_000 }).catch(() => undefined);
};

try {
  await page.goto(`${ready.url}/?token=${ready.token}`);
  await page.waitForSelector(".start-title");
  await page.waitForTimeout(1500);
  await capture("start");

  await page.getByRole("radio", { name: "Claude" }).click();
  await page.locator(".composer-input").fill("7주차 강의 자료의 도입부를 두 문장으로 써줘. 주제는 '질문에서 시작하는 지식 생산'.");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".turn-user");
  await page.waitForTimeout(2500);
  await capture("claude-streaming");
  await page.waitForSelector(".turn-assistant .markdown:not(.streaming)", { timeout: 240_000 });
  await waitIdle(page);
  await capture("claude-reply");

  await page.locator(".composer-right .select-button").click();
  await capture("target-menu");
  await page.getByRole("menuitem", { name: "새 Codex 세션" }).click();
  await page.waitForSelector(".session-tabs");
  await page.locator(".composer-input").fill("Run the shell command `touch codex-check.txt` and then reply done.");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".approval-card", { timeout: 240_000 });
  await capture("codex-approval");
  await page.getByRole("button", { name: /허용/ }).click();
  await waitIdle(page);
  await page.waitForTimeout(1000);
  await capture("codex-done");

  await page.getByRole("button", { name: /작업/ }).first().click();
  await page.waitForSelector(".finder-inner");
  await page.getByRole("button", { name: "폴더" }).last().click();
  await page.locator(".tree-form input").fill("강의");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  await capture("finder");
} finally {
  await browser.close();
  child.kill("SIGTERM");
}
