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
// Writes <browser>-<theme>-<screen>.png and results.json into outDir. DESIGN_SHOTS_WEB_DIR=<dist>
// takes the screens of another UI build (for before/after pairs).

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium } from "playwright-core";
import type { Artifact, Folder, Proposal, Session, TranscriptItem, Work } from "@workbench/contracts";
import { makePkmVault } from "./fixtures/pkm-vault.ts";

const args = process.argv.slice(2);
const outDir = resolve(args.find((arg) => !arg.startsWith("--")) ?? join(tmpdir(), "wb-design-shots"));
const option = (name: string) => args.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
const higMode = args.includes("--hig");
const auditSource = process.env.HIG_AUDIT_SOURCE ? readFileSync(process.env.HIG_AUDIT_SOURCE, "utf8") : null;
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

const child = spawn(process.execPath, [process.env.DESIGN_SHOTS_HOST_ENTRY ?? "apps/host/src/main.ts"], {
  env: {
    ...process.env,
    WORKBENCH_DATA_DIR: dataDir,
    // Another build of the UI to compare against (a "before" pass), or this checkout's.
    WORKBENCH_WEB_DIR: process.env.DESIGN_SHOTS_WEB_DIR ?? "apps/web/dist",
    WORKBENCH_HOST_LABEL: "노트북",
    WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"),
    WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"),
    CLAUDE_CONFIG_DIR: claudeConfig,
  },
  stdio: ["ignore", "pipe", "inherit"],
});
const ready = await new Promise<{ url: string; token: string }>((done, reject) => {
  child.once("error", reject);
  child.once("exit", code => reject(new Error(`Preview host exited before readiness (${code})`)));
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
await send(minutes.id, higMode ? "스크린샷 견본: 회의록을 정리하고 그림을 확인해 줘." : "견본: 회의록을 정리해 줘.");
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
// `probe` is an expression whose value is printed (Chromium pass), for measuring a layout.
// `assert` names one of the design invariants below; it is checked in both browsers.
type Step = { js?: string; wait?: string; prefs?: Record<string, unknown>; reload?: boolean; pause?: number; probe?: string; assert?: keyof typeof INVARIANTS };
type Screen = { name: string; steps: Step[]; settle?: number; cleanup?: Step[]; viewport?: { width: number; height: number } };

const PRELUDE = `
  window.__wb = window.__wb || {
    q(selector, text) {
      const all = [...document.querySelectorAll(selector)].filter(element => element.getClientRects().length > 0);
      return text ? all.find((element) => element.textContent.includes(text)) : all[0];
    },
    click(selector, text) {
      const element = this.q(selector, text);
      if (!element) return false;
      element.scrollIntoView({ block: "nearest" });
      element.focus({ preventScroll: true });
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

// Design invariants (docs/design/DESIGN.md): each is an expression giving { ok, detail }.
const INVARIANTS = {
  // No side stripes: a left or right border thicker than the top one, or an inset stripe shadow.
  "옆줄 없음": `(() => {
    const bad = [...document.querySelectorAll("body *")].filter((element) => {
      const style = getComputedStyle(element);
      if (style.display === "none" || !element.getClientRects().length) return false;
      const top = parseFloat(style.borderTopWidth);
      const side = (width, kind) => parseFloat(width) > 1.5 && parseFloat(width) > top + 0.5 && kind !== "none";
      const stripe = /inset\\s+[2-9](\\.\\d+)?px\\s+0px\\s+0px/.test(style.boxShadow) || /rgba?\\([^)]*\\)\\s+[2-9](\\.\\d+)?px\\s+0px\\s+0px\\s+0px\\s+inset/.test(style.boxShadow);
      return side(style.borderLeftWidth, style.borderLeftStyle) || side(style.borderRightWidth, style.borderRightStyle) || stripe;
    });
    return { ok: bad.length === 0, detail: bad.slice(0, 3).map((element) => element.className || element.tagName).join(" | ") };
  })()`,
  // The frame's text sits on the type ladder (12 13 14 16 18 20 23 26).
  "틀 글자는 사다리 위": `(() => {
    const ladder = new Set([12, 13, 14, 16, 18, 20, 23, 26]);
    const off = [];
    for (const element of document.querySelectorAll(".sidebar *, .topbar *, .context-menu *, .popover *, .palette *")) {
      const own = [...element.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim());
      if (!own || !element.getClientRects().length) continue;
      const size = Math.round(parseFloat(getComputedStyle(element).fontSize) * 10) / 10;
      if (!ladder.has(size)) off.push((element.className || element.tagName) + ":" + size);
    }
    return { ok: off.length === 0, detail: [...new Set(off)].slice(0, 4).join(" | ") };
  })()`,
  // No glass: nothing blurs what is behind it.
  "흐림 없음": `(() => {
    const blurred = [...document.querySelectorAll("body *")].filter((element) => {
      const style = getComputedStyle(element);
      return (style.backdropFilter && style.backdropFilter !== "none") || (style.webkitBackdropFilter && style.webkitBackdropFilter !== "none");
    });
    return { ok: blurred.length === 0, detail: blurred.slice(0, 3).map((element) => element.className).join(" | ") };
  })()`,
  // One desk: the sidebar and the top bar share the frame color.
  "틀 색 하나": `(() => {
    const side = document.querySelector(".sidebar");
    const top = document.querySelector(".topbar");
    const a = side && getComputedStyle(side).backgroundColor;
    const b = top && getComputedStyle(top).backgroundColor;
    return { ok: Boolean(a) && a === b, detail: a + " / " + b };
  })()`,
};

const row = (id: string) => `.sidebar [data-row-id="${id}"]`;
// A session row, or the row of a work with one session (the tree shows no session row for it).
const openSession = (id: string): Step[] => [
  { js: "if (!__wb.has('.sidebar')) __wb.click('.topbar-left [aria-label=\"사이드바 열기\"]')", wait: `__wb.has('${row(id)}')` },
  { js: `__wb.click('${row(id)}')`, wait: `__wb.has('.work-view .transcript')` },
];
const SCREENS: Screen[] = [
  {
    name: "01-home",
    steps: [{ js: "__wb.click('.topbar .brand')", wait: "__wb.has('.start-view .composer-input')" }, { js: "__wb.blur()" }, { assert: "옆줄 없음" }, { assert: "틀 글자는 사다리 위" }, { assert: "틀 색 하나" }],
    settle: 1400,
  },
  {
    name: "02-home-no-sidebar",
    steps: [{ js: "__wb.click('.topbar .brand')", wait: "__wb.has('.start-view')" }, { js: "__wb.click('.topbar-left .icon-button')", wait: "!__wb.has('.sidebar')" }, { js: "__wb.blur()" }],
    settle: 900,
    cleanup: [{ js: "__wb.click('.topbar-left .icon-button')", wait: "__wb.has('.sidebar')" }],
  },
  {
    name: "03-work-codex",
    steps: [...openSession(codex.id), { wait: "__wb.has('.approval-card')" }, { js: "__wb.blur()" }, { assert: "옆줄 없음" }, { assert: "틀 글자는 사다리 위" }, { assert: "흐림 없음" }, { assert: "틀 색 하나" }],
    settle: 900,
  },
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
    steps: [
      { js: "__wb.blur(); __wb.key('k', { ctrlKey: true })", wait: "__wb.has('.palette input')" },
      { js: "__wb.type('.palette input', '루브릭')", wait: "__wb.has('.palette-entry')", pause: 600 },
      { assert: "흐림 없음" },
      { assert: "틀 글자는 사다리 위" },
    ],
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
  {
    name: "17-integrations",
    steps: [
      ...openSession(codex.id),
      { js: "__wb.click('.topbar-right .anchor .icon-button')", wait: "__wb.has('.popover .text-button', 'MCP')" },
      { js: "__wb.click('.popover .text-button', 'MCP')", wait: "__wb.has('.integrations-sheet')" },
    ],
    settle: 1200,
    cleanup: [{ js: "__wb.click('.integrations-sheet .sheet-head .icon-button')", wait: "!__wb.has('.integrations-sheet')" }],
  },
  {
    // "보드" became part of "지금" (P3); the projects mode is the home's other view of works.
    name: "18-home-projects",
    steps: [
      { js: "__wb.click('.topbar .brand')", wait: "__wb.has('.home-mode-bar')" },
      { js: "__wb.click('.home-mode-bar button', '프로젝트')", wait: "__wb.has('.home-modes.mode-projects')" },
      { js: "__wb.blur()" },
    ],
    settle: 900,
    cleanup: [{ js: "__wb.click('.home-mode-bar button', '지금')", wait: "__wb.has('.home-modes.mode-now')" }],
  },
  {
    name: "19-schedule",
    steps: [
      ...openSession(codex.id),
      { js: `__wb.context('${row(codex.id)}')`, wait: "__wb.has('.context-menu-item', '예약 작업')" },
      { js: "__wb.click('.context-menu-item', '예약 작업')", wait: "__wb.has('.schedule-dialog')" },
    ],
    settle: 600,
    cleanup: [{ js: "__wb.key('Escape'); document.querySelector('.modal-backdrop') && document.querySelector('.modal-backdrop').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))", wait: "!__wb.has('.schedule-dialog')" }],
  },
  {
    name: "21-doc-compare",
    steps: [
      ...openSession(codex.id),
      { js: "__wb.click('.docs-button')", wait: "__wb.has('.docs-menu .menu-item', '강의안.md')" },
      { js: "__wb.click('.docs-menu .menu-item', '강의안.md')", wait: "__wb.has('.document-view .doc-proposal')" },
      { js: "__wb.click('.doc-proposal .button', '미리보기')", wait: "__wb.has('.doc-compare')" },
    ],
    settle: 900,
    cleanup: [{ js: "__wb.click('.doc-compare-actions .button', '닫기')", wait: "!__wb.has('.doc-compare')" }],
  },
  {
    name: "22-split",
    steps: [
      ...openSession(codex.id),
      { js: "__wb.click('.docs-button')", wait: "__wb.has('.docs-menu .menu-item', '강의안.md')" },
      { js: "__wb.click('.docs-menu .menu-item', '강의안.md')", wait: "__wb.has('.work-mode-bar')" },
      { js: "__wb.click('.work-mode-bar button', '나란히')", wait: "__wb.has('.split-host.split')" },
    ],
    settle: 1200,
    cleanup: [{ js: "__wb.click('.work-mode-bar button', '대화')", wait: "!__wb.has('.split-host.split')" }],
  },
  {
    name: "23-answer-codex",
    steps: [...openSession(meeting.id), { wait: "__wb.has('.turn-assistant .markdown table')" }, { js: "__wb.blur(); const scroller = document.querySelector('.work-view .transcript'); const answer = document.querySelector('.turn-assistant .markdown'); scroller.scrollTop = answer.offsetTop - 80;" }],
    settle: 800,
  },
  {
    name: "24-answer-claude",
    steps: [
      ...openSession(review.id),
      { wait: "__wb.has('.turn-assistant .markdown table')" },
      { js: "__wb.blur(); const scroller = document.querySelector('.work-view .transcript'); const answer = document.querySelector('.turn-assistant .markdown'); scroller.scrollTop = answer.offsetTop - 80;" },
      { probe: "(() => { const w = (s) => [...document.querySelectorAll(s)].map((e) => Math.round(e.getBoundingClientRect().width)); return { bar: w('.work-view .composer-bar'), left: w('.work-view .composer-left'), right: w('.work-view .composer-right'), leftKids: [...document.querySelectorAll('.work-view .composer-left > *')].map((e) => e.className.split(' ')[0] + ':' + Math.round(e.getBoundingClientRect().width)), rightKids: [...document.querySelectorAll('.work-view .composer-right > *')].map((e) => e.className.split(' ')[0] + ':' + Math.round(e.getBoundingClientRect().width)) }; })()" },
    ],
    settle: 800,
  },
  {
    name: "20-switcher",
    steps: [...openSession(codex.id), { js: "__wb.blur(); __wb.key('Tab', { ctrlKey: true })", wait: "__wb.has('.switcher')" }],
    settle: 500,
    cleanup: [{ js: "window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', bubbles: true }))", wait: "!__wb.has('.switcher')" }],
  },
];
const gridSteps = (n: number): Step[] => [
  { js: "if (!__wb.has('[aria-label=\"화면 배치\"]')) __wb.click('[aria-label=\"연결과 설정\"]')", wait: "__wb.has('[aria-label=\"화면 배치\"]')" },
  { js: "__wb.click('[aria-label=\"화면 배치\"]')", wait: "__wb.has('.layout-options button')" },
  { js: `__wb.click('.layout-options button', '${n}칸')`, wait: `document.querySelectorAll('.pane:not([hidden])').length === ${n}${n === 1 ? " && !document.querySelector('.panes')?.dataset.grid" : ""}` },
];
const HIG_SCREENS: Screen[] = [
  ...SCREENS.filter(s => ["01-home", "03-work-codex", "07-search", "09-settings"].includes(s.name)).map(s => ({ ...s, steps: [...(s.name === "01-home" ? gridSteps(1) : []), ...s.steps.filter(step => !step.assert)] })),
  { name: "hig-project", steps: [{ js: `__wb.click('${row(lecture.id)}')`, wait: "__wb.has('.project-view')" }] },
  { ...SCREENS.find(screen => screen.name === "08-document")!, name: "hig-editor" },
  { name: "hig-images", steps: [...openSession(minutes.id),
    { wait: "__wb.has('.transcript .attach-preview')" },
    { js: "document.querySelector('.transcript .attach-preview').scrollIntoView({block:'center'})", wait: "[...document.querySelectorAll('.transcript .attach-thumb img')].some(img => img.complete && img.naturalWidth > 0)" },
  ] },
  { name: "hig-image-gallery", steps: [
    { js: "__wb.click('.transcript .attach-thumb:not(:disabled)')", wait: "__wb.has('.attach-lightbox img')" },
    { wait: "document.querySelector('.attach-lightbox img')?.naturalWidth > 0" },
  ], cleanup: [{ js: "__wb.click('[aria-label=\"그림 닫기\"]')", wait: "!__wb.has('.attach-lightbox')" }] },
  { name: "hig-grid-nine", steps: gridSteps(9), viewport: { width: 1600, height: 1000 } },
  { name: "hig-grid-focus", steps: [{ js: "__wb.click('[aria-label=\"이 칸 확대\"]')", wait: "document.querySelectorAll('.pane:not([hidden])').length === 1" }], viewport: { width: 1600, height: 1000 }, cleanup: [{ js: "__wb.click('[aria-label=\"전체 칸 보기\"]')" }] },
  { name: "hig-work-links", steps: [{ js: "__wb.click('[aria-label=\"화면 배치\"]')" }, { js: "__wb.click('[role^=menuitem]', '작업 연결')", wait: "__wb.has('.work-link-dialog[open]')" },
    { js: `const fields = document.querySelectorAll('.work-link-pair select'); fields[0].value = '${minutes.id}'; fields[0].dispatchEvent(new Event('change', {bubbles:true}));` },
    { js: `const target = document.querySelectorAll('.work-link-pair select')[1]; target.value = '${reviewer.id}'; target.dispatchEvent(new Event('change', {bubbles:true}));` },
    { js: "__wb.type('.work-link-dialog textarea', 'HIG 연결 확인: 요청을 정리해 줘.');" },
    { js: "__wb.click('.work-link-dialog [type=submit]')", wait: "__wb.has('.work-link-dialog [role=status]', '요청을 보냈습니다') && __wb.has('.work-link-history')" },
  ], cleanup: [{ js: "__wb.click('[aria-label=\"작업 연결 닫기\"]')" }] },
  { name: "hig-narrow", steps: [...gridSteps(1), ...openSession(minutes.id)], viewport: { width: 744, height: 900 } },
  { name: "hig-large-text", steps: [{ js: "document.documentElement.style.fontSize = '32px'" }], viewport: { width: 1000, height: 900 }, cleanup: [{ js: "document.documentElement.style.fontSize = ''" }] },
];
const availableScreens = higMode ? HIG_SCREENS : SCREENS;
const screens = only ? availableScreens.filter((screen) => only.some((name) => screen.name.includes(name))) : availableScreens;
const VIEWPORT = { width: Number(option("width")) || 1280, height: Number(option("height")) || 860 };
const url = `${ready.url}/?token=${ready.token}`;
const appReady = "__wb.has('.work-view, .start-view, .archive-view, .pkm-center, .document-view, .project-view, .browser-view')";

async function chromiumPass() {
  const browser = await chromium.launch();
  const logs: string[] = [];
  try {
    for (const theme of themes) {
      await setPrefs({ theme });
      const page = await browser.newPage({ viewport: VIEWPORT });
      page.on("console", (message) => message.type() === "error" && logs.push(`[${theme}] ${message.text().slice(0, 200)}`));
      page.on("pageerror", (error) => logs.push(`[${theme} pageerror] ${(error.stack ?? error.message).slice(0, 6000)}`));
      const run = (script: string) => page.evaluate(`(() => { ${PRELUDE}; ${script}; return true; })()`);
      const wait = (expression: string, timeout = 12_000) => page.waitForFunction(`(() => { ${PRELUDE}; return Boolean(${expression}); })()`, null, { timeout });
      const step = async (entry: Step) => {
        if (entry.prefs) await setPrefs(entry.prefs);
        if (entry.reload) await page.reload();
        if (entry.js) await run(entry.js);
        if (entry.wait) await wait(entry.wait);
        if (entry.pause) await page.waitForTimeout(entry.pause);
        if (entry.probe) console.log(`PROBE ${theme}: ${JSON.stringify(await page.evaluate(`(() => { ${PRELUDE}; return (${entry.probe}); })()`))}`);
        if (entry.assert) {
          const result = (await page.evaluate(INVARIANTS[entry.assert])) as { ok: boolean; detail: string };
          check(`Chromium ${theme} ${entry.assert}`, result.ok, result.detail);
        }
      };
      await page.goto(url);
      await wait(appReady, 20_000);
      for (const screen of screens) {
        try {
          await page.setViewportSize(screen.viewport ?? VIEWPORT);
          for (const entry of screen.steps) await step(entry);
          if (args.includes("--close-sidebar")) await run("__wb.click('.sidebar-scrim')");
          await page.waitForTimeout(screen.settle ?? 500);
          if (screen.name === "hig-editor") {
            const editor = await page.locator(".office-frame").elementHandle();
            const frame = await editor?.contentFrame();
            if (!frame) throw new Error("Office editor iframe did not open");
            await frame.waitForFunction(() => document.querySelector("style[data-wb-office-chrome]") && document.querySelector(".ribbon"));
            const chrome = await frame.evaluate(async () => {
              const fonts = await document.fonts.load('400 13px "Pretendard Variable"');
              const asset = await fetch('/office/fonts/pretendard/PretendardVariable.ttf');
              return { format: document.documentElement.dataset.wbOfficeFormat, family: getComputedStyle(document.querySelector(".ribbon")!).fontFamily, font: fonts.some(font => font.status === 'loaded'), asset: asset.status };
            });
            check(`Chromium ${theme} actual office chrome`, chrome.format === "markdown" && chrome.family.includes("Pretendard Variable") && chrome.font && chrome.asset === 200, JSON.stringify(chrome));
          }
          if (higMode) {
            await page.evaluate(() => document.fonts.ready);
            const font = await page.evaluate(() => document.fonts.check('400 17px "Pretendard Variable"'));
            check(`Chromium ${theme} ${screen.name} bundled font`, font);
            if (auditSource) {
              await page.evaluate(() => { (window as Window & { HIG_AUDIT?: unknown }).HIG_AUDIT = { pxPerPt: 1, minTextPt: 10, minTarget: 28 }; });
              writeFileSync(join(outDir, `audit-${theme}-${screen.name}.json`), JSON.stringify(await page.evaluate(auditSource), null, 2));
            }
          }
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

/**
 * Reduced motion (after the screenshots, since it adds a turn): while an engine writes a long
 * answer, the page shows that it works but no animation keeps looping. Then, without the setting,
 * the same moment does loop (the working segment), so the check can fail.
 */
async function motionCheck() {
  const browser = await chromium.launch();
  try {
    const looping = async (reducedMotion: "reduce" | "no-preference") => {
      const page = await browser.newPage({ viewport: VIEWPORT, reducedMotion });
      await page.goto(url);
      await page.waitForFunction(`(() => { ${PRELUDE}; return Boolean(${appReady}); })()`, null, { timeout: 20_000 });
      for (const entry of openSession(meeting.id)) {
        await page.evaluate(`(() => { ${PRELUDE}; ${entry.js}; return true; })()`);
        await page.waitForFunction(`(() => { ${PRELUDE}; return Boolean(${entry.wait}); })()`, null, { timeout: 12_000 });
      }
      await send(minutes.id, "길게 설명해 줘.");
      await page.waitForSelector('.work-view .composer[data-phase="waiting"]', { timeout: 10_000 });
      await page.waitForTimeout(600);
      const names = (await page.evaluate(
        `document.getAnimations().filter((animation) => animation.playState === "running" && animation.effect && animation.effect.getComputedTiming().iterations === Infinity).map((animation) => animation.animationName || "waapi")`,
      )) as string[];
      await idle(minutes.id);
      await page.close();
      return names;
    };
    const still = await looping("reduce");
    const moving = await looping("no-preference");
    check("Chromium 움직임 줄이기: 엔진이 일하는 동안에도 반복 애니메이션 0", still.length === 0 && moving.length > 0, `줄이기 ${still.join(", ") || "없음"} · 보통 ${moving.join(", ")}`);
  } finally {
    await browser.close();
  }
}

function webkitPass() {
  const scenario = join(outDir, "scenario.json");
  writeFileSync(scenario, JSON.stringify({ url, token: ready.token, base: ready.url, outDir, viewport: VIEWPORT, themes, prelude: PRELUDE, appReady, screens, invariants: INVARIANTS }, null, 2));
  const result = spawnSync("python3", ["scripts/webkit-design-shots.py", scenario], { stdio: "inherit", timeout: 15 * 60_000 });
  check("WebKitGTK 실행", result.status === 0, `exit ${result.status}`);
}

try {
  if (args.includes("--serve")) {
    // An owned fixture host for external visual reviewers; never the user's app/data.
    writeFileSync(join(outDir, "preview.json"), JSON.stringify({ url, host: ready.url, token: ready.token, sessions: { codex: codex.id, claude: claude.id, minutes: minutes.id } }, null, 2), { mode: 0o600 });
    console.log(`Fixture preview ready: ${join(outDir, "preview.json")}`);
    await new Promise<void>(done => { process.once("SIGTERM", done); process.once("SIGINT", done); });
  } else {
    if (runChromium) await chromiumPass();
    if (runWebkit) webkitPass();
    if (runChromium && !only && !higMode) await motionCheck();
  }
} finally {
  child.kill();
  for (const folder of [dataDir, worksDir, vaultDir, claudeConfig]) rmSync(folder, { recursive: true, force: true });
}
writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
const failed = results.filter((entry) => !entry.ok);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
