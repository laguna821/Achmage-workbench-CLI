/// <reference lib="dom" />
// Captures of the "휴대폰 메신저" dialog in WebKitGTK (the engine the Linux app runs on): every step
// of the Telegram registration wizard, the keyring-absent line, the QR, the four digits, and the
// registered state (connected, paused, locked, reconnecting, conflict, token replacement, record),
// then a conversation with a request from the phone. One theme per run, on a fresh gateway.
//
// Nothing here contacts Telegram: the gateway is pointed at the stand-in Bot API of the channel
// tests (apps/host/src/channels/fake-telegram.ts) on 127.0.0.1, and at a stand-in keyring
// (scripts/fixtures/fake-secret.mjs). The page plays the phone through a control address on
// 127.0.0.1 served by this script. Engines are the repository's stand-ins (no model).
//
// Usage (from the repository, through ux/run-isolated.sh): node scripts/channel-shots.ts <outDir> --theme=light|dark
//   DESIGN_SHOTS_HOST_ENTRY=apps/host/dist/host.mjs (default) — build the web UI and the host bundle first.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { ChannelsState, Snapshot } from "@workbench/contracts";
import { FAKE_TOKEN, FakeTelegram } from "../apps/host/src/channels/fake-telegram.ts";

const args = process.argv.slice(2);
const outDir = resolve(args.find((arg) => !arg.startsWith("--")) ?? join(tmpdir(), "wb-channel-shots"));
const theme = args.find((arg) => arg.startsWith("--theme="))?.split("=")[1] === "dark" ? "dark" : "light";
mkdirSync(outDir, { recursive: true });

const dataDir = mkdtempSync(join(tmpdir(), "workbench-channel-shots-"));
const keyringOff = join(dataDir, "keyring-off");
const fake = new FakeTelegram();
await fake.start();

const child = spawn(process.execPath, [process.env.DESIGN_SHOTS_HOST_ENTRY ?? "apps/host/dist/host.mjs"], {
  env: {
    ...process.env,
    WORKBENCH_DATA_DIR: dataDir,
    WORKBENCH_WEB_DIR: "apps/web/dist",
    WORKBENCH_HOST_LABEL: "노트북",
    WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"),
    WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"),
    WORKBENCH_TELEGRAM_API: fake.url,
    WORKBENCH_SECRET_BIN: resolve("scripts/fixtures/fake-secret.mjs"),
    FAKE_SECRET_OFF: keyringOff,
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
await api("PUT", "/api/prefs", { prefs: { ...prefs, onboarding: "done", startScreen: "last", theme, sidebar: true } });

// The phone, as the page asks for it.
const control = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://control");
  const done = (value: unknown = "ok") => { res.writeHead(200, { "access-control-allow-origin": "*", "content-type": "text/plain" }); res.end(String(value)); };
  void (async () => {
    switch (url.pathname) {
      case "/keyring-off": writeFileSync(keyringOff, ""); return done();
      case "/keyring-on": rmSync(keyringOff, { force: true }); return done();
      case "/phone-start": {
        // The phone scans the QR: a link of its own, so the screen's QR stays unread here.
        const bot = (await api<ChannelsState>("GET", "/api/channels")).bots[0]!;
        const { link } = await api<{ link: string }>("POST", `/api/channels/telegram/bots/${bot.id}/pairing`, {});
        fake.message(`/start ${new URL(link).searchParams.get("start")}`);
        return done();
      }
      case "/phone-say": fake.message(url.searchParams.get("text") ?? ""); return done();
      case "/phone-contest": {
        // Two accounts open the same link: the owner and someone who saw the screen.
        const bot = (await api<ChannelsState>("GET", "/api/channels")).bots[0]!;
        const { link } = await api<{ link: string }>("POST", `/api/channels/telegram/bots/${bot.id}/pairing`, {});
        const value = new URL(link).searchParams.get("start");
        fake.message(`/start ${value}`, { userId: 666 });
        fake.message(`/start ${value}`, { userId: 555 });
        return done();
      }
      case "/phone-say-blocked": {
        // The person blocked the bot after asking: the answer is refused (403), as Telegram does.
        const before = fake.of("sendMessage").length;
        fake.message(url.searchParams.get("text") ?? "");
        for (let wait = 0; wait < 100 && !fake.of("sendMessage").slice(before).some((call) => String(call.params.text).startsWith("작업 중")); wait += 1) await new Promise((next) => setTimeout(next, 100));
        fake.nextSend = ["forbid"];
        return done();
      }
      case "/fail-polls": fake.failPolls = Number(url.searchParams.get("n") ?? 0); return done();
      case "/conflict": fake.conflict = url.searchParams.get("on") === "1"; return done();
      case "/phone-session": {
        const snapshot = await api<Snapshot>("GET", "/api/snapshot");
        return done(snapshot.sessions.find((session) => session.purpose.startsWith("휴대폰"))?.id ?? "");
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
const DIALOG = ".feature-dialog[open] .phone-messenger";
const click = (selector: string, text?: string) => `__wb.click(${JSON.stringify(selector)}${text ? `, ${JSON.stringify(text)}` : ""})`;
const has = (selector: string, text?: string) => `__wb.has(${JSON.stringify(selector)}${text ? `, ${JSON.stringify(text)}` : ""})`;
const button = (text: string) => click(`${DIALOG} button`, text);
const heading = (text: string) => has(`${DIALOG} h3`, text);
const status = (word: string) => has(`${DIALOG} .pm-status`, ` · ${word} · `);
const exact = (text: string) => `[...document.querySelectorAll('${DIALOG} button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)} && b.getClientRects().length)?.click()`;

const SCREENS: Screen[] = [
  { name: "pm-00-menu", steps: [{ js: click('[aria-label="연결과 설정"]'), wait: has(".feature-actions button", "휴대폰 메신저") }], settle: 500 },
  { name: "pm-01-intro", steps: [{ js: click(".feature-actions button", "휴대폰 메신저"), wait: has(`${DIALOG} .pm-intro`) }, { js: "__wb.blur()" }], settle: 600 },
  // The tick is shown on (pm-01-intro), then taken off: a test gateway must never register a login service on this machine.
  { name: "pm-01b-slack", steps: [{ js: `const tick = __wb.q('${DIALOG} .pm-intro input[type=checkbox]'); if (tick && tick.checked) tick.click()`, wait: `!__wb.q('${DIALOG} .pm-intro input[type=checkbox]')?.checked` },
    { js: button("Slack으로 시작"), wait: heading("Slack 앱을 만듭니다.") }, { js: "__wb.blur()" }], cleanup: [{ js: exact("이전"), wait: has(`${DIALOG} .pm-intro`) }] },
  { name: "pm-02-open", steps: [{ js: button("텔레그램으로 시작"), wait: heading("PC 브라우저에서 BotFather 대화를") }, { js: "__wb.blur()" }] },
  { name: "pm-03-send", steps: [{ js: exact("다음"), wait: heading("BotFather에게 아래 세 줄을") }, { js: click(`${DIALOG} button[aria-label="/newbot 복사"]`), pause: 200 }] },
  { name: "pm-06-token", steps: [{ js: exact("다음"), wait: heading("BotFather가 보낸 긴 토큰") }, { js: `__wb.type('${DIALOG} .pm-token input', ${JSON.stringify(FAKE_TOKEN)})` }] },
  { name: "pm-06b-no-keyring", steps: [{ js: phone("/keyring-off"), pause: 200 }, { js: exact("확인"), wait: has(`${DIALOG} [role=alert]`, "키링") }, { js: "__wb.blur()" }] },
  { name: "pm-07-qr", steps: [{ js: phone("/keyring-on"), pause: 200 }, { js: exact("확인"), wait: has(`${DIALOG} img.pm-qr`) }, { js: "__wb.blur()" }], settle: 800 },
  { name: "pm-07b-contested", steps: [{ js: phone("/phone-contest"), wait: has(`${DIALOG} [role=alert]`, "두 계정이") }, { js: "__wb.blur()" }] },
  { name: "pm-08-digits", steps: [{ js: phone("/phone-start"), wait: has(`${DIALOG} .pm-request`) }, { js: "__wb.blur()" }] },
  { name: "pm-09-connected", steps: [{ js: click(`${DIALOG} .pm-request button`, "연결"), wait: `${has(`${DIALOG} .pm-facts`, "연결한 사람")} && ${status("연결됨")}` }, { js: "__wb.blur()" }] },
  { name: "pm-10-paused", steps: [{ js: exact("멈춤"), wait: status("멈춤") }, { js: "__wb.blur()" }], cleanup: [{ js: exact("다시 시작"), wait: status("연결됨") }] },
  { name: "pm-11-locked", steps: [{ js: phone("/phone-say?text=" + encodeURIComponent("잠금")), wait: status("잠김") }, { js: "__wb.blur()" }], cleanup: [{ js: exact("잠금 풀기"), wait: status("연결됨") }] },
  { name: "pm-12-retrying", steps: [{ js: phone("/fail-polls?n=2"), wait: has(`${DIALOG} .pm-status`, "다시 연결 중") }, { js: "__wb.blur()" }], cleanup: [{ wait: status("연결됨") }] },
  { name: "pm-13-conflict", steps: [{ js: phone("/conflict?on=1"), wait: status("충돌") }, { js: "__wb.blur()" }] },
  { name: "pm-14-replace-token", steps: [{ js: phone("/conflict?on=0"), pause: 100 }, { js: exact("토큰 바꾸기"), wait: has(`${DIALOG} .pm-token input`) }],
    cleanup: [{ js: `__wb.type('${DIALOG} .pm-token input', ${JSON.stringify(FAKE_TOKEN)})` }, { js: exact("확인"), wait: status("연결됨") }] },
  { name: "pm-15-record", steps: [{ js: click(`${DIALOG} [role=tab]`, "기록"), wait: has(`${DIALOG} .pm-record li`) }, { js: "__wb.blur()" }],
    cleanup: [{ js: click(`${DIALOG} [role=tab]`, "연결"), wait: has(`${DIALOG} .pm-facts`) }] },
  { name: "pm-15b-undelivered", steps: [{ js: phone("/phone-say-blocked?text=" + encodeURIComponent("오늘 일정 정리해 줘")), pause: 10_000 }, { wait: has(`${DIALOG} [data-testid=channel-undelivered]`) }, { js: "__wb.blur()" }] },
  { name: "pm-15c-remove-confirm", steps: [{ js: exact("봇 등록 지우기"), wait: has(`${DIALOG} .pm-remove-confirm`) }, { js: "__wb.blur()" }], cleanup: [{ js: exact("취소"), wait: `!${has(`${DIALOG} .pm-remove-confirm`)}` }] },
  // Requests from the phone in their conversation (the waiting-request mark is covered by phone-origin.test.tsx).
  { name: "pm-16-phone-mark", steps: [
    { js: click('[aria-label="휴대폰 메신저 닫기"]'), wait: `!${has(".feature-dialog[open]")}` },
    { js: phone("/phone-say?text=" + encodeURIComponent("3학년만 뽑아서 따로 저장해 줘")), pause: 9000 },
    { js: phone("/phone-say?text=" + encodeURIComponent("그다음 출석부도 같은 방식으로 정리해 줘")), pause: 300 },
    { js: `${phone("/phone-session")}.then((r) => r.text()).then((id) => { window.__phone = id; })`, wait: "window.__phone" },
    { js: "if (!__wb.has('.sidebar')) __wb.click('.topbar-left [aria-label=\"사이드바 열기\"]')", wait: "__wb.has('.sidebar [data-row-id=\"' + window.__phone + '\"]') || (__wb.click('.sidebar .side-row', '휴대폰') && false)" },
    { js: "__wb.click('.sidebar [data-row-id=\"' + window.__phone + '\"]')", wait: "document.querySelectorAll('.work-view .transcript .phone-tag').length >= 2" },
    { js: "__wb.blur(); const t = document.querySelector('.work-view .transcript'); t.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true })); t.scrollTop = 0;", pause: 500 },
  ], settle: 900 },
];

function capture() {
  const scenario = join(outDir, `scenario-${theme}.json`);
  const PRELUDE_SOURCE = `
  window.__wb = window.__wb || {
    q(selector, text) { const all = [...document.querySelectorAll(selector)].filter((e) => e.getClientRects().length > 0); return text ? all.find((e) => e.textContent.includes(text)) : all[0]; },
    click(selector, text) { const e = this.q(selector, text); if (!e) return false; e.scrollIntoView({ block: "nearest" }); e.focus({ preventScroll: true }); e.click(); return true; },
    type(selector, text) { const e = this.q(selector); if (!e) return false; e.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(e, text); e.dispatchEvent(new Event("input", { bubbles: true })); return true; },
    blur() { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); return true; },
    has(selector, text) { return Boolean(this.q(selector, text)); },
  };`;
  const appReady = "__wb.has('.work-view, .start-view, .archive-view, .pkm-center, .document-view, .project-view')";
  writeFileSync(scenario, JSON.stringify({ url: `${ready.url}/?token=${ready.token}`, token: ready.token, base: ready.url, outDir, viewport: { width: 1440, height: 900 }, themes: [theme], prelude: PRELUDE_SOURCE, appReady, screens: SCREENS, invariants: {} }, null, 2), { mode: 0o600 });
  // Not spawnSync: the stand-in Bot API and the control address answer from this process meanwhile.
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
  await fake.stop();
  rmSync(dataDir, { recursive: true, force: true });
  // Whatever reached the stand-in: the token went only to it, and no outside address was used.
  console.log(`stand-in Bot API calls: ${fake.calls.length} (${[...new Set(fake.calls.map((call) => call.method))].join(", ")})`);
}
console.log(`webkit exit ${code}`);
process.exit(code === 0 ? 0 : 1);
