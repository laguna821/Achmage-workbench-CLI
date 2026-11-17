/// <reference lib="dom" />
// 완료 소리 rig check (0.5.3, unit done-sound): the built UI and gateway with the stand-in Codex; the page's
// HTMLMediaElement.play is replaced by a recorder (nothing reaches a speaker), so the check asserts the play call.
//   1. The window is hidden (document.hidden / hasFocus faked): a turn ends → one play of 맑은 두 음 (chime).
//   2. A failing turn → 내려가는 두 음 (fall).   3. A command waiting for approval → 올라가는 세 음 (rise).
//   4. Ten conversations end together → at most one sound per 1.5 s (one, when they end within the gap).
//   5. 완료 소리 off in the gateway's prefs → nothing.
//   6. Captures of 설정 › 일반 with the rows (1440×900 light/dark, 1000×800 light/dark, 760×800 light).
// Usage: node scripts/done-sound-check.ts <out folder>   (through ux/run-isolated.sh)
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Browser, type Page } from "playwright-core";

const out = resolve(process.argv[2] ?? "done-sound"); mkdirSync(out, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), "wb-done-sound-"));
const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`); };
const wait = (ms: number) => new Promise(done => setTimeout(done, ms));
const until = async (what: () => Promise<boolean>, timeout = 30_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await what()) return true; await wait(100); }
  return false;
};
type Play = { src: string; volume: number; at: number };
const sound = (play: Play) => /data:audio/.test(play.src) ? "pop" : (play.src.match(/\/(chime|bell|pop|rise|fall)-[^/]*\.wav$/)?.[1] ?? play.src.slice(0, 40));

let child: ChildProcess | null = null, browser: Browser | null = null;
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
  const items = async (id: string) => (await api(`/api/sessions/${id}/items`)).items as { kind: string; status?: string; decision?: unknown }[];
  let turn = 0;
  const send = (id: string, text: string) => api(`/api/sessions/${id}/messages`, "POST", { requestId: `turn-${++turn}`, text, refs: [], create: null, mode: "auto" });
  const ends = async (id: string) => (await items(id)).filter(item => item.kind === "turnEnd").length;

  const work = await api("/api/works", "POST", { title: "완료 소리 검사", cwd: null });
  const sessions: { id: string }[] = [];
  for (let i = 0; i < 11; i++) sessions.push(await api(`/api/works/${work.id}/sessions`, "POST", { provider: "codex", purpose: `대화 ${i + 1}` }));

  browser = await chromium.launch();
  const page: Page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => {
    const plays: { src: string; volume: number; at: number }[] = [];
    (window as unknown as { __plays: typeof plays }).__plays = plays;
    HTMLMediaElement.prototype.play = function () { plays.push({ src: this.currentSrc || this.src, volume: this.volume, at: performance.now() }); return Promise.resolve(); };
  });
  await page.goto(`${ready.url}/?token=${ready.token}`);
  await page.waitForSelector(".app-shell, .composer-input, main", { timeout: 30_000 });
  await wait(1500);
  const plays = () => page.evaluate(() => (window as unknown as { __plays: { src: string; volume: number; at: number }[] }).__plays.slice());
  const clear = () => page.evaluate(() => { (window as unknown as { __plays: unknown[] }).__plays.length = 0; });
  // The window goes to the back (minimised / hidden to the tray): not visible, not focused.
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.hasFocus = () => false;
    document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("blur"));
  });

  // 1. a turn ends while hidden
  const [first] = sessions;
  await send(first.id, "안녕하세요");
  await until(async () => (await ends(first.id)) >= 1);
  await wait(400);
  let heard = await plays();
  check("창이 숨은 채 답이 끝나면 '끝났을 때' 소리 한 번", heard.length === 1 && sound(heard[0]) === "chime" && Math.abs(heard[0].volume - 0.45) < 1e-6, JSON.stringify(heard.map(play => [sound(play), play.volume])));
  await wait(1700); await clear();

  // 2. a failing turn
  await send(first.id, "실패해");
  await until(async () => (await ends(first.id)) >= 2);
  await wait(400);
  heard = await plays();
  check("실패한 턴은 '실패했을 때' 소리", heard.length === 1 && sound(heard[0]) === "fall", JSON.stringify(heard.map(sound)));
  await wait(1700); await clear();

  // 3. an approval
  await send(first.id, "명령: 목록을 보여 줘");
  const asked = await until(async () => (await items(first.id)).some(item => item.kind === "approval" && item.decision === null), 15_000);
  await wait(400);
  heard = await plays();
  check("승인을 기다리면 '확인이 필요할 때' 소리", asked && heard.length >= 1 && sound(heard[0]) === "rise", `approval=${asked} ${JSON.stringify(heard.map(sound))}`);
  await wait(1700);

  // 4. ten conversations end together (warmed up first, so their engines answer at once)
  const ten = sessions.slice(1);
  await Promise.all(ten.map(session => send(session.id, "준비")));
  await until(async () => (await Promise.all(ten.map(session => ends(session.id)))).every(count => count >= 1));
  await wait(1700); await clear();
  const t0 = Date.now();
  await Promise.all(ten.map(session => send(session.id, "안녕하세요")));
  await until(async () => (await Promise.all(ten.map(session => ends(session.id)))).every(count => count >= 2));
  const spread = Date.now() - t0;
  await wait(1700);
  heard = await plays();
  const gaps = heard.slice(1).map((play, i) => play.at - heard[i].at);
  check("열 개가 함께 끝나도 1.5초에 한 번 이하", heard.length >= 1 && heard.length <= 1 + Math.floor(spread / 1500) && gaps.every(gap => gap >= 1450), `sounds=${heard.length} over ${spread} ms, gaps=${gaps.map(Math.round).join(",")}`);
  await clear();

  // 5. 완료 소리 off (as the settings row saves it)
  await api("/api/prefs", "PUT", { prefs: { doneSound: false } });
  await wait(500);
  await send(first.id, "안녕하세요");
  const before = await ends(first.id);
  await until(async () => (await ends(first.id)) > before);
  await wait(600);
  heard = await plays();
  check("완료 소리를 끄면 소리 없음", heard.length === 0, JSON.stringify(heard.map(sound)));
  await api("/api/prefs", "PUT", { prefs: {} });

  // 6. captures of the settings rows
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.hasFocus = () => true;
  });
  for (const [name, width, height, theme] of [["1440x900-light", 1440, 900, "light"], ["1440x900-dark", 1440, 900, "dark"], ["1000x800-light", 1000, 800, "light"], ["1000x800-dark", 1000, 800, "dark"], ["760x800-light", 760, 800, "light"]] as const) {
    await api("/api/prefs", "PUT", { prefs: { theme } });
    await page.setViewportSize({ width, height });
    await page.reload(); await page.waitForSelector("main", { timeout: 30_000 }); await wait(1200);
    await page.keyboard.press("Control+,");
    const row = page.locator(".settings-row", { hasText: "완료 소리" }).first();
    const shown = await row.waitFor({ timeout: 10_000 }).then(() => true, () => false);
    if (!shown) { check(`설정 행 보임 ${name}`, false); await page.screenshot({ path: join(out, `settings-${name}-missing.png`) }); continue; }
    await row.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(out, `settings-${name}.png`) });
    const group = page.locator(".settings-group", { hasText: "완료 소리" }).first();
    await group.screenshot({ path: join(out, `settings-${name}-group.png`) });
    check(`설정 행 보임 ${name}`, true);
  }
} catch (error) {
  check("검사가 끝까지 돎", false, String(error));
} finally {
  await browser?.close().catch(() => undefined);
  if (child && child.exitCode === null) child.kill("SIGTERM");
  writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2));
  const failed = results.filter(result => !result.ok).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
}
