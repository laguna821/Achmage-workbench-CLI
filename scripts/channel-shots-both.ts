/// <reference lib="dom" />
// Captures of 설정 › 메신저 with one Telegram bot AND one Slack app (WebKitGTK, the Linux app's
// engine): the two rows with none connected, each wizard's first step, Telegram only, both
// connected, and 기록 with rows of both. One theme and one width per run, on a fresh gateway.
//
// Nothing here contacts Telegram or Slack: the gateway is pointed at the stand-ins of the channel
// tests on 127.0.0.1 and at a stand-in keyring. The page asks this script (a control address on
// 127.0.0.1) to register and pair a messenger, as the person would on the phone. Stand-in engines.
//
// Usage (from the repository, through ux/run-isolated.sh, after building the web UI and the host):
//   node scripts/channel-shots-both.ts <outDir> --theme=light|dark [--width=1440|390]

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { ChannelPairingLink, ChannelsState } from "@workbench/contracts";
import { FAKE_APP_TOKEN, FAKE_BOT_TOKEN, FakeSlack } from "../apps/host/src/channels/fake-slack.ts";
import { FAKE_TOKEN, FakeTelegram } from "../apps/host/src/channels/fake-telegram.ts";

const args = process.argv.slice(2);
const outDir = resolve(args.find((arg) => !arg.startsWith("--")) ?? join(tmpdir(), "wb-channel-shots-both"));
const theme = args.find((arg) => arg.startsWith("--theme="))?.split("=")[1] === "dark" ? "dark" : "light";
const width = Number(args.find((arg) => arg.startsWith("--width="))?.split("=")[1] ?? 1440) === 390 ? 390 : 1440;
mkdirSync(outDir, { recursive: true });

const dataDir = mkdtempSync(join(tmpdir(), "workbench-channel-shots-both-"));
const tg = new FakeTelegram(), slack = new FakeSlack();
await tg.start();
await slack.start();
const child = spawn(process.execPath, [process.env.DESIGN_SHOTS_HOST_ENTRY ?? "apps/host/dist/host.mjs"], {
  env: {
    ...process.env,
    WORKBENCH_DATA_DIR: dataDir,
    WORKBENCH_WEB_DIR: "apps/web/dist",
    WORKBENCH_HOST_LABEL: "노트북",
    WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"),
    WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"),
    WORKBENCH_TELEGRAM_API: tg.url,
    WORKBENCH_SLACK_API: slack.url,
    WORKBENCH_SECRET_BIN: resolve("scripts/fixtures/fake-secret.mjs"),
  },
  stdio: ["ignore", "pipe", "inherit"],
});
const ready = await new Promise<{ url: string; token: string }>((done, reject) => {
  child.once("error", reject);
  child.once("exit", (code) => reject(new Error(`gateway exited before readiness (${code})`)));
  createInterface({ input: child.stdout! }).on("line", (line) => { if (line.startsWith("WORKBENCH_READY ")) done(JSON.parse(line.slice(16))); });
});
console.log(`gateway pid ${child.pid}`);
const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${ready.url}${path}`, { method, headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return (await response.json()) as T;
};
const prefs = (await api<{ prefs: Record<string, unknown> }>("GET", "/api/snapshot")).prefs;
await api("PUT", "/api/prefs", { prefs: { ...prefs, onboarding: "done", startScreen: "last", theme, sidebar: width > 600 } });
const waitFor = async (what: () => Promise<boolean>) => { for (let round = 0; round < 200 && !(await what()); round += 1) await new Promise((next) => setTimeout(next, 100)); };
const botOf = async (kind: "telegram" | "slack") => (await api<ChannelsState>("GET", "/api/channels")).bots.find((bot) => bot.kind === kind);

// The person, as the page asks for it: a messenger registered and paired, or a line from each.
const control = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://control");
  const done = (value: unknown = "ok") => { res.writeHead(200, { "access-control-allow-origin": "*", "content-type": "text/plain" }); res.end(String(value)); };
  void (async () => {
    switch (url.pathname) {
      case "/telegram": {
        await api("POST", "/api/channels/telegram/bots", { token: FAKE_TOKEN });
        const { link } = await api<{ link: string }>("POST", `/api/channels/telegram/bots/${tg.botId}/pairing`, {});
        tg.message(`/start ${new URL(link).searchParams.get("start")}`);
        await waitFor(async () => Boolean((await botOf("telegram"))?.pairing.request));
        await api("POST", `/api/channels/telegram/bots/${tg.botId}/pairing/${(await botOf("telegram"))!.pairing.request!.id}`, { approve: true });
        return done();
      }
      case "/slack": {
        await api("POST", "/api/channels/slack/bots", { botToken: FAKE_BOT_TOKEN, appToken: FAKE_APP_TOKEN, appName: "Workbench 노트북" });
        await api<ChannelPairingLink>("POST", `/api/channels/slack/bots/${slack.botId}/pairing`, {});
        slack.message("연결");
        await waitFor(async () => Boolean((await botOf("slack"))?.pairing.request));
        await api("POST", `/api/channels/slack/bots/${slack.botId}/pairing/${(await botOf("slack"))!.pairing.request!.id}`, { approve: true });
        return done();
      }
      case "/engines": {
        // Each messenger's own default engine, as the person sets it (Codex through Telegram, Claude through Slack).
        await api("PATCH", `/api/channels/telegram/bots/${tg.botId}`, { defaultEngine: "codex" });
        await api("PATCH", `/api/channels/slack/bots/${slack.botId}`, { defaultEngine: "claude" });
        return done();
      }
      case "/project": {
        // A project of the person's own, beside the messengers' places.
        await api("POST", "/api/works", { title: "연구계획서" });
        return done();
      }
      case "/say-both": {
        tg.message("어제 받은 학생 명단 정리해 줘");
        slack.message("회의록 정리해 줘");
        return done();
      }
      default: res.writeHead(404); res.end();
    }
  })().catch((error: unknown) => { res.writeHead(500, { "access-control-allow-origin": "*" }); res.end(String(error)); });
});
await new Promise<void>((done) => control.listen(0, "127.0.0.1", done));
const CONTROL = `http://127.0.0.1:${(control.address() as AddressInfo).port}`;
const phone = (path: string) => `fetch('${CONTROL}${path}')`;

type Step = { js?: string; wait?: string; pause?: number };
type Screen = { name: string; steps: Step[]; settle?: number; cleanup?: Step[] };
const DIALOG = ".settings-dialog[open] .phone-messenger";
const click = (selector: string, text?: string) => `__wb.click(${JSON.stringify(selector)}${text ? `, ${JSON.stringify(text)}` : ""})`;
const has = (selector: string, text?: string) => `__wb.has(${JSON.stringify(selector)}${text ? `, ${JSON.stringify(text)}` : ""})`;
const labelled = (label: string) => click(`${DIALOG} button[aria-label="${label}"]`);
const heading = (text: string) => has(`${DIALOG} h3`, text);
const row = (label: string, word: string) => `[...document.querySelectorAll('${DIALOG} .settings-row')].some((e) => e.querySelector('.settings-row-label')?.textContent.startsWith(${JSON.stringify(label)}) && e.textContent.includes(${JSON.stringify(word)}))`;
const back = click(`${DIALOG} button`, "← 메신저 목록");
const rows = has(`${DIALOG} button[aria-label="Slack 연결하기"], ${DIALOG} button[aria-label="Slack 열기"], ${DIALOG} button[aria-label="Slack 이어서 하기"]`);
// On a phone the section list is 설정's first screen: the messenger section is opened from it.
const openSection = width > 600 ? click(".settings-nav [data-section=messenger]") : `${click(".settings-dialog[open] [data-section=messenger]")} || ${click(".settings-dialog[open] button", "메신저")}`;

const SCREENS: Screen[] = [
  { name: "msg2-00-none", steps: [
    // A Slack way left part done by an earlier capture in this browser profile is forgotten: each run starts from none.
    { js: "localStorage.removeItem('workbench.phone-messenger.slack')" },
    { js: `if (!__wb.has('.settings-dialog[open]')) window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true, cancelable: true }))`, wait: has(".settings-dialog[open]") },
    { js: openSection, wait: rows }, { js: "__wb.blur()" }], settle: 600 },
  { name: "msg2-01-telegram-first-step", steps: [{ js: labelled("텔레그램 연결하기"), wait: heading("텔레그램으로 일 시키기") },
    // A test gateway must never register a login service on this machine: the autostart tick is taken off.
    { js: `const tick = __wb.q('${DIALOG} .pm-intro input[type=checkbox]'); if (tick && tick.checked) tick.click()`, wait: `!__wb.q('${DIALOG} .pm-intro input[type=checkbox]')?.checked` }, { js: "__wb.blur()" }],
    cleanup: [{ js: back, wait: rows }] },
  { name: "msg2-02-slack-first-step", steps: [{ js: labelled("Slack 연결하기"), wait: heading("Slack 앱을 만듭니다.") }, { js: "__wb.blur()" }],
    // The wizard's own 이전 on its first step: back to the rows, and the place is forgotten.
    cleanup: [{ js: `[...document.querySelectorAll('${DIALOG} .pm-nav button')].find((b) => b.textContent.trim() === '이전')?.click()`, wait: has(`${DIALOG} button[aria-label="Slack 연결하기"]`) }] },
  { name: "msg2-03-telegram-only", steps: [{ js: phone("/telegram"), wait: `${row("텔레그램", "연결됨")} && ${row("텔레그램", "길동")}` }, { js: "__wb.blur()" }], settle: 600 },
  { name: "msg2-04-both", steps: [{ js: phone("/slack"), wait: `${row("Slack", "연결됨")} && ${row("Slack", "길동")}` }, { js: "__wb.blur()" }], settle: 600 },
  { name: "msg2-05-record-both", steps: [{ js: phone("/say-both"), pause: 4000 }, { js: labelled("텔레그램 열기"), wait: has(`${DIALOG} [role=tab]`, "기록") },
    { js: click(`${DIALOG} [role=tab]`, "기록"), wait: `${has(`${DIALOG} .pm-record li`, "Slack · ")} && ${has(`${DIALOG} .pm-record li`, "텔레그램 · ")}` }, { js: "__wb.blur()" }], settle: 600 },
  // "기본 엔진": Telegram's own screen with the control, then the two rows saying each messenger's own.
  { name: "msg2-06-default-engine-status", steps: [{ js: phone("/engines"), pause: 2500 }, { js: click(`${DIALOG} [role=tab]`, "연결"), wait: `__wb.q('${DIALOG} [role=radiogroup][aria-label="기본 엔진"] [aria-checked=true]')?.textContent === 'Codex'` }, { js: "__wb.blur()" }], settle: 600 },
  { name: "msg2-07-default-engine-rows", steps: [{ js: back, wait: `${row("텔레그램", "기본 엔진 Codex")} && ${row("Slack", "기본 엔진 Claude")}` }, { js: "__wb.blur()" }], settle: 600 },
  // Messenger homes: the list of all projects with "메신저" above 폴더 (each messenger's own place), then Telegram's opened.
  { name: "msg2-08-messenger-section", steps: [
    { js: phone("/project"), pause: 800 },
    { js: click(".settings-dialog[open] .settings-close"), wait: "!__wb.has('.settings-dialog[open]')" },
    { js: click(".nav-rail [data-rail=projects]"), pause: 400 },
    { js: "if (__wb.has('.sidebar[data-level=project]')) __wb.click('.sidebar .nav-back')", wait: `${has(`.sidebar[data-level=projects] [role=tree][aria-label="메신저"] [data-row-id]`, "텔레그램 대화")} && ${has(`.sidebar[data-level=projects] [role=tree][aria-label="메신저"] [data-row-id]`, "Slack 대화")}` },
    { js: "__wb.blur()" }], settle: 600 },
  { name: "msg2-09-messenger-home-open", steps: [{ js: click(`.sidebar [role=tree][aria-label="메신저"] [data-row-id]`, "텔레그램 대화"), wait: "__wb.has('.sidebar[data-level=project]')" }, { js: "__wb.blur()" }], settle: 800 },
];

function capture() {
  const scenario = join(outDir, `scenario-${theme}-${width}.json`);
  const PRELUDE_SOURCE = `
  window.__wb = window.__wb || {
    q(selector, text) { const all = [...document.querySelectorAll(selector)].filter((e) => e.getClientRects().length > 0); return text ? all.find((e) => e.textContent.includes(text)) : all[0]; },
    click(selector, text) { const e = this.q(selector, text); if (!e) return false; e.scrollIntoView({ block: "nearest" }); e.focus({ preventScroll: true }); e.click(); return true; },
    blur() { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); return true; },
    has(selector, text) { return Boolean(this.q(selector, text)); },
  };`;
  const appReady = "__wb.has('.work-view, .start-view, .archive-view, .pkm-center, .document-view, .project-view')";
  const screens = SCREENS.map((screen) => ({ ...screen, name: `${screen.name}-${theme}-${width}` }));
  writeFileSync(scenario, JSON.stringify({ url: `${ready.url}/?token=${ready.token}`, token: ready.token, base: ready.url, outDir, viewport: width > 600 ? { width: 1440, height: 900 } : { width: 390, height: 844 }, themes: [theme], prelude: PRELUDE_SOURCE, appReady, screens, invariants: {} }, null, 2), { mode: 0o600 });
  return new Promise<number | null>((done) => {
    const py = spawn("python3", ["scripts/webkit-design-shots.py", scenario], { stdio: "inherit" });
    console.log(`webkit driver pid ${py.pid}`);
    py.once("exit", (code) => { rmSync(scenario, { force: true }); done(code); });
  });
}

let code: number | null = 1;
try {
  code = await capture();
} finally {
  child.kill();
  await new Promise((done) => child.once("exit", done));
  control.close();
  await tg.stop();
  await slack.stop();
  rmSync(dataDir, { recursive: true, force: true });
  console.log(`stand-in calls: Bot API ${tg.calls.length}, Slack ${slack.calls.length}`);
}
console.log(`webkit exit ${code}`);
process.exit(code === 0 ? 0 : 1);
