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
//        [--motion] (the motion bursts, WebKitGTK) [--reduced-motion] (WebKitGTK with reduced motion)
// Writes <browser>-<theme>-<screen>.png and results.json into outDir. DESIGN_SHOTS_WEB_DIR=<dist>
// takes the screens of another UI build (for before/after pairs).
// Search (07-search, u25x-claude-find) needs the Rust search worker: WORKBENCH_SEARCH_WORKER_BIN, or
// a build of it in this checkout (cargo build --offline in apps/desktop/search-worker).

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium } from "playwright-core";
import type { Artifact, Attachment, Folder, Proposal, Session, TranscriptItem, Work } from "@workbench/contracts";
import { makePkmVault } from "./fixtures/pkm-vault.ts";
import { pagePng } from "./fixtures/png.mjs";

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

const searchWorker = process.env.WORKBENCH_SEARCH_WORKER_BIN
  ?? ["release", "debug"].map((profile) => resolve(`apps/desktop/search-worker/target/${profile}/workbench-search-worker`)).find((path) => existsSync(path));
if (!searchWorker) console.log("No search worker: the search screens (07-search, u25x-claude-find) cannot find anything.");
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
    ...(searchWorker ? { WORKBENCH_SEARCH_WORKER_BIN: searchWorker } : {}),
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

const LONG_REQUEST = [
  "다음 주 3주차 수업 자료를 같이 준비하고 싶어. 지난 학기 판서 사진을 붙였으니 흐름을 참고해 줘.",
  "",
  "학생들이 AI가 고친 글을 그대로 내는 일이 많았어. 이번에는 자기 글과 AI가 고친 글을 나란히 놓고, 무엇이 왜 바뀌었는지 자기 말로 설명하게 만들고 싶어.",
  "",
  "조건은 이래.",
  "- 도입은 10분 안에 끝내고, 질문 하나로 시작할 것",
  "- 사례는 세 개, 전공이 다른 학생도 읽을 수 있는 글로",
  "- 평가 기준은 강의안의 루브릭을 그대로 쓸 것",
  "",
  "마지막으로, 과제 안내는 한 장으로 줄여 줘. 제출 형식과 마감만 분명하면 돼.",
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

// The screens here were written for the one-column sidebar: they keep it by preference. The
// navigator's own screens (--only=nav-u35…) set the layout they show, the automatic one included.
await setPrefs({ onboarding: "done", startScreen: "last", theme: "light", sidebar: true, navigator: { layout: "tree" } });
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
// U28 screens: a Word document of the project as well (a minimal .docx, made here).
const WORD_NAME = "가을 특강 계획.docx";
const word = only?.some((name) => name.startsWith("u28")) ? await (async () => {
  const make = String.raw`
import sys, zipfile
from xml.sax.saxutils import escape
W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
para = lambda text: '<w:p><w:r><w:t xml:space="preserve">%s</w:t></w:r></w:p>' % escape(text)
out, texts = sys.argv[1], sys.argv[2:]
ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
doc = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document %s><w:body>%s<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>' % (W, ''.join(para(t) for t in texts))
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', ct); z.writestr('_rels/.rels', rels); z.writestr('word/document.xml', doc)
`;
  execFileSync("python3", ["-I", "-c", make, join(lectureDir, WORD_NAME), "가을 특강 계획", "질문에서 시작하는 글쓰기: 학생이 먼저 묻고, 교수자가 그 질문을 따라 강의를 엮는다. 첫 시간은 질문 목록을 함께 만드는 데 쓴다.", "일정: 10월 28일 오후 3시, 인문관 204호", "준비물: 지난 학기 설문 결과와 평가 기준표"]);
  return api<Artifact>("POST", `/api/works/${lecture.id}/artifacts`, { path: WORD_NAME });
})() : null;
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

// A long request of several paragraphs with a picture: it folds after a few lines in the note.
const board = await (await fetch(`${ready.url}/api/attachments`, {
  method: "POST",
  headers: { authorization: `Bearer ${ready.token}`, "content-type": "image/png", "x-file-name": encodeURIComponent("지난 학기 판서.png"), "x-workbench-work": lecture.id },
  body: new Uint8Array(pagePng(480, 300, [38, 98, 160])),
})).json() as Attachment;
await send(claude.id, LONG_REQUEST, { attachments: [board] });
await until(async () => (await session(claude.id)).status !== "idle", 3000);
await idle(claude.id);
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

// A design the engine made in the conversation: its file card shows the picture, not a badge.
const card = { schemaVersion: 1, width: 1080, height: 1350, unit: "px", pages: [{ id: "p1", background: { type: "gradient", kind: "linear", angle: 160, stops: [{ offset: 0, color: "#1f4e8c" }, { offset: 1, color: "#0f7a7a" }] }, objects: [
  { id: "t1", type: "textbox", text: "학과 회의 요약", left: 540, top: 420, width: 860, originX: "center", originY: "center", fontFamily: "Pretendard", fontSize: 96, fontWeight: 700, fill: "#ffffff", textAlign: "center" },
  { id: "t2", type: "textbox", text: "과제 마감 · 녹음 30분 57초 · 질문 3개", left: 540, top: 600, width: 860, originX: "center", originY: "center", fontFamily: "Pretendard", fontSize: 44, fill: "#e6f0ff", textAlign: "center" },
] }] };
writeFileSync(join(worksDir, "meeting", "카드원본.design.json"), JSON.stringify(card));
await send(minutes.id, "[[cp 카드원본.design.json 회의-요약-카드.design.json]] 회의 요약을 카드 한 장으로 만들어 줘.");
if (await waiting(minutes.id)) {
  const ask = (await items(minutes.id)).findLast((item) => item.kind === "approval" && item.decision === null);
  if (ask) await api("POST", `/api/sessions/${minutes.id}/approvals/${encodeURIComponent(ask.id)}`, { decision: "accept" });
}
await idle(minutes.id);

// An Office file the engine made: its card keeps the first-page preview it had before U25.
const deck = await api<Artifact & { code?: string; message?: string }>("POST", `/api/works/${meeting.id}/office-documents`, { format: "pptx", name: "발표원본" });
if (deck.path) {
  await send(minutes.id, `[[cp ${deck.path.split("/").at(-1)} 회의-발표.pptx]] 회의 내용을 발표 자료로 만들어 줘.`);
  if (await waiting(minutes.id)) {
    const ask = (await items(minutes.id)).findLast((item) => item.kind === "approval" && item.decision === null);
    if (ask) await api("POST", `/api/sessions/${minutes.id}/approvals/${encodeURIComponent(ask.id)}`, { decision: "accept" });
  }
  await idle(minutes.id);
} else console.log(`Office 견본 없음: ${deck.message ?? deck.code ?? "?"}`);

// The meeting conversation hands a request to the review one (the right sidebar's 연결 › 대화).
await api("POST", "/api/handoffs", { requestId: `design-handoff-${Date.now()}`, sourceSessionId: minutes.id, targetSessionId: reviewer.id, text: "견본: 회의에서 나온 리뷰 의견을 메모에 붙여 줘.", refs: [] });
await until(async () => (await session(reviewer.id)).status !== "idle", 3000);
await idle(reviewer.id);
// …and to one that was archived since: 연결 says 보관됨 and opens that conversation itself.
const memo = await api<Session>("POST", `/api/works/${meeting.id}/sessions`, { provider: "codex", purpose: "지난 회의 메모", access: "auto" });
await api("POST", "/api/handoffs", { requestId: `design-handoff-memo-${Date.now()}`, sourceSessionId: minutes.id, targetSessionId: memo.id, text: "견본: 지난 회의에서 정한 것을 정리해 줘.", refs: [] });
await until(async () => (await session(memo.id)).status !== "idle", 3000);
await idle(memo.id);
await api("PATCH", `/api/sessions/${memo.id}`, { archived: true });

const old = await newWork("지난 학기 성적 정리", null, dir("old"));
const oldSession = await api<Session>("POST", `/api/works/${old.id}/sessions`, { provider: "codex", purpose: "성적", access: "auto" });
await send(oldSession.id, "견본: 성적표를 정리해 줘.");
await until(async () => (await session(oldSession.id)).status !== "idle", 3000);
await idle(oldSession.id);
await api("PATCH", `/api/works/${old.id}`, { archived: true });

// --only=nav-…: a project with six documents, four of them with a document AI (the user's case).
const navMode = only?.some(name => name.startsWith("nav-")) ?? false;
let papers: Work | null = null;
let paperDocs: Artifact[] = [];
let paperAgents: Session[] = [];
let draft: Artifact | null = null;
let paperMain: Session | null = null;
let emptyFolder: Folder | null = null;
if (navMode) {
  const papersDir = dir("papers");
  const names = ["word-source.md", "style.md", "강의 계획.md", "회의 요약.md", "읽을거리.txt", "01-word-workshop.md"];
  for (const name of names) writeFileSync(join(papersDir, name), `# ${name}\n\n견본 문서입니다.\n`);
  papers = await newWork("문서 정리", null, papersDir);
  const main = await api<Session>("POST", `/api/works/${papers.id}/sessions`, { provider: "codex", purpose: "문서 정리", access: "auto" });
  paperMain = main;
  for (const name of names) paperDocs.push(await api<Artifact>("POST", `/api/works/${papers.id}/artifacts`, { path: name }));
  for (const [index, artifact] of paperDocs.slice(0, 4).entries())
    paperAgents.push(await api<Session>("POST", `/api/artifacts/${artifact.id}/document-session`, { parentSessionId: main.id, provider: index % 2 ? "claude" : "codex" }));
  // A project in the app's own work area (no folder chosen): the only place the trash takes files from.
  const inApp = async (title: string, name: string) => {
    const created = await api<Work>("POST", "/api/works", { title });
    mkdirSync(created.cwd, { recursive: true });
    writeFileSync(join(created.cwd, name), `# ${name}\n\n견본 문서입니다.\n`);
    return { work: created, doc: await api<Artifact>("POST", `/api/works/${created.id}/artifacts`, { path: name }) };
  };
  draft = (await inApp("앱 작업 영역", "초안.md")).doc;
  // A project deleted after one of its documents went to the trash: it waits in 보관함 under the old name.
  const past = await inApp("지난 학기 자료", "지난 강의안.md");
  const trashed = await api<Artifact>("POST", `/api/artifacts/${past.doc.id}/remove`, { action: "trash" });
  check("시드: 앱 작업 영역의 문서는 휴지통으로", trashed.removed?.kind === "trash", JSON.stringify(trashed).slice(0, 200));
  await api("DELETE", `/api/works/${past.work.id}`);
  // A request left waiting (kept after a stop) on one document AI: it must stay with the conversation.
  await send(paperAgents[2]!.id, "천천히 길게 정리해 줘");
  await until(async () => (await session(paperAgents[2]!.id)).status === "running", 5000);
  await send(paperAgents[2]!.id, "끝나면 표로도 정리해 줘", { mode: "queue" });
  await api("POST", `/api/sessions/${paperAgents[2]!.id}/interrupt`, {});
  await idle(paperAgents[2]!.id);
  check("시드: 문서 AI에 남겨 둔 요청", (await session(paperAgents[2]!.id)).queued.some((entry) => entry.held), JSON.stringify((await session(paperAgents[2]!.id)).queued));
  // One answered while nobody looked: its document row must still say so.
  await send(paperAgents[0]!.id, "견본: 이 문서를 한 줄로 요약해 줘.");
  await until(async () => (await session(paperAgents[0]!.id)).status !== "idle", 3000);
  await idle(paperAgents[0]!.id);
}

// The navigator's screens (--only=nav-u35…): projects that read as notes in the list (a note's first
// words, tags, a stage), a folder with nothing in it, and a web tab's AI.
if (navMode && papers && only?.some((name) => name.startsWith("nav-u35"))) {
  emptyFolder = await api<Folder>("POST", "/api/folders", { name: "새 학기 준비", parentId: null });
  const note = async (workId: string, tags: string[], body: string, stage?: number) => {
    const project = (method: string, path: string, payload?: unknown) => api(method, `/api/projects/${workId}${path}`, payload);
    await project("PUT", "/property", { key: "tags", values: tags });
    const stages = await api<{ name: string }[]>("GET", "/api/projects/stages");
    if (stage !== undefined && stages[stage]) await project("PUT", "/stage", { stage: stages[stage]!.name });
    const page = await api<{ note: { revision: number | null } }>("GET", `/api/projects/${workId}`);
    await project("PUT", "/body", { baseRevision: page.note.revision, body });
  };
  await note(papers.id, ["문서", "정리"], "워드 원고와 강의 계획을 한 폴더에 모으고, 문서마다 AI에게 맡긴 일을 적어 둔다.\n\n- word-source.md: 요약 한 줄\n- 강의 계획.md: 표로 정리\n", 1);
  await note(lecture.id, ["강의", "AI글쓰기"], "3주차 수업은 질문 → 사례 → 실습 순서로 다시 짠다. 사례는 한 장에 하나씩, 5분 안에 읽히게 줄인다.\n", 1);
  await note(review.id, ["연구/리뷰"], "방법론 절이 짧다. 표본 수와 기간을 밝혀 달라고 적는다.\n", 0);
}

// The project note screens (--only=u26…, u34…): the lecture note as a project in use has it —
// properties, a body, decisions and open questions — written through the gateway, so the file is real.
const u26 = only?.some((name) => name.startsWith("u26") || name.startsWith("u34")) ?? false;
if (u26) {
  const project = (method: string, path: string, body?: unknown) => api(method, `/api/projects/${lecture.id}${path}`, body);
  const stages = await api<{ name: string }[]>("GET", "/api/projects/stages");
  if (stages[1] ?? stages[0]) await project("PUT", "/stage", { stage: (stages[1] ?? stages[0])!.name });
  await project("PUT", "/property", { key: "tags", values: ["강의", "AI글쓰기"] });
  await project("PUT", "/property", { key: "종류", values: ["강의"] });
  await project("PUT", "/property", { key: "마감일", values: ["2026-11-20"] });
  await project("PUT", "/property", { key: "중요도", values: ["높음"] });
  await project("PUT", "/property", { key: "목표", values: ["학생이 AI가 고친 글과 자기 글의 차이를 자기 말로 설명하게 한다."] });
  const page = await api<{ note: { revision: number | null } }>("GET", `/api/projects/${lecture.id}`);
  await project("PUT", "/body", { baseRevision: page.note.revision, body: ["## 이번 주에 할 일", "", "- 슬라이드 구성을 질문 → 사례 → 실습 순서로 다시 짠다.", "- 루브릭에 쓸 근거 자료를 모은다.", "- 과제 안내 문구를 학생 눈높이로 고친다.", "", "## 메모", "", "지난 학기에는 사례가 너무 길어 실습 시간이 모자랐다. 사례는 한 장에 하나씩, 5분 안에 읽히게 줄인다.", ""].join("\n") });
  await project("POST", "/entries", { section: "decision", text: "평가 기준은 강의안의 루브릭 세 단계를 그대로 쓴다." });
  await project("POST", "/entries", { section: "decision", text: "도입부는 질문 하나로 시작한다." });
  await project("POST", "/entries", { section: "question", text: "과제 마감을 한 주 늦출 것인가?" });
  await project("POST", "/entries", { section: "question", text: "사례 세 가지 중 하나를 학생 글로 바꿀 수 있는가?" });
  // A multi-line property (a block scalar), which the page shows but leaves to the source.
  const written = await api<{ note: { source: string; revision: number } }>("GET", `/api/projects/${lecture.id}`);
  const withSummary = written.note.source.replace("\n---\n", "\n요약: |\n  도입 질문 → 사례 → 실습.\n\n  사례는 한 장에 하나씩.\n---\n");
  await project("PUT", "/source", { text: withSummary, baseRevision: written.note.revision });
  // The meeting project's note: readable, then broken outside the app (Obsidian, sync).
  const meetingProject = (method: string, path: string, body?: unknown) => api(method, `/api/projects/${meeting.id}${path}`, body);
  await meetingProject("PUT", "/property", { key: "종류", values: ["회의"] });
  await meetingProject("PUT", "/property", { key: "마감일", values: ["2026-11-27"] });
  const minutesNote = await api<{ note: { path: string; source: string } }>("GET", `/api/projects/${meeting.id}`);
  writeFileSync(minutesNote.note.path, minutesNote.note.source.replace(/\n---\n/, "\n깨진 줄: [닫히지 않은 괄호\n---\n"));
  // The review project's note: properties only, and no line ending after the closing `---`.
  await api("PUT", `/api/projects/${review.id}/property`, { key: "종류", values: ["리뷰"] });
  // Another project's 목표: the lecture's own 목표 is a sentence and stays a text field all the same.
  await api("PUT", `/api/projects/${review.id}/property`, { key: "목표", values: ["선행 연구의 방법을 한 장으로 요약한다."] });
  const reviewNote = await api<{ note: { path: string; source: string } }>("GET", `/api/projects/${review.id}`);
  writeFileSync(reviewNote.note.path, reviewNote.note.source.replace(/\n$/, ""));
}

// Every work unfolded in the sidebar, so their sessions are rows to click.
const navWorks = [...(papers ? [papers.id] : []), ...(draft ? [draft.workId] : [])];
await setPrefs({ tree: { closedFolders: [], openWorks: [lecture.id, review.id, meeting.id, ...navWorks], closedWorks: [], openDocs: [lecture.id, ...navWorks] } });

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
// `burst`: WebKitGTK only — start a motion with `js` (after `until` holds) and take `frames` snapshots `every` ms apart.
type Burst = { name: string; js?: string; until?: string; frames?: number; every?: number };
type Step = { js?: string; wait?: string; prefs?: Record<string, unknown>; reload?: boolean; pause?: number; probe?: string; assert?: keyof typeof INVARIANTS; burst?: Burst;
  /** A real key press (GTK in WebKitGTK, the keyboard in Chromium), e.g. "Escape". */
  press?: string };
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
    // The one actually on screen: hidden tabs keep their boxes in some layouts.
    shown(selector) {
      return [...document.querySelectorAll(selector)].find((element) => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + Math.min(box.height / 2, 200));
        return hit && element.contains(hit);
      });
    },
  };
`;

// Design invariants (docs/design/DESIGN.md): each is an expression giving { ok, detail }.
const INVARIANTS = {
  // The navigator's two panes sit on the window's tinted frame (no surface of their own), a 1px
  // line between them, and nothing in the sidebar casts a blurred shadow.
  "내비게이터 두 칸은 틀 위에": `(() => {
    const side = document.querySelector(".sidebar"), nav = side?.querySelector(".nav-pane"), list = side?.querySelector(".list-pane"), bar = side?.querySelector(".nav-divider");
    if (!side || !nav || !list || !bar) return { ok: false, detail: "no two panes" };
    const clear = (element) => ["rgba(0, 0, 0, 0)", "transparent"].includes(getComputedStyle(element).backgroundColor);
    const frame = getComputedStyle(side).backgroundColor, top = getComputedStyle(document.querySelector(".topbar")).backgroundColor;
    const box = bar.getBoundingClientRect(), line = Math.min(box.width, box.height);
    const blurs = (shadow) => shadow === "none" ? [] : shadow.split(/,(?![^(]*\\))/).map((part) => part.replace(/(rgba?|color)\\([^)]*\\)/g, "").match(/-?[\\d.]+px/g) ?? []).map((lengths) => parseFloat(lengths[2] ?? "0"));
    const body = side.querySelector(".nav-body");
    const blurred = [body, ...body.querySelectorAll("*")].filter((element) => blurs(getComputedStyle(element).boxShadow).some((blur) => blur > 0)).map((element) => String(element.className).slice(0, 40));
    const ok = clear(nav) && clear(list) && frame === top && line === 1 && blurred.length === 0;
    return { ok, detail: "frame " + frame + (frame === top ? " = top bar" : " ≠ top bar " + top) + " · panes clear " + clear(nav) + "/" + clear(list) + " · line " + line + "px · blurred " + (blurred.length ? blurred.slice(0, 3).join(" | ") : "none") };
  })()`,
  // The sidebar head's row: "새로 만들기" at the width it has in one column (192px at most), the
  // layout button and ⋯ together at the row's right end.
  "머리줄: 새로 만들기는 제 너비, 배치와 ⋯는 오른쪽 끝": `(() => {
    const side = document.querySelector(".sidebar"), row = side?.querySelector(".side-head-row");
    const create = row?.querySelector(".side-new"), layout = row?.querySelector(".side-layout"), dots = row?.querySelector('[aria-label="사이드바 메뉴"]');
    if (!create || !layout || !dots) return { ok: false, detail: "no head row" };
    const c = create.getBoundingClientRect(), l = layout.getBoundingClientRect(), d = dots.getBoundingClientRect(), r = row.getBoundingClientRect();
    const ok = c.width <= 192.5 && Math.abs(d.right - r.right) < 1 && Math.abs(d.left - l.right - 8) < 1.5 && Math.abs(c.left - r.left) < 1;
    return { ok, detail: side.dataset.layout + " · 새로 만들기 " + Math.round(c.width) + "px · 배치 " + Math.round(l.left) + "–" + Math.round(l.right) + " · ⋯ " + Math.round(d.left) + "–" + Math.round(d.right) + " · 줄 " + Math.round(r.left) + "–" + Math.round(r.right) };
  })()`,
  // Beside the navigator (and a docked right sidebar) every work pane keeps its least width.
  "칸은 최소 너비를 지킴": `(() => {
    const panes = [...document.querySelectorAll(".panes > .pane:not([hidden])")].map((pane) => Math.round(pane.getBoundingClientRect().width));
    const least = document.querySelector(".panes")?.dataset.grid ? 240 : 360;
    const side = document.querySelector(".sidebar"), right = document.querySelector(".right-sidebar");
    return { ok: panes.length > 0 && panes.every((width) => width >= least), detail: "navigator " + (side ? side.dataset.layout + " " + Math.round(side.getBoundingClientRect().width) + "px" : "closed") + " · panes " + panes.join("/") + " (least " + least + ") · right " + (right ? (right.dataset.overlay ? "over" : "docked " + Math.round(right.getBoundingClientRect().width) + "px") : "closed") + " · window " + innerWidth };
  })()`,
  // 곁 화면: an input sits directly under the transcript it sends to, inside that conversation's
  // column — never spanning two columns, never in the document or page, and one per tab.
  "입력은 제 대화 아래": `(() => {
    const pane = document.querySelector('.pane[data-pane-active="true"][data-tab-active="true"]') ?? document.querySelector('.pane[data-pane-active="true"]') ?? document;
    const inputs = [...pane.querySelectorAll(".hig-composer")].filter((element) => element.getClientRects().length > 0 && !element.closest(".browse-entry, [inert]"));
    const problems = [];
    for (const input of inputs) {
      const column = input.closest(".agent-column, .work-view");
      const transcript = column?.querySelector(".transcript");
      if (!column || !transcript) { problems.push("an input with no transcript in its column"); continue; }
      const a = input.getBoundingClientRect(), c = column.getBoundingClientRect(), t = transcript.getBoundingClientRect();
      if (a.left < c.left - 1 || a.right > c.right + 1) problems.push("an input wider than its column");
      if (a.top < t.bottom - 1) problems.push("an input not under its transcript");
      if (input.closest(".document-view, .browser-view")) problems.push("an input inside the document or page");
    }
    const heads = [...pane.querySelectorAll(".agent-column .note-title, .work-view .note-title")].filter((element) => element.getClientRects().length > 0 && !element.closest("[inert]")).map((element) => element.textContent);
    return { ok: inputs.length <= 1 && problems.length === 0, detail: "inputs=" + inputs.length + " head=" + JSON.stringify(heads) + (problems.length ? " " + problems.join("; ") : "") };
  })()`,
  // A key pressed in the right sidebar (a row, the resize edge) leaves the waiting approval alone.
  "승인은 그대로 기다림": `(() => {
    const card = document.querySelector('.pane[data-pane-active="true"] .approval-card');
    return { ok: Boolean(card) && !document.querySelector('.pane[data-pane-active="true"] .approval-done'), detail: card ? "approval card waiting" : "no waiting approval card" };
  })()`,
  // A removed document's AI conversation: no enabled input, no 지금 보내기 on its waiting requests.
  "읽기 전용 대화": `(() => {
    const view = document.querySelector(".pane[data-pane-active=true] .work-view") ?? document.querySelector(".work-view");
    // No input at all: one banner stands in its place, and nothing waiting can be sent.
    const input = view?.querySelector(".composer-input, .composer");
    const banner = view?.querySelector(".composer-area .note-banner");
    const send = [...(view?.querySelectorAll("button") ?? [])].filter((button) => /지금 보내기|지금 끼어들기|^보내기$/.test(button.textContent ?? "") || button.getAttribute("aria-label") === "보내기");
    const ok = Boolean(view) && !input && Boolean(banner) && send.length === 0;
    return { ok, detail: "input=" + Boolean(input) + " banner=" + Boolean(banner) + " send buttons=" + send.length };
  })()`,
  // A menu opened at the bottom-right corner flips above its trigger and stays wholly in the window.
  "구석 메뉴는 창 안에서 뒤집힘": `(() => {
    const menu = document.querySelector(".ui-layer[data-state=open]");
    if (!menu) return { ok: false, detail: "no open menu" };
    const box = menu.getBoundingClientRect(), anchor = document.querySelector("[data-corner-fixture]").getBoundingClientRect();
    const inside = box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight;
    // Above its trigger and next to it (within 8px), not left behind if the trigger moved.
    const above = menu.dataset.side === "top" && box.bottom <= anchor.top + 1 && anchor.top - box.bottom <= 8;
    return { ok: inside && above, detail: \`side=\${menu.dataset.side} menu=\${Math.round(box.left)},\${Math.round(box.top)}–\${Math.round(box.right)},\${Math.round(box.bottom)} window=\${innerWidth}×\${innerHeight} trigger top=\${Math.round(anchor.top)} browser-top-layer=\${(() => { try { return menu.matches(":popover-open"); } catch { return false; } })()}\` };
  })()`,
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
  // A notice in the top bar is drawn over none of its controls, and stays inside the window (U38).
  "알림은 상단 버튼을 덮지 않음": `(() => {
    const notice = document.querySelector(".topbar .top-notice");
    if (!notice) return { ok: false, detail: "no notice" };
    const box = notice.getBoundingClientRect();
    const hit = [...document.querySelectorAll(".topbar button, .topbar a")].filter((control) => !notice.contains(control) && control.getClientRects().length && getComputedStyle(control).opacity !== "0").filter((control) => {
      const r = control.getBoundingClientRect();
      return r.width > 0 && r.left < box.right - 0.5 && box.left < r.right - 0.5 && r.top < box.bottom - 0.5 && box.top < r.bottom - 0.5;
    });
    const inside = box.left >= 0 && box.right <= innerWidth + 0.5;
    const buttons = [...notice.querySelectorAll("button")].every((button) => { const r = button.getBoundingClientRect(); return r.right <= box.right + 0.5 && r.left >= box.left - 0.5; });
    return { ok: hit.length === 0 && inside && buttons, detail: (hit.map((control) => control.getAttribute("aria-label") || control.textContent.trim().slice(0, 12)).join(" | ") || "none covered") + " notice " + Math.round(box.left) + "–" + Math.round(box.right) + " of " + innerWidth };
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
  // The line above each input is the engine it sends to: its colour equals the engine mark on its target chip.
  "입력창 선은 보낼 엔진": `(() => {
    const rows = [...document.querySelectorAll(".hig-composer")].filter((composer) => composer.getClientRects().length).map((composer) => {
      // Inside the input (its target chip), else the engine picked just above it (start and blank web tab).
      const mark = composer.querySelector(".select-button .engine-mark, .engine-mark") ?? composer.closest(".browse-entry, .composer-area, .start-inner")?.querySelector('[aria-checked="true"] .engine-mark');
      const line = getComputedStyle(composer).borderTopColor;
      return { provider: composer.dataset.provider, mark: mark && mark.dataset.provider, same: Boolean(mark) && line === getComputedStyle(mark).color && composer.dataset.provider === mark.dataset.provider, width: getComputedStyle(composer).borderTopWidth };
    });
    const ok = rows.length > 0 && rows.every((row) => row.same && row.width === "2px");
    return { ok, detail: rows.map((row) => row.provider + "/" + row.mark + " " + row.width).join(" | ") };
  })()`,
  // Every pane is one sheet (12px corners) inside the work area; the dividers are the 8px gaps between them.
  "칸마다 면 하나": `(() => {
    const host = document.querySelector(".panes");
    if (!host) return { ok: false, detail: "no panes" };
    const area = host.getBoundingClientRect();
    const panes = [...host.querySelectorAll(":scope > .pane:not([hidden])")];
    const boxes = panes.map((pane) => pane.getBoundingClientRect());
    const gaps = [...host.querySelectorAll(":scope > .pane-divider")].map((divider) => divider.getBoundingClientRect());
    const overlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    const outside = boxes.filter((box) => box.left < area.left - 0.5 || box.right > area.right + 0.5 || box.top < area.top - 0.5 || box.bottom > area.bottom + 0.5).length;
    const corners = [...new Set(panes.map((pane) => getComputedStyle(pane).borderTopLeftRadius))];
    const widths = [...new Set(gaps.map((gap) => Math.round(Math.min(gap.width, gap.height))))];
    const covered = gaps.filter((gap) => boxes.some((box) => overlap(gap, box) > 0.5)).length;
    const ok = outside === 0 && covered === 0 && corners.join() === "12px" && (gaps.length === 0 || widths.join() === "8");
    return { ok, detail: boxes.length + " panes · corners " + corners.join("/") + " · gaps " + widths.join("/") + " · outside " + outside + " · covered " + covered };
  })()`,
  // A sheet and everything around it cast no blurred shadow: WebKitGTK repaints a blur whenever anything inside repaints.
  "면에 흐린 그림자 없음": `(() => {
    const blurs = (shadow) => shadow === "none" ? [] : shadow.split(/,(?![^(]*\\))/).map((part) => part.replace(/(rgba?|color)\\([^)]*\\)/g, "").match(/-?[\\d.]+px/g) ?? []).map((lengths) => parseFloat(lengths[2] ?? "0"));
    const seen = new Set(), bad = [];
    for (const sheet of document.querySelectorAll(".panes > .pane:not([hidden]), .body > main")) {
      for (let element = sheet; element && element !== document; element = element.parentElement) {
        if (seen.has(element)) continue;
        seen.add(element);
        const shadow = getComputedStyle(element).boxShadow;
        if (blurs(shadow).some((blur) => blur > 0)) bad.push((element.className || element.tagName) + ": " + shadow);
      }
    }
    return { ok: seen.size > 0 && bad.length === 0, detail: bad.length ? bad.slice(0, 2).join(" | ") : seen.size + " boxes" };
  })()`,
  // Below 744px the work surface runs to the window's edges: no gap, no corners.
  "좁으면 가장자리까지": `(() => {
    const pane = document.querySelector(".panes > .pane:not([hidden])");
    const box = pane && pane.getBoundingClientRect();
    const radius = pane && getComputedStyle(pane).borderBottomRightRadius;
    const ok = Boolean(box) && Math.abs(box.right - window.innerWidth) < 1 && Math.abs(box.bottom - window.innerHeight) < 1 && radius === "0px";
    return { ok, detail: box ? Math.round(box.right) + "x" + Math.round(box.bottom) + " of " + window.innerWidth + "x" + window.innerHeight + " · " + radius : "no pane" };
  })()`,
  // One wordmark on screen: the top bar's, or the home hero's (then the top bar shows the symbol).
  "상표 하나": `(() => {
    const shown = (element) => { if (!element || !element.getClientRects().length) return false; for (let at = element; at; at = at.parentElement) { const style = getComputedStyle(at); if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity) < 0.5) return false; } return true; };
    const marks = [...document.querySelectorAll(".wordmark")].filter(shown).map((mark) => mark.classList[1] ?? "wordmark");
    const symbol = shown(document.querySelector(".topbar .brand-compact"));
    return { ok: marks.length === 1 && (symbol || marks[0] === "brand-wordmark"), detail: marks.join("+") + (symbol ? " · top bar symbol" : "") };
  })()`,
  // The top bar's left cluster keeps its place when the brand switches between wordmark and symbol.
  "상단 왼쪽 그대로": `(() => {
    const boxes = [...document.querySelectorAll(".topbar-left > *")].map((element) => { const box = element.getBoundingClientRect(); return (element.className || element.tagName).split(" ")[0] + "@" + Math.round(box.left) + "-" + Math.round(box.right); });
    const before = window.__topLeft ?? [];
    const brand = document.querySelector(".topbar .brand");
    const shows = brand ? [...brand.querySelectorAll("svg")].filter((svg) => getComputedStyle(svg).display !== "none" && getComputedStyle(svg).opacity !== "0").map((svg) => svg.classList[1] ?? svg.classList[0]).join("+") : "none";
    return { ok: before.length > 0 && before.join() === boxes.join(), detail: shows + " · " + boxes.join(" ") + (before.join() === boxes.join() ? "" : " ≠ " + before.join(" ")) };
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
// A conversation's row (a project's own row opens its project page, never a conversation).
const openSession = (id: string): Step[] => [
  { js: "if (!__wb.has('.sidebar')) __wb.click('.topbar-left [aria-label=\"사이드바 열기\"]')", wait: `__wb.has('${row(id)}')` },
  { js: `__wb.click('${row(id)}')`, wait: `__wb.has('.work-view .transcript')` },
];
// Interactive controls a person can see in the conversation pane before typing: on screen, not
// transparent or hidden, by area (the tab strip, the conversation head and body, the input).
const CONTROL_COUNT = `(() => {
  const pane = document.querySelector(".pane[data-pane-active=true]") ?? document.querySelector(".panes");
  const seen = (element) => {
    const box = element.getBoundingClientRect();
    if (!box.width || !box.height || box.bottom <= 0 || box.top >= innerHeight || box.right <= 0 || box.left >= innerWidth) return false;
    // Content of a closed <details> still has boxes in WebKitGTK; ask the engine whether it is drawn.
    if (typeof element.checkVisibility === "function" && !element.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true })) return false;
    if (element.closest("details:not([open]) > :not(summary)")) return false;
    for (let at = element; at && at !== document.body; at = at.parentElement) {
      const style = getComputedStyle(at);
      if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity) < 0.1) return false;
    }
    return true;
  };
  const controls = [...pane.querySelectorAll("button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [contenteditable=true]")]
    .filter((element) => !element.closest("[hidden]") && seen(element));
  const area = (element) => element.closest(".composer-area") ? "input" : element.closest(".group-tabs, .session-tabs, .pane-head") ? "tabs" : element.closest(".transcript-wrap, .transcript") ? "conversation" : "head";
  const counts = { tabs: 0, head: 0, conversation: 0, input: 0 };
  for (const element of controls) counts[area(element)] += 1;
  const names = controls.filter((element) => area(element) !== "input").map((element) => (element.getAttribute("aria-label") || element.textContent || element.className).trim().slice(0, 24));
  return { total: controls.length, ...counts, withoutInput: controls.length - counts.input, names };
})()`;
const gridSteps = (n: number): Step[] => [
  { js: "if (!__wb.has('[aria-label=\"화면 배치\"]')) __wb.click('[aria-label=\"연결과 설정\"]')", wait: "__wb.has('[aria-label=\"화면 배치\"]')" },
  // Retried while the page settles after a reload; never toggles an open menu shut.
  { js: "if (!__wb.has('.layout-options button')) __wb.click('[aria-label=\"화면 배치\"]')", wait: "__wb.has('.layout-options button') || (__wb.click('[aria-label=\"화면 배치\"]') && false)" },
  { js: `__wb.click('.layout-options button', '${n}칸')`, wait: `document.querySelectorAll('.pane:not([hidden])').length === ${n}${n === 1 ? " && !document.querySelector('.panes')?.dataset.grid" : ""}` },
];
// The right sidebar: opened and closed by the top bar's toggle (absent from builds before U27).
// A pointer click (detail 1): the focus stays where it was, as with a mouse.
const MOUSE_TOGGLE = "document.querySelector('.shell-right-sidebar').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))";
const openRight: Step[] = [{ js: `if (!__wb.has('.right-sidebar')) ${MOUSE_TOGGLE}`, wait: "__wb.has('.right-sidebar[data-state=open]')", pause: 350 }];
const closeRight: Step[] = [{ js: `if (__wb.has('.right-sidebar[data-state=open]')) ${MOUSE_TOGGLE}`, wait: "!__wb.has('.right-sidebar')" }];
const ACTIVE_COLUMN = "document.querySelector('.pane[data-pane-active=\"true\"] .work-view .transcript-inner')";
const OUTLINE_PROBE = `({ rows: [...document.querySelectorAll('.right-sidebar .outline-row')].map((r) => (r.getAttribute('aria-current') ? '▶ ' : '') + r.getAttribute('aria-label')), column: Math.round(${ACTIVE_COLUMN}.getBoundingClientRect().width), sidebar: Math.round(document.querySelector('.right-sidebar').getBoundingClientRect().width) })`;
// Toggle the sidebar and record, per animation frame for 450ms: the gap since the last frame and
// the width of the conversation's reading column.
const OPEN_TIMING = `window.__u27 = { frames: [], widths: [] }; let last = 0; const column = ${ACTIVE_COLUMN}; const end = performance.now() + 450; const tick = (now) => { if (last) window.__u27.frames.push(Math.round(now - last)); last = now; const w = Math.round(column.getBoundingClientRect().width) + '@' + Math.round(column.getBoundingClientRect().left); if (window.__u27.widths.at(-1) !== w) window.__u27.widths.push(w); if (now < end) requestAnimationFrame(tick); }; requestAnimationFrame(tick); ${MOUSE_TOGGLE}`;
const toTop: Step[] = [{ js: "__wb.blur(); const s = __wb.shown('.work-view .transcript'); s.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true })); s.scrollTop = 0;", pause: 400 }];
const toEnd: Step[] = [{ js: "__wb.blur(); const s = __wb.shown('.work-view .transcript'); s.scrollTop = s.scrollHeight;", pause: 400 }];
// A document that already has a tab of its own opens there, not beside a conversation (App.tsx
// openBeside): screens that show it beside close the tab an earlier screen left (08-document).
const closeDocTab = (name: string): Step => ({
  js: `[...document.querySelectorAll('.group-tab')].filter((tab) => tab.querySelector('.group-tab-title')?.textContent === '${name}').forEach((tab) => tab.querySelector('.group-tab-close')?.click())`,
  wait: `![...document.querySelectorAll('.group-tab-title')].some((title) => title.textContent === '${name}')`, pause: 300,
});
// Two panes: the conversation and its document beside it (Ctrl+click on the tree's row).
const panesDoc: Step[] = [...gridSteps(1), ...openSession(codex.id),
    { js: "const row = __wb.q('.sidebar .side-row', '강의안.md'); row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }))", wait: "__wb.has('.document-view')" },
    // A document in focus fills the window ("편집기에 집중"); "작업공간 보기" shows both panes.
    // Too narrow for both (1000px), the panes take turns: the cell picker shows instead.
    { js: "__wb.click('.topbar-right button', '작업공간 보기')", wait: "!__wb.has('.topbar-right button', '작업공간 보기') && (document.querySelectorAll('.pane:not([hidden])').length === 2 || __wb.has('.pane-narrow'))" }, ...openRight];
const SCREENS: Screen[] = [
  {
    name: "01-home",
    steps: [{ js: "__wb.click('.topbar .brand')", wait: "__wb.has('.start-view .composer-input')" }, { js: "__wb.blur()" }, { assert: "옆줄 없음" }, { assert: "틀 글자는 사다리 위" }, { assert: "틀 색 하나" }, { assert: "면에 흐린 그림자 없음" }, { assert: "상표 하나" }],
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
    steps: [...openSession(codex.id), { wait: "__wb.has('.approval-card')" }, { js: "__wb.blur()" }, { assert: "옆줄 없음" }, { assert: "틀 글자는 사다리 위" }, { assert: "흐림 없음" }, { assert: "틀 색 하나" }, { assert: "입력창 선은 보낼 엔진" }],
    settle: 900,
  },
  {
    name: "04-work-codex-steps",
    steps: [
      ...openSession(codex.id),
      { js: "document.querySelectorAll('.work-summary').forEach((button) => button.getAttribute('aria-expanded') === 'false' && button.click())", wait: "__wb.has('.work-list')" },
      { js: "const scroller = __wb.shown('.work-view .transcript'); const turn = scroller.querySelector('.turn'); scroller.scrollTop = turn.offsetTop - 12; scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true }));" },
    ],
    settle: 700,
  },
  { name: "05-work-claude-plan", steps: [...openSession(claude.id), { wait: "__wb.has('.plan-approval')" }, { js: "__wb.blur()" }, { assert: "입력창 선은 보낼 엔진" }], settle: 900 },
  // One wordmark per screen: home shows the symbol in the top bar, and nothing beside it moves.
  {
    name: "15-topbar-brand",
    steps: [
      { js: "__wb.click('.topbar .brand')", wait: "__wb.has('.start-view .home-brand')", pause: 300 },
      { js: "window.__topLeft = [...document.querySelectorAll('.topbar-left > *')].map((element) => { const box = element.getBoundingClientRect(); return (element.className || element.tagName).split(' ')[0] + '@' + Math.round(box.left) + '-' + Math.round(box.right); })" },
      ...openSession(codex.id),
      { pause: 300, assert: "상단 왼쪽 그대로" },
      { assert: "상표 하나" },
      { js: "__wb.click('.topbar-left [aria-label=\"사이드바 닫기\"]')", wait: "!__wb.has('.sidebar')", pause: 300 },
      { js: "window.__topLeft = [...document.querySelectorAll('.topbar-left > *')].map((element) => { const box = element.getBoundingClientRect(); return (element.className || element.tagName).split(' ')[0] + '@' + Math.round(box.left) + '-' + Math.round(box.right); })" },
      { js: "__wb.click('.topbar .brand')", wait: "__wb.has('.start-view .home-brand')", pause: 300 },
      { assert: "상단 왼쪽 그대로" },
      { assert: "상표 하나" },
      { js: "__wb.blur()" },
    ],
    settle: 500,
    // The sidebar choice is saved a moment later; the next screen (or theme reload) expects it open.
    cleanup: [{ js: "__wb.click('.topbar-left [aria-label=\"사이드바 열기\"]')", wait: "__wb.has('.sidebar')", pause: 1200 }],
  },
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
      { js: "__wb.click('.note-head-more')", wait: "__wb.has('.note-menu [role=menuitem]', '강의안.md')" },
      // Opened from the conversation it comes beside it; this screen is the document in a tab of its own.
      { js: "__wb.click('.note-menu [role=menuitem]', '강의안.md')", wait: "__wb.has('.document-view')" },
      { js: "if (__wb.has('.document-view .doc-wide')) __wb.click('.document-view .doc-wide')", wait: "__wb.has('.document-view') && !__wb.has('.document-view[data-hosted]')" },
    ],
    settle: 1500,
  },
  {
    // The start input (the same browse-entry composer as a blank web tab) carries the picked engine's line.
    name: "27-start-engine-line",
    steps: [
      { js: "__wb.click('.topbar .brand')", wait: "__wb.has('.browse-entry .hig-composer')" },
      { js: "__wb.click('.browse-entry .engine-tabs button', 'Claude')", wait: "__wb.has('.browse-entry .hig-composer[data-provider=\"claude\"]')", pause: 500 },
      { js: "__wb.blur()" },
      { assert: "입력창 선은 보낼 엔진" },
      { js: "__wb.click('.browse-entry .engine-tabs button', 'Codex')", wait: "__wb.has('.browse-entry .hig-composer[data-provider=\"codex\"]')", pause: 500 },
      { js: "__wb.blur()" },
      { assert: "입력창 선은 보낼 엔진" },
    ],
    cleanup: [{ js: "__wb.click('.browse-entry .engine-tabs button', 'Claude')" }],
    settle: 600,
  },
  {
    // A Claude chat's document whose document AI runs on Codex: the input's line follows the document AI.
    name: "26-doc-ai-engine",
    steps: [
      ...openSession(claude.id),
      { js: "__wb.click('.note-head-more')", wait: "__wb.has('.note-menu [role=menuitem]', '강의안.md')" },
      { js: "__wb.click('.note-menu [role=menuitem]', '강의안.md')", wait: "__wb.has('.document-view')" },
      // The document's own AI is in its own tab (beside a conversation, that conversation takes the questions).
      { js: "if (__wb.has('.document-view [aria-label=\"탭으로 넓게 열기\"]')) __wb.click('.document-view [aria-label=\"탭으로 넓게 열기\"]')", wait: "__wb.has('.document-view .ghost-button', '문서 AI')" },
      { js: "if (!__wb.has('.doc-composer .hig-composer')) __wb.click('.document-view .ghost-button', '문서 AI')", wait: "__wb.has('.doc-composer .hig-composer[data-provider]')" },
      // The engine is picked in the bar's target menu, as in a conversation.
      { js: "if (!__wb.has('.doc-composer .hig-composer[data-provider=\"codex\"]')) __wb.click('.doc-composer .composer-right .select-button')", wait: "__wb.has('.doc-composer .hig-composer[data-provider=\"codex\"]') || __wb.has('.doc-composer .popover [role^=menuitem]', 'Codex')" },
      { js: "if (!__wb.has('.doc-composer .hig-composer[data-provider=\"codex\"]')) __wb.click('.doc-composer .popover [role^=menuitem]', 'Codex')", wait: "__wb.has('.doc-composer .hig-composer[data-provider=\"codex\"]') && !__wb.has('.doc-composer .popover')" },
      { js: "__wb.blur()" },
      { assert: "입력창 선은 보낼 엔진" },
    ],
    settle: 900,
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
    // Its close is the shared IconButton now (no .icon-button class): found by its name.
    cleanup: [{ js: "__wb.click('.appearance-sheet [aria-label=\"외형 설정 닫기\"]')", wait: "!__wb.has('.appearance-sheet')" }],
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
      { js: "__wb.click('.note-head-more')", wait: "__wb.has('.note-menu [role=menuitem]', '강의안.md')" },
      { js: "__wb.click('.note-menu [role=menuitem]', '강의안.md')", wait: "__wb.has('.document-view .doc-proposal')" },
      { js: "__wb.click('.doc-proposal .button', '미리보기')", wait: "__wb.has('.doc-compare')" },
    ],
    settle: 900,
    cleanup: [{ js: "__wb.click('.doc-compare-actions .button', '닫기')", wait: "!__wb.has('.doc-compare')" }],
  },
  {
    name: "22-split",
    steps: [
      ...openSession(codex.id),
      closeDocTab("강의안.md"),
      { js: "__wb.click('.note-head-more')", wait: "__wb.has('.note-menu [role=menuitem]', '강의안.md')" },
      // 나란히: the document beside its conversation, in the conversation's tab.
      { js: "__wb.click('.note-menu [role=menuitem]', '강의안.md')", wait: "__wb.has('.document-view[data-hosted]')" },
    ],
    settle: 1200,
    cleanup: [{ js: "__wb.click('.document-view [aria-label=\"곁 화면 닫기\"]')", wait: "!__wb.has('.document-view[data-hosted]')" }],
  },
  {
    name: "23-answer-codex",
    steps: [...openSession(minutes.id), { wait: "__wb.has('.turn-answer .markdown table')" }, { js: "__wb.blur(); const scroller = __wb.shown('.work-view .transcript'); const answer = scroller.querySelector('.turn-answer .markdown table').closest('.markdown'); scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true })); scroller.scrollTop = answer.offsetTop - 80;" }],
    settle: 800,
  },
  {
    name: "24-answer-claude",
    steps: [
      ...openSession(reviewer.id),
      { wait: "__wb.has('.turn-answer .markdown table')" },
      { js: "__wb.blur(); const scroller = __wb.shown('.work-view .transcript'); const answer = scroller.querySelector('.turn-answer .markdown table').closest('.markdown'); scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true })); scroller.scrollTop = answer.offsetTop - 80;" },
      { probe: "(() => { const w = (s) => [...document.querySelectorAll(s)].map((e) => Math.round(e.getBoundingClientRect().width)); return { bar: w('.work-view .composer-bar'), left: w('.work-view .composer-left'), right: w('.work-view .composer-right'), leftKids: [...document.querySelectorAll('.work-view .composer-left > *')].map((e) => e.className.split(' ')[0] + ':' + Math.round(e.getBoundingClientRect().width)), rightKids: [...document.querySelectorAll('.work-view .composer-right > *')].map((e) => e.className.split(' ')[0] + ':' + Math.round(e.getBoundingClientRect().width)) }; })()" },
    ],
    settle: 800,
  },
  {
    name: "25-answer-korean-emphasis",
    steps: [
      ...openSession(minutes.id),
      { wait: "__wb.has('.turn-answer .markdown table')" },
      { js: "__wb.blur(); const scroller = __wb.shown('.work-view .transcript'); scroller.scrollTop = scroller.scrollHeight;" },
    ],
    settle: 800,
  },
  // U25: the conversation read as a note. Same steps for the build before and after.
  { name: "u25-codex-top", steps: [...openSession(codex.id), { wait: "__wb.has('.approval-card')" }, ...toTop, { probe: CONTROL_COUNT }], settle: 900 },
  { name: "u25-codex-end", steps: [...openSession(codex.id), { wait: "__wb.has('.approval-card')" }, ...toEnd, { probe: CONTROL_COUNT }], settle: 900 },
  { name: "u25-claude-top", steps: [...openSession(claude.id), { wait: "__wb.has('.plan-approval')" }, ...toTop, { probe: CONTROL_COUNT }], settle: 900 },
  { name: "u25-claude-end", steps: [...openSession(claude.id), { wait: "__wb.has('.plan-approval')" }, ...toEnd, { probe: CONTROL_COUNT }], settle: 900 },
  // The request band pinned over a long answer, halfway down.
  { name: "u25-codex-pin", steps: [...openSession(codex.id), { wait: "__wb.has('.approval-card')" }, { js: "__wb.blur(); const s = __wb.shown('.work-view .transcript'); s.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true })); s.scrollTop = s.scrollHeight * 0.42;", pause: 400 }], settle: 600 },
  // After only: what the note adds (a long request opened, raw Markdown, the ⋯ menu, session details).
  { name: "u25x-claude-long-open", steps: [...openSession(claude.id), { wait: "__wb.has('.plan-approval')" }, ...toTop, { js: "__wb.click('.request-more')", wait: "__wb.has('.request-more[aria-expanded=true]')", pause: 300 }], settle: 700 },
  { name: "u25x-codex-raw", steps: [...openSession(codex.id), { wait: "__wb.has('.approval-card')" }, { js: "__wb.click('button[aria-label=\"원문(md) 보기\"]')", wait: "__wb.has('.raw-note-text', 'title:')" }, { js: "__wb.blur()" }], settle: 700,
    cleanup: [{ js: "__wb.click('button[aria-label=\"원문(md) 보기\"]')", wait: "!__wb.has('.raw-note-text')" }] },
  { name: "u25x-codex-menu", steps: [...openSession(codex.id), { wait: "__wb.has('.approval-card')" }, ...toTop, { js: "__wb.click('button[aria-label=\"노트 메뉴\"]')", wait: "__wb.has('.ui-menu[data-placed][data-state=open]')", pause: 300 }], settle: 400, cleanup: [{ js: "__wb.key('Escape')", wait: "!__wb.has('.ui-menu[data-state=open]')" }] },
  { name: "u25x-codex-details", steps: [...openSession(codex.id), { wait: "__wb.has('.approval-card')" }, ...toTop, { js: "__wb.click('.note-props .note-prop', 'Codex')", wait: "__wb.has('.status-detail[data-placed]')", pause: 300 }], settle: 400, cleanup: [{ js: "__wb.key('Escape')", wait: "!__wb.has('.status-detail[data-state=open]')" }] },
  // Fix round 1: the band carries the head's essentials, the menu opens from it, a design card
  // keeps its picture, a search hit opens a folded request, the raw note while a turn runs.
  { name: "u25x-codex-band-menu", steps: [...openSession(codex.id), { wait: "__wb.has('.approval-card')" }, ...toEnd, { wait: "__wb.has('.turn-pin-tail [aria-label=\"노트 메뉴\"]')" },
    { js: "__wb.click('.turn-pin-tail [aria-label=\"노트 메뉴\"]')", wait: "__wb.has('.ui-menu[data-placed][data-state=open]')", pause: 300 }], settle: 400,
    cleanup: [{ js: "__wb.key('Escape')", wait: "!__wb.has('.ui-menu[data-state=open]')" }] },
  { name: "u25x-meeting-design-card", steps: [...openSession(minutes.id), { wait: "__wb.has('.doc-card.with-thumb .design-card-thumb img')" },
    { js: "__wb.blur(); const s = __wb.shown('.work-view .transcript'); s.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true })); const card = document.querySelector('.doc-card.with-thumb'); s.scrollTop = card.offsetTop - 220;", pause: 900 }], settle: 900 },
  { name: "u25x-meeting-office-card", steps: [...openSession(minutes.id), { wait: "__wb.has('.doc-card.with-thumb', '회의-발표.pptx')" }, { pause: 4000 },
    { js: "__wb.blur(); const s = __wb.shown('.work-view .transcript'); s.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true })); const card = __wb.q('.doc-card', '회의-발표.pptx'); s.scrollTop = card.offsetTop - 300;", pause: 900 },
    { probe: "(() => { const card = __wb.q('.doc-card', '회의-발표.pptx'); return { img: Boolean(card.querySelector('.design-card-thumb img')), text: card.querySelector('.design-card-thumb').textContent }; })()" }], settle: 900 },
  { name: "u25x-claude-find", steps: [{ js: "__wb.blur(); __wb.key('k', { ctrlKey: true })", wait: "__wb.has('.palette input')" },
    { js: "__wb.type('.palette input', '마감만 분명하면')", wait: "__wb.has('.palette-entry', '마감만')", pause: 600 },
    { js: "__wb.click('.palette-entry', '마감만')", wait: "__wb.has('.request-more[aria-expanded=true]') && __wb.has('.turn-request.flash')", pause: 200 }], settle: 300 },
  { name: "u25x-meeting-raw-running", steps: [...openSession(minutes.id),
    { js: `__wb.type('.pane[data-pane-active="true"] .composer-input', '길게 설명해 줘')` },
    { js: `__wb.click('.pane[data-pane-active="true"] [aria-label="보내기"]')`, wait: "__wb.has('.pane[data-pane-active=\"true\"] .composer[data-phase=\"waiting\"]')" },
    { js: "__wb.click('button[aria-label=\"원문(md) 보기\"]')", wait: "__wb.has('.raw-note-pending')" },
    { js: "__wb.blur(); const s = __wb.shown('.work-view .transcript'); s.scrollTop = s.scrollHeight;", pause: 500 }], settle: 400,
    cleanup: [{ js: "__wb.click('button[aria-label=\"원문(md) 보기\"]')", wait: "!__wb.has('.raw-note-text')" }, { wait: "!__wb.has('.pane[data-pane-active=\"true\"] .composer[data-phase=\"waiting\"]')" }] },
  // U27 — the right sidebar. Closed (the conversation as before, plus the top bar's toggle), then
  // open on 개요 and 연결, beside two panes, laid over a narrow window, and opening as a burst.
  { name: "u27-closed-top", steps: [...openSession(codex.id), { wait: "__wb.has('.approval-card')" }, ...toTop, { probe: CONTROL_COUNT }], settle: 900 },
  { name: "u27-closed-end", steps: [...openSession(codex.id), { wait: "__wb.has('.approval-card')" }, ...toEnd, { probe: CONTROL_COUNT }], settle: 900 },
  { name: "u27-outline", steps: [...openSession(codex.id), { wait: "__wb.has('.approval-card')" },
    { js: "__wb.blur(); const s = __wb.shown('.work-view .transcript'); s.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true })); s.scrollTop = [...s.querySelectorAll('.turn')][1].offsetTop + 120;", pause: 400 },
    ...openRight, { probe: OUTLINE_PROBE }], settle: 600, cleanup: closeRight },
  { name: "u27-links", steps: [...openSession(minutes.id), ...openRight, { js: "__wb.click('.right-sidebar [role=tab]', '연결')", wait: "__wb.has('.right-group')" }, { js: "__wb.blur()", pause: 300 },
    { probe: "[...document.querySelectorAll('.right-group')].map((g) => g.querySelector('h3').textContent + ': ' + [...g.querySelectorAll('.right-link')].map((r) => r.textContent).join(' | '))" }], settle: 500,
    cleanup: [{ js: "__wb.click('.right-sidebar [role=tab]', '개요')" }, ...closeRight] },
  // At 720 wide: laid over the work, under a scrim (its own viewport, so a default run reaches it too).
  // Just after the window narrows the compact shell may still settle: open the laid-over sidebar until it stays.
  { name: "u27-narrow", viewport: { width: 720, height: 860 }, steps: [{ pause: 400, wait: "__wb.has('.sidebar') || (__wb.click('.topbar-left [aria-label=\"사이드바 열기\"]') && false)" }, ...openSession(codex.id), { js: "if (__wb.has('.sidebar-scrim')) __wb.click('.sidebar-scrim')", wait: "!__wb.has('.sidebar-scrim')" },
    ...openRight, { wait: "__wb.has('.right-sidebar[data-overlay]')", pause: 400 }, { js: "__wb.blur()" }], settle: 500,
    cleanup: [{ js: "__wb.click('.right-sidebar-scrim')", wait: "!__wb.has('.right-sidebar')" }] },
  // Opening next to a long conversation: snapshots ~40ms apart, then the frame times and the
  // conversation pane's widths seen on each frame (one change expected, not one per frame).
  { name: "u27-motion", steps: [...openSession(codex.id), { wait: "__wb.has('.approval-card')" }, ...toEnd, ...closeRight,
    { burst: { name: "open", js: OPEN_TIMING, frames: 10, every: 40 } }, { pause: 300 }, { probe: "window.__u27" },
    { burst: { name: "close", js: OPEN_TIMING, frames: 6, every: 40 } }, { pause: 300 }, { probe: "window.__u27" },
    // The same without snapshots in between (they cost the engine frames of their own).
    { js: OPEN_TIMING, pause: 700 }, { probe: "window.__u27" }, { js: OPEN_TIMING, pause: 700 }, { probe: "window.__u27" }], settle: 300, cleanup: closeRight },
  // Review I1: real Enter / Escape (GTK) on a sidebar row and on its resize edge, with an approval waiting.
  { name: "u27-keys", steps: [...openSession(codex.id), { wait: "__wb.has('.approval-card')" }, ...toEnd, ...openRight,
    // On 개요 (a previous screen may have left 연결 chosen), and the row really has the focus.
    { js: "__wb.click('.right-sidebar [role=tab]', '개요')", wait: "__wb.has('.right-sidebar .outline-row')" },
    { js: "document.querySelector('.right-sidebar .outline-row').focus()", wait: "document.activeElement?.classList.contains('outline-row')" }, { press: "Return", pause: 300 }, { assert: "승인은 그대로 기다림" },
    { js: "document.querySelector('.right-sidebar-edge').focus()", wait: "document.activeElement?.classList.contains('right-sidebar-edge')" }, { press: "Return", pause: 200 }, { press: "Escape", pause: 300 }, { assert: "승인은 그대로 기다림" },
    { js: "document.querySelector('.right-sidebar .outline-row').focus()" }], settle: 400, cleanup: closeRight },
  // Review I3: the archived conversation in 연결, and opening it shows that conversation itself.
  { name: "u27-links-archived", steps: [...openSession(minutes.id), ...openRight, { js: "__wb.click('.right-sidebar [role=tab]', '연결')", wait: "__wb.has('.right-link', '보관됨')" }, { js: "__wb.blur()", pause: 300 },
    { probe: "[...document.querySelectorAll('.right-group .right-link')].map((r) => r.tagName + ':' + r.textContent)" }], settle: 400 },
  { name: "u27-archived-open", steps: [{ js: "__wb.click('.right-link', '지난 회의 메모')", wait: "__wb.has('.work-view .note-title', '지난 회의 메모')", pause: 600 }, { js: "__wb.blur()" },
    { probe: "({ title: document.querySelector('.pane[data-pane-active=\"true\"] .note-title')?.textContent, banner: document.querySelector('.pane[data-pane-active=\"true\"] .work-view')?.textContent.includes('보관한 대화입니다') })" }], settle: 500,
    cleanup: [{ js: "__wb.click('.right-sidebar [role=tab]', '개요')" }, ...closeRight] },
  // Two panes: the conversation and its document beside it (Ctrl+click on the tree's row); the
  // sidebar follows the focused pane.
  { name: "u27-panes-doc", steps: [...panesDoc, { wait: "__wb.has('.right-sidebar [aria-label=\"문서 개요\"]')", pause: 800 }, { js: "__wb.blur()" },
    { probe: "({ overlay: __wb.has('.right-sidebar[data-overlay]'), panes: [...document.querySelectorAll('.pane:not([hidden])')].map((p) => Math.round(p.getBoundingClientRect().width)), rows: [...document.querySelectorAll('.right-sidebar .outline-row')].map((r) => r.getAttribute('aria-label')) })" }], settle: 700 },
  // Review round 2: a saved-open sidebar at boot, with two panes that would not fit beside it
  // (run at --width=1200): it starts laid over (or closed), never squeezing the panes.
  { name: "u27-boot", steps: [{ js: "__wb.click('.work-view .transcript')", pause: 500 }, { prefs: { rightSidebar: { open: true, width: 280, tab: "outline" } }, reload: true }, { wait: "__wb.has('.panes .pane')", pause: 2000 },
    { probe: "({ overlay: __wb.has('.right-sidebar[data-overlay]'), docked: __wb.has('.right-sidebar:not([data-overlay])'), panes: [...document.querySelectorAll('.pane:not([hidden])')].map((p) => Math.round(p.getBoundingClientRect().width)) })" }], settle: 500,
    cleanup: [{ prefs: { rightSidebar: { open: false, width: 280, tab: "outline" } }, reload: true }, { wait: "__wb.has('.panes .pane')" }] },
  // Its own two panes and sidebar (u27-boot, run between, reloads and closes the sidebar; the layout
  // it comes back to is not always the two panes): the sidebar follows the document's pane, then the
  // conversation's (a pointer down in a pane focuses that pane).
  { name: "u27-panes-chat", steps: [...panesDoc,
    { js: "__wb.q('.panes .document-view').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))", wait: "__wb.has('.right-sidebar [aria-label=\"문서 개요\"]')", pause: 300 },
    { js: "__wb.click('.work-view .transcript')", wait: "__wb.has('.right-sidebar [aria-label=\"요청 목록\"]')", pause: 400 }, { js: "__wb.blur()" },
    { probe: "[...document.querySelectorAll('.right-sidebar .outline-row')].map((r) => r.getAttribute('aria-label'))" }], settle: 500,
    cleanup: [...closeRight, ...gridSteps(1)] },
  {
    name: "20-switcher",
    steps: [...openSession(codex.id), { js: "__wb.blur(); __wb.key('Tab', { ctrlKey: true })", wait: "__wb.has('.switcher')" }],
    settle: 500,
    cleanup: [{ js: "window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', bubbles: true }))", wait: "!__wb.has('.switcher')" }],
  },
];
// The shared Select (components/ui/Select.tsx): open it by its name, then choose an option by value.
const openMenu = (name: string): Step => ({ js: `__wb.click('button[aria-label="${name}"]')`, wait: "__wb.has('.ui-menu[data-placed][data-state=open]')", pause: 250 });
const pick = (name: string, value: string): Step[] => [openMenu(name), { js: `__wb.click('.ui-menu [data-value="${value}"]')`, wait: "!__wb.has('.ui-menu')" }];
const closeMenu: Step = { js: "__wb.key('Escape')", wait: "!__wb.has('.ui-menu')" };
const MENU_SCREENS: Screen[] = [
  { name: "menu-search-filter", steps: [{ js: "__wb.blur(); __wb.key('k', { ctrlKey: true })", wait: "__wb.has('.palette input')" }, openMenu("프로젝트 범위")],
    cleanup: [closeMenu, { js: "__wb.key('Escape')", wait: "!__wb.has('.palette')" }] },
  { name: "menu-grid-corner", viewport: { width: 1600, height: 1000 }, steps: [...gridSteps(9),
    { js: "[...document.querySelectorAll('[aria-label=\"이 칸 확대\"]')].at(-1).click()", wait: "document.querySelectorAll('.pane:not([hidden])').length === 1" },
    openMenu("표시할 칸")],
    cleanup: [closeMenu, { js: "__wb.click('[aria-label=\"전체 칸 보기\"]')" }, ...gridSteps(1)] },
  { name: "menu-work-link", steps: [{ js: "__wb.click('[aria-label=\"화면 배치\"]')", wait: "__wb.has('[role^=menuitem]', '작업 연결')" }, { js: "__wb.click('[role^=menuitem]', '작업 연결')", wait: "__wb.has('.work-link-dialog[open]')" },
    openMenu("받는 세션"), { js: "__wb.type('.ui-select-search-input', '리뷰')", pause: 250 }],
    cleanup: [closeMenu, { js: "__wb.click('[aria-label=\"작업 연결 닫기\"]')", wait: "!__wb.has('.work-link-dialog[open]')" }] },
  // The document AI's target menu (engine, another session), at the bar's right as in a conversation.
  { name: "menu-side-engine", steps: [...gridSteps(1), ...SCREENS.find(screen => screen.name === "08-document")!.steps,
    { js: "__wb.click('.hk-seg button, .segmented button', '원문')", wait: "__wb.has('button[aria-expanded]', '문서 AI')" },
    { js: "if (!__wb.has('.doc-composer')) __wb.click('button[aria-expanded]', '문서 AI')", wait: "__wb.has('.doc-composer .composer-right .select-button')" },
    { js: "__wb.click('.doc-composer .composer-right .select-button')", wait: "__wb.has('.doc-composer .popover [role^=menuitem]', 'Claude')", pause: 250 }],
    // Back to 편집: the view is kept per document, and hig-editor (the dark pass) needs the editor.
    cleanup: [{ js: "__wb.key('Escape')", wait: "!__wb.has('.doc-composer .popover')" }, { js: "__wb.click('.hk-seg button, .segmented button', '편집')", pause: 800 }, { js: "__wb.click('.topbar .brand')", wait: "__wb.has('.start-view')" }] },
  // A fixture: the palette's project filter moved to the window's bottom-right corner (the check, not the app).
  { name: "menu-corner-flip", steps: [{ js: "__wb.blur(); __wb.key('k', { ctrlKey: true })", wait: "__wb.has('.palette input')" },
    { js: "const t = document.querySelector('button[aria-label=\"프로젝트 범위\"]'); t.dataset.cornerFixture = ''; Object.assign(t.style, { position: 'fixed', right: '6px', bottom: '6px', left: 'auto', top: 'auto', zIndex: '1' });" },
    openMenu("프로젝트 범위"), { assert: "구석 메뉴는 창 안에서 뒤집힘" }],
    cleanup: [closeMenu, { js: "__wb.key('Escape')", wait: "!__wb.has('.palette')" }] },
  // A real Escape with the picker open closes only the picker; the next one closes the dialog.
  { name: "menu-dialog-escape", steps: [{ js: "__wb.click('[aria-label=\"화면 배치\"]')", wait: "__wb.has('[role^=menuitem]', '작업 연결')" },
    { js: "__wb.click('[role^=menuitem]', '작업 연결')", wait: "__wb.has('.work-link-dialog[open]')" }, openMenu("받는 세션"),
    { press: "Escape", wait: "!__wb.has('.ui-menu') && __wb.has('.work-link-dialog[open]')" },
    { press: "Escape", wait: "!__wb.has('.work-link-dialog[open]')" }] },
  { name: "menu-motion", steps: [{ js: "__wb.blur(); __wb.key('k', { ctrlKey: true })", wait: "__wb.has('.palette input')" },
    { burst: { name: "menu-open", js: "__wb.click('button[aria-label=\"프로젝트 범위\"]')", frames: 6, every: 40 } },
    { wait: "__wb.has('.ui-menu[data-state=open]')", pause: 200 },
    { burst: { name: "menu-close", js: "__wb.key('Escape')", frames: 6, every: 40 } }],
    cleanup: [{ wait: "!__wb.has('.ui-menu')" }, { js: "__wb.key('Escape')", wait: "!__wb.has('.palette')" }] },
];
const HIG_SCREENS: Screen[] = [
  ...SCREENS.filter(s => ["01-home", "03-work-codex", "07-search", "09-settings"].includes(s.name)).map(s => ({ ...s, steps: [...(s.name === "01-home" ? gridSteps(1) : []), ...s.steps.filter(step => !step.assert)] })),
  { name: "hig-project", steps: [{ js: `__wb.click('${row(lecture.id)}')`, wait: "__wb.has('.project-view')" }] },
  { ...SCREENS.find(screen => screen.name === "08-document")!, name: "hig-editor" },
  { name: "hig-images", steps: [...openSession(minutes.id),
    { wait: "__wb.has('.transcript .attach-preview')" },
    // The pictures load when they come near the screen (IntersectionObserver): bring the shown
    // conversation's first one there, let the transcript settle, then move by a pixel so the
    // observer looks again (a full run sometimes left them as "그림" on screen otherwise).
    { js: "__wb.shown('.work-view .transcript').querySelector('.attach-preview').scrollIntoView({block:'center'})", pause: 600 },
    { js: "const s = __wb.shown('.work-view .transcript'); s.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true })); s.scrollTop -= 1;", wait: "[...document.querySelectorAll('.transcript .attach-thumb img')].some(img => img.complete && img.naturalWidth > 0)" },
  ] },
  { name: "hig-image-gallery", steps: [
    { js: "__wb.click('.transcript .attach-thumb:not(:disabled)')", wait: "__wb.has('.attach-lightbox img')" },
    { wait: "document.querySelector('.attach-lightbox img')?.naturalWidth > 0" },
  ], cleanup: [{ js: "__wb.click('[aria-label=\"그림 닫기\"]')", wait: "!__wb.has('.attach-lightbox')" }] },
  { name: "hig-grid-two", steps: [...gridSteps(2), { assert: "칸마다 면 하나" }, { assert: "면에 흐린 그림자 없음" }], viewport: { width: 1600, height: 1000 } },
  { name: "hig-grid-four", steps: [...gridSteps(4), { assert: "칸마다 면 하나" }], viewport: { width: 1600, height: 1000 } },
  { name: "hig-grid-nine", steps: [...gridSteps(9), { assert: "칸마다 면 하나" }], viewport: { width: 1600, height: 1000 } },
  { name: "hig-grid-focus", steps: [{ js: "__wb.click('[aria-label=\"이 칸 확대\"]')", wait: "document.querySelectorAll('.pane:not([hidden])').length === 1" }, { assert: "칸마다 면 하나" }], viewport: { width: 1600, height: 1000 }, cleanup: [{ js: "__wb.click('[aria-label=\"전체 칸 보기\"]')" }] },
  { name: "hig-work-links", steps: [{ wait: "__wb.has('[aria-label=\"화면 배치\"]')", pause: 800 }, { js: "__wb.click('[aria-label=\"화면 배치\"]')", wait: "__wb.has('[role^=menuitem]', '작업 연결')" }, { js: "__wb.click('[role^=menuitem]', '작업 연결')", wait: "__wb.has('.work-link-dialog[open]')" },
    ...pick("보내는 세션", minutes.id),
    ...pick("받는 세션", reviewer.id),
    { js: "__wb.type('.work-link-dialog textarea', 'HIG 연결 확인: 요청을 정리해 줘.');" },
    { js: "__wb.click('.work-link-dialog [type=submit]')", wait: "__wb.has('.work-link-dialog [role=status]', '요청을 보냈습니다') && __wb.has('.work-link-history')" },
  ], cleanup: [{ js: "__wb.click('[aria-label=\"작업 연결 닫기\"]')" }] },
  { name: "hig-narrow", steps: [...gridSteps(1), ...openSession(minutes.id)], viewport: { width: 744, height: 900 } },
  { name: "hig-phone", steps: [...gridSteps(1), ...openSession(minutes.id), { js: "if (__wb.has('.sidebar')) __wb.click('.sidebar-scrim')", wait: "!__wb.has('.sidebar')" }, { assert: "좁으면 가장자리까지" }], viewport: { width: 700, height: 900 } },
  ...MENU_SCREENS,
  { name: "hig-large-text", steps: [{ js: "document.documentElement.style.fontSize = '32px'" }], viewport: { width: 1000, height: 900 }, cleanup: [{ js: "document.documentElement.style.fontSize = ''" }] },
];
// The motion grammar (--motion): each motion as a burst of WebKitGTK snapshots ~40ms apart.
const MOTION_SCREENS: Screen[] = [
  { name: "m1-segment", steps: [
    ...gridSteps(1),
    { js: "__wb.click('.topbar .brand')", wait: "__wb.has('.home-mode-bar') && __wb.has('.start-view .engine-tabs')" },
    { js: "__wb.blur()", pause: 400 },
    { burst: { name: "engine", js: "__wb.click('.start-view .engine-tabs button', 'Codex')", frames: 8 } },
    { burst: { name: "home", js: "__wb.click('.home-mode-bar button', '흐름')", frames: 8 } },
  ], cleanup: [{ js: "__wb.click('.home-mode-bar button', '지금')", wait: "__wb.has('.home-modes.mode-now')" }, { js: "__wb.click('.start-view .engine-tabs button', 'Claude')" }] },
  { name: "m2-progress", steps: [
    ...openSession(minutes.id),
    { js: "__wb.type('.work-view .composer-input', '천천히 길게 정리해 줘')" },
    { burst: { name: "line", js: "__wb.click('.work-view .composer [aria-label=\"보내기\"]')", until: "true", frames: 12, every: 80 } },
  ], settle: 300 },
  // The same line on a Claude conversation: the engine's own colour carries the motion.
  { name: "m2-progress-claude", steps: [
    ...openSession(reviewer.id),
    { js: "__wb.type('.work-view .composer-input', '천천히 길게 정리해 줘')" },
    { burst: { name: "line", js: "__wb.click('.work-view .composer [aria-label=\"보내기\"]')", until: "true", frames: 12, every: 80 } },
  ], settle: 300 },
  { name: "m3-shimmer", steps: [
    ...openSession(codex.id),
    // The fixture's finished turn stands in for a running one: the class is what a running step gets.
    { wait: "__wb.has('.work-view .work-summary-text')" },
    { js: "const text = __wb.q('.work-view .work-summary-text'); text?.classList.add('running'); text?.scrollIntoView({ block: 'center' })" },
    { burst: { name: "text", frames: 8, every: 120 } },
  ] },
  { name: "m4-zoom", viewport: { width: 1440, height: 900 }, steps: [
    ...openSession(codex.id),
    ...gridSteps(2),
    { burst: { name: "grow", js: "__wb.click('[aria-label=\"이 칸 확대\"]')", frames: 8 } },
    { pause: 400 },
    { burst: { name: "restore", js: "__wb.click('[aria-label=\"전체 칸 보기\"]')", frames: 8 } },
  ], cleanup: gridSteps(1) },
  { name: "m5-tabs", steps: [
    ...gridSteps(1),
    ...openSession(codex.id),
    { pause: 400 },
    { burst: { name: "open", js: `__wb.click('${row(meeting.id)}')`, frames: 6 } },
    { pause: 400 },
    { burst: { name: "close", js: "[...document.querySelectorAll('.group-tab')].at(-2)?.querySelector('.group-tab-close')?.click()", frames: 6 } },
    // Frame intervals while a tab opens, without snapshots in the way (the width motion must not thrash).
    { pause: 400 },
    { js: `window.__frames = []; let last = 0; const end = performance.now() + 400; const tick = (now) => { if (last) window.__frames.push(Math.round(now - last)); last = now; if (now < end) requestAnimationFrame(tick); }; requestAnimationFrame(tick); __wb.click('${row(review.id)}')`, pause: 500 },
    { probe: "window.__frames" },
    // Closing the shown (active) tab: its view and its copy of the bar go away with it.
    { js: "__wb.click('.group-tab [role=\"tab\"]')", pause: 500 },
    { burst: { name: "close-active", js: "__wb.click('.group-tab.active .group-tab-close')", frames: 6 } },
  ] },
  // Last: reloads, so the logo's once-per-launch entrance runs again, and the capsule mounts anew.
  { name: "m6-entrance", steps: [
    { js: "__wb.click('.topbar .brand')", wait: "__wb.has('.home-brand')", pause: 1500 },
    { reload: true },
    // As soon as the logo mounts: whether it enters, and whether the arc is drawn yet (reduced motion: no entrance, drawn).
    { wait: "__wb.has('.home-brand')", probe: "({ reduced: matchMedia('(prefers-reduced-motion: reduce)').matches, greet: document.querySelector('.home-brand').classList.contains('greet'), arc: getComputedStyle(document.querySelector('.home-brand .wordmark-arc')).opacity, letters: getComputedStyle(document.querySelector('.home-brand .wordmark-flow')).opacity })",
      burst: { name: "logo", until: "__wb.has('.home-brand')", frames: 10 } },
    { burst: { name: "approval", js: "const b = document.querySelector('.attention-button'); b?.replaceWith(b.cloneNode(true))", frames: 5 } },
  ] },
];
// Completion notices (they add turns, so only when asked for by --only=completion).
const sendIn = (text: string): Step[] => [
  { js: `__wb.type('.pane[data-pane-active="true"] .composer-input', '${text}')` },
  { js: `__wb.click('.pane[data-pane-active="true"] [aria-label="보내기"]')`, wait: `__wb.has('.pane[data-pane-active="true"] .composer[data-phase]')` },
];
const closeReviewer: Step[] = [{ js: "__wb.click('[aria-label=\"리뷰 정리 탭 닫기\"]')", wait: "!__wb.has('[aria-label=\"리뷰 정리 탭 닫기\"]')" }];
const COMPLETION_SCREENS: Screen[] = [
  {
    // Answer arrives in a background tab: the tab and the sidebar row say so in place.
    name: "completion-hidden-tab",
    steps: [...gridSteps(1), ...openSession(minutes.id), ...sendIn("완료 알림 확인: 숨은 탭"), { js: `__wb.click('${row(reviewer.id)}')` }, { burst: { name: "burst", frames: 30, every: 40 } }, { wait: "__wb.has('.top-notice')" }],
    settle: 300,
    cleanup: closeReviewer,
  },
  {
    // The palette stays on top of a notice.
    name: "completion-palette",
    steps: [{ wait: "!__wb.has('.top-notice')" }, ...openSession(minutes.id), ...sendIn("완료 알림 확인: 팔레트"), { js: `__wb.click('${row(reviewer.id)}')` }, { js: "__wb.blur(); __wb.key('k', { ctrlKey: true })", wait: "__wb.has('.palette')" }, { wait: "__wb.has('.top-notice')" }],
    settle: 300,
    cleanup: [{ js: "__wb.key('Escape')", wait: "!__wb.has('.palette')" }, ...closeReviewer],
  },
  {
    // Two panes: the answer the user is watching arrives with nothing laid over it.
    name: "completion-two-panes",
    steps: [
      { wait: "!__wb.has('.top-notice')" }, ...openSession(minutes.id), ...gridSteps(2),
      { js: "window.__shotPane = __wb.q('.pane[data-pane-active=\"true\"]').dataset.pane; __wb.q('.pane:not([hidden])[data-pane-active=\"false\"] [role=tab][aria-selected=true]').focus()", wait: "__wb.q('.pane[data-pane-active=\"true\"]').dataset.pane !== window.__shotPane" },
      { js: `__wb.click('${row(reviewer.id)}')`, wait: "__wb.has('.pane[data-pane-active=\"true\"] .pane-head-title', '리뷰 정리') && document.querySelectorAll('.pane:not([hidden]) .work-view').length === 2" },
      ...sendIn("완료 알림 확인: 보이는 칸"), { pause: 2500 },
    ],
    settle: 300,
    cleanup: gridSteps(1),
  },
];
COMPLETION_SCREENS.push({
  // The user's own action: its toast takes the title's place in the top bar.
  name: "completion-action-toast",
  steps: [{ wait: "!__wb.has('.top-notice')" }, ...openSession(minutes.id), { js: "__wb.blur(); __wb.key('k', { ctrlKey: true })", wait: "__wb.has('.palette')" },
    { js: "__wb.click('.palette [role=option], .palette button, .palette li', '마크다운으로 복사')", wait: "__wb.has('.topbar > .top-notice')" },
    // The engine honours inert: the faded title cannot take focus (the step fails otherwise).
    { wait: "(() => { const title = document.querySelector('.topbar-title'); title.focus(); return title.inert === true && document.activeElement !== title; })()" }],
  settle: 300,
});
// An error in the same slot: the host made unreachable for one command.
const failFetch = "window.__realFetch = window.__realFetch || window.fetch; window.fetch = () => Promise.reject(new TypeError('호스트에 연결하지 못했습니다.'))";
const restoreFetch: Step[] = [{ js: "if (window.__realFetch) window.fetch = window.__realFetch; __wb.click('.top-notice [aria-label=\"알림 닫기\"]')", wait: "!__wb.has('.top-notice')" }];
// The layout is saved 200ms after it changes (opening the row in a narrow window closes the laid-over
// sidebar): let that save land first, or it fails too and its standing notice takes the slot.
const errorSteps: Step[] = [{ wait: "!__wb.has('.top-notice')" }, ...openSession(minutes.id), { pause: 1000 }, { js: failFetch }, { js: "__wb.blur(); __wb.key('k', { ctrlKey: true })", wait: "__wb.has('.palette')" },
  { js: "__wb.click('.palette [role=option], .palette button, .palette li', '마크다운으로 복사')", wait: "__wb.has('.topbar > .top-notice[data-kind=error]')" }];
COMPLETION_SCREENS.push(
  { name: "completion-error-toast", steps: errorSteps, settle: 300, cleanup: restoreFetch },
  // Below 744px the title is hidden; the slot keeps the same band.
  { name: "completion-narrow-hidden-tab", viewport: { width: 700, height: 860 }, steps: [{ wait: "!__wb.has('.top-notice')" }, ...openSession(minutes.id), ...sendIn("완료 알림 확인: 좁은 창"), { js: `__wb.click('${row(reviewer.id)}')` }, { pause: 2500 }], settle: 300, cleanup: closeReviewer },
  { name: "completion-narrow-error", viewport: { width: 700, height: 860 }, steps: errorSteps, settle: 300, cleanup: restoreFetch },
);
// The project subtree by kind (--only=nav-): 대화 · 문서 · 웹, the document AI on its document row.
const sidebarOpen: Step = { js: "if (!__wb.has('.sidebar')) __wb.click('.topbar-left [aria-label=\"사이드바 열기\"]')", wait: "__wb.has('.sidebar')" };
const NAV_SCREENS: Screen[] = papers ? [
  { name: "nav-kinds", steps: [
    sidebarOpen,
    { js: `__wb.click('${row(papers.id)}')`, wait: `__wb.has('${row(paperDocs[5]!.id)}')` },
    { js: `__wb.q('${row(papers.id)}').scrollIntoView({ block: 'start' }); __wb.blur()`, pause: 300 },
  ], settle: 600 },
  // A document row's menu at the pointer (right-click).
  { name: "nav-doc-menu", steps: [
    sidebarOpen,
    { js: `__wb.q('${row(paperDocs[0]!.id)}').scrollIntoView({ block: 'center' })`, pause: 200 },
    { js: `__wb.context('${row(paperDocs[0]!.id)}')`, wait: "__wb.has('.context-menu') || __wb.has('.ui-menu[data-state=open]')", pause: 300 },
  ], settle: 300, cleanup: [{ press: "Escape", wait: "!__wb.has('.context-menu') && !__wb.has('.ui-menu')" }] },
  // The same menu under the row's ⋯, from the keyboard path's button.
  { name: "nav-doc-more", steps: [
    sidebarOpen,
    { js: `__wb.click('${row(paperDocs[0]!.id)} .row-more')`, wait: "__wb.has('.ui-menu[data-state=open]')", pause: 300 },
  ], settle: 300, cleanup: [{ press: "Escape", wait: "!__wb.has('.ui-menu')" }] },
  // A document AI's own actions, under its entry in the document row's menu.
  { name: "nav-doc-ai-actions", steps: [
    sidebarOpen,
    { js: `__wb.q('${row(paperDocs[0]!.id)}').scrollIntoView({ block: 'center' })`, pause: 200 },
    { js: `__wb.context('${row(paperDocs[0]!.id)}')`, wait: "__wb.has('.ui-menu[data-state=open]')", pause: 200 },
    { js: "__wb.click('.ui-menu [data-value^=submenu]')", wait: "document.querySelectorAll('.ui-menu[data-state=open]').length === 2", pause: 300 },
  ], settle: 300, cleanup: [{ press: "Escape" }, { press: "Escape", wait: "!__wb.has('.ui-menu')" }] },
  // A document with its AI on screen and its 문서 group folded: the group is where the user is.
  { name: "nav-folded-active", steps: [
    sidebarOpen,
    { js: `__wb.click('${row(paperDocs[0]!.id)}')`, wait: "__wb.has('.document-view')", pause: 600 },
    sidebarOpen,
    { js: `__wb.click('${row(`docs:${papers.id}`)} .row-chevron')`, wait: `!__wb.has('${row(paperDocs[0]!.id)}')` },
    { js: `__wb.q('${row(papers.id)}').scrollIntoView({ block: 'start' }); __wb.blur()`, pause: 300 },
  ], settle: 300, cleanup: [{ js: `__wb.click('${row(`docs:${papers.id}`)} .row-chevron')`, wait: `__wb.has('${row(paperDocs[0]!.id)}')` }] },
  // The app's own work area: both actions; a user folder (above): 목록에서 빼기 only.
  { name: "nav-doc-menu-trash", steps: [
    sidebarOpen,
    { js: `__wb.q('${row(draft!.id)}').scrollIntoView({ block: 'center' })`, pause: 200 },
    { js: `__wb.context('${row(draft!.id)}')`, wait: "__wb.has('.ui-menu [role=menuitem]', '휴지통으로 옮기기')", pause: 300 },
  ], settle: 300, cleanup: [{ press: "Escape", wait: "!__wb.has('.ui-menu')" }] },
  // Unsaved edits: the editor itself is asked before anything is sent.
  { name: "nav-unsaved", steps: [
    sidebarOpen,
    { js: `__wb.click('${row(draft!.id)}')`, wait: "__wb.has('.document-view')", pause: 600 },
    { js: "__wb.click('.document-view button', '원문')", wait: "__wb.has('.document-view .cm-content')", pause: 300 },
    // The save never reaches the gateway here, so the edit stays unsaved while the question is asked.
    { js: "window.__realFetch = window.__realFetch || window.fetch; window.fetch = (input, init) => (init && init.method === 'PUT' && String(input).includes('/text')) ? new Promise((resolve, reject) => { window.__heldSave = () => window.__realFetch(input, init).then(resolve, reject); }) : window.__realFetch(input, init)" },
    { js: "const content = __wb.q('.document-view .cm-content'); content.focus(); document.execCommand('insertText', false, '저장 안 한 줄 ')", pause: 200 },
    sidebarOpen,
    { js: `__wb.context('${row(draft!.id)}')`, wait: "__wb.has('.ui-menu [role=menuitem]', '목록에서 빼기')", pause: 200 },
    { js: "__wb.click('.ui-menu [role=menuitem]', '목록에서 빼기')", wait: "__wb.has('.nav-dialog', '저장하지 않은 내용이 있습니다')", pause: 300 },
  ], settle: 300,
  // 취소 sends nothing; then the held save goes through and the edit is saved.
  cleanup: [{ js: "__wb.click('.nav-dialog button', '취소'); if (window.__realFetch) window.fetch = window.__realFetch; window.__heldSave?.()", wait: "!__wb.has('.nav-dialog') && !__wb.has('.document-view', '저장 중')", pause: 1500 }] },
  // 휴지통으로 옮기기 of the app-area document open in a tab: the tab closes, 되돌리기 in the notice.
  { name: "nav-doc-trashed", steps: [
    { pause: 1500 },
    sidebarOpen,
    { js: `__wb.context('${row(draft!.id)}')`, wait: "__wb.has('.ui-menu [role=menuitem]', '휴지통으로 옮기기')", pause: 200 },
    { js: "__wb.click('.ui-menu [role=menuitem]', '휴지통으로 옮기기')", wait: "__wb.has('.top-notice', '앱 휴지통으로 옮겼습니다') && !__wb.has('.group-tab', '초안.md')" },
    { js: "__wb.blur()", pause: 300 },
  ], settle: 300 },
  // 목록에서 빼기 of a document in the user's folder, open in a tab: the file stays where it is.
  { name: "nav-doc-unlisted", steps: [
    sidebarOpen,
    { js: `__wb.click('${row(paperDocs[1]!.id)}')`, wait: "__wb.has('.document-view')", pause: 600 },
    sidebarOpen,
    { js: `__wb.context('${row(paperDocs[1]!.id)}')`, wait: "__wb.has('.ui-menu [role=menuitem]', '목록에서 빼기')", pause: 200 },
    // Its rich editor may hold edits (an embedded editor reports from its frame, so the app cannot
    // tell): asked "…편집이 있을 수 있습니다", then saved through its own leave path. Since U38 the
    // untouched document no longer reports unsaved edits, and the removal waits for the view's clean
    // report at the gateway (it was refused with 409 document_unsaved).
    { js: "__wb.click('.ui-menu [role=menuitem]', '목록에서 빼기')", wait: "__wb.has('.nav-dialog', '저장하지 않은 편집이')" },
    { js: "__wb.click('.nav-dialog button', '저장하고 계속')", wait: "__wb.has('.top-notice', '목록에서 뺐습니다') && !__wb.has('.group-tab', 'style.md') && !__wb.has('.document-view', '문서를 찾을 수 없습니다')" },
    // The next tab is a document (editor focus hides the sidebar): open it again for the picture.
    { pause: 600 }, sidebarOpen,
    { js: `__wb.q('${row(papers.id)}').scrollIntoView({ block: 'start' }); __wb.blur()`, pause: 300 },
  ], settle: 300 },
  { name: "nav-archive", steps: [
    sidebarOpen,
    { js: "__wb.click('.side-foot .side-row', '보관함')", wait: "__wb.has('.archive-view .archive-row', 'style.md') && __wb.has('.archive-view .archive-row', '초안.md') && __wb.has('.archive-view .archive-row', '지운 프로젝트')", pause: 300 },
  ], settle: 300,
  // 되돌리기 from 보관함: both come back to their rows, the AI with its document.
  cleanup: [
    { js: "[...document.querySelectorAll('.archive-row')].find((item) => item.querySelector('.archive-title')?.textContent === 'style.md')?.querySelector('button.button')?.click()", wait: `__wb.has('${row(paperDocs[1]!.id)}')` },
    { js: "[...document.querySelectorAll('.archive-row')].find((item) => item.querySelector('.archive-title')?.textContent === '초안.md')?.querySelector('button.button')?.click()", wait: "!__wb.has('.archive-row', '초안.md')" },
  ] },
  // A document taken off the list: its AI conversation is history — a reason, no working input,
  // and its waiting request shown without 지금 보내기.
  { name: "nav-retired-ai", steps: [
    sidebarOpen,
    { js: `__wb.context('${row(paperDocs[2]!.id)}')`, wait: "__wb.has('.ui-menu [role=menuitem]', '목록에서 빼기')", pause: 200 },
    { js: "__wb.click('.ui-menu [role=menuitem]', '목록에서 빼기')", wait: "__wb.has('.top-notice', '목록에서 뺐습니다')" },
    { js: "__wb.click('.side-foot .side-row', '보관함')", wait: "__wb.has('.archive-row', '목록에서 뺀 문서의 문서 AI')", pause: 200 },
    { js: "[...document.querySelectorAll('.archive-row')].find((item) => item.textContent.includes('목록에서 뺀 문서의 문서 AI'))?.querySelector('.archive-open')?.click()", wait: "__wb.has('.note-banner', '목록에서 뺀 문서') && __wb.has('.queued-list', '표로도')", pause: 400 },
    { wait: "!__wb.has('.work-view', '대화를 불러오는 중')", pause: 300 },
    { assert: "읽기 전용 대화" },
  ], settle: 300,
  cleanup: [
    { js: "__wb.click('.side-foot .side-row', '보관함')", wait: "__wb.has('.archive-view')" },
    { js: "[...document.querySelectorAll('.archive-row')].find((item) => item.querySelector('.archive-title')?.textContent === '강의 계획.md')?.querySelector('button.button')?.click()", wait: `__wb.has('${row(paperDocs[2]!.id)}')` },
  ] },
] : [];
// ── fix wave 2, part A (--only=nav-fx2a) ─────────────────────────────────────────────────────────
// One block, appended to the nav set (it needs that set's seeds: documents with their own AIs).
// The conversation's input zone, the document AI's composer, read-only banners, the narrow-pane
// view of a document, and the one opener of a document AI.
const BAR_PROBE = (scope: string) => `(() => {
  const bar = __wb.shown('${scope} .composer-bar');
  if (!bar) return { bar: false };
  const mid = (element) => { const box = element.getBoundingClientRect(); return Math.round(box.top + box.height / 2); };
  const controls = [...bar.querySelectorAll('.composer-left > *, .composer-right > *')].filter((element) => element.getClientRects().length);
  return { width: Math.round(bar.getBoundingClientRect().width), rows: new Set(controls.map(mid)).size, labels: [...bar.querySelectorAll('.plain-select, .composer-target-name, .select-button')].map((element) => element.textContent.trim()), modeBar: __wb.has('${scope} .work-mode-row') };
})()`;
const JUMP_PROBE = `(() => {
  const view = document.querySelector('.pane[data-pane-active="true"] .work-view') ?? document.querySelector('.work-view');
  const button = view.querySelector('.jump-end'), column = view.querySelector('.transcript-inner');
  if (!button || !column) return { band: false };
  const box = button.getBoundingClientRect(), col = column.getBoundingClientRect(), band = view.querySelector('.jump-band').getBoundingClientRect();
  const covered = [...view.querySelectorAll('.turn-request time, .turn-request, .markdown p, .markdown li')].filter((element) => { const r = element.getBoundingClientRect(); return r.bottom > band.top + 1 && r.top < band.bottom && r.height > 0; }).length;
  return { band: true, insideColumn: box.left >= col.left - 1 && box.right <= col.right + 1, bandTop: Math.round(band.top), buttonRight: Math.round(box.right), columnRight: Math.round(col.right), wordsUnderBandAreCutNotCovered: covered };
})()`;
const openLecture: Step[] = [
  { js: "__wb.click('.note-head-more')", wait: "__wb.has('.note-menu [role=menuitem]', '강의안.md')" },
  { js: "__wb.click('.note-menu [role=menuitem]', '강의안.md')", wait: "__wb.has('.document-view')" },
];
const closeDocTabs: Step = { js: "[...document.querySelectorAll('.group-tab')].filter((tab) => /\\.(md|txt)/.test(tab.textContent)).forEach((tab) => tab.querySelector('.group-tab-close')?.click())", pause: 800 };
const FIX2A_SCREENS: Screen[] = papers ? [
  // A10: a conversation with no document open has no 대화/문서/… bar; the bar comes with a document tab.
  { name: "nav-fx2a-quiet-codex", steps: [...gridSteps(1), closeDocTabs, ...openSession(codex.id), { wait: "__wb.has('.approval-card')" }, ...toEnd, { probe: BAR_PROBE(".work-view") }], settle: 800 },
  { name: "nav-fx2a-quiet-claude", steps: [...openSession(claude.id), { wait: "__wb.has('.plan-approval')" }, ...toEnd, { probe: BAR_PROBE(".work-view") }], settle: 800 },
  // A10: 맨 아래로 as a band under the conversation, with the right sidebar open.
  { name: "nav-fx2a-jump", steps: [...openSession(codex.id), { wait: "__wb.has('.approval-card')" }, ...openRight, ...toTop, { wait: "__wb.has('.work-view .jump-band')", pause: 300 }, { probe: JUMP_PROBE }], settle: 600, cleanup: [...closeRight] },
  // A7: a document just opened in the embedded editor shows no unsaved mark.
  { name: "nav-fx2a-doc-opened", steps: [...openSession(codex.id), ...openLecture, { pause: 6000 }, { probe: "({ label: document.querySelector('.document-view .save-state')?.textContent, editor: __wb.has('.document-view iframe') })" }], settle: 500 },
  // A5/A6: the document AI's composer (원문, in its column beside the document), and the conversation's bar.
  { name: "nav-fx2a-doc-composer", steps: [
    { js: "if (!__wb.has('.document-view .ghost-button', '문서 AI')) __wb.click('.document-view button', '원문')", wait: "__wb.has('.document-view .ghost-button', '문서 AI')" },
    { js: "if (!__wb.has('.doc-composer .hig-composer')) __wb.click('.document-view .ghost-button', '문서 AI')", wait: "__wb.has('.doc-composer .hig-composer[data-provider]')" },
    { js: "__wb.blur()" }, { probe: BAR_PROBE(".doc-composer") }], settle: 800 },
  { name: "nav-fx2a-doc-target-menu", steps: [{ js: "__wb.click('.doc-composer .composer-right .select-button')", wait: "__wb.has('.doc-composer .popover [role^=menuitem]', 'Claude')", pause: 250 }], settle: 300,
    cleanup: [{ js: "__wb.key('Escape')", wait: "!__wb.has('.doc-composer .popover')" }] },
  { name: "nav-fx2a-bar-band", steps: [{ js: "__wb.click('.document-view .doc-header .ghost-button', '대화')", wait: "__wb.has('.work-view .hig-composer')" }, ...toTop, { probe: BAR_PROBE(".work-view") }], settle: 800 },
  // A8: two panes — a document opened into a pane too narrow for the editor (no tab of it open
  // before, so no editor exists): its own view stands in, with the line.
  { name: "nav-fx2a-panes", steps: [...gridSteps(1), closeDocTabs, ...openSession(codex.id), ...gridSteps(2), sidebarOpen,
    { js: "__wb.click('.sidebar .side-row', '강의안.md')", wait: "__wb.has('.document-view')", pause: 2500 },
    { js: "__wb.blur()" },
    { probe: "({ panes: [...document.querySelectorAll('.pane:not([hidden])')].map((p) => Math.round(p.getBoundingClientRect().width)), line: __wb.q('.document-view .doc-note-line')?.textContent, editorFrames: [...document.querySelectorAll('.document-view iframe')].filter((f) => f.getClientRects().length).length, view: __wb.q('.document-view [role=radio][aria-checked=true]')?.textContent, revision: __wb.q('.document-view button[title=\"판 기록\"]')?.textContent.trim() })" }], settle: 800 },
  { name: "nav-fx2a-panes-editor", steps: [{ js: "__wb.click('.document-view .doc-note-line button', '편집기로 열기')", wait: "__wb.has('.document-view iframe')", pause: 5000 }, { js: "__wb.blur()" },
    { probe: "({ line: __wb.has('.document-view .doc-note-line'), view: __wb.q('.document-view [role=radio][aria-checked=true]')?.textContent })" }], settle: 800,
    cleanup: [{ js: "__wb.click('.document-view button', '원문')", pause: 800 }, ...gridSteps(1)] },
  // A8, one narrow pane (run with --width=660): the document opens in its own view, with the line.
  { name: "nav-fx2a-narrow-doc", steps: [...gridSteps(1), ...openSession(codex.id),
    { js: "if (__wb.has('.sidebar-scrim')) __wb.click('.sidebar-scrim')", wait: "!__wb.has('.sidebar-scrim')" },
    ...openLecture, { pause: 2500 }, { js: "__wb.blur()" },
    { probe: "({ view: Math.round(document.querySelector('.document-view').getBoundingClientRect().width), line: __wb.q('.document-view .doc-note-line')?.textContent, editorFrames: [...document.querySelectorAll('.document-view iframe')].filter((f) => f.getClientRects().length).length, mode: __wb.q('.document-view [role=radio][aria-checked=true]')?.textContent })" }], settle: 600,
    cleanup: [{ js: "__wb.click('.document-view .doc-header .ghost-button', '대화')", wait: "__wb.has('.work-view .transcript')" }] },
  // A8 after verification: an editor already open (it reports unsaved edits, as the Markdown editor
  // does from opening) whose pane becomes narrow stays — nothing is saved; the other view is offered.
  { name: "nav-fx2a-narrow-offer", steps: [...gridSteps(1), ...openSession(codex.id), ...openLecture,
    { js: "if (__wb.has('.document-view button[aria-checked=false]', '편집')) __wb.click('.document-view button', '편집')", wait: "__wb.has('.document-view iframe')", pause: 5000 },
    { probe: "({ before: __wb.q('.document-view .save-state')?.textContent, revision: __wb.q('.document-view button[title=\"판 기록\"]')?.textContent.trim() })" },
    { js: "if (__wb.has('.topbar-right button', '작업공간 보기')) __wb.click('.topbar-right button', '작업공간 보기')", wait: "!__wb.has('.topbar-right button', '작업공간 보기')", pause: 600 },
    ...gridSteps(2), { pause: 1500 }, { js: "__wb.blur()" },
    { probe: "({ panes: [...document.querySelectorAll('.pane:not([hidden])')].map((p) => Math.round(p.getBoundingClientRect().width)), line: __wb.q('.document-view .doc-note-line')?.textContent, editorFrames: [...document.querySelectorAll('.document-view iframe')].filter((f) => f.getClientRects().length).length, view: __wb.q('.document-view [role=radio][aria-checked=true]')?.textContent, label: __wb.q('.document-view .save-state')?.textContent, revision: __wb.q('.document-view button[title=\"판 기록\"]')?.textContent.trim() })" }], settle: 800 },
  // 원문으로 보기 there: the person's own change of view (it saves first, as picking a view does).
  { name: "nav-fx2a-narrow-offer-taken", steps: [{ js: "__wb.click('.document-view .doc-note-line button', '원문으로 보기')", wait: "__wb.has('.document-view .cm-content') && !__wb.has('.document-view .doc-note-line')", pause: 800 }, { js: "__wb.blur()" },
    { probe: "({ view: __wb.q('.document-view [role=radio][aria-checked=true]')?.textContent, editorFrames: [...document.querySelectorAll('.document-view iframe')].filter((f) => f.getClientRects().length).length, revision: __wb.q('.document-view button[title=\"판 기록\"]')?.textContent.trim() })" }], settle: 600,
    cleanup: [...gridSteps(1)] },
  // The same for a PowerPoint document (its editor reports unsaved edits only every 2 s): the open
  // editor stays in the narrowed pane, whatever it has reported.
  { name: "nav-fx2a-narrow-offer-pptx", steps: [...gridSteps(1), ...openSession(minutes.id), { wait: "__wb.has('.doc-card', '회의-발표.pptx')" },
    // A file card opens it beside its conversation in the app's own view (U28); its own tab has the editor.
    { js: "__wb.click('.doc-card', '회의-발표.pptx')", wait: "__wb.has('.document-view[data-hosted] .doc-wide')", pause: 600 },
    { js: "__wb.click('.document-view[data-hosted] .doc-wide')", wait: "!__wb.has('.document-view[data-hosted]') && __wb.has('.document-view iframe')", pause: 6000 },
    { js: "if (__wb.has('.topbar-right button', '작업공간 보기')) __wb.click('.topbar-right button', '작업공간 보기')", wait: "!__wb.has('.topbar-right button', '작업공간 보기')", pause: 600 },
    ...gridSteps(2), { pause: 1500 }, { js: "__wb.blur()" },
    { probe: "({ panes: [...document.querySelectorAll('.pane:not([hidden])')].map((p) => Math.round(p.getBoundingClientRect().width)), line: __wb.q('.document-view .doc-note-line')?.textContent, editorFrames: [...document.querySelectorAll('.document-view iframe')].filter((f) => f.getClientRects().length).length, view: __wb.q('.document-view [role=radio][aria-checked=true]')?.textContent, revision: __wb.q('.document-view button[title=\"판 기록\"]')?.textContent.trim() })" }], settle: 800,
    cleanup: [...gridSteps(1)] },
  // A11: the document row's menu, its AI submenu opened with → from the keyboard.
  { name: "nav-fx2a-submenu-keys", steps: [
    sidebarOpen,
    { js: `__wb.q('${row(paperDocs[0]!.id)}').scrollIntoView({ block: 'center' })`, pause: 200 },
    { js: `__wb.context('${row(paperDocs[0]!.id)}')`, wait: "__wb.has('.ui-menu[data-state=open]')", pause: 300 },
    // One key at a time: the menu's active item moves on its next render.
    ...Array.from({ length: 8 }, (): Step => ({ js: "if (!document.getElementById(document.querySelector('.ui-menu [aria-activedescendant]')?.getAttribute('aria-activedescendant') ?? '')?.dataset.value?.startsWith('submenu')) __wb.key('ArrowDown')", pause: 120 })),
    { js: "__wb.key('ArrowRight')", wait: "document.querySelectorAll('.ui-menu[data-state=open]').length === 2", pause: 300 },
    { probe: "({ open: document.querySelectorAll('.ui-menu[data-state=open]').length, focusInSubmenu: [...document.querySelectorAll('.ui-menu')].at(-1).contains(document.activeElement) })" }], settle: 300,
    cleanup: [{ js: "__wb.key('ArrowLeft')", wait: "document.querySelectorAll('.ui-menu[data-state=open]').length === 1" }, { press: "Escape", wait: "!__wb.has('.ui-menu')" }] },
  // A1 + A12: 열기 in the AI submenu — the same opener as the row: the document, and its conversation asked for.
  { name: "nav-fx2a-ai-open", steps: [
    sidebarOpen,
    { js: `__wb.context('${row(paperDocs[0]!.id)}')`, wait: "__wb.has('.ui-menu[data-state=open]')", pause: 200 },
    { js: "__wb.click('.ui-menu [data-value^=submenu]')", wait: "document.querySelectorAll('.ui-menu[data-state=open]').length === 2", pause: 200 },
    { js: "[...document.querySelectorAll('.ui-menu')].at(-1).querySelector('[role=menuitem]').click()", wait: "__wb.has('.document-view') && __wb.has('.agent-column .doc-composer .hig-composer')", pause: 400 },
    { js: "__wb.blur()" },
    { probe: "({ notice: __wb.q('.top-notice')?.textContent, composer: __wb.has('.doc-composer .hig-composer'), tab: __wb.q('.group-tab.active')?.textContent })" }], settle: 500 },
  // A2: 보관 from the document AI's own ⋯ — no live input for it; one line and 문서 AI 시작.
  { name: "nav-fx2a-ai-archived", steps: [
    sidebarOpen,
    { js: `__wb.click('${row(paperDocs[3]!.id)}')`, wait: "__wb.has('.document-view')", pause: 800 },
    { js: "if (!__wb.has('.document-view .ghost-button', '문서 AI')) __wb.click('.document-view button', '원문')", wait: "__wb.has('.document-view .ghost-button', '문서 AI')" },
    { js: "if (!__wb.has('.doc-composer .hig-composer')) __wb.click('.document-view .ghost-button', '문서 AI')", wait: "__wb.has('.doc-composer .hig-composer[data-provider]')" },
    { js: "__wb.click('.agent-column .note-head button[aria-label=\"이 문서 AI 메뉴\"]')", wait: "__wb.has('.context-menu [role=menuitem]', '보관') || __wb.has('.context-menu button', '보관')", pause: 200 },
    { js: "__wb.click('.context-menu [role=menuitem], .context-menu button', '보관')", wait: "__wb.has('.doc-composer .note-banner button', '문서 AI 시작')", pause: 300 },
    { js: "__wb.blur()" },
    { probe: "({ input: __wb.has('.doc-composer textarea'), line: __wb.q('.doc-composer .note-banner')?.textContent, notice: __wb.q('.top-notice')?.textContent })" }], settle: 400 },
  // A4: that archived AI opened from 보관함: read-only — one banner where the input was.
  { name: "nav-fx2a-ai-readonly", steps: [
    sidebarOpen,
    { js: "__wb.click('.side-foot .side-row', '보관함')", wait: "__wb.has('.archive-view .archive-row', '회의 요약.md')", pause: 300 },
    { js: "[...document.querySelectorAll('.archive-row')].find((item) => item.textContent.includes('회의 요약.md'))?.querySelector('.archive-open')?.click()", wait: "__wb.has('.work-view .composer-area .note-banner', '보관한 대화')", pause: 500 },
    { js: "__wb.blur()" }, { assert: "읽기 전용 대화" }], settle: 400 },
  // A3: 되돌리기 there: the tab gives way to the document with exactly that AI beside it.
  { name: "nav-fx2a-ai-restored", steps: [
    { js: "__wb.click('.work-view .composer-area .note-banner button', '되돌리기')", wait: "__wb.has('.document-view') && __wb.has('.doc-composer .hig-composer') && !__wb.has('.doc-composer .note-banner button', '문서 AI 시작')", pause: 600 },
    { js: "__wb.blur()" },
    { probe: "({ tab: __wb.q('.group-tab.active')?.textContent, input: __wb.has('.doc-composer textarea'), target: __wb.q('.doc-composer .composer-target-name')?.textContent, readOnlyTabs: [...document.querySelectorAll('.group-tab')].filter((tab) => tab.textContent.includes('문서 AI')).length })" }], settle: 500 },
  // After verification (m-A2): 보관함에서 보기 on the AI of a removed document opens 보관함 in a tab of
  // its own — the read-only conversation keeps its tab, so restoring the document there gives that
  // tab back as the document.
  { name: "nav-fx2a-retired-archive", steps: [...gridSteps(1), sidebarOpen,
    { js: `__wb.q('${row(paperDocs[1]!.id)}').scrollIntoView({ block: 'center' })`, pause: 200 },
    { js: `__wb.context('${row(paperDocs[1]!.id)}')`, wait: "__wb.has('.ui-menu [role=menuitem]', '목록에서 빼기')", pause: 200 },
    // Open in its editor (a later pass), the document asks first; closed, it goes at once.
    { js: "__wb.click('.ui-menu [role=menuitem]', '목록에서 빼기')", wait: "__wb.has('.top-notice', '목록에서 뺐습니다') || __wb.has('.nav-dialog')" },
    { js: "if (__wb.has('.nav-dialog')) __wb.click('.nav-dialog button', '저장하고 계속')", wait: "__wb.has('.top-notice', '목록에서 뺐습니다')" },
    { js: "__wb.click('.side-foot .side-row', '보관함')", wait: "__wb.has('.archive-row', 'style.md')", pause: 300 },
    { js: "[...document.querySelectorAll('.archive-row')].find((item) => item.textContent.includes('style.md') && item.querySelector('.archive-open'))?.querySelector('.archive-open')?.click()", wait: "__wb.has('.work-view .composer-area .note-banner button', '보관함에서 보기')", pause: 500 },
    { probe: "({ tabsBefore: [...document.querySelectorAll('.group-tab')].map((tab) => tab.textContent.trim()) })" },
    { js: "__wb.click('.work-view .composer-area .note-banner button', '보관함에서 보기')", wait: "__wb.has('.archive-view .archive-row', 'style.md')", pause: 400 },
    { js: "__wb.blur()" },
    { probe: "({ tabsAfter: [...document.querySelectorAll('.group-tab')].map((tab) => tab.textContent.trim()), active: __wb.q('.group-tab.active')?.textContent.trim() })" }], settle: 400 },
  { name: "nav-fx2a-retired-restored", steps: [
    { js: "[...document.querySelectorAll('.archive-row')].find((item) => item.querySelector('.archive-title')?.textContent === 'style.md')?.querySelector('button.button')?.click()", wait: `__wb.has('${row(paperDocs[1]!.id)}')`, pause: 800 },
    { probe: "({ tabs: [...document.querySelectorAll('.group-tab')].map((tab) => tab.textContent.trim()) })" },
    { js: "[...document.querySelectorAll('.group-tab')].find((tab) => tab.textContent.includes('style.md'))?.querySelector('[role=tab]')?.click()", wait: "__wb.has('.document-view')", pause: 2500 },
    { js: "__wb.blur()" },
    { probe: "({ active: __wb.q('.group-tab.active')?.textContent.trim(), notice: __wb.q('.top-notice')?.textContent, composer: __wb.has('.doc-composer .hig-composer'), readOnlyBanner: __wb.has('.work-view .composer-area .note-banner') })" }], settle: 500 },
  // A4: a layout that could not be saved stands in the top bar's notice slot (not a strip under the bar).
  { name: "nav-fx2a-layout-notice", steps: [
    { js: "window.__realFetch = window.__realFetch || window.fetch; window.fetch = (input, init) => (init && init.method === 'PUT' && String(input).includes('/api/layouts/')) ? Promise.resolve(new Response(JSON.stringify({ code: 'layout_conflict', message: '다른 창에서 이 작업공간의 배치를 바꿨습니다. 현재 배치는 유지했습니다.' }), { status: 409, headers: { 'content-type': 'application/json' } })) : window.__realFetch(input, init)" },
    { js: "__wb.click('.topbar .brand')", wait: "__wb.has('.top-notice.layout-problem')", pause: 300 },
    { js: "__wb.blur()" },
    { probe: "({ text: __wb.q('.top-notice.layout-problem .top-notice-text')?.textContent, actions: [...document.querySelectorAll('.top-notice.layout-problem button')].map((b) => b.textContent), strip: __wb.has('.app > .layout-problem') })" }], settle: 300,
    cleanup: [{ js: "window.fetch = window.__realFetch; __wb.click('.top-notice.layout-problem button', '현재 배치로 저장')", wait: "!__wb.has('.top-notice.layout-problem')" }] },
] : [];
NAV_SCREENS.push(...FIX2A_SCREENS);
// ── end of fix wave 2, part A ────────────────────────────────────────────────────────────────────

// ── the two-pane navigator (--only=nav-u35) ──────────────────────────────────────────────────────
// Nothing stored (the layout follows the window), each stored layout, with the right sidebar, and
// what the list keeps: a project unfolded by kind, a document row's menu, sort, an empty folder.
const layoutIs = (layout: string) => `document.querySelector('.sidebar')?.dataset.layout === '${layout}'`;
const listRow = (id: string) => `.list-pane [data-row-id="${id}"]`;
// The app saves its whole set of preferences a moment after a change: wait that out before the
// script writes them, or the app's older copy lands on top (the layout, and the next pass's theme).
const SAVED: Step = { pause: 600 };
// The capture browser keeps its localStorage between runs; when a run gets an earlier run's port,
// the layout kept there brings back tabs of projects that no longer exist ("프로젝트 프로젝트"): closed.
const closeStaleTabs: Step = { js: "[...document.querySelectorAll('.group-tab')].filter((tab) => tab.textContent.trim() === '프로젝트프로젝트').forEach((tab) => tab.querySelector('.group-tab-close')?.click())", pause: 200 };
const navigatorAs = (navigator: Record<string, unknown>, layout: string): Step[] => [...gridSteps(1), closeStaleTabs, sidebarOpen, SAVED, { prefs: { navigator: { selected: { kind: "root" }, ...navigator } }, wait: layoutIs(layout), pause: 300 }];
// The off-screen window does not shrink below the size it started at: run this set with --width=1000 --height=700.
const WIDE = { width: 1440, height: 900 }, NARROW = { width: 1000, height: 700 }, MIDDLE = { width: 1100, height: 760 }, WIDEST = { width: 1920, height: 1000 };
// Ctrl+click on a conversation's row: it opens in a second pane beside the first (two panes of 360px at least).
const besideOf = (id: string): Step => ({ js: `__wb.q('${listRow(id)}').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }))`, wait: "document.querySelectorAll('.pane:not([hidden])').length === 2 && !document.querySelector('.panes')?.dataset.grid", pause: 900 });
const TABS = "({ tabs: [...document.querySelectorAll('.group-tab')].map((tab) => tab.textContent.trim()) })";
const U35_SCREENS: Screen[] = papers && paperMain && emptyFolder ? [
  // Nothing stored, 1440px: two panes. The project's page on screen; in the list it unfolds by kind.
  { name: "nav-u35-dual", viewport: WIDE, steps: [...navigatorAs({}, "dual"), { probe: TABS },
    { js: `__wb.click('${listRow(papers.id)}')`, wait: "__wb.has('.project-view')" }, { probe: TABS },
    { js: `__wb.q('${listRow(papers.id)}').scrollIntoView({ block: 'start' }); __wb.blur()`, pause: 400 },
    { assert: "내비게이터 두 칸은 틀 위에" }, { assert: "칸은 최소 너비를 지킴" }, { assert: "머리줄: 새로 만들기는 제 너비, 배치와 ⋯는 오른쪽 끝" }], settle: 700 },
  // A conversation of the project on screen: its row is the one marked; the project holds it.
  { name: "nav-u35-dual-chat", viewport: WIDE, steps: [...navigatorAs({}, "dual"),
    { js: `__wb.click('${listRow(paperMain.id)}')`, wait: "__wb.has('.work-view .transcript')" },
    { js: `__wb.q('${listRow(papers.id)}').scrollIntoView({ block: 'start' }); __wb.blur()`, pause: 400 },
    { probe: `({ project: __wb.q('${listRow(papers.id)}').className, current: __wb.q('${listRow(paperMain.id)}').className, kinds: [...document.querySelectorAll('.list-pane .side-kind, .list-pane .row-docs')].map((element) => element.textContent) })` },
    { assert: "칸은 최소 너비를 지킴" }], settle: 700 },
  // A document row's menu in the list (U24), under its ⋯.
  { name: "nav-u35-doc-menu", viewport: WIDE, steps: [...navigatorAs({}, "dual"),
    { js: `__wb.q('${listRow(paperDocs[0]!.id)}').scrollIntoView({ block: 'center' })`, pause: 200 },
    { js: `__wb.click('${listRow(paperDocs[0]!.id)} .row-more')`, wait: "__wb.has('.ui-menu[data-state=open]')", pause: 300 }], settle: 300,
    cleanup: [{ press: "Escape", wait: "!__wb.has('.ui-menu')" }] },
  // The layout control in the head, open.
  { name: "nav-u35-layout-menu", viewport: WIDE, steps: [...navigatorAs({}, "dual"),
    { js: "__wb.click('.side-head .side-layout')", wait: "__wb.has('.ui-menu[data-state=open] [role=menuitemradio]')", pause: 300 },
    { probe: "({ items: [...document.querySelectorAll('.ui-menu [role=menuitemradio]')].map((item) => item.textContent + (item.getAttribute('aria-checked') === 'true' ? ' ✓' : '')) })" }], settle: 300,
    cleanup: [{ press: "Escape", wait: "!__wb.has('.ui-menu')" }] },
  // A folder selected (the list's scope) while a conversation of one of its projects is on screen.
  { name: "nav-u35-folder", viewport: WIDE, steps: [...navigatorAs({}, "dual"), ...openSession(codex.id),
    { js: `__wb.click('.nav-pane [data-row-id="${lectures.id}"]')`, wait: `__wb.q('.list-pane .list-name')?.textContent === '강의'` },
    { js: "__wb.blur()", pause: 300 }], settle: 700 },
  // A tag of the projects' notes selected.
  { name: "nav-u35-tag", viewport: WIDE, steps: [...navigatorAs({}, "dual"),
    { js: "__wb.click('.nav-pane [data-tag=\"강의\"]')", wait: "__wb.q('.list-pane .list-name')?.textContent === '#강의'" }, { js: "__wb.blur()", pause: 300 }], settle: 500 },
  // An empty folder says what to do.
  { name: "nav-u35-empty-folder", viewport: WIDE, steps: [...navigatorAs({}, "dual"),
    { js: `__wb.click('.nav-pane [data-row-id="${emptyFolder.id}"]')`, wait: "__wb.has('.list-pane .list-empty')" }, { js: "__wb.blur()", pause: 300 }], settle: 500 },
  // A folder's own sort and the row shapes, from the list head.
  { name: "nav-u35-sort-menu", viewport: WIDE, steps: [...navigatorAs({}, "dual"),
    { js: "__wb.click('.list-pane [aria-label=\"정렬과 줄 모양\"]')", wait: "__wb.has('.ui-menu[data-state=open]', '마감일')", pause: 300 }], settle: 300,
    cleanup: [{ press: "Escape", wait: "!__wb.has('.ui-menu')" }] },
  { name: "nav-u35-compact", viewport: WIDE, steps: [...navigatorAs({ density: "compact" }, "dual"), { js: "__wb.q('.list-scroll').scrollTop = 0; __wb.blur()", pause: 300 }], settle: 500 },
  { name: "nav-u35-preview2", viewport: WIDE, steps: [...navigatorAs({ previewLines: 2, includeSub: false }, "dual"), { js: "__wb.q('.list-scroll').scrollTop = 0; __wb.blur()", pause: 300 }], settle: 500 },
  // Sections folded stay folded (지금 · 바로가기 · 태그).
  { name: "nav-u35-folded", viewport: WIDE, steps: [...navigatorAs({ sections: { now: true, shortcuts: true, tags: true } }, "dual"), { js: "__wb.blur()", pause: 300 },
    { probe: "({ folded: [...document.querySelectorAll('.nav-pane .nav-fold[aria-expanded=false]')].map((button) => button.textContent) })" }], settle: 400 },
  // The sidebar's edge and the split, from the keyboard.
  { name: "nav-u35-resize-keys", viewport: WIDE, steps: [...navigatorAs({}, "dual"),
    { js: "document.querySelector('.sidebar .side-resize').focus()" }, { press: "Right" }, { press: "Right" },
    { js: "document.querySelector('.sidebar .nav-divider').focus()" }, { press: "Left" },
    { probe: "({ sidebar: Math.round(document.querySelector('.sidebar').getBoundingClientRect().width), nav: Math.round(document.querySelector('.nav-pane').getBoundingClientRect().width), list: Math.round(document.querySelector('.list-pane').getBoundingClientRect().width) })" },
    { assert: "칸은 최소 너비를 지킴" }], settle: 400 },
  // The top bar's sidebar toggle hides the navigator and brings it back as it was.
  { name: "nav-u35-toggle", viewport: WIDE, steps: [...navigatorAs({}, "dual"),
    { js: "__wb.click('.topbar-left [aria-label=\"사이드바 닫기\"]')", wait: "!__wb.has('.sidebar')", pause: 300 }, { assert: "칸은 최소 너비를 지킴" }], settle: 400,
    cleanup: [{ js: "__wb.click('.topbar-left [aria-label=\"사이드바 열기\"]')", wait: layoutIs("dual") }] },
  // Nothing stored, about 1000px: stacked. The same project, unfolded by kind.
  { name: "nav-u35-stacked", viewport: NARROW, steps: [...navigatorAs({}, "stacked"),
    { js: `__wb.click('${listRow(paperMain.id)}')`, wait: "__wb.has('.work-view .transcript')" },
    { js: `__wb.q('${listRow(papers.id)}').scrollIntoView({ block: 'start' }); __wb.blur()`, pause: 400 },
    { assert: "칸은 최소 너비를 지킴" }, { assert: "머리줄: 새로 만들기는 제 너비, 배치와 ⋯는 오른쪽 끝" }], settle: 700 },
  // Chosen two panes on the same narrow window: kept while a pane keeps 360px.
  { name: "nav-u35-dual-narrow", viewport: NARROW, steps: [...navigatorAs({ layout: "dual" }, "dual"), { js: "__wb.blur()", pause: 300 }, { assert: "칸은 최소 너비를 지킴" }], settle: 500 },
  // Stacked by choice on a wide window.
  { name: "nav-u35-stacked-wide", viewport: WIDE, steps: [...navigatorAs({ layout: "stacked" }, "stacked"),
    { js: `__wb.q('${listRow(papers.id)}').scrollIntoView({ block: 'start' }); __wb.blur()`, pause: 400 }], settle: 500 },
  // The single tree by choice: the same kinds under the project; 지금 · 바로가기 in the open.
  { name: "nav-u35-tree", viewport: WIDE, steps: [...navigatorAs({ layout: "tree" }, "tree"),
    { js: `__wb.click('${row(paperMain.id)}')`, wait: "__wb.has('.work-view .transcript')" },
    { js: `__wb.q('${row(papers.id)}').scrollIntoView({ block: 'start' }); __wb.blur()`, pause: 400 },
    { probe: "({ details: document.querySelectorAll('.sidebar details').length, sections: [...document.querySelectorAll('.sidebar .side-section')].map((section) => section.getAttribute('aria-label')), layoutButton: __wb.has('.side-head .side-layout') })" }, { assert: "머리줄: 새로 만들기는 제 너비, 배치와 ⋯는 오른쪽 끝" }], settle: 700 },
  // 1920px with the right sidebar: two navigator panes, the work, and the right sidebar docked.
  { name: "nav-u35-wide-right", viewport: WIDEST, steps: [...navigatorAs({}, "dual"), ...openSession(codex.id), { wait: "__wb.has('.approval-card')" }, ...openRight,
    { js: "__wb.blur()", pause: 300 }, { assert: "칸은 최소 너비를 지킴" }, { assert: "내비게이터 두 칸은 틀 위에" }], settle: 700, cleanup: [...closeRight] },
  // 1920px, two work panes and the right sidebar: still docked beside two navigator panes.
  { name: "nav-u35-wide-right-two", viewport: WIDEST, steps: [...navigatorAs({}, "dual"), ...openSession(codex.id), ...gridSteps(2), sidebarOpen, ...openRight,
    { js: "__wb.blur()", pause: 300 }, { assert: "칸은 최소 너비를 지킴" }], settle: 700, cleanup: [...closeRight, SAVED, ...gridSteps(1), SAVED] },
  // 1440px, two work panes side by side (728px) and the right sidebar: the navigator keeps two
  // panes, and the right sidebar lies over the work rather than squeeze them.
  { name: "nav-u35-right-over", viewport: WIDE, steps: [...navigatorAs({}, "dual"), ...openSession(codex.id), besideOf(minutes.id), { wait: layoutIs("dual") }, ...openRight,
    { js: "__wb.blur()", pause: 300 }, { assert: "칸은 최소 너비를 지킴" }], settle: 700, cleanup: [...closeRight, SAVED, ...gridSteps(1), SAVED] },
  // 1100px with two panes chosen: kept beside one work pane…
  { name: "nav-u35-dual-chosen", viewport: MIDDLE, steps: [...navigatorAs({ layout: "dual" }, "dual"), ...openSession(codex.id), { js: "__wb.blur()", pause: 300 }, { assert: "칸은 최소 너비를 지킴" }], settle: 600 },
  // …and drawn stacked when a second work pane opens (two need 728px): the choice itself stays.
  { name: "nav-u35-dual-yields", viewport: MIDDLE, steps: [...navigatorAs({ layout: "dual" }, "dual"), ...openSession(codex.id), besideOf(minutes.id), { wait: layoutIs("stacked"), pause: 300 },
    { js: "__wb.click('.side-head .side-layout')", wait: "__wb.has('.ui-menu[data-state=open] [role=menuitemradio]')", pause: 300 },
    { probe: "({ items: [...document.querySelectorAll('.ui-menu [role=menuitemradio]')].map((item) => item.textContent + (item.getAttribute('aria-checked') === 'true' ? ' ✓' : '')) })" },
    { assert: "칸은 최소 너비를 지킴" }], settle: 500, cleanup: [{ press: "Escape", wait: "!__wb.has('.ui-menu')" }, SAVED, ...gridSteps(1), { wait: layoutIs("dual") }, SAVED] },
  // About 1000px with the right sidebar: stacked navigator, one pane, the right sidebar docked.
  { name: "nav-u35-narrow-right", viewport: NARROW, steps: [...navigatorAs({}, "stacked"), ...openSession(codex.id), ...openRight,
    { js: "__wb.blur()", pause: 300 }, { assert: "칸은 최소 너비를 지킴" }], settle: 700, cleanup: [...closeRight, SAVED] },
  // U24's removal from the list pane: a document of the app's own work area goes to the app's
  // trash from its row's menu, with the way back in the top bar's notice.
  { name: "nav-u35-doc-removed", viewport: WIDE, steps: [...navigatorAs({}, "dual"),
    { js: `__wb.q('${listRow(draft!.id)}').scrollIntoView({ block: 'center' })`, pause: 200 },
    { js: `__wb.context('${listRow(draft!.id)}')`, wait: "__wb.has('.ui-menu [role=menuitem]', '휴지통으로 옮기기')", pause: 200 },
    { js: "__wb.click('.ui-menu [role=menuitem]', '휴지통으로 옮기기')", wait: `__wb.has('.top-notice', '앱 휴지통으로 옮겼습니다') && !__wb.has('${listRow(draft!.id)}')` },
    { js: "__wb.blur()", pause: 300 },
    { probe: "({ notice: __wb.q('.top-notice')?.textContent, actions: [...document.querySelectorAll('.top-notice button')].map((button) => button.textContent) })" }], settle: 300,
    cleanup: [{ js: "__wb.click('.top-notice button', '되돌리기')", wait: `__wb.has('${listRow(draft!.id)}')`, pause: 300 }, SAVED] },
] : [];
NAV_SCREENS.push(...U35_SCREENS);
// ── end of the two-pane navigator ────────────────────────────────────────────────────────────────

// ── a tab strip with more tabs than fit (--only=nav-tabs-overflow, with --width=1000 --height=700) ──
// Nine tabs in one pane of about 700px: project pages and conversations opened one after another
// from the sidebar. The probe says what the strip's scroller is doing (its scrollbar, how far it is
// scrolled, whether the active tab is wholly in view). The second screen is the same strip scrolled
// back to its start.
const STRIP = `(() => {
  const list = document.querySelector('.pane[data-pane-active="true"] .group-tabs [role=tablist]') ?? document.querySelector('.group-tabs [role=tablist]');
  if (!list) return { strip: false };
  const style = getComputedStyle(list), box = list.getBoundingClientRect(), active = list.querySelector('.group-tab.active')?.getBoundingClientRect();
  return { tabs: list.querySelectorAll('.group-tab').length, clientWidth: list.clientWidth, scrollWidth: list.scrollWidth, scrollLeft: Math.round(list.scrollLeft), overflowX: style.overflowX, scrollbarWidth: style.scrollbarWidth,
    scrollbarHeight: list.offsetHeight - list.clientHeight, stripHeight: Math.round(list.closest('.group-tabs').getBoundingClientRect().height),
    activeInView: Boolean(active) && active.left >= box.left - 1 && active.right <= box.right + 1, newButtonInside: (() => { const button = list.closest('.group-tabs').querySelector('.group-tab-new')?.getBoundingClientRect(), strip = list.closest('.group-tabs').getBoundingClientRect(); return Boolean(button) && button.right <= strip.right + 1; })() };
})()`;
const openRow = (id: string, shown: string): Step => ({ js: `__wb.q('${row(id)}').scrollIntoView({ block: 'center' }); __wb.click('${row(id)}')`, wait: `__wb.has('${shown}')`, pause: 350 });
const TABS_SCREENS: Screen[] = papers && paperMain ? [
  { name: "nav-tabs-overflow", viewport: NARROW, steps: [...gridSteps(1), closeStaleTabs, sidebarOpen,
    openRow(lecture.id, ".project-view"), openRow(codex.id, ".work-view .transcript"), openRow(claude.id, ".work-view .transcript"),
    openRow(review.id, ".project-view"), openRow(reviewer.id, ".work-view .transcript"),
    openRow(meeting.id, ".project-view"), openRow(minutes.id, ".work-view .transcript"),
    openRow(papers.id, ".project-view"), openRow(paperMain.id, ".work-view .transcript"),
    { js: "__wb.blur()", pause: 500 }, { probe: STRIP }], settle: 600 },
  { name: "nav-tabs-overflow-start", viewport: NARROW, steps: [
    { js: "(document.querySelector('.pane[data-pane-active=\"true\"] .group-tabs [role=tablist]') ?? document.querySelector('.group-tabs [role=tablist]')).scrollLeft = 0", pause: 400 }, { probe: STRIP }], settle: 400, cleanup: [SAVED] },
] : [];
NAV_SCREENS.push(...TABS_SCREENS);
// ── end of the tab strip ─────────────────────────────────────────────────────────────────────────

// The project note (U26): reading, a 4-pane cell, the cards, and editing the body and a property in place.
// Each screen starts at the top of the page (the tab, and its scroll, carry over between screens).
const openProject: Step = { js: `__wb.click('${row(lecture.id)}'); document.querySelectorAll('.pn-scroll').forEach((scroller) => scroller.scrollTo(0, 0))`, wait: "__wb.has('.project-view .project-title', '3주차 강의 슬라이드') && __wb.has('.project-view .pn-stats')" };
/** Change the lecture note through the gateway (another window, as far as this page knows). */
const changeLecture = (from: string, to: string) => `window.__u26done = false; (async () => { const headers = { authorization: 'Bearer ${ready.token}', 'content-type': 'application/json' }; const page = await (await fetch('/api/projects/${lecture.id}', { headers })).json(); await fetch('/api/projects/${lecture.id}/source', { method: 'PUT', headers, body: JSON.stringify({ text: page.note.source.includes(${JSON.stringify(from)}) ? page.note.source.replace(${JSON.stringify(from)}, ${JSON.stringify(to)}) : page.note.source.replace(${JSON.stringify(to)}, ${JSON.stringify(from)}), baseRevision: page.note.revision }) }); window.__u26done = (await fetch('/api/projects/${lecture.id}', { headers })).ok; })()`;
const U26_SCREENS: Screen[] = [
  { name: "u26-project", steps: [...gridSteps(1), openProject, { js: "__wb.blur()" }], settle: 1000 },
  { name: "u26-project-cards", steps: [...gridSteps(1), openProject, { js: "__wb.blur(); document.querySelector('.project-view [aria-label=\"대화\"]')?.scrollIntoView({ block: 'start' })" }], settle: 1000 },
  // A click with real coordinates inside the 메모 paragraph: the caret lands there, the page does not jump.
  { name: "u26-edit-body", steps: [...gridSteps(1), openProject, { js: `(() => { const p = [...document.querySelectorAll('.project-view .pn-run p')].find((element) => element.textContent.includes('사례가 너무 길어')); p.scrollIntoView({ block: 'center' }); const box = p.getBoundingClientRect(); const range = document.createRange(); const text = p.firstChild; range.setStart(text, 12); range.setEnd(text, 13); const at = range.getBoundingClientRect(); p.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: at.left + 1, clientY: at.top + at.height / 2 })); return box.top; })()`, wait: "__wb.has('.project-view .pn-body-edit .cm-editor')" },
    // The caret is not drawn off-screen: a marker typed at it shows where it is.
    { pause: 300, js: "document.querySelector('.project-view .pn-body-edit .cm-content').focus({ preventScroll: true }); document.execCommand('insertText', false, '▌')" }], settle: 800,
    cleanup: [{ press: "Escape", wait: "!__wb.has('.pn-body-edit')" }] },
  { name: "u26-source-key", steps: [...gridSteps(1), openProject, { js: "__wb.click('.project-view button[aria-label^=\"요약:\"]')", wait: "__wb.has('.project-view .pn-body-edit[data-mode=source] .cm-editor')" },
    { pause: 300, js: "document.querySelector('.project-view .pn-body-edit .cm-content').focus({ preventScroll: true }); document.execCommand('insertText', false, '▌')" }], settle: 800,
    cleanup: [{ press: "Escape", wait: "!__wb.has('.pn-body-edit')" }] },
  { name: "u26-edit-prop-refused", steps: [...gridSteps(1), openProject, { js: "__wb.click('.project-view .pn-prop[data-key=\"마감일\"] .pn-prop-button')", wait: "__wb.has('.project-view .pn-prop[data-key=\"마감일\"] input')" },
    { js: "__wb.type('.project-view .pn-prop[data-key=\"마감일\"] input', '언젠가'); __wb.key('Enter')", wait: "__wb.has('.project-view .pn-band[data-refused]')" }], settle: 600,
    cleanup: [{ press: "Escape", wait: "!__wb.has('.pn-prop input')" }] },
  { name: "u26-edit-prop", steps: [...gridSteps(1), openProject, { js: "__wb.click('.project-view .pn-prop[data-key=\"마감일\"] .pn-prop-button')", wait: "__wb.has('.project-view .pn-prop[data-key=\"마감일\"] input')" }], settle: 600,
    cleanup: [{ press: "Escape", wait: "!__wb.has('.pn-prop input')" }] },
  { name: "u26-edit-stage", steps: [...gridSteps(1), openProject, { js: "__wb.click('.project-view .pn-stage')", wait: "__wb.has('.ui-menu[data-state=open]')" }], settle: 600,
    cleanup: [{ press: "Escape", wait: "!__wb.has('.ui-menu')" }] },
  { name: "u26-project-4pane", viewport: { width: 1440, height: 900 }, steps: [...gridSteps(4), openProject, { js: "__wb.blur()" }], settle: 1000, cleanup: gridSteps(1) },
  { name: "u26-project-9pane", viewport: { width: 1600, height: 1000 }, steps: [...gridSteps(9), openProject, { js: "__wb.blur()" }], settle: 1000, cleanup: gridSteps(1) },
  // Round 2: a kept draft resumed after the note changed asks first; a same-key property change asks;
  // a typed decision survives leaving its field.
  { name: "u26-draft-conflict", steps: [...gridSteps(1), openProject,
    { js: "window.getSelection()?.removeAllRanges(); const li = [...document.querySelectorAll('.project-view .pn-run li')].find((element) => element.textContent.includes('근거')); li.scrollIntoView({ block: 'center' }); const box = li.getBoundingClientRect(); li.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: box.right - 4, clientY: box.top + box.height / 2 }))", wait: "__wb.has('.project-view .pn-body-edit .cm-editor')" },
    { pause: 300, js: "document.querySelector('.project-view .pn-body-edit .cm-content').focus({ preventScroll: true }); document.execCommand('insertText', false, ' (내 초안: 논문 두 편)')" },
    { pause: 600 }, { reload: true },
    // While the page was gone the note changed elsewhere (the editor's lease is gone with it).
    { js: changeLecture("루브릭에 쓸 근거 자료를 모은다.", "루브릭 근거는 다른 창에서 고쳤다."), wait: "window.__u26done === true" },
    openProject, { wait: "__wb.has('.project-view .pn-recovery')" },
    { js: "__wb.click('.project-view .pn-recovery button', '이어서 고치기')", wait: "__wb.has('.project-view .pn-conflict')" }, { js: "__wb.click('.project-view .pn-conflict button', '비교')" }], settle: 800,
    cleanup: [{ js: "__wb.click('.project-view .pn-conflict button', '저쪽 것 받기')", wait: "!__wb.has('.pn-body-edit')" }] },
  { name: "u26-key-conflict", steps: [...gridSteps(1), openProject, { js: "__wb.click('.project-view .pn-prop[data-key=\"마감일\"] .pn-prop-button')", wait: "__wb.has('.project-view .pn-prop[data-key=\"마감일\"] input')" },
    { js: "__wb.type('.project-view .pn-prop[data-key=\"마감일\"] input', '11월 27일')" },
    { js: changeLecture("마감일: 2026-11-20", "마감일: 2026-12-01"), wait: "window.__u26done === true" },
    { js: "__wb.q('.project-view .pn-prop[data-key=\"마감일\"] input').focus(); __wb.key('Enter')", wait: "__wb.has('.project-view .pn-key-conflict')" }], settle: 800,
    cleanup: [{ js: "__wb.click('.project-view .pn-key-conflict button', '저쪽 것 받기')", wait: "!__wb.has('.pn-key-conflict')" }] },
  { name: "u26-add-blur", steps: [...gridSteps(1), openProject, { js: "__wb.click('.project-view button', '+ 결정')", wait: "__wb.has('.project-view .pn-add-input')" },
    { js: "__wb.type('.project-view .pn-add-input[aria-label=\"정한 것 (Enter)\"]', '발표 자료는 금요일까지 올린다'); __wb.click('.project-view button', '+ 질문')", wait: "__wb.has('.project-view .pn-add-input[aria-label=\"열린 질문 (Enter)\"]')" },
    { js: "__wb.type('.project-view .pn-add-input[aria-label=\"열린 질문 (Enter)\"]', '과제 분량을 줄일까?'); __wb.blur()", pause: 300 }], settle: 600,
    cleanup: [
      { js: "__wb.q('.project-view .pn-add-input[aria-label=\"정한 것 (Enter)\"]').focus(); __wb.key('Escape')", wait: "!__wb.has('.pn-add-input[aria-label=\"정한 것 (Enter)\"]')" },
      { js: "__wb.q('.project-view .pn-add-input').focus(); __wb.key('Escape')", wait: "!__wb.has('.pn-add-input')" }] },
  // A note that is only properties, with no line ending after the closing ---, gets its first words.
  { name: "u26-first-words", steps: [...gridSteps(1), { js: `__wb.click('${row(review.id)}')`, wait: "__wb.has('.project-view .project-title', '논문 리뷰 메모')" },
    { js: "__wb.click('.project-view .pn-run')", wait: "__wb.has('.project-view .pn-body-edit .cm-editor')" },
    { pause: 300, js: "document.querySelector('.project-view .pn-body-edit .cm-content').focus({ preventScroll: true }); document.execCommand('insertText', false, '방법론 절을 먼저 읽는다.')" }], settle: 600 },
  { name: "u26-first-words-saved", steps: [{ js: "__wb.click('.project-view .pn-edit-actions button', '저장')", wait: "!__wb.has('.project-view .pn-body-edit') && __wb.has('.project-view .pn-run', '방법론')" }], settle: 800 },
  { name: "u26-broken", steps: [...gridSteps(1), { js: `__wb.click('${row(meeting.id)}'); document.querySelectorAll('.pn-scroll').forEach((scroller) => scroller.scrollTo(0, 0))`, wait: "__wb.has('.project-view .pn-broken')" }, { js: "__wb.blur()" }], settle: 1000 },
  // Round 4: text kept on this device that has no field to return into is a row of its own. A
  // "+ 속성" value kept from before (as after a reload) can be written or put away; on a note that
  // does not read, kept text can only be copied or put away. The kept entries are put in the
  // device's store as another window of the app would leave them (the page follows the store).
  { name: "u26-kept-row", steps: [...gridSteps(1), openProject,
    { js: `localStorage.setItem('workbench.projectField.${lecture.id}.prop:참고 자료', JSON.stringify({ text: '교재 3장과 지난 학기 설문', baseRevision: Number(document.querySelector('.project-view').dataset.noteRevision), added: 'text' })); window.dispatchEvent(new StorageEvent('storage'))`, wait: "__wb.has('.project-view .pn-band[data-kept]')" },
    { js: "__wb.blur()" }], settle: 800,
    cleanup: [{ js: `localStorage.removeItem('workbench.projectField.${lecture.id}.prop:참고 자료'); window.dispatchEvent(new StorageEvent('storage'))`, wait: "!__wb.has('.project-view .pn-kept')" }] },
  { name: "u26-broken-kept", steps: [...gridSteps(1), { js: `__wb.click('${row(meeting.id)}'); document.querySelectorAll('.pn-scroll').forEach((scroller) => scroller.scrollTo(0, 0))`, wait: "__wb.has('.project-view .pn-broken')" },
    { js: `localStorage.setItem('workbench.projectField.${meeting.id}.prop:안건', JSON.stringify({ text: '예산안 검토', baseRevision: 1 })); localStorage.setItem('workbench.projectField.${meeting.id}.add:decision', JSON.stringify({ text: '다음 회의는 목요일로 옮긴다', baseRevision: 1 })); window.dispatchEvent(new StorageEvent('storage'))`, wait: "__wb.has('.project-view .pn-kept-line') && __wb.has('.project-view .pn-band[data-kept]')" },
    { js: "__wb.blur()" }], settle: 1000,
    cleanup: [{ js: `localStorage.removeItem('workbench.projectField.${meeting.id}.prop:안건'); localStorage.removeItem('workbench.projectField.${meeting.id}.add:decision'); window.dispatchEvent(new StorageEvent('storage'))`, wait: "!__wb.has('.project-view .pn-kept')" }] },
  // K1: a field holding kept text on one note (open without the focus, as after a reload) does not
  // follow the tab to another project, and is there again with its text back on its own note.
  { name: "u26-field-stays-other", steps: [...gridSteps(1), openProject,
    { js: `localStorage.setItem('workbench.projectField.${lecture.id}.prop:마감일', JSON.stringify({ text: '12월 첫 주 금요일', baseRevision: Number(document.querySelector('.project-view').dataset.noteRevision) })); window.dispatchEvent(new StorageEvent('storage'))`, wait: "__wb.q('.project-view .pn-prop[data-key=\"마감일\"] input')?.value === '12월 첫 주 금요일'" },
    { js: `__wb.click('${row(review.id)}')`, wait: "__wb.has('.project-view .project-title', '논문 리뷰 메모') && !__wb.has('.project-view .pn-input') && !document.querySelector('.project-view').textContent.includes('12월 첫 주 금요일')" },
    { js: "__wb.blur()" }], settle: 800 },
  { name: "u26-field-stays-back", steps: [openProject, { wait: "__wb.q('.project-view .pn-prop[data-key=\"마감일\"] input')?.value === '12월 첫 주 금요일'" }, { js: "__wb.blur()" }], settle: 800,
    cleanup: [{ js: `localStorage.removeItem('workbench.projectField.${lecture.id}.prop:마감일'); window.dispatchEvent(new StorageEvent('storage'))`, wait: "!__wb.has('.project-view .pn-prop[data-key=\"마감일\"] input')" }] },
  // u26-kept-picker retired: since 2fc72f3b a key with kept text is a text field (the text returns into it, as in u26-field-stays-*), no longer a band beside a shut picker.
];
// The properties block (U34): folded, an empty template field being filled, a long text value
// being edited (as text, though another project has a value for that key), the tags picker from
// its row, and a cell narrow enough for the key to sit above its value. (Open, a row being edited,
// a conflict, a kept draft and a read-only key are the u26 screens above, its 4-pane one a cell;
// a smaller window is a pass with --width/--height: WebKitGTK here only grows the window per screen.)
const propsHead = ".project-view .pn-props .ui-section-toggle";
U26_SCREENS.push(
  { name: "u34-props-folded", steps: [...gridSteps(1), openProject, { js: `if (__wb.q('${propsHead}').getAttribute('aria-expanded') === 'true') __wb.click('${propsHead}')`, wait: "!__wb.has('.project-view .pn-prop')" }, { js: "__wb.blur()" }], settle: 600,
    cleanup: [{ js: `__wb.click('${propsHead}')`, wait: "__wb.has('.project-view .pn-prop')" }] },
  { name: "u34-props-empty-field", steps: [...gridSteps(1), openProject, { js: "__wb.click('.project-view .pn-prop[data-key=\"시작일\"] .pn-prop-button')", wait: "__wb.has('.project-view .pn-prop[data-key=\"시작일\"] input')" },
    { js: "__wb.type('.project-view .pn-prop[data-key=\"시작일\"] input', '다음 주 월요일')" }], settle: 600,
    cleanup: [{ press: "Escape", wait: "!__wb.has('.pn-prop input')" }] },
  { name: "u34-props-long-text", steps: [...gridSteps(1), openProject, { js: "__wb.click('.project-view .pn-prop[data-key=\"목표\"] .pn-prop-button')", wait: "__wb.has('.project-view .pn-prop[data-key=\"목표\"] input') && !__wb.has('.pn-picker')" },
    { js: "__wb.type('.project-view .pn-prop[data-key=\"목표\"] input', '학생이 AI가 고친 글과 자기 글의 차이를 자기 말로 설명하고, 고친 이유를 한 줄로 적게 한다.')" }], settle: 600,
    cleanup: [{ press: "Escape", wait: "!__wb.has('.pn-prop input')" }] },
  { name: "u34-props-tags-picker", steps: [...gridSteps(1), openProject, { js: "__wb.click('.project-view .pn-prop[data-key=\"tags\"] .pn-prop-button')", wait: "__wb.has('.pn-picker')" }], settle: 600,
    cleanup: [{ press: "Escape", wait: "!__wb.has('.pn-picker')" }] },
  { name: "u34-props-stacked", viewport: { width: 1440, height: 900 }, steps: [...gridSteps(9), openProject, { js: "__wb.blur(); document.querySelector('.project-view .pn-props').scrollIntoView({ block: 'start' })" }], settle: 1000, cleanup: gridSteps(1) },
);
// The device connection screens (--only=m01…): remote access on with no address a phone can open, a
// phone approved and remembered, and the same phone asking again and naming its earlier approval.
// The pairing runs through the real protected channel on loopback; the request waits five minutes.
const m01 = only?.some((name) => name.startsWith("m01")) ?? false;
if (m01) {
  const { RemotePeer, parseRemoteOffer } = await import("../packages/client/src/remote.ts");
  const { defaultWebSocketFactory } = await import("@getpaseo/client/internal/daemon-client-websocket-transport");
  await api("PUT", "/api/devices/config", { enabled: true, listenHost: "127.0.0.1", port: 0 });
  const pair = async (about: Record<string, unknown>) => {
    const offer = parseRemoteOffer((await api<{ url: string }>("POST", "/api/devices/offers")).url);
    const peer = new RemotePeer({ url: offer.workbench.endpoint, daemonPublicKeyB64: offer.daemonPublicKeyB64, serverId: offer.serverId, webSocketFactory: defaultWebSocketFactory });
    await peer.connect();
    const ticket = await peer.rpc<{ requestId: string; claimToken: string }>("pair", { offer: offer.workbench, name: "내 휴대폰", platform: "iPhone · Safari", ...about });
    return { peer, ticket };
  };
  const first = await pair({ remember: true });
  const grant = await api<{ deviceId: string }>("POST", `/api/devices/enrollments/${first.ticket.requestId}/approve`, { permissions: ["read", "send", "approve"], workIds: [lecture.id] });
  await first.peer.rpc("claim", { requestId: first.ticket.requestId, claimToken: first.ticket.claimToken });
  first.peer.close();
  (await pair({ remember: true, previousDeviceId: grant.deviceId })).peer.close();
}
const openDevices: Step = { js: "__wb.click('.shell-connections')", wait: "__wb.has('.host-connections-dialog[open] .host-connection-local-status')", pause: 300 };
const closeDevices: Step[] = [{ js: "__wb.click('[aria-label=\"기기 연결 닫기\"]')", wait: "!__wb.has('.host-connections-dialog[open]')" }];
const M01_SCREENS: Screen[] = [
  { name: "m01-join", steps: [openDevices, { js: "__wb.blur(); document.getElementById('join-host-title').scrollIntoView({ block: 'start' })", pause: 300 }], settle: 400, cleanup: closeDevices },
  { name: "m01-local", steps: [openDevices, { js: "__wb.blur(); document.getElementById('local-devices-title').scrollIntoView({ block: 'start' })", pause: 300 }], settle: 400, cleanup: closeDevices },
  { name: "m01-approval", steps: [openDevices, { js: "__wb.blur(); document.querySelector('.host-connection-pending').scrollIntoView({ block: 'start' })", pause: 300 }], settle: 400, cleanup: closeDevices },
  { name: "m01-devices", steps: [openDevices, { js: "__wb.blur(); document.querySelector('.host-connections-dialog').scrollTop = 1e6", pause: 300 }], settle: 400, cleanup: closeDevices },
];

// ── U28 곁 화면: a conversation with its document or page beside it; a document or page with its AI beside it ──
const u28 = only?.some((name) => name.startsWith("u28")) ?? false;
// U38: a real second writer (another window) changes the stored layout; this window's next layout
// change is refused (409, provoked on purpose) and the standing notice appears. It must not cover
// the top bar's controls at 1280 and 1000 px; 저장된 배치 불러오기 answers it.
const u38 = only?.some((name) => name.startsWith("u38")) ?? false;
const otherWindowWrites: Step = {
  js: `window.__u38 = 0; (async () => { const h = { authorization: 'Bearer ' + sessionStorage.getItem('workbench.token'), 'content-type': 'application/json' }; const { record } = await (await fetch('/api/layouts/global', { headers: h })).json(); await fetch('/api/layouts/global', { method: 'PUT', headers: h, body: JSON.stringify({ expectedRevision: record ? record.revision : 0, layout: record ? record.layout : { version: 2 } }) }); window.__u38 = 1; })()`,
  wait: "window.__u38 === 1",
};
const conflictScreen = (name: string, viewport: { width: number; height: number }): Screen => ({
  name, viewport,
  steps: [
    ...openSession(minutes.id), { pause: 900 }, otherWindowWrites,
    { js: `__wb.click('${row(codex.id)}')`, wait: "__wb.has('.topbar .top-notice.layout-problem')", pause: 400 },
    { js: "__wb.blur()" }, { assert: "알림은 상단 버튼을 덮지 않음" },
  ],
  settle: 400,
  cleanup: [{ js: "__wb.click('.top-notice.layout-problem .top-notice-action', '저장된 배치 불러오기')", wait: "!__wb.has('.top-notice.layout-problem')", pause: 400 }],
});
const U38_SCREENS: Screen[] = [conflictScreen("u38-layout-conflict-1280", { width: 1280, height: 860 }), conflictScreen("u38-layout-conflict-1000", { width: 1000, height: 860 }),
  // Below 900 px the bar is a flex row (hig-workspace.css): the notice wraps to its own line.
  conflictScreen("u38-layout-conflict-860", { width: 860, height: 860 })];
const ACTIVE_TAB = `(document.querySelector('.pane[data-pane-active="true"][data-tab-active="true"]') ?? document)`;
const BESIDE_PROBE = `(() => { const pane = ${ACTIVE_TAB}; const host = pane.querySelector('.beside'); const box = (selector) => { const element = pane.querySelector(selector); if (!element) return null; const b = element.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.width)]; }; const frame = pane.querySelector('.document-view iframe'); return { window: innerWidth + 'x' + innerHeight, fit: host?.dataset.fit ?? null, over: host?.dataset.over ?? null, chat: box('.beside-chat'), content: box('.beside-content'), document: box('.document-view'), editor: frame ? Math.round(frame.getBoundingClientRect().width) : null, inputs: [...pane.querySelectorAll('.hig-composer')].filter((element) => element.getClientRects().length > 0).length, tabs: [...document.querySelectorAll('.pane[data-pane-active="true"][data-tab-active="true"] .group-tab-title, .group-tab-title')].map((tab) => tab.textContent).slice(0, 8) }; })()`;
const WEB_URL = "https://ctl.example.ac.kr/guide/ai-writing-rubric";
// The native web page cannot be drawn off screen: a labelled box stands where it would be.
const standIn = `(() => { for (const v of document.querySelectorAll('.browser-viewport')) { if (v.querySelector('.web-standin')) continue; const d = document.createElement('div'); d.className = 'web-standin'; d.style.cssText = 'position:absolute;inset:0;display:grid;place-items:center;font:500 15px/1.6 "Pretendard Variable",sans-serif;color:var(--muted, #566173);background:repeating-linear-gradient(135deg, transparent 0 14px, color-mix(in srgb, currentColor 5%, transparent) 14px 15px);text-align:center'; d.innerHTML = '<div><div style="font-size:18px;font-weight:600">웹 페이지 (견본)</div><div>실제 앱에서는 이 자리에 네이티브 웹 페이지가 뜹니다</div><div style="font-size:13px">${WEB_URL}</div></div>'; if (getComputedStyle(v).position === 'static') v.style.position = 'relative'; v.appendChild(d); } })()`;
const besideDoc: Step[] = [
  ...openSession(codex.id), { wait: "__wb.has('.approval-card')" },
  // In a grid the head is folded into the band: the same menu is there.
  { js: "if (!__wb.has('.document-view[data-hosted]')) __wb.click('.work-view .note-head-more')", wait: "__wb.has('.document-view[data-hosted]') || __wb.has('.note-menu [role=menuitem]', '강의안.md')" },
  { js: "if (!__wb.has('.document-view[data-hosted]')) __wb.click('.note-menu [role=menuitem]', '강의안.md')", wait: "__wb.has('.document-view[data-hosted]')", pause: 1200 },
];
// Side by side it closes with ×; laid over its conversation, with the labelled ← 대화 in its head.
const closeBeside: Step[] = [{ js: "if (__wb.has('[aria-label=\"곁 화면 닫기\"]')) __wb.click('[aria-label=\"곁 화면 닫기\"]'); else if (__wb.has('.document-view[data-hosted] .doc-back, .browser-view[data-hosted] .browser-back')) __wb.click('.document-view[data-hosted] .doc-back, .browser-view[data-hosted] .browser-back')", wait: "!__wb.has('.document-view[data-hosted], .browser-view[data-hosted]')", pause: 300 }];
// Tabs a scene opened are closed after it, so the next starts from the conversations only.
const closeU28Tabs: Step = { js: "[...document.querySelectorAll('.group-tab')].filter((tab) => /\\.md$|\\.docx$|루브릭/.test(tab.querySelector('.group-tab-title')?.textContent ?? '')).forEach((tab) => tab.querySelector('.group-tab-close')?.click())", pause: 600 };
const docTab: Step[] = [
  ...openSession(codex.id), ...closeBeside,
  { js: `__wb.click('${row(doc.id)}')`, wait: "__wb.has('.document-view') && !__wb.has('.document-view[data-hosted]')", pause: 1200 },
];
const openColumn: Step[] = [{ js: "if (!__wb.has('.agent-column')) __wb.click('.document-view .doc-agent-toggle')", wait: "__wb.has('.agent-column .hig-composer[data-provider], .agent-column .note-banner')", pause: 600 }];
const askColumn = (text: string, until: string): Step[] => [
  { js: `__wb.type('.agent-column .composer-input', '${text}')` },
  { js: "__wb.click('.agent-column [aria-label=\"보내기\"]')", wait: until, pause: 800 },
  { js: "__wb.blur()" },
];
const columnTop: Step = { js: "__wb.blur(); const s = document.querySelector('.agent-column .transcript'); if (s) { s.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true })); s.scrollTop = 0; }", pause: 300 };
const authed = `{ method: 'PATCH', headers: { authorization: 'Bearer ${ready.token}', 'content-type': 'application/json' }`;
const U28_SCREENS: Screen[] = [
  // From a conversation: its document beside it, the conversation keeping its place and its input.
  { name: "u28-chat-doc", steps: [...besideDoc, ...toTop, { probe: BESIDE_PROBE }, { assert: "입력은 제 대화 아래" }], settle: 900 },
  // The same, at the end of the conversation: its waiting approval is in its own column.
  { name: "u28-chat-doc-approval", steps: [...besideDoc, ...toEnd, { probe: BESIDE_PROBE }, { assert: "입력은 제 대화 아래" }, { assert: "승인은 그대로 기다림" }], settle: 900 },
  // A file card in the conversation opens that file beside it (in place of the one that was there).
  { name: "u28-chat-doc-card", steps: [...besideDoc, ...toTop, { js: "__wb.click('.work-view .transcript .doc-card', '슬라이드-구성.md')", wait: "__wb.has('.document-view[data-hosted] .doc-name', '슬라이드-구성.md')", pause: 1200 }, { js: "__wb.blur()" }, { probe: BESIDE_PROBE }, { assert: "입력은 제 대화 아래" }], settle: 900 },
  // With the right sidebar: it docks only while both columns keep their minimum; otherwise it lies over.
  { name: "u28-chat-doc-right", steps: [...besideDoc, ...toTop, ...openRight, { js: "__wb.blur()" },
    { probe: `(() => { const side = document.querySelector('.right-sidebar'); return { ...${BESIDE_PROBE}, sidebar: side ? (side.hasAttribute('data-overlay') ? 'over' : 'docked') : 'closed' }; })()` }, { assert: "입력은 제 대화 아래" }], settle: 900, cleanup: [...closeRight] },
  // 탭으로 넓게 열기: the companion becomes the document's own tab; the conversation's tab stays.
  { name: "u28-chat-doc-wide", steps: [...besideDoc, { js: "__wb.click('.document-view .doc-wide')", wait: "__wb.has('.document-view') && !__wb.has('.document-view[data-hosted]')", pause: 1200 }, { probe: BESIDE_PROBE }], settle: 900, cleanup: [closeU28Tabs] },
  // From a document tab: the document's own AI as a conversation column beside the embedded editor.
  { name: "u28-doc-ai", steps: [...docTab, ...openColumn, { probe: BESIDE_PROBE }, { assert: "입력은 제 대화 아래" }], settle: 1200 },
  // The same with a request answered: the conversation's Transcript in the column.
  { name: "u28-doc-ai-asked", steps: [...docTab, ...openColumn, ...askColumn("견본: 이 문서의 도입부를 살펴봐 줘.", "__wb.has('.agent-column .turn-end')"), columnTop, { probe: BESIDE_PROBE }, { assert: "입력은 제 대화 아래" }], settle: 1200 },
  // The app's own view of the document (원문) with the column.
  { name: "u28-doc-ai-source", steps: [...docTab, ...openColumn, { js: "__wb.click('.document-view [role=radio]', '원문')", wait: "__wb.has('.document-view .cm-editor')", pause: 800 }, { js: "__wb.blur()" }, { probe: BESIDE_PROBE }, { assert: "입력은 제 대화 아래" }], settle: 900, cleanup: [{ js: "__wb.click('.document-view [role=radio]', '편집')", pause: 1200 }] },
  // A waiting approval of the document's AI is in its column.
  { name: "u28-doc-ai-approval", steps: [...docTab, ...openColumn, ...askColumn("명령 실행해 줘. 폴더에 무엇이 있는지 확인하고 싶어.", "__wb.has('.agent-column .approval-card')"),
    { js: "const s = document.querySelector('.agent-column .transcript'); s.scrollTop = s.scrollHeight;", pause: 400 }, { probe: BESIDE_PROBE }, { assert: "입력은 제 대화 아래" }], settle: 900,
    cleanup: [{ js: "__wb.click('.agent-column .approval-card button', '거절')", wait: "!__wb.has('.agent-column .approval-actions')", pause: 800 }] },
  // The main conversation is not held by it, and reads its work: one line above its input.
  { name: "u28-chat-child-line", steps: [...docTab, ...openColumn, ...askColumn("명령 실행해 줘. 폴더에 무엇이 있는지 확인하고 싶어.", "__wb.has('.agent-column .approval-card')"), ...openSession(codex.id), { wait: "__wb.has('.child-work-line')" }, ...toEnd,
    { probe: "({ lines: [...document.querySelectorAll('.child-work-line')].map((line) => line.textContent), composerEnabled: !document.querySelector('.work-view .composer-input')?.disabled })" }, { assert: "입력은 제 대화 아래" }], settle: 900,
    cleanup: [{ js: "__wb.click('.child-work-line')", wait: "__wb.has('.agent-column .approval-card')", pause: 600 }, { js: "__wb.click('.agent-column .approval-card button', '거절')", wait: "!__wb.has('.agent-column .approval-actions')", pause: 800 }] },
  // An archived AI: its column says so in one line, with no input.
  { name: "u28-doc-ai-readonly", steps: [...docTab, ...openColumn,
    { js: `fetch('/api/sessions/' + document.querySelector('.agent-column').dataset.session, ${authed}, body: JSON.stringify({ archived: true }) })`, wait: "__wb.has('.agent-column .note-banner') && !__wb.has('.agent-column .hig-composer')", pause: 500 },
    { probe: BESIDE_PROBE }, { assert: "입력은 제 대화 아래" }], settle: 900,
    cleanup: [{ js: "__wb.click('.agent-column .note-banner button', '문서 AI 시작')", wait: "__wb.has('.agent-column .hig-composer')", pause: 500 }, closeU28Tabs] },
  // Two panes and four: there is no room for both columns, so the companion lies over.
  { name: "u28-panes-2", steps: [...gridSteps(2), ...besideDoc, { probe: BESIDE_PROBE }], settle: 1200, cleanup: [...closeBeside, ...gridSteps(1)] },
  { name: "u28-panes-2-ai", steps: [...gridSteps(2), ...docTab, ...openColumn, { probe: BESIDE_PROBE }], settle: 1200, cleanup: [{ js: "if (__wb.has('.agent-column')) __wb.click('.agent-column .note-head .agent-close')", pause: 300 }, closeU28Tabs, ...gridSteps(1)] },
  { name: "u28-panes-4", steps: [...gridSteps(4), ...besideDoc, { probe: BESIDE_PROBE }], settle: 1200, cleanup: [...closeBeside, ...gridSteps(1)] },
  // Fix round 1. A Word document beside a conversation is read in the app's own view (pages), with
  // 탭으로 열어 고치기 and 문서 AI in its head; no embedded editor and no second input.
  { name: "u28-chat-word", steps: [...openSession(codex.id), ...closeBeside, { js: "__wb.click('.work-view .note-head-more')", wait: `__wb.has('.note-menu [role=menuitem]', '${WORD_NAME}')` },
    { js: `__wb.click('.note-menu [role=menuitem]', '${WORD_NAME}')`, wait: "__wb.has('.document-view[data-hosted]')", pause: 2500 }, ...toTop, { js: "__wb.blur()" }, { probe: BESIDE_PROBE }, { assert: "입력은 제 대화 아래" }], settle: 1200, cleanup: [...closeBeside] },
  // 읽기 and 검토 from a conversation, by pointer: the note's ⋯ while a document of the project is open.
  { name: "u28-note-modes", steps: [...besideDoc, ...toTop, { js: "__wb.click('.work-view .note-head-more')", wait: "__wb.has('.note-menu [role=menuitem]', '읽기 ·')", pause: 300 }], settle: 600, cleanup: [{ js: "__wb.key('Escape')", wait: "!__wb.has('.note-menu')" }] },
  // A Word document's own tab with its AI: the column needs the editor's 680 and its own AI panel
  // (1040) beside it, so at 1440 it lies over as a sheet unless Word says its panel is closed.
  { name: "u28-word-ai", steps: [...openSession(codex.id), ...closeBeside, { js: `__wb.click('${row(word?.id ?? "")}')`, wait: "__wb.has('.document-view') && !__wb.has('.document-view[data-hosted]')", pause: 6000 }, ...openColumn, { pause: 1500 }, { probe: BESIDE_PROBE }, { assert: "입력은 제 대화 아래" }], settle: 1500,
    cleanup: [{ js: "if (__wb.has('.agent-column')) __wb.click('.agent-column .note-head .agent-close')", pause: 300 }, closeU28Tabs] },
  // The document's head with its AI's column closed while that AI waits for an approval: the state
  // in words beside the dot, 대화 옆에, and one line at the document's foot that opens the column.
  { name: "u28-doc-wait", steps: [...docTab, ...openColumn, ...askColumn("명령 실행해 줘. 폴더에 무엇이 있는지 확인하고 싶어.", "__wb.has('.agent-column .approval-card')"),
    { js: "__wb.click('.agent-column .note-head .agent-close')", wait: "!__wb.has('.agent-column') && __wb.has('.doc-agent-wait')", pause: 600 }, { js: "__wb.blur()" },
    { probe: "({ head: document.querySelector('.document-view .doc-header-right')?.textContent, foot: document.querySelector('.doc-agent-wait')?.textContent })" }], settle: 900,
    cleanup: [{ js: "__wb.click('.doc-agent-wait .child-work-line')", wait: "__wb.has('.agent-column .approval-card')", pause: 600 }, { js: "__wb.click('.agent-column .approval-card button', '거절')", wait: "!__wb.has('.agent-column .approval-actions')", pause: 800 }] },
  // Fix round 2: a conversation's row, where its companion lies over it (1000), brings the conversation.
  { name: "u28-row-back", steps: [...openSession(codex.id), closeU28Tabs, ...besideDoc, { js: `__wb.click('${row(codex.id)}')`, pause: 1200 }, ...toEnd,
    { probe: `({ ...${BESIDE_PROBE}, hosted: !!document.querySelector('.pane[data-pane-active="true"] .document-view[data-hosted]'), back: document.querySelector('.doc-back')?.textContent ?? null })` }], settle: 900, cleanup: [...closeBeside] },
  // 대화 옆에 on a document tab whose editor may hold edits: the person is asked first and can cancel.
  { name: "u28-move-ask", steps: [...docTab, { js: "if (__wb.has('.agent-column')) __wb.click('.agent-column .note-head .agent-close')", pause: 300 }, { js: "__wb.click('.document-view .doc-beside')", wait: "__wb.has('.modal-backdrop')", pause: 300 },
    { probe: "({ lines: [...document.querySelectorAll('.modal-backdrop p')].map((p) => p.textContent), buttons: [...document.querySelectorAll('.modal-backdrop button')].map((b) => b.textContent), focused: document.activeElement?.textContent })" }], settle: 600,
    cleanup: [{ js: "__wb.click('.modal-backdrop button', '취소')", wait: "!__wb.has('.modal-backdrop') && __wb.has('.document-view') && !__wb.has('.document-view[data-hosted]')", pause: 400 }, closeU28Tabs] },
];
// The web scenes need the desktop bridge: run them with --native-stub.
const webTab: Step[] = [
  ...openSession(codex.id), ...closeBeside,
  // The web tab an earlier scene opened is used again (one page, one tab).
  { js: "if (__wb.has('.group-tab > button:not(.group-tab-close)', '루브릭')) __wb.click('.group-tab > button:not(.group-tab-close)', '루브릭')", pause: 400 },
  { js: "if (!__wb.has('.browser-view')) __wb.click('.pane[data-pane-active=\"true\"] .group-tab-new')", wait: "__wb.has('.browser-view') || __wb.has('.context-menu-item, [role=menuitem]', '새 웹 탭')" },
  // Once only (a step may be run again while its wait settles): one page, one tab.
  { js: "if (!__wb.has('.browser-view') && !window.__u28web) { window.__u28web = true; __wb.click('.context-menu-item, [role=menuitem]', '새 웹 탭'); }", wait: "__wb.has('.browser-view .browser-search input, .browser-view .browser-ask')" },
  { js: `if (__wb.has('.browser-view .browser-search input') && !window.__u28url) { window.__u28url = true; __wb.type('.browser-view .browser-search input', '${WEB_URL}'); __wb.q('.browser-view .browser-search').requestSubmit(); }`, wait: "__wb.has('.browser-view .browser-ask')", pause: 600 },
];
const U28_WEB_SCREENS: Screen[] = [
  // Fix round 2: first, as in the order that stalled in round 1 — the dark pass then starts on the
  // page's tab, and its first click on the conversation's row must not be undone by the start-up restore.
  // Fix round 1: a page beside a conversation closed with × stays as a tab of its own behind it.
  { name: "u28-web-closed", steps: [...webTab,
    { js: "if (!__wb.has('.agent-column')) __wb.click('.browser-view .browser-ask')", wait: "__wb.has('.agent-column .composer-input')", pause: 400 },
    ...openSession(codex.id), ...openRight, { js: "__wb.click('.right-sidebar [role=tab]', '연결')", wait: "__wb.has('.right-link', '루브릭')", pause: 300 },
    { js: "__wb.click('.right-link', '루브릭')", wait: "__wb.has('.browser-view[data-hosted]')", pause: 600 }, ...closeRight,
    { js: "__wb.click('.browser-view[data-hosted] [aria-label=\"곁 화면 닫기\"], .browser-view[data-hosted] .browser-back')", wait: "!__wb.has('.browser-view[data-hosted]') && __wb.has('.group-tab', '루브릭')", pause: 600 }, ...toTop, { js: "__wb.blur()" },
    { probe: "({ tabs: [...document.querySelectorAll('.group-tab-title')].map((tab) => tab.textContent) })" }], settle: 900 },
  // From a web tab: the page's own AI as a conversation column beside the page.
  { name: "u28-web-ai", steps: [...webTab,
    { js: "if (!__wb.has('.agent-column')) __wb.click('.browser-view .browser-ask')", wait: "__wb.has('.agent-column .composer-input')", pause: 400 },
    ...askColumn("견본: 이 페이지의 평가 기준을 정리해 줘.", "__wb.has('.agent-column .turn-end')"), columnTop, { js: standIn }, { probe: BESIDE_PROBE }, { assert: "입력은 제 대화 아래" }], settle: 1200 },
  // From the conversation that opened it (연결): the page beside that conversation.
  { name: "u28-chat-web", steps: [...webTab,
    // The page's AI exists once its conversation was opened: that is what 연결 lists.
    { js: "if (!__wb.has('.agent-column')) __wb.click('.browser-view .browser-ask')", wait: "__wb.has('.agent-column .composer-input')", pause: 400 },
    ...openSession(codex.id), ...openRight, { js: "__wb.click('.right-sidebar [role=tab]', '연결')", wait: "__wb.has('.right-link', '루브릭')", pause: 300 },
    { js: "__wb.click('.right-link', '루브릭')", wait: "__wb.has('.browser-view[data-hosted]')", pause: 600 }, ...closeRight, ...toTop, { js: standIn }, { js: "__wb.blur()" }, { probe: BESIDE_PROBE }, { assert: "입력은 제 대화 아래" }], settle: 1200,
    // Back to a tab of its own (탭으로 넓게 열기), so the page is where the next scene looks for it.
    cleanup: [{ js: "__wb.click('.browser-view [aria-label=\"탭으로 넓게 열기\"]')", wait: "!__wb.has('.browser-view[data-hosted]') && __wb.has('.browser-view .browser-ask')", pause: 400 }] },
];
const availableScreens = u38 ? U38_SCREENS : u28 ? (args.includes("--native-stub") ? U28_WEB_SCREENS : U28_SCREENS) : higMode ? HIG_SCREENS : args.includes("--motion") ? MOTION_SCREENS : navMode ? NAV_SCREENS : only?.some(name => name.startsWith("completion")) ? COMPLETION_SCREENS : u26 ? U26_SCREENS : m01 ? M01_SCREENS : SCREENS;
const screens = only ? availableScreens.filter((screen) => only.some((name) => screen.name.includes(name))) : availableScreens;
const VIEWPORT = { width: Number(option("width")) || 1280, height: Number(option("height")) || 860 };
const url = `${ready.url}/?token=${ready.token}`;
const appReady = "__wb.has('.work-view, .start-view, .archive-view, .pkm-center, .document-view, .project-view, .browser-view')";

async function chromiumPass() {
  const browser = await chromium.launch();
  const logs: string[] = [];
  // The screen being reached, so a console error says where it came from.
  let shown = "start";
  try {
    for (const theme of themes) {
      await setPrefs({ theme });
      const page = await browser.newPage({ viewport: VIEWPORT });
      page.on("console", (message) => message.type() === "error" && logs.push(`[${theme} ${shown}] ${message.text().slice(0, 200)} ${message.location().url.replace(/[?#].*$/, "").slice(0, 120)}`));
      page.on("pageerror", (error) => logs.push(`[${theme} pageerror] ${(error.stack ?? error.message).slice(0, 6000)}`));
      const run = (script: string) => page.evaluate(`(() => { ${PRELUDE}; ${script}; return true; })()`);
      const wait = (expression: string, timeout = 12_000) => page.waitForFunction(`(() => { ${PRELUDE}; return Boolean(${expression}); })()`, null, { timeout });
      const step = async (entry: Step) => {
        if (entry.prefs) await setPrefs(entry.prefs);
        if (entry.reload) await page.reload();
        if (entry.js) await run(entry.js);
        // GTK names the key Return; Playwright names it Enter.
        if (entry.press) { await page.keyboard.press(entry.press === "Return" ? "Enter" : entry.press); await page.waitForTimeout(300); }
        if (entry.wait) await wait(entry.wait);
        if (entry.pause) await page.waitForTimeout(entry.pause);
        if (entry.burst?.js) await run(entry.burst.js);
        if (entry.probe) console.log(`PROBE ${theme}: ${JSON.stringify(await page.evaluate(`(() => { ${PRELUDE}; return (${entry.probe}); })()`))}`);
        if (entry.assert) {
          const result = (await page.evaluate(INVARIANTS[entry.assert])) as { ok: boolean; detail: string };
          check(`Chromium ${theme} ${entry.assert}`, result.ok, result.detail);
        }
      };
      await page.goto(url);
      await wait(appReady, 20_000);
      for (const screen of screens) {
        // Where a screen stopped (the step and its wait), for the failure line.
        let at = "start";
        shown = screen.name;
        try {
          await page.setViewportSize(screen.viewport ?? VIEWPORT);
          for (const [index, entry] of screen.steps.entries()) { at = `step ${index + 1}/${screen.steps.length}: ${(entry.wait ?? entry.js ?? entry.press ?? "").slice(0, 160)}`; await step(entry); }
          at = "screenshot or cleanup";
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
          check(`Chromium ${theme} ${screen.name}`, false, `${error instanceof Error ? error.message.split("\n")[0]! : String(error)} — at ${at}`);
          await page.screenshot({ path: join(outDir, `chromium-${theme}-${screen.name}-failure.png`) }).catch(() => undefined);
          await page.goto(url);
          await wait(appReady, 20_000).catch(() => undefined);
        }
      }
      // Leave the page as a window is closed (pagehide gives up its document leases), so the next
      // theme's page is not left read-only behind a lease of a page that is gone.
      await page.goto("about:blank").catch(() => undefined);
      await page.close();
    }
  } finally {
    await browser.close();
  }
  check("Chromium 콘솔 오류 없음", logs.length === 0, logs.slice(0, 6).join(" | "));
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
      for (const entry of openSession(minutes.id)) {
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
  writeFileSync(scenario, JSON.stringify({ url, token: ready.token, base: ready.url, outDir, viewport: VIEWPORT, themes, prelude: PRELUDE, appReady, screens, invariants: INVARIANTS, reducedMotion: args.includes("--reduced-motion"), nativeStub: args.includes("--native-stub") }, null, 2));
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
  // Wait for the gateway to be gone: on its way out it still writes into its Claude folder, which
  // was left behind in /tmp after every run when removed at once.
  if (child.exitCode === null && child.signalCode === null) {
    const gone = new Promise((done) => child.once("exit", done));
    child.kill();
    await Promise.race([gone, new Promise((done) => setTimeout(done, 10_000))]);
  }
  for (const folder of [dataDir, worksDir, vaultDir, claudeConfig]) rmSync(folder, { recursive: true, force: true });
}
writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
const failed = results.filter((entry) => !entry.ok);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
