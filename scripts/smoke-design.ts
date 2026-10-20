/// <reference lib="dom" />
// Real-engine acceptance for design documents (vendored doory editor), no mocks:
// the user's design r2 → Codex edits the file through its working copy (proposal) → the user edits
// first (r3) → the r2 proposal is refused → asked again on r3 it applies and keeps both edits →
// a request scoped to one selected object changes only that object → Codex creates a new design
// file from scratch, which the app tracks and the editor opens. Then screenshots of the real UI.
// Usage: HOST_ENTRY=apps/host/dist/host.mjs node scripts/smoke-design.ts [outDir]

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import type { Artifact, DocRef, Proposal, Session, Snapshot, TranscriptItem, Work } from "@workbench/contracts";

const outDir = process.argv[2] ?? join(tmpdir(), "wb-smoke-design");
mkdirSync(outDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "workbench-design-smoke-"));
const project = join(dataDir, "project");
mkdirSync(project, { recursive: true });
const results: { name: string; ok: boolean; detail: string }[] = [];
let host: { child: ChildProcess; url: string; token: string } | null = null;

function startHost(): Promise<NonNullable<typeof host>> {
  const child = spawn(process.execPath, [process.env.HOST_ENTRY ?? "apps/host/src/main.ts"], {
    env: { ...process.env, WORKBENCH_DATA_DIR: dataDir, WORKBENCH_WEB_DIR: "apps/web/dist", WORKBENCH_CODEX_IDLE_MS: "600000", WORKBENCH_CLAUDE_IDLE_MS: "600000" },
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

async function waitFor<T>(label: string, check: () => Promise<T | null | undefined | false>, timeoutMs = 420_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`timeout: ${label}`);
}

async function finishTurn(sessionId: string, requestId: string) {
  return waitFor(`turn ${requestId}`, async () => {
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
}

async function ask(sessionId: string, text: string, refs: DocRef[] = []) {
  const requestId = randomUUID();
  await api("POST", `/api/sessions/${sessionId}/messages`, { requestId, text, refs });
  const end = await finishTurn(sessionId, requestId);
  return { requestId, end };
}

const record = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

type Doc = { width: number; height: number; pages: { id: string; background: { type: string; color?: string }; objects: Obj[] }[] };
type Obj = Record<string, unknown> & { id: string; type: string; text?: string };

const textOf = async (artifactId: string, revision?: number) => (await api<{ text: string }>("GET", `/api/artifacts/${artifactId}/text${revision ? `?revision=${revision}` : ""}`)).text;
const parse = (text: string) => JSON.parse(text) as Doc;

/** A text box the way the editor writes one (Fabric 7 + doory props, origin at the centre). */
function textbox(id: string, text: string, top: number, fontSize: number, weight: number, fill: string): Obj {
  return {
    id, type: "textbox", text, originX: "center", originY: "center", left: 540, top, width: 900, height: fontSize * 1.16,
    fontSize, fontWeight: weight, fontFamily: '"Achmage SameTone", sans-serif', fontStyle: "normal", lineHeight: 1.16, textAlign: "center",
    fill, scaleX: 1, scaleY: 1, angle: 0, opacity: 1, visible: true, styles: [], charSpacing: 0,
  };
}

async function proposalFor(sessionId: string, baseRevision: number) {
  return waitFor("proposal", async () =>
    (await snapshot()).proposals.find((proposal: Proposal) => proposal.sessionId === sessionId && proposal.baseRevision === baseRevision && proposal.status !== "running"),
  60_000);
}

try {
  host = await startHost();
  const work = await api<Work>("POST", "/api/works", { title: "가을 특강 홍보", folderId: null, cwd: project });
  const design = await api<Artifact>("POST", `/api/works/${work.id}/designs`, { name: "특강 포스터", preset: "portrait" });

  // The user's first design (what the editor would save): title, subtitle, a colour band.
  const r1 = parse(await textOf(design.id));
  const titleId = randomUUID();
  const subtitleId = randomUUID();
  const bandId = randomUUID();
  r1.pages[0].background = { type: "solid", color: "#f7f3ea" };
  r1.pages[0].objects.push(
    { id: bandId, type: "rect", originX: "center", originY: "center", left: 540, top: 1180, width: 1080, height: 340, fill: "#0b1f4d", scaleX: 1, scaleY: 1, angle: 0, opacity: 1, visible: true },
    textbox(titleId, "봄 특강", 420, 120, 800, "#0b1f4d"),
    textbox(subtitleId, "질문에서 시작하는 글쓰기", 580, 56, 500, "#334155"),
  );
  const r2 = await api<Artifact>("PUT", `/api/artifacts/${design.id}/text`, { expectedRevision: 1, text: JSON.stringify(r1, null, 2) });
  record("사용자 디자인 r2 저장", r2.revision === 2);

  const codex = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "codex", purpose: "포스터 다듬기" });

  // 1) Edit request on r2 → a proposal in the working copy; the real file stays as it is.
  const first = await ask(codex.id, "제목을 '가을 특강'으로 바꾸고, 부제목 아래에 '10월 28일 (화) 오후 3시 · 미디어스쿨 302호'라는 작은 글자(약 40px, 회색)를 하나 추가해 줘.", [
    { artifactId: design.id, revision: 2, mode: "edit" },
  ]);
  record("Codex 턴 완료", first.end.status === "completed", first.end.status);
  const proposal1 = await proposalFor(codex.id, 2);
  const texts1 = await api<{ base: string; proposed: string }>("GET", `/api/proposals/${proposal1.id}`);
  const proposed1 = parse(texts1.proposed);
  const objects1 = proposed1.pages[0].objects;
  record("수정안 생성 (파일 직접 수정 아님)", proposal1.status === "pending" && !proposal1.problem && readFileSync(design.path, "utf8").includes("봄 특강"), `problem=${proposal1.problem ?? "없음"}`);
  record("수정안: 제목 변경 + 날짜 글자 추가", objects1.some((object) => object.id === titleId && String(object.text).includes("가을 특강")) && objects1.some((object) => String(object.text ?? "").includes("10월 28일")), objects1.map((object) => `${object.type}:${object.text ?? ""}`).join(" | "));

  // 2) The user changes the background first (r3): the r2 proposal must not be applied.
  const mine = parse(await textOf(design.id));
  mine.pages[0].background = { type: "solid", color: "#fde68a" };
  const r3 = await api<Artifact>("PUT", `/api/artifacts/${design.id}/text`, { expectedRevision: 2, text: JSON.stringify(mine, null, 2) });
  const stale = await api("POST", `/api/proposals/${proposal1.id}/apply`).then(() => null, (error: { code?: string }) => error.code);
  record("이전 판 수정안 적용 거부", r3.revision === 3 && stale === "stale_proposal" && readFileSync(design.path, "utf8").includes("#fde68a"), String(stale));

  // 3) Asked again on r3: applies, and both the user's background and the AI's text are there.
  await ask(codex.id, "방금과 같은 수정을 최신 판에 다시 해 줘.", [{ artifactId: design.id, revision: 3, mode: "edit" }]);
  const proposal2 = await proposalFor(codex.id, 3);
  const applied = await api<{ artifact: Artifact }>("POST", `/api/proposals/${proposal2.id}/apply`);
  const r4 = parse(readFileSync(design.path, "utf8"));
  record(
    "최신 판 수정안 적용, 두 편집 모두 유지",
    applied.artifact.revision === 4 && r4.pages[0].background.color === "#fde68a" && r4.pages[0].objects.some((object) => String(object.text).includes("가을 특강")),
    `r${applied.artifact.revision}`,
  );

  // 4) Selection-scoped: only the selected subtitle may change.
  const subtitle = r4.pages[0].objects.find((object) => object.id === subtitleId)!;
  const third = await ask(codex.id, "선택한 글자만 30% 크게, 색은 #b45309로 바꿔 줘.", [
    {
      artifactId: design.id,
      revision: 4,
      mode: "edit",
      selection: { from: 0, to: 0, pageId: r4.pages[0].id, objectIds: [subtitleId], label: `1쪽 "${String(subtitle.text).slice(0, 16)}"`, text: `textbox "${subtitle.text}" (id ${subtitleId})` },
    },
  ]);
  const proposal3 = await proposalFor(codex.id, 4);
  const proposed3 = parse((await api<{ proposed: string }>("GET", `/api/proposals/${proposal3.id}`)).proposed).pages[0].objects;
  const changedIds = proposed3.filter((object) => JSON.stringify(object) !== JSON.stringify(r4.pages[0].objects.find((before) => before.id === object.id))).map((object) => object.id);
  const newSubtitle = proposed3.find((object) => object.id === subtitleId)!;
  const grown = Number(newSubtitle.fontSize) * Number(newSubtitle.scaleY ?? 1) > Number(subtitle.fontSize) * Number(subtitle.scaleY ?? 1) * 1.15;
  record(
    "선택 개체만 변경",
    third.end.status === "completed" && changedIds.length === 1 && changedIds[0] === subtitleId && grown && String(newSubtitle.fill).toLowerCase() === "#b45309",
    `바뀐 개체 ${changedIds.length}개, fontSize ${String(subtitle.fontSize)}→${String(newSubtitle.fontSize)}, fill ${String(newSubtitle.fill)}`,
  );

  // 5) A new design from scratch: the engine writes a .design.json file and the app tracks it.
  await ask(codex.id, "같은 특강의 인스타그램 정사각형(1080×1080) 카드 디자인을 새 파일 '특강 카드.design.json'으로 만들어 줘. 지금 포스터 파일의 형식을 그대로 따르고, 제목·날짜·장소 글자와 배경색을 넣어 줘.", [
    { artifactId: design.id, revision: 4, mode: "review" },
  ]);
  const card = await waitFor("card artifact", async () => (await snapshot()).artifacts.find((artifact: Artifact) => artifact.name === "특강 카드.design.json"), 30_000).catch(() => null);
  const cardProblem = card ? await textOf(card.id).then((text) => {
    try {
      const doc = parse(text);
      return doc.width === 1080 && doc.height === 1080 && doc.pages[0].objects.some((object) => object.type === "textbox") ? null : "크기나 글자가 다름";
    } catch (error) {
      return String(error);
    }
  }) : "파일이 추적되지 않음";
  record("새 디자인 파일 생성·추적", !cardProblem, cardProblem ?? card!.path);

  // Screenshots of the real UI over this data: the conversation with design cards, the editor, the compare view.
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  const logs: string[] = [];
  page.on("pageerror", (error) => logs.push(`[pageerror] ${error.message}`));
  await page.addInitScript(([workId]) => localStorage.setItem("workbench.lastWork", workId), [work.id]);
  await page.goto(`${host.url}/?token=${host.token}`);
  await page.waitForSelector(".proposal-card", { timeout: 30_000 });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: join(outDir, "01-conversation.png") });
  await page.locator(".proposal-card").last().scrollIntoViewIfNeeded();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(outDir, "02-proposal-card.png") });
  await page.locator(".proposal-card").last().getByRole("button", { name: "미리보기" }).click();
  await page.waitForSelector(".design-compare img", { timeout: 30_000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(outDir, "03-compare.png") });
  await page.getByRole("button", { name: "닫기" }).first().click();
  await page.waitForSelector("iframe.design-frame", { timeout: 20_000 });
  const frame = page.frameLocator("iframe.design-frame");
  await frame.locator("canvas").first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: join(outDir, "04-editor.png") });
  record("UI: 대화 카드·비교·편집기 표시", logs.length === 0, logs.join(" / "));
  writeFileSync(join(outDir, "ui-errors.log"), logs.join("\n"));
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
