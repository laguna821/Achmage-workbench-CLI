/// <reference lib="dom" />
// Real-engine acceptance for documents across formats (no mocks): with a Markdown document
// attached, Codex makes a new Hangul (HWPX) document and a new PowerPoint deck at the paths the
// gateway reserved (tracked with their source), and edits a Word document as a proposal that
// applies. Then screenshots of the conversation, the @ list and the document tabs.
// Needs IeumOffice (connection screen → 이음오피스 설치) and the hallym-kordoc skill.
// Usage: HOST_ENTRY=apps/host/dist/host.mjs node scripts/smoke-convert.ts [outDir]

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import type { Artifact, ArtifactRevision, CreateTarget, DocRef, Proposal, Session, Snapshot, TranscriptItem, Work } from "@workbench/contracts";
import { findIeumCli } from "../apps/host/src/ieumoffice.ts";

const outDir = process.argv[2] ?? join(tmpdir(), "wb-smoke-convert");
mkdirSync(outDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "workbench-convert-smoke-"));
const project = join(dataDir, "project");
mkdirSync(project, { recursive: true });
const results: { name: string; ok: boolean; detail: string }[] = [];
let host: { child: ChildProcess; url: string; token: string } | null = null;
const cli = findIeumCli();

function startHost(): Promise<NonNullable<typeof host>> {
  const child = spawn(process.execPath, [process.env.HOST_ENTRY ?? "apps/host/src/main.ts"], {
    env: { ...process.env, WORKBENCH_DATA_DIR: dataDir, WORKBENCH_WEB_DIR: "apps/web/dist", WORKBENCH_CODEX_IDLE_MS: "600000", WORKBENCH_CODEX_APPROVAL: "never" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("host did not start")), 20_000);
    createInterface({ input: child.stdout! }).on("line", (line) => {
      if (!line.startsWith("WORKBENCH_READY ")) return;
      clearTimeout(timer);
      const ready = JSON.parse(line.slice("WORKBENCH_READY ".length)) as { url: string; token: string };
      resolve({ child, url: ready.url, token: ready.token });
    });
  });
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${host!.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${host!.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json()) as T & { code?: string; message?: string };
  if (!response.ok) throw Object.assign(new Error(`${method} ${path} -> ${response.status} ${json.message}`), { code: json.code, status: response.status });
  return json;
}

const snapshot = () => api<Snapshot>("GET", "/api/snapshot");
const items = async (sessionId: string) => (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${sessionId}/items`)).items;

async function waitFor<T>(label: string, check: () => Promise<T | null | undefined | false>, timeoutMs = 900_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`timeout: ${label}`);
}

async function ask(sessionId: string, text: string, refs: DocRef[] = [], create: CreateTarget | null = null) {
  const requestId = randomUUID();
  await api("POST", `/api/sessions/${sessionId}/messages`, { requestId, text, refs, create });
  const end = await waitFor(`turn ${requestId}`, async () => {
    const list = await items(sessionId);
    const start = list.findIndex((item) => item.id === `user:${requestId}`);
    if (start === -1) return null;
    for (const item of list.slice(start)) {
      if (item.kind === "approval" && item.decision === null) {
        await api("POST", `/api/sessions/${sessionId}/approvals/${encodeURIComponent(item.id)}`, { decision: "accept" }).catch(() => undefined);
      }
    }
    return list.slice(start).find((item) => item.kind === "turnEnd") as (TranscriptItem & { kind: "turnEnd" }) | undefined;
  });
  return { requestId, end };
}

const record = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

try {
  if (!cli) throw new Error("IeumOffice is not installed");
  writeFileSync(
    join(project, "강의 계획.md"),
    "# 가을 특강 계획\n\n질문에서 시작하는 글쓰기\n\n## 일정\n\n- 10월 28일 (화) 오후 3시\n- 미디어스쿨 302호\n\n## 진행\n\n| 순서 | 내용 | 시간 |\n|---|---|---|\n| 1 | 질문 만들기 | 30분 |\n| 2 | 자료 읽기 | 40분 |\n| 3 | 짧은 글 쓰기 | 50분 |\n",
  );
  writeFileSync(join(project, "보고서.md"), "# 가을 특강 결과 보고\n\n참석자 24명이 질문 만들기 활동을 했다.\n\n## 다음 계획\n\n겨울 특강을 준비한다.\n");
  execFileSync(cli, ["convert", "보고서.md", "--to", "docx", "--json"], { cwd: project, env: { ...process.env, GENOFFICE_AUDIT_LOG: "off" } });

  host = await startHost();
  const work = await api<Work>("POST", "/api/works", { title: "가을 특강 문서", folderId: null, cwd: project });
  const md = await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path: "강의 계획.md" });
  const docx = await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path: "보고서.docx" });
  const codex = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "codex", purpose: "문서 변환" });

  // 1) Markdown → a new Hangul document.
  const hwpx = await ask(codex.id, "첨부한 마크다운 강의 계획을 같은 내용의 한글 문서로 만들어 줘. 표도 표로 살려 줘.", [{ artifactId: md.id, revision: 1, mode: "review" }], {
    format: "hwpx",
    name: "강의 계획",
  });
  const hwpxDoc = (await snapshot()).artifacts.find((artifact) => artifact.name === "강의 계획.hwpx");
  const hwpxText = hwpxDoc ? (await api<{ text: string }>("GET", `/api/artifacts/${hwpxDoc.id}/text`).catch(() => ({ text: "" }))).text : "";
  const hwpxRevision = hwpxDoc ? (await api<ArtifactRevision[]>("GET", `/api/artifacts/${hwpxDoc.id}/revisions`))[0] : null;
  record(
    "마크다운 → 새 한글(HWPX)",
    hwpx.end.status === "completed" && Boolean(hwpxDoc) && hwpxText.includes("가을 특강") && hwpxText.includes("자료 읽기"),
    hwpxDoc ? `${hwpxDoc.name}, 글 ${hwpxText.length}자` : "파일 없음",
  );
  record("출처 기록(derivedFrom)", Boolean(hwpxRevision?.derivedFrom?.some((source) => source.artifactId === md.id)), JSON.stringify(hwpxRevision?.derivedFrom ?? null));

  // 2) The same Markdown → a new PowerPoint deck.
  const pptx = await ask(codex.id, "같은 강의 계획 마크다운으로 발표 슬라이드 4장 정도를 만들어 줘. 깔끔한 기본 스타일이면 돼.", [{ artifactId: md.id, revision: 1, mode: "review" }], {
    format: "pptx",
    name: "강의 계획 발표",
  });
  const deck = (await snapshot()).artifacts.find((artifact) => artifact.name === "강의 계획 발표.pptx");
  const deckPages = deck ? await api<{ pages: unknown[] }>("GET", `/api/artifacts/${deck.id}/office-pages`).catch(() => ({ pages: [] })) : { pages: [] };
  record("마크다운 → 새 PPT", pptx.end.status === "completed" && Boolean(deck) && deckPages.pages.length >= 2, deck ? `${deck.name}, ${deckPages.pages.length}장` : "파일 없음");

  // 3) A Word document edited through its working copy.
  await ask(codex.id, "보고서의 '겨울 특강을 준비한다.' 문장을 '12월 첫 주에 겨울 특강을 연다.'로 바꿔 줘.", [{ artifactId: docx.id, revision: 1, mode: "edit" }]);
  const proposal = await waitFor("docx proposal", async () => (await snapshot()).proposals.find((entry: Proposal) => entry.artifactId === docx.id && entry.status !== "running"), 60_000);
  const texts = await api<{ base: string; proposed: string }>("GET", `/api/proposals/${proposal.id}`);
  const applied = proposal.status === "pending" && !proposal.problem ? await api<{ artifact: Artifact }>("POST", `/api/proposals/${proposal.id}/apply`).catch(() => null) : null;
  record(
    "워드 수정안 → 적용",
    texts.proposed.includes("12월 첫 주에 겨울 특강을 연다") && !texts.proposed.includes("겨울 특강을 준비한다") && applied?.artifact.revision === 2,
    `status=${proposal.status} problem=${proposal.problem ?? "없음"} r${applied?.artifact.revision ?? "-"}`,
  );

  // Screens over this data.
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(([workId, openIds]) => {
    localStorage.setItem("workbench.lastWork", workId);
    localStorage.setItem("workbench.openDocs", JSON.stringify({ [workId]: openIds }));
  }, [work.id, [md.id, docx.id]] as const);
  await page.goto(`${host.url}/?token=${host.token}`);
  await page.waitForSelector(".doc-card", { timeout: 30_000 });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: join(outDir, "01-conversation.png") });
  await page.locator(".composer-input").fill("이 @강");
  await page.locator(".composer-input").press("End");
  await page.waitForSelector(".mention-list", { timeout: 5000 });
  await page.screenshot({ path: join(outDir, "02-mention.png") });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  await page.locator(".composer .icon-button[aria-label='새 문서로 만들기']").click();
  await page.getByText("새 한글(HWPX) 문서").click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(outDir, "03-create-chip.png") });
  record("UI: 카드·@목록·새 문서 칩", errors.length === 0, errors.join(" / "));
  await browser.close();
} catch (error) {
  record("실행", false, error instanceof Error ? error.message : String(error));
} finally {
  writeFileSync(join(outDir, "results.json"), JSON.stringify({ dataDir, results }, null, 2));
  host?.child.kill();
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed · ${dataDir}`);
  process.exitCode = failed.length ? 1 : 0;
}
