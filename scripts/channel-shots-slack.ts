/// <reference lib="dom" />
// Captures of the Slack branch of the "휴대폰 메신저" dialog in WebKitGTK (the engine the Linux app
// runs on), wide (1440) or narrow (--narrow: 720): the intro, the manifest step, installing, the two token
// fields, the keyring-absent line, the line to send in the app's DM, the four digits, the
// connected state, token replacement, the record and the removal step. One theme per run.
//
// Nothing here contacts Slack: the gateway is pointed at the stand-in Slack of the channel tests
// (apps/host/src/channels/fake-slack.ts) on 127.0.0.1 and at a stand-in keyring. The page plays the
// person through a control address on 127.0.0.1 served by this script. Engines are stand-ins.
//
// Usage (from the repository, through ux/run-isolated.sh): node scripts/channel-shots-slack.ts <outDir> --theme=light|dark [--narrow]
//   DESIGN_SHOTS_HOST_ENTRY=apps/host/dist/host.mjs (default) — build the web UI and the host bundle first.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { FAKE_APP_TOKEN, FAKE_BOT_TOKEN, FakeSlack } from "../apps/host/src/channels/fake-slack.ts";

const args = process.argv.slice(2);
const outDir = resolve(args.find((arg) => !arg.startsWith("--")) ?? join(tmpdir(), "wb-channel-shots-slack"));
const theme = args.find((arg) => arg.startsWith("--theme="))?.split("=")[1] === "dark" ? "dark" : "light";
// A whole run at one width: the capture driver's window does not shrink in the middle of a run.
const narrowRun = args.includes("--narrow");
mkdirSync(outDir, { recursive: true });

const dataDir = mkdtempSync(join(tmpdir(), "workbench-channel-shots-slack-"));
const keyringOff = join(dataDir, "keyring-off");
const fake = new FakeSlack();
await fake.start();

const child = spawn(process.execPath, [process.env.DESIGN_SHOTS_HOST_ENTRY ?? "apps/host/dist/host.mjs"], {
  env: {
    ...process.env,
    WORKBENCH_DATA_DIR: dataDir,
    WORKBENCH_WEB_DIR: "apps/web/dist",
    WORKBENCH_HOST_LABEL: "노트북",
    WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"),
    WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"),
    WORKBENCH_SLACK_API: fake.url,
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

const control = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://control");
  const done = (value: unknown = "ok") => { res.writeHead(200, { "access-control-allow-origin": "*", "content-type": "text/plain" }); res.end(String(value)); };
  void (async () => {
    switch (url.pathname) {
      case "/keyring-off": writeFileSync(keyringOff, ""); return done();
      case "/keyring-on": rmSync(keyringOff, { force: true }); return done();
      case "/person-pairs":
        // The person sends just the word in the app's DM; the window the screen opened is live.
        fake.message("연결");
        return done();
      case "/person-say": fake.message(url.searchParams.get("text") ?? ""); return done();
      // A colleague sends the word while the person's request waits: told to wait, named on the card.
      case "/other-asks": fake.message("연결", { user: "U0KIM", channel: "D0KIM" }); return done();
      default: res.writeHead(404); res.end();
    }
  })().catch((error: unknown) => { res.writeHead(500, { "access-control-allow-origin": "*" }); res.end(String(error)); });
});
await new Promise<void>((done) => control.listen(0, "127.0.0.1", done));
const CONTROL = `http://127.0.0.1:${(control.address() as AddressInfo).port}`;
const person = (path: string) => `fetch('${CONTROL}${path}')`;

type Step = { js?: string; wait?: string; pause?: number };
type Screen = { name: string; steps: Step[]; settle?: number; cleanup?: Step[] };
const DIALOG = ".feature-dialog[open] .phone-messenger";
const click = (selector: string, text?: string) => `__wb.click(${JSON.stringify(selector)}${text ? `, ${JSON.stringify(text)}` : ""})`;
const has = (selector: string, text?: string) => `__wb.has(${JSON.stringify(selector)}${text ? `, ${JSON.stringify(text)}` : ""})`;
const heading = (text: string) => has(`${DIALOG} h3`, text);
const status = (word: string) => has(`${DIALOG} .pm-status`, ` · ${word} · `);
const exact = (text: string) => `[...document.querySelectorAll('${DIALOG} button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)} && b.getClientRects().length)?.click()`;
const VIEWPORT = narrowRun ? { width: 720, height: 900 } : { width: 1440, height: 900 };

const SCREENS: Screen[] = ([
  { name: "slack-01-intro", steps: [{ js: click('[aria-label="연결과 설정"]'), wait: has(".feature-actions button", "휴대폰 메신저") },
    { js: click(".feature-actions button", "휴대폰 메신저"), wait: has(`${DIALOG} .pm-intro`) },
    // A test gateway must never register a login service on this machine: the tick goes off.
    { js: `const tick = __wb.q('${DIALOG} .pm-intro input[type=checkbox]'); if (tick && tick.checked) tick.click()`, wait: `!__wb.q('${DIALOG} .pm-intro input[type=checkbox]')?.checked` },
    { js: "__wb.blur()" }], settle: 600 },
  { name: "slack-02-create", steps: [{ js: exact("Slack으로 시작"), wait: heading("Slack 앱을 만듭니다.") }, { js: "__wb.blur()" }] },
  { name: "slack-03-install", steps: [{ js: exact("다음"), wait: heading("워크스페이스에 설치합니다.") }, { js: "__wb.blur()" }] },
  { name: "slack-04-tokens", steps: [{ js: exact("다음"), wait: heading("토큰 두 개를") },
    { js: `__wb.type('${DIALOG} .pm-token-row input', ${JSON.stringify(FAKE_BOT_TOKEN)}); const all = [...document.querySelectorAll('${DIALOG} .pm-token-row input')]; all[1].focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(all[1], ${JSON.stringify(FAKE_APP_TOKEN)}); all[1].dispatchEvent(new Event("input", { bubbles: true }));` },
    { js: "__wb.blur()" }] },
  { name: "slack-04b-no-keyring", steps: [{ js: person("/keyring-off"), pause: 200 }, { js: exact("확인"), wait: has(`${DIALOG} [role=alert]`, "키링") }, { js: "__wb.blur()" }] },
  { name: "slack-05-pairing-line", steps: [{ js: person("/keyring-on"), pause: 200 }, { js: exact("확인"), wait: has(`${DIALOG} .pm-say code`) },
    // The one-time value stays out of the picture (it is a stand-in's, but no capture shows one).
    { js: `__wb.q('${DIALOG} .pm-say code').textContent = "연결 " + "•".repeat(22)` }, { js: "__wb.q('.feature-dialog[open] .pm-panel').scrollTop = 0" }, { js: "__wb.blur()" }], settle: 800 },
  { name: "slack-06-digits", steps: [{ js: person("/person-pairs"), wait: has(`${DIALOG} .pm-request`) }, { js: "__wb.blur()" }] },
  { name: "slack-06b-also-asked", steps: [{ js: person("/other-asks"), wait: has(`${DIALOG} .pm-others`, "김철수") }, { js: "__wb.blur()" }] },
  { name: "slack-07-connected", steps: [{ js: click(`${DIALOG} .pm-request button`, "연결"), wait: `${has(`${DIALOG} .pm-facts`, "연결한 사람")} && ${status("연결됨")}` }, { js: "__wb.blur()" }] },
  { name: "slack-08-locked", steps: [{ js: person("/person-say?text=" + encodeURIComponent("잠금")), wait: status("잠김") }, { js: "__wb.blur()" }],
    cleanup: [{ js: exact("잠금 풀기"), wait: status("연결됨") }] },
  { name: "slack-09-replace-tokens", steps: [{ js: exact("토큰 바꾸기"), wait: has(`${DIALOG} .pm-token-row input`) }, { js: "__wb.blur()" }],
    cleanup: [{ js: exact("취소"), wait: `!${has(`${DIALOG} .pm-token-row input`)}` }] },
  { name: "slack-10-record", steps: [{ js: click(`${DIALOG} [role=tab]`, "기록"), wait: has(`${DIALOG} .pm-record li`) }, { js: "__wb.blur()" }],
    cleanup: [{ js: click(`${DIALOG} [role=tab]`, "연결"), wait: has(`${DIALOG} .pm-facts`) }] },
  { name: "slack-11-remove-confirm", steps: [{ js: exact("봇 등록 지우기"), wait: has(`${DIALOG} .pm-remove-confirm`) }, { js: "__wb.blur()" }] },
] as Screen[]).map((screen) => (narrowRun ? { ...screen, name: `${screen.name}-narrow` } : screen));

function capture() {
  const scenario = join(outDir, `scenario-slack-${theme}${narrowRun ? "-narrow" : ""}.json`);
  const PRELUDE_SOURCE = `
  window.__wb = window.__wb || {
    q(selector, text) { const all = [...document.querySelectorAll(selector)].filter((e) => e.getClientRects().length > 0); return text ? all.find((e) => e.textContent.includes(text)) : all[0]; },
    click(selector, text) { const e = this.q(selector, text); if (!e) return false; e.scrollIntoView({ block: "nearest" }); e.focus({ preventScroll: true }); e.click(); return true; },
    type(selector, text) { const e = this.q(selector); if (!e) return false; e.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(e, text); e.dispatchEvent(new Event("input", { bubbles: true })); return true; },
    blur() { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); return true; },
    has(selector, text) { return Boolean(this.q(selector, text)); },
  };`;
  const appReady = "__wb.has('.work-view, .start-view, .archive-view, .pkm-center, .document-view, .project-view')";
  writeFileSync(scenario, JSON.stringify({ url: `${ready.url}/?token=${ready.token}`, token: ready.token, base: ready.url, outDir, viewport: VIEWPORT, themes: [theme], prelude: PRELUDE_SOURCE, appReady, screens: SCREENS, invariants: {} }, null, 2), { mode: 0o600 });
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
  console.log(`stand-in Slack calls: ${fake.calls.length} (${[...new Set(fake.calls.map((call) => call.method))].join(", ")})`);
}
console.log(`webkit exit ${code}`);
process.exit(code === 0 ? 0 : 1);
