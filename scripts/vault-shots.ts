/// <reference lib="dom" />
// Captures of "비밀 보관함" in the 휴대폰 메신저 dialog, in WebKitGTK (the engine the Linux app runs
// on): the list with a conversation waiting, adding with masked fields, filling the waiting
// hand-over, renaming, and a deletion with 되살리기. One theme and one width per run, on a fresh
// gateway (the bundled one), the stand-in Bot API and the stand-in keyring; the waiting hand-over is
// asked for by running the gateway's own `workbench-credential` as an engine would. Values are
// random and only ever typed into masked fields; none is printed.
//
// Usage (through ux/run-isolated.sh): node scripts/vault-shots.ts <outDir> --theme=light|dark [--width=1440]

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Session, Work } from "@workbench/contracts";
import { FAKE_TOKEN, FakeTelegram } from "../apps/host/src/channels/fake-telegram.ts";

const args = process.argv.slice(2);
const outDir = resolve(args.find((arg) => !arg.startsWith("--")) ?? join(tmpdir(), "wb-vault-shots"));
const theme = args.find((arg) => arg.startsWith("--theme="))?.split("=")[1] === "dark" ? "dark" : "light";
const width = Number(args.find((arg) => arg.startsWith("--width="))?.split("=")[1] ?? 1440);
mkdirSync(outDir, { recursive: true });

const dataDir = mkdtempSync(join(tmpdir(), "workbench-vault-shots-"));
const fake = new FakeTelegram();
await fake.start();
const child = spawn(process.execPath, [process.env.DESIGN_SHOTS_HOST_ENTRY ?? "apps/host/dist/host.mjs"], {
  env: {
    ...process.env, WORKBENCH_DATA_DIR: dataDir, WORKBENCH_WEB_DIR: "apps/web/dist", WORKBENCH_HOST_LABEL: "노트북",
    WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"), WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"),
    WORKBENCH_TELEGRAM_API: fake.url, WORKBENCH_SECRET_BIN: resolve("scripts/fixtures/fake-secret.mjs"),
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
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`);
  return (await response.json()) as T;
};
const prefs = (await api<{ prefs: Record<string, unknown> }>("GET", "/api/snapshot")).prefs;
await api("PUT", "/api/prefs", { prefs: { ...prefs, onboarding: "done", startScreen: "last", theme, sidebar: true } });
// A bot registered by its route (no wizard, so no autostart tick is ever touched).
await api("POST", "/api/channels/telegram/bots", { token: FAKE_TOKEN });
const fakeValue = () => `zz-${randomBytes(12).toString("base64url")}`;
await api("POST", "/api/channels/credentials", { name: "네이버", kind: "login", site: "nid.naver.com", values: { 아이디: fakeValue(), 비밀번호: fakeValue() } });
await api("POST", "/api/channels/credentials", { name: "노션 키", kind: "api-key", site: "notion.so", values: { 키: fakeValue() } });
const card = await api<{ entries: { id: string; name: string }[] }>("POST", "/api/channels/credentials", { name: "카드 1", kind: "card", site: "", values: { 카드번호: "4000123412341234", 유효기간: "12/29", CVC: "123" } });
await api("PATCH", `/api/channels/credentials/${card.entries.find((entry) => entry.name === "카드 1")!.id}`, { askEachTime: true });
// A conversation that asked for a login, as an engine does: the stand-in Claude runs the gateway's own
// workbench-credential from its spool (the request text tells the stand-in what to ask for).
const work = await api<Work>("POST", "/api/works", { title: "도서관" });
const session = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "claude", purpose: "대출 목록 정리", access: "full" });
await api("POST", `/api/sessions/${session.id}/messages`, { requestId: "shots-1", text: "대출 목록 정리해 줘. 비밀 필요: need --name 학술정보원 --kind login --site lib.example.ac.kr --fields 아이디,비밀번호" });
for (let tries = 0; tries < 200 && !(await api<{ waiting: unknown[] }>("GET", "/api/channels/credentials")).waiting.length; tries += 1) await new Promise((done) => setTimeout(done, 100));
console.log(`waiting hand-overs: ${(await api<{ waiting: unknown[] }>("GET", "/api/channels/credentials")).waiting.length}`);

type Step = { js?: string; wait?: string; pause?: number };
type Screen = { name: string; steps: Step[]; settle?: number; cleanup?: Step[] };
const DIALOG = ".feature-dialog[open] .phone-messenger";
const click = (selector: string, text?: string) => `__wb.click(${JSON.stringify(selector)}${text ? `, ${JSON.stringify(text)}` : ""})`;
const has = (selector: string, text?: string) => `__wb.has(${JSON.stringify(selector)}${text ? `, ${JSON.stringify(text)}` : ""})`;
const exact = (text: string, scope = DIALOG) => `[...document.querySelectorAll('${scope} button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)} && b.getClientRects().length)?.click()`;
const typeIn = (label: string, value: string) => `(() => { const l = [...document.querySelectorAll('${DIALOG} .vault-form label')].find((e) => e.firstChild && e.firstChild.textContent === ${JSON.stringify(label)}); const i = l && l.querySelector('input'); if (!i) return false; i.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(i, ${JSON.stringify(value)}); i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`;

const SCREENS: Screen[] = [
  { name: "vault-01-list", steps: [
    { js: click('[aria-label="연결과 설정"]'), wait: has(".feature-actions button", "휴대폰 메신저") },
    { js: click(".feature-actions button", "휴대폰 메신저"), wait: has(`${DIALOG} [role=tab]`, "비밀 보관함") },
    { js: click(`${DIALOG} [role=tab]`, "비밀 보관함"), wait: `${has(`${DIALOG} .vault-row`)} && ${has(`${DIALOG} .vault-wait`)}` },
    { js: "__wb.blur()" },
  ], settle: 700 },
  { name: "vault-02-add", steps: [
    { js: exact("항목 추가"), wait: has(`${DIALOG} .vault-form`) },
    // 아이디 is not a secret (shown as typed); the password field holds a placeholder, never a value used anywhere.
    { js: typeIn("이름", "학교 포털") }, { js: typeIn("사이트", "portal.example.ac.kr") }, { js: typeIn("아이디", "hong.gildong") }, { js: typeIn("비밀번호", "보기-예시-0000") },
    { js: "__wb.blur()" },
  ], cleanup: [] },
  { name: "vault-02b-show", steps: [{ js: click(`${DIALOG} .vault-show`), wait: `__wb.q('${DIALOG} .vault-form input[type=text][spellcheck=false]:not([autocomplete=off])')` }, { js: "__wb.blur()" }],
    cleanup: [{ js: exact("취소", `${DIALOG} .vault-form`), wait: `!${has(`${DIALOG} .vault-form`)}` }] },
  { name: "vault-03-fill-waiting", steps: [
    { js: exact("넣기", `${DIALOG} .vault-wait`), wait: has(`${DIALOG} .vault-form`) },
    { js: typeIn("아이디", "hong.gildong") },
    { js: "__wb.blur()" },
  ], cleanup: [{ js: exact("취소", `${DIALOG} .vault-form`), wait: `!${has(`${DIALOG} .vault-form`)}` }] },
  { name: "vault-04-rename", steps: [{ js: exact("이름 바꾸기"), wait: has(`${DIALOG} .vault-rename`) }, { js: "__wb.blur()" }],
    cleanup: [{ js: exact("취소", `${DIALOG} .vault-rename`), wait: `!${has(`${DIALOG} .vault-rename`)}` }] },
  { name: "vault-05-deleted", steps: [{ js: `${click(`${DIALOG} .vault-row:nth-child(2) .vault-delete`)}`, wait: has(`${DIALOG} .vault-said`, "되살리기") }, { js: "__wb.blur()" }] },
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
  const screens = SCREENS.map((screen) => ({ ...screen, name: width < 900 ? `${screen.name}-narrow` : screen.name }));
  writeFileSync(scenario, JSON.stringify({ url: `${ready.url}/?token=${ready.token}`, token: ready.token, base: ready.url, outDir, viewport: { width, height: 900 }, themes: [theme], prelude: PRELUDE_SOURCE, appReady, screens, invariants: {} }, null, 2), { mode: 0o600 });
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
  await fake.stop();
  rmSync(dataDir, { recursive: true, force: true });
  console.log(`stand-in Bot API calls: ${fake.calls.length} (${[...new Set(fake.calls.map((call) => call.method))].join(", ")})`);
}
console.log(`webkit exit ${code}`);
process.exit(code === 0 ? 0 : 1);
