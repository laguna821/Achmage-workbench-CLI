// sec-vault round 2, review I3 in the real UI: when the vault refuses the gateway, the person is told —
// a standing row under the top bar ("비밀 보관함을 열지 못했습니다 …" + what to do + 다시 시도), the
// messenger shown not connected with the same reason — and 다시 시도 clears it once the cause is gone.
// The stand-in helper (scripts/fixtures/fake-secret.mjs) fails while FAKE_SECRET_OFF exists, as a locked
// keyring does. Headless Chromium from the Playwright cache; loopback only; made-up values only.
// Usage (through ux/run-isolated.sh): node scripts/sec-vault-notice-check.ts [web dir, default apps/web/dist]
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium } from "playwright-core";
import { FAKE_TOKEN, FakeTelegram } from "../apps/host/src/channels/fake-telegram.ts";

const webDir = resolve(process.argv[2] ?? "apps/web/dist");
const shell = join(process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), ".cache", "ms-playwright"), "chromium_headless_shell-1248", "chrome-headless-shell-linux64", "chrome-headless-shell");
if (!existsSync(shell)) { console.log(`FAIL no headless shell at ${shell}: not run`); process.exit(2); }
const failures: string[] = [];
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failures.push(what); };
const dataDir = mkdtempSync(join(tmpdir(), "wb-notice-")), off = join(dataDir, "keyring-off");
const fake = new FakeTelegram(); await fake.start();
const start = async () => {
  const child = spawn(process.execPath, ["apps/host/dist/host.mjs"], {
    env: { ...process.env, WORKBENCH_DATA_DIR: dataDir, WORKBENCH_WEB_DIR: webDir, WORKBENCH_PORT: "0", WORKBENCH_EDITORS_PORT: "0", WORKBENCH_IEUM_BOOTSTRAP: "0", WORKBENCH_EXIT_ON_STDIN_CLOSE: "1",
      WORKBENCH_SECRET_BIN: resolve("scripts/fixtures/fake-secret.mjs"), FAKE_SECRET_OFF: off, WORKBENCH_TELEGRAM_API: fake.url,
      WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"), WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = ""; child.stderr!.on("data", (part: Buffer) => { stderr += part; });
  const ready = await new Promise<{ url: string; token: string }>((done, reject) => {
    child.once("exit", (code) => reject(new Error(`gateway exited (${code})`)));
    createInterface({ input: child.stdout! }).on("line", (line) => { if (line.startsWith("WORKBENCH_READY ")) done(JSON.parse(line.slice(16))); });
  });
  return { child, ready, stderr: () => stderr };
};
const stop = async (child: ChildProcess) => { const gone = new Promise((done) => child.once("exit", done)); child.stdin!.end(); await gone; };
let running: ChildProcess | null = null;
const browser = await chromium.launch({ executablePath: shell, headless: true });
try {
  // A bot whose token is sealed while the vault opens.
  let gateway = await start(); running = gateway.child;
  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${gateway.ready.url}${path}`, { method, headers: { authorization: `Bearer ${gateway.ready.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return await response.json() as T;
  };
  await api("POST", "/api/channels/telegram/bots", { token: FAKE_TOKEN });
  // A person past the first run (its dialog would cover the page).
  await api("PUT", "/api/prefs", { prefs: { onboarding: "done", startScreen: "last" } });
  await stop(gateway.child);
  // The vault refuses at the next start (as a locked keyring does).
  writeFileSync(off, "");
  gateway = await start(); running = gateway.child;
  const host = await api<{ vault?: { state: string; message: string | null } }>("GET", "/api/host");
  check(host.vault?.state === "refused" && Boolean(host.vault.message), `/api/host says the vault is refused, with what to do (${host.vault?.state})`);
  check(gateway.stderr().split("\n").filter((line) => line.startsWith("Vault: refused")).length === 1, "one line in the gateway's log, not a loop");
  const channels = await api<{ bots: { status: { state: string; detail: string | null } }[] }>("GET", "/api/channels");
  check(channels.bots[0]?.status.state === "stopped" && channels.bots[0]?.status.detail === host.vault?.message, "the messenger is shown not connected, with the same reason");
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await page.goto(`${gateway.ready.url}/?token=${gateway.ready.token}`);
  const row = page.locator(".vault-problem");
  await row.waitFor({ timeout: 20_000 }).catch(() => undefined);
  const text = (await row.count()) ? await row.innerText() : "";
  check(text.includes("비밀 보관함을 열지 못했습니다") && text.includes("키링") && text.includes("다시 시도"), `the app shows a standing row with the reason, what to do and 다시 시도 (${text.slice(0, 40)}…)`);
  check(!/[A-Za-z0-9+/]{43}=/.test(text), "no secret-shaped value in it");
  await page.screenshot({ path: join(dataDir, "vault-notice.png") });
  // The cause gone (the keyring unlocked), 다시 시도 clears it.
  rmSync(off, { force: true });
  const buttons = await row.locator("button").allInnerTexts();
  console.log(`buttons in the row: ${JSON.stringify(buttons)}`);
  const responses: string[] = [];
  page.on("response", (response) => { if (response.url().includes("/api/host/vault")) responses.push(`${response.status()}`); });
  await row.getByRole("button", { name: "다시 시도" }).click().catch((error: unknown) => console.log(`click: ${error instanceof Error ? error.message.split("\n").slice(-6).join(" / ") : error}`));
  await new Promise((done) => setTimeout(done, 3000));
  console.log(`retry responses: ${JSON.stringify(responses)}`);
  await row.waitFor({ state: "detached", timeout: 15_000 }).catch(() => undefined);
  check((await page.locator(".vault-problem").count()) === 0, "다시 시도 after the cause is gone clears the row");
  check((await api<{ vault?: { state: string } }>("GET", "/api/host")).vault?.state === "open", "the vault is open again");
  await page.close();
} catch (error) { check(false, `harness: ${error instanceof Error ? error.message : String(error)}`); }
finally {
  await browser.close();
  if (running && running.exitCode === null) await stop(running).catch(() => running?.kill("SIGTERM"));
  await fake.stop().catch(() => {});
  rmSync(dataDir, { recursive: true, force: true });
}
console.log(failures.length ? `${failures.length} notice checks FAILED` : "all notice checks passed");
process.exitCode = failures.length ? 1 : 0;
