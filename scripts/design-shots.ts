/// <reference lib="dom" />
// Screenshots of every main screen for the design pass, in Chromium and in WebKitGTK (the engine
// the Linux app runs on), light and dark, against a real gateway driving the stand-in engines (no
// model) and a fixture vault in a temporary folder (the user's vault is never read or written).
//
// The state is seeded first: folders, works, a Codex conversation with a realistic turn ("견본":
// thinking, a plan, a command, a new file and a Markdown answer), a proposal and a waiting
// approval, a Claude conversation waiting on a plan ("계획 먼저"), an unread reply, an archived work
// and an open Markdown document. Then each screen is reached with small scripts run inside the
// page (clicks and key events), the same scripts for both browsers, so the two sets match.
//
// Usage: node scripts/design-shots.ts [outDir] [--chromium-only|--webkit-only] [--only=a,b] [--themes=light,dark]
// Writes <browser>-<theme>-<screen>.png and results.json into outDir.

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Page } from "playwright-core";
import type { Artifact, Folder, Proposal, Session, TranscriptItem, Work } from "@workbench/contracts";
import { makePkmVault } from "./fixtures/pkm-vault.ts";

const args = process.argv.slice(2);
const outDir = resolve(args.find((arg) => !arg.startsWith("--")) ?? join(tmpdir(), "wb-design-shots"));
const option = (name: string) => args.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
const only = option("only")?.split(",").filter(Boolean) ?? null;
const themes = (option("themes")?.split(",") ?? ["light", "dark"]).filter((theme) => theme === "light" || theme === "dark");
const runChromium = !args.includes("--webkit-only");
const runWebkit = !args.includes("--chromium-only");
mkdirSync(outDir, { recursive: true });

const dataDir = mkdtempSync(join(tmpdir(), "workbench-design-"));
const worksDir = mkdtempSync(join(tmpdir(), "workbench-design-works-"));
const vaultDir = mkdtempSync(join(tmpdir(), "workbench-design-vault-"));
const claudeConfig = mkdtempSync(join(tmpdir(), "workbench-design-claude-"));
writeFileSync(join(claudeConfig, "settings.json"), JSON.stringify({ permissions: { defaultMode: "default" } }));
makePkmVault(vaultDir);

const results: { step: string; ok: boolean; detail: string }[] = [];
const check = (step: string, ok: boolean, detail = "") => {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`);
};

const child = spawn(process.execPath, ["apps/host/src/main.ts"], {
  env: {
    ...process.env,
    WORKBENCH_DATA_DIR: dataDir,
    WORKBENCH_WEB_DIR: "apps/web/dist",
    WORKBENCH_HOST_LABEL: "노트북",
    WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"),
    WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"),
    CLAUDE_CONFIG_DIR: claudeConfig,
  },
  stdio: ["ignore", "pipe", "inherit"],
});
const ready = await new Promise<{ url: string; token: string }>((done) => {
  createInterface({ input: child.stdout! }).on("line", (line) => {
    if (line.startsWith("WORKBENCH_READY ")) done(JSON.parse(line.slice(16)));
  });
});
const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${ready.url}${path}`, { method, headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return (await response.json()) as T;
};
type Snapshot = { sessions: Session[]; proposals: Proposal[]; artifacts: Artifact[] };
const snapshot = () => api<Snapshot>("GET", "/api/snapshot");
const session = async (id: string) => (await snapshot()).sessions.find((entry) => entry.id === id)!;
const items = async (id: string) => (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${id}/items`)).items;
const until = async (what: () => Promise<boolean>, timeout = 20_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await what()) return true;
    await new Promise((done) => setTimeout(done, 100));
  }
  return false;
};
let requestNo = 0;
const send = (sessionId: string, text: string, extra: Record<string, unknown> = {}) =>
  api("POST", `/api/sessions/${sessionId}/messages`, { requestId: `design-${Date.now()}-${++requestNo}`, text, ...extra });
const idle = (id: string) => until(async () => (await session(id)).status === "idle");
// PUT /api/prefs replaces the whole set: merge into what is there.
const setPrefs = async (patch: Record<string, unknown>) => {
  const { prefs } = await api<{ prefs: Record<string, unknown> }>("GET", "/api/snapshot");
  await api("PUT", "/api/prefs", { prefs: { ...prefs, ...patch } });
};
const waiting = (id: string) => until(async () => (await session(id)).status === "awaitingApproval");

// ── seed ──────────────────────────────────────────────────────────────────────────────────────
const LESSON = [
  "# 3주차 강의안: AI가 쓴 글은 누구의 글인가",
  "",
  "## 목표",
  "",
  "학생이 AI가 고친 글과 자기 글을 나란히 놓고, 무엇이 바뀌었는지 자기 말로 설명한다.",
  "",
  "## 흐름",
  "",
  "1. 질문으로 시작한다. AI가 쓴 글은 누구의 글인가.",
  "2. 사례 세 가지를 함께 읽는다.",
  "3. 짝을 지어 서로의 글을 고쳐 본다.",
  "",
  "## 평가 루브릭",
  "",
  "- 1단계: 질문을 세운다",
  "- 2단계: 근거를 붙인다",
  "- 3단계: 자기 말로 다시 쓴다",
  "",
  "## 과제",
  "",
  "다음 주까지 자기 글 한 편과 AI가 고친 글 한 편을 함께 낸다. 바뀐 곳마다 이유를 한 줄로 적는다.",
  "",
].join("\n");

const dir = (name: string) => {
  const path = join(worksDir, name);
  mkdirSync(path, { recursive: true });
  return path;
};
const lectureDir = dir("lecture");
writeFileSync(join(lectureDir, "강의안.md"), LESSON);
const researchDir = dir("research");
writeFileSync(join(researchDir, "리뷰 메모.md"), "# 리뷰 메모\n\n방법론 절이 짧다. 표본 수와 기간을 밝혀야 한다.\n");

await setPrefs({ onboarding: "done", startScreen: "last", theme: "light", sidebar: true });
await api("PUT", "/api/pkm/vault", { path: vaultDir });
const lectures = await api<Folder>("POST", "/api/folders", { name: "강의", parentId: null });
const term = await api<Folder>("POST", "/api/folders", { name: "2026-2학기", parentId: lectures.id });
const research = await api<Folder>("POST", "/api/folders", { name: "연구", parentId: null });

const newWork = async (title: string, folderId: string | null, cwd: string) => {
  const created = await api<Work>("POST", "/api/works", { title, folderId, cwd });
  // Named by hand, so the automatic title leaves it as it is.
  return api<Work>("PATCH", `/api/works/${created.id}`, { title });
};
const lecture = await newWork("3주차 강의 슬라이드", term.id, lectureDir);
const doc = await api<Artifact>("POST", `/api/works/${lecture.id}/artifacts`, { path: "강의안.md" });
const codex = await api<Session>("POST", `/api/works/${lecture.id}/sessions`, { provider: "codex", purpose: "슬라이드 정리", access: "auto" });
const claude = await api<Session>("POST", `/api/works/${lecture.id}/sessions`, { provider: "claude", purpose: "자료 조사", access: "auto" });

await send(codex.id, "견본: 3주차 슬라이드 구성을 다시 짜 줘. 평가 기준은 강의안 그대로 두고.");
await until(async () => (await session(codex.id)).status !== "idle", 3000);
await idle(codex.id);
await send(codex.id, "도입부를 고쳐 줘. 질문 하나로 시작하게.", { refs: [{ artifactId: doc.id, revision: doc.revision, mode: "edit" }] });
const proposed = await until(async () => (await snapshot()).proposals.some((entry) => entry.artifactId === doc.id && entry.status === "pending"));
await idle(codex.id);
await send(codex.id, "명령 실행해 줘. 폴더에 무엇이 있는지 확인하고 싶어.");
const asked = await waiting(codex.id);

await send(claude.id, "견본: 평가 루브릭에 쓸 자료를 찾아 정리해 줘.");
await until(async () => (await session(claude.id)).status !== "idle", 3000);
await idle(claude.id);
await send(claude.id, "과제 안내 문구를 고쳐 줘.", { plan: true });
const planned = await waiting(claude.id);

const review = await newWork("논문 리뷰 메모", research.id, researchDir);
await api<Artifact>("POST", `/api/works/${review.id}/artifacts`, { path: "리뷰 메모.md" });
const reviewer = await api<Session>("POST", `/api/works/${review.id}/sessions`, { provider: "claude", purpose: "리뷰 정리", access: "auto" });
await send(reviewer.id, "견본: 리뷰 메모를 정리해 줘.");
await until(async () => (await session(reviewer.id)).status !== "idle", 3000);
await idle(reviewer.id);

const meeting = await newWork("학과 회의록 정리", null, dir("meeting"));
const minutes = await api<Session>("POST", `/api/works/${meeting.id}/sessions`, { provider: "codex", purpose: "회의록", access: "auto" });
await send(minutes.id, "견본: 회의록을 정리해 줘.");
await until(async () => (await session(minutes.id)).status !== "idle", 3000);
await idle(minutes.id);

const old = await newWork("지난 학기 성적 정리", null, dir("old"));
const oldSession = await api<Session>("POST", `/api/works/${old.id}/sessions`, { provider: "codex", purpose: "성적", access: "auto" });
await send(oldSession.id, "견본: 성적표를 정리해 줘.");
await until(async () => (await session(oldSession.id)).status !== "idle", 3000);
await idle(oldSession.id);
await api("PATCH", `/api/works/${old.id}`, { archived: true });

// Every work unfolded in the sidebar, so their sessions are rows to click.
await setPrefs({ tree: { closedFolders: [], openWorks: [lecture.id, review.id, meeting.id], closedWorks: [], openDocs: [lecture.id] } });

const seededItems = await items(codex.id);
check(
  "시드: 견본 턴(생각·계획·명령·파일)·수정안·승인 대기·계획 대기",
  proposed && asked && planned && seededItems.some((item) => item.kind === "plan") && seededItems.some((item) => item.kind === "tool" && item.tool === "fileChange"),
  `proposal=${proposed} approval=${asked} plan=${planned} items=${seededItems.length}`,
);

// ── screens ───────────────────────────────────────────────────────────────────────────────────
// Steps run inside the page (both browsers): `js` acts, `wait` is an expression that must turn true.
type Step = { js?: string; wait?: string; prefs?: Record<string, unknown>; reload?: boolean; pause?: number };
type Screen = { name: string; steps: Step[]; settle?: number; cleanup?: Step[]; viewport?: { width: number; height: number } };

const PRELUDE = `
  window.__wb = window.__wb || {
    q(selector, text) {
      const all = [...document.querySelectorAll(selector)];
      return text ? all.find((element) => element.textContent.includes(text)) : all[0];
    },
    click(selector, text) {
      const element = this.q(selector, text);
      if (!element) return false;
      element.scrollIntoView({ block: "nearest" });
      element.click();
      return true;
    },
    key(key, options = {}) {
      const target = document.activeElement || document.body;
      target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }));
      return true;
    },
    type(selector, text) {
      const element = this.q(selector);
      if (!element) return false;
      element.focus();
      const proto = element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(element, text);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    },
    context(selector, text) {
      const element = this.q(selector, text);
      if (!element) return false;
      const box = element.getBoundingClientRect();
      element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: box.left + 60, clientY: box.top + box.height / 2 }));
      return true;
    },
    blur() {
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
      return true;
    },
    has(selector, text) {
      return Boolean(this.q(selector, text));
    },
  };
`;

const row = (id: string) => `.sidebar [data-row-id="${id}"]`;
const openSession = (id: string): Step[] => [{ js: `__wb.click('${row(id)}')`, wait: `__wb.has('.work-view .transcript')` }];
const SCREENS: Screen[] = [
  { name: "01-home", steps: [{ js: "__wb.click('.topbar .brand')", wait: "__wb.has('.start-view .composer-input')" }, { js: "__wb.blur()" }], settle: 1400 },
  {
    name: "02-home-no-sidebar",
    steps: [{ js: "__wb.click('.topbar .brand')", wait: "__wb.has('.start-view')" }, { js: "__wb.click('.topbar-left .icon-button')", wait: "!__wb.has('.sidebar')" }, { js: "__wb.blur()" }],
    settle: 900,
    cleanup: [{ js: "__wb.click('.topbar-left .icon-button')", wait: "__wb.has('.sidebar')" }],
  },
  { name: "03-work-codex", steps: [...openSession(codex.id), { wait: "__wb.has('.approval-card')" }, { js: "__wb.blur()" }], settle: 900 },
  {
    name: "04-work-codex-steps",
    steps: [
      ...openSession(codex.id),
      { js: "document.querySelectorAll('.work-summary').forEach((button) => button.getAttribute('aria-expanded') === 'false' && button.click())", wait: "__wb.has('.work-list')" },
      { js: "const turn = document.querySelector('.turn'); const scroller = document.querySelector('.work-view .transcript'); scroller.scrollTop = turn.offsetTop - 12; scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true }));" },
    ],
    settle: 700,
  },
  { name: "05-work-claude-plan", steps: [...openSession(claude.id), { wait: "__wb.has('.plan-approval')" }, { js: "__wb.blur()" }], settle: 900 },
  {
    name: "06-row-menu",
    steps: [...openSession(codex.id), { js: `__wb.context('${row(codex.id)}')`, wait: "__wb.has('.context-menu')" }],
    settle: 400,
    cleanup: [{ js: "__wb.key('Escape')", wait: "!__wb.has('.context-menu')" }],
  },
  {
    name: "07-search",
    steps: [{ js: "__wb.blur(); __wb.key('k', { ctrlKey: true })", wait: "__wb.has('.palette input')" }, { js: "__wb.type('.palette input', '루브릭')", wait: "__wb.has('.palette-entry')", pause: 600 }],
    settle: 600,
    cleanup: [{ js: "__wb.key('Escape')", wait: "!__wb.has('.palette')" }],
  },
  {
    name: "08-document",
    steps: [
      ...openSession(codex.id),
      { js: "__wb.click('.docs-button')", wait: "__wb.has('.docs-menu .menu-item', '강의안.md')" },
      { js: "__wb.click('.docs-menu .menu-item', '강의안.md')", wait: "__wb.has('.document-view')" },
    ],
    settle: 1500,
  },
  {
    name: "09-settings",
    steps: [...openSession(codex.id), { js: "__wb.click('.topbar-right .anchor .icon-button')", wait: "__wb.has('.popover .connection')" }],
    settle: 500,
    cleanup: [{ js: "__wb.key('Escape'); document.querySelector('.popover') && __wb.click('.topbar-right .anchor .icon-button')", wait: "!__wb.has('.popover .connection')" }],
  },
  {
    name: "10-appearance",
    steps: [
      ...openSession(codex.id),
      { js: "__wb.click('.topbar-right .anchor .icon-button')", wait: "__wb.has('.popover .text-button', '외형 설정')" },
      { js: "__wb.click('.popover .text-button', '외형 설정')", wait: "__wb.has('.appearance-sheet')" },
    ],
    settle: 600,
    cleanup: [{ js: "__wb.click('.appearance-sheet .sheet-head .icon-button')", wait: "!__wb.has('.appearance-sheet')" }],
  },
  {
    name: "11-access-menu",
    steps: [...openSession(codex.id), { js: "__wb.click('.access-select')", wait: "__wb.has('.access-menu')" }],
    settle: 400,
    cleanup: [{ js: "__wb.key('Escape'); document.querySelector('.access-menu') && __wb.click('.access-select')", wait: "!__wb.has('.access-menu')" }],
  },
  {
    name: "12-vault-cards",
    steps: [{ js: `__wb.click('.vault-row[data-vault-path="20. Information (I)"]')`, wait: "document.querySelectorAll('.pkm-card').length > 1" }],
    settle: 900,
  },
  {
    name: "13-vault-note",
    steps: [
      { js: `__wb.click('.vault-row[data-vault-path="20. Information (I)"]')`, wait: "__wb.has('.pkm-card', 'AI 글쓰기 수업 설계')" },
      { js: "__wb.click('.pkm-card', 'AI 글쓰기 수업 설계')", wait: "__wb.has('.pkm-note-body')" },
    ],
    settle: 900,
  },
  { name: "14-archive", steps: [{ js: "__wb.click('.side-foot .side-row', '보관함')", wait: "__wb.has('.archive-view .archive-row')" }], settle: 500 },
  {
    name: "15-onboarding",
    steps: [{ prefs: { onboarding: "start" }, wait: "__wb.has('.onboarding')" }],
    settle: 700,
    cleanup: [{ prefs: { onboarding: "done" }, wait: "!__wb.has('.onboarding')" }],
  },
  {
    name: "16-work-narrow",
    viewport: { width: 900, height: 760 },
    steps: [...openSession(codex.id), { wait: "__wb.has('.approval-card')" }, { js: "__wb.blur()" }],
    settle: 900,
  },
];
const screens = only ? SCREENS.filter((screen) => only.some((name) => screen.name.includes(name))) : SCREENS;
const VIEWPORT = { width: 1280, height: 860 };
const url = `${ready.url}/?token=${ready.token}`;
const appReady = "__wb.has('.work-view, .start-view, .archive-view, .pkm-center')";

async function chromiumPass() {
  const browser = await chromium.launch();
  const logs: string[] = [];
  try {
    for (const theme of themes) {
      await setPrefs({ theme });
      const page = await browser.newPage({ viewport: VIEWPORT });
      page.on("console", (message) => message.type() === "error" && logs.push(`[${theme}] ${message.text().slice(0, 200)}`));
      page.on("pageerror", (error) => logs.push(`[${theme} pageerror] ${error.message.slice(0, 200)}`));
      const run = (script: string) => page.evaluate(`(() => { ${PRELUDE}; ${script}; return true; })()`);
      const wait = (expression: string, timeout = 12_000) => page.waitForFunction(`(() => { ${PRELUDE}; return Boolean(${expression}); })()`, null, { timeout });
      const step = async (entry: Step) => {
        if (entry.prefs) await setPrefs(entry.prefs);
        if (entry.reload) await page.reload();
        if (entry.js) await run(entry.js);
        if (entry.wait) await wait(entry.wait);
        if (entry.pause) await page.waitForTimeout(entry.pause);
      };
      await page.goto(url);
      await wait(appReady, 20_000);
      for (const screen of screens) {
        try {
          await page.setViewportSize(screen.viewport ?? VIEWPORT);
          for (const entry of screen.steps) await step(entry);
          await page.waitForTimeout(screen.settle ?? 500);
          await page.screenshot({ path: join(outDir, `chromium-${theme}-${screen.name}.png`) });
          for (const entry of screen.cleanup ?? []) await step(entry);
          check(`Chromium ${theme} ${screen.name}`, true);
        } catch (error) {
          check(`Chromium ${theme} ${screen.name}`, false, error instanceof Error ? error.message.split("\n")[0]! : String(error));
          await page.screenshot({ path: join(outDir, `chromium-${theme}-${screen.name}-failure.png`) }).catch(() => undefined);
          await page.goto(url);
          await wait(appReady, 20_000).catch(() => undefined);
        }
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
  check("Chromium 콘솔 오류 없음", logs.length === 0, logs.slice(0, 3).join(" | "));
}

function webkitPass() {
  const scenario = join(outDir, "scenario.json");
  writeFileSync(scenario, JSON.stringify({ url, token: ready.token, base: ready.url, outDir, viewport: VIEWPORT, themes, prelude: PRELUDE, appReady, screens }, null, 2));
  const result = spawnSync("python3", ["scripts/webkit-design-shots.py", scenario], { stdio: "inherit", timeout: 15 * 60_000 });
  check("WebKitGTK 실행", result.status === 0, `exit ${result.status}`);
}

try {
  if (runChromium) await chromiumPass();
  if (runWebkit) webkitPass();
} finally {
  child.kill();
  for (const folder of [dataDir, worksDir, vaultDir, claudeConfig]) rmSync(folder, { recursive: true, force: true });
}
writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
const failed = results.filter((entry) => !entry.ok);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
